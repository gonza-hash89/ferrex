/**
 * FERREX Backend v2.0 — PostgreSQL + SuperAdmin
 * Pilares: secretos en .env · JWT corto + refresh httpOnly · rate-limit ·
 *          mediación total vía API · helmet + CORS + PostgreSQL persistente
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('./db/pool');
const dbServices = require('./db/services');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---- Pilar 1: secretos centralizados ----
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && NODE_ENV === 'production') {
  console.error('[FATAL] JWT_SECRET no definido en producción. Abortando.');
  process.exit(1);
}
if (!JWT_SECRET) console.warn('[WARN] JWT_SECRET ausente: usando secreto efímero de desarrollo.');
const JWT_KEY = JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ACCESS_TTL = process.env.ACCESS_TTL || '15m';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_HTTPS = BASE_URL.startsWith('https://');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// ---- Directorios garantizados ----
for (const d of [UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
try { fs.accessSync(UPLOAD_DIR, fs.constants.W_OK); }
catch { console.error('[FATAL] /uploads no escribible:', UPLOAD_DIR); process.exit(1); }

// ---- Helmet + CORS ----
app.use(helmet({
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "https://fonts.googleapis.com"],
      upgradeInsecureRequests: []
    }
  }
}));

const CORS_LIST = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
try { CORS_LIST.push(new URL(BASE_URL).origin); } catch {}
CORS_LIST.push('https://ferrex-pe.netlify.app');
CORS_LIST.push('http://localhost:3001', 'http://127.0.0.1:3001');

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, CORS_LIST.includes(origin.replace(/\/$/, '')));
  },
  credentials: true, maxAge: 86400
}));

app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiadas peticiones, espera un minuto' } });
const uploadLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Límite de subidas alcanzado (10 por 15 min)' } });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiados intentos, espera 15 minutos' } });
app.use('/api/', apiLimiter);

// ---- Upload config ----
const MIME_TO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
function fileFilter(req, file, cb) {
  if (!MIME_TO_EXT[file.mimetype]) return cb(new Error('Solo JPG / PNG / WEBP (máx 5MB)'));
  cb(null, true);
}
function isRealImage(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, 12, 0); } finally { fs.closeSync(fd); }
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const isWebp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return isJpg || isPng || isWebp;
}
function rejectFakeImage(file) {
  if (file && !isRealImage(file.path)) {
    try { fs.unlinkSync(file.path); } catch {}
    return true;
  }
  return false;
}
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const fotoUrl = f => (f ? `/uploads/${f}` : null);

// ---- Validaciones ----
const CATS = ['Electricidad', 'Gasfitería', 'Fijaciones', 'Herramientas', 'Pinturas', 'Candados', 'Plomería', 'Cerrajería', 'Otros'];
const PAYS = ['Efectivo', 'Yape', 'Plin'];
const DELIVERIES = ['delivery', 'recojo'];
const ORDER_STATUS = ['Pendiente', 'Aceptado', 'En Camino', 'Listo para recojo', 'Completado', 'Rechazado'];
const NEXT = {
  'Pendiente': ['Aceptado', 'Rechazado'],
  'Aceptado': ['En Camino', 'Listo para recojo', 'Rechazado', 'Completado'],
  'En Camino': ['Completado'],
  'Listo para recojo': ['Completado'],
  'Completado': [], 'Rechazado': []
};

const nonEmpty = (v, max = 120) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const validPrice = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 100000; };
const validPeruPhone = v => typeof v === 'string' && /^9\d{8}$/.test(v.trim());
function normalizeWhatsapp(v) {
  if (typeof v !== 'string') return null;
  const d = v.replace(/\D/g, '');
  if (/^9\d{8}$/.test(d)) return '51' + d;
  if (/^51(9\d{8})$/.test(d)) return d;
  return null;
}
function sendError(res, status, message, details) {
  return res.status(status).json({ ok: false, error: message, ...(details ? { details } : {}) });
}
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function checkValidation(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return sendError(res, 400, 'Datos inválidos', errors.array().map(e => e.path ?? e.param));
}

// Validadores
const vRegister = [
  body('nombre').trim().isLength({ min: 3, max: 80 }),
  body('distrito').trim().isLength({ min: 1, max: 60 }),
  body('direccion').optional().trim().isLength({ max: 160 }),
  body('telefono').optional({ checkFalsy: true }).matches(/^9\d{8}$/),
  body('password').isLength({ min: 6, max: 72 }),
  body('apertura').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('cierre').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('lat').optional({ checkFalsy: true }).isFloat({ min: -90, max: 90 }),
  body('lng').optional({ checkFalsy: true }).isFloat({ min: -180, max: 180 })
];
const vLogin = [
  body('identifier').trim().isLength({ min: 1, max: 40 }),
  body('password').isString().isLength({ min: 1, max: 72 })
];
const vProduct = [
  body('store_id').isUUID(),
  body('nombre').trim().isLength({ min: 2, max: 100 }),
  body('precio').isFloat({ gt: 0, lt: 100000 }),
  body('categoria').optional().isIn(CATS)
];
const vOrder = [
  body('store_id').isUUID(),
  body('items').isArray({ min: 1, max: 50 }),
  body('pay').optional().isIn(PAYS),
  body('delivery').optional().isIn(DELIVERIES),
  body('address').optional().trim().isLength({ max: 160 }),
  body('pickupName').optional().trim().isLength({ max: 80 }),
];

// JWT
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_HTTPS = BASE_URL.startsWith('https://');

function signAccess(ferreteriaId) {
  return jwt.sign({ sid: ferreteriaId }, JWT_KEY, { expiresIn: ACCESS_TTL });
}
function sha256(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function signRefresh(ferreteriaId) {
  return jwt.sign({ sid: ferreteriaId, type: 'refresh' }, JWT_KEY, { expiresIn: '7d' });
}
function verifyRefresh(token) {
  try {
    const payload = jwt.verify(token, JWT_KEY);
    if (payload.type !== 'refresh') return null;
    return payload.sid;
  } catch { return null; }
}
function setRefreshCookie(res, raw) {
  res.cookie('ga_refresh', raw, {
    httpOnly: true, secure: IS_HTTPS, sameSite: IS_HTTPS ? 'none' : 'lax',
    maxAge: REFRESH_TTL_MS, path: '/'
  });
}
function clearRefreshCookie(res) {
  res.clearCookie('ga_refresh', { httpOnly: true, secure: IS_HTTPS, sameSite: IS_HTTPS ? 'none' : 'lax', path: '/' });
}
function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}
function requireStoreAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return sendError(res, 401, 'Inicia sesión como ferretería');
  try {
    const payload = jwt.verify(token, JWT_KEY);
    req.authStoreId = payload.sid;
    return next();
  } catch {
    return sendError(res, 401, 'Sesión vencida, vuelve a entrar');
  }
}
function requireSuperAdminAuth(req, res, next) {
  const token = req.cookies?.admin_session || req.headers['x-admin-token'];
  if (!token) return sendError(res, 401, 'No autenticado como SuperAdmin');
  try {
    const payload = jwt.verify(token, JWT_KEY);
    if (payload.type !== 'superadmin') return sendError(res, 403, 'No autorizado');
    req.adminId = payload.aid;
    return next();
  } catch {
    return sendError(res, 401, 'Sesión admin inválida');
  }
}

// ---- Static files ----
const FRONT_DIR = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
for (const d of [UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
const fotoUrl = f => (f ? `/uploads/${f}` : null);

// ================= API ROUTES =================

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'FERREX API', version: '2.0.0', baseUrl: BASE_URL }));

// ================= AUTH FERRETERÍA =================
app.post('/api/auth/login', authLimiter, vLogin, checkValidation, async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const cleanPhone = String(identifier).replace(/\D/g, '');
    
    const ferreteria = await dbServices.getFerreteriaByPhone(cleanPhone);
    if (!ferreteria || !ferreteria.password_hash) {
      return sendError(res, 401, 'Ferretería no registrada o sin contraseña');
    }
    
    const valid = await bcrypt.compare(password, ferreteria.password_hash);
    if (!valid) return sendError(res, 401, 'Credenciales incorrectas');
    
    // Crear session en BD
    await dbServices.createSession(ferreteria.id, signRefresh(ferreteria.id));
    
    const accessToken = signAccess(ferreteria.id);
    const refreshToken = signRefresh(ferreteria.id);
    
    setRefreshCookie(res, refreshToken);
    res.json({ accessToken, refreshToken, store: { ...ferreteria, password_hash: undefined } });
  } catch (err) {
    console.error('Login error:', err);
    sendError(res, 500, 'Error en login');
  }
});

app.post('/api/auth/refresh', authLimiter, async (req, res) => {
  const raw = req.cookies?.ga_refresh || req.body?.refreshToken;
  if (!raw) return sendError(res, 401, 'Sin sesión');
  
  const ferreteriaId = verifyRefresh(raw);
  if (!ferreteriaId) return sendError(res, 401, 'Sesión inválida');
  
  const accessToken = signAccess(ferreteriaId);
  const newRefresh = signRefresh(ferreteriaId);
  setRefreshCookie(res, newRefresh);
  res.json({ accessToken });
});

app.post('/api/auth/logout', (req, res) => {
  const raw = req.cookies?.ga_refresh;
  if (raw) {
    // TODO: Invalidar en BD
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
});

// ================= REGISTRO FERRETERÍA =================
app.post('/api/stores', uploadLimiter, upload.single('logo'), vRegister, checkValidation, async (req, res) => {
  try {
    const { nombre, distrito, direccion, telefono, whatsapp, password, apertura, cierre, dias_atencion, lat, lng } = req.body;
    
    if (!nonEmpty(nombre, 80)) return sendError(res, 400, 'Nombre requerido (3-80)', ['nombre']);
    if (!nonEmpty(distrito, 60)) return sendError(res, 400, 'Distrito requerido', ['distrito']);
    if (telefono && !validPeruPhone(telefono)) return sendError(res, 400, 'Celular inválido', ['telefono']);
    if (!password || password.length < 6) return sendError(res, 400, 'Contraseña mín. 6 chars', ['password']);
    
    let wa = null;
    if (whatsapp && whatsapp.trim()) {
      wa = normalizeWhatsapp(whatsapp);
      if (!wa) return sendError(res, 400, 'WhatsApp inválido', ['whatsapp']);
    }
    
    let la = null, ln = null;
    if ((lat !== undefined && lat !== '') || (lng !== undefined && lng !== '')) {
      if (!validLat(lat) || !validLng(lng)) return sendError(res, 400, 'Coordenadas inválidas', ['lat', 'lng']);
      la = Number(lat); ln = Number(lng);
    }
    
    let horario = { apertura: '08:00', cierre: '20:00', dias: [1,2,3,4,5,6] };
    if (apertura || cierre || dias_atencion) {
      let dArr = [1,2,3,4,5,6];
      if (dias_atencion) {
        try { dArr = typeof dias_atencion === 'string' ? JSON.parse(dias_atencion) : dias_atencion; } catch {}
        dArr = (Array.isArray(dArr) ? dArr : [dArr]).map(Number);
      }
      horario = { apertura: apertura || '08:00', cierre: cierre || '20:00', dias: dArr };
      if (!validHorario(horario)) return sendError(res, 400, 'Horario inválido', ['horario']);
    }
    
    const existing = await dbServices.getFerreteriaByPhone(telefono.replace(/\D/g, ''));
    if (existing) return sendError(res, 400, 'Ya existe una ferretería con ese teléfono', ['telefono']);
    
    if (req.file && rejectFakeImage(req.file)) return sendError(res, 400, 'Archivo no es imagen válida');
    
    const ferreteria = await dbServices.createFerreteria({
      nombre: nombre.trim(), distrito: distrito.trim(), direccion: direccion?.trim() || '',
      telefono: telefono.replace(/\D/g, ''), whatsapp: wa, direccion: direccion?.trim() || '',
      password, apertura: horario.apertura, cierre: horario.cierre, dias_atencion: horario.dias,
      lat: la, lng: ln, logo: req.file ? req.file.filename : null
    });
    
    const accessToken = signAccess(ferreteria.id);
    const refreshToken = signRefresh(ferreteria.id);
    setRefreshCookie(res, refreshToken);
    
    res.status(201).json({ accessToken, refreshToken, store: { ...ferreteria, password_hash: undefined } });
  } catch (err) {
    console.error('Register error:', err);
    sendError(res, 500, 'Error registrando ferretería');
  }
});

app.get('/api/auth/me', async (req, res) => {
  const token = bearer(req);
  if (!token) return sendError(res, 401, 'No autenticado');
  try {
    const payload = jwt.verify(token, JWT_KEY);
    const ferreteria = await dbServices.getFerreteriaById(payload.sid);
    if (!ferreteria) return sendError(res, 404, 'Ferretería no encontrada');
    res.json({ ...ferreteria, password_hash: undefined });
  } catch {
    sendError(res, 401, 'Token inválido');
  }
});

app.patch('/api/stores/:id', requireStoreAuth, async (req, res) => {
  try {
    if (req.params.id !== req.authStoreId) return sendError(res, 403, 'Solo tu ferretería');
    const updated = await dbServices.updateFerreteria(req.params.id, req.body);
    if (!updated) return sendError(res, 404, 'No encontrada');
    res.json({ ...updated, password_hash: undefined });
  } catch (err) {
    sendError(res, 500, 'Error actualizando');
  }
});

// ================= PRODUCTOS =================
app.get('/api/products', async (req, res) => {
  try {
    const { store_id, q, cat, only_stock } = req.query;
    let products = await dbServices.getProductosByFerreteria(store_id, only_stock === '1');
    
    if (cat && cat !== 'Todo') products = products.filter(p => p.categoria === cat);
    if (q) products = products.filter(p => p.nombre.toLowerCase().includes(q.toLowerCase()));
    
    res.json(products.map(p => ({ ...p, foto_url: p.foto_base64 || p.foto_url || null })));
  } catch (err) {
    sendError(res, 500, 'Error cargando productos');
  }
});

app.post('/api/products', requireStoreAuth, uploadLimiter, upload.single('foto'), vProduct, checkValidation, async (req, res) => {
  try {
    const { store_id, nombre, precio, categoria } = req.body;
    if (req.body.store_id !== req.authStoreId) return sendError(res, 403, 'Solo tu ferretería');
    
    let fotoBase64 = null;
    if (req.file) {
      if (req.file.size > 5 * 1024 * 1024) return sendError(res, 400, 'Imagen > 5MB');
      const fs = require('fs');
      const base64 = fs.readFileSync(req.file.path, 'base64');
      fotoBase64 = `data:${req.file.mimetype};base64,${base64}`;
      fs.unlinkSync(req.file.path);
    }
    
    const producto = await dbServices.createProducto({
      ferreteria_id: store_id,
      codigo: req.body.codigo || `SKU-${Date.now()}`,
      nombre: nombre.trim(),
      precio: parseFloat(precio),
      categoria,
      stock_qty: parseInt(req.body.stock_qty) || 0,
      precio_oferta: req.body.precio_oferta ? parseFloat(req.body.precio_oferta) : null,
      categoria_enum: req.body.categoria_enum,
      foto_base64: fotoBase64
    });
    
    res.status(201).json({ ...producto, foto_url: producto.foto_base64 });
  } catch (err) {
    console.error('Create product error:', err);
    sendError(res, 500, 'Error creando producto');
  }
});

app.patch('/api/products/:id', requireStoreAuth, async (req, res) => {
  try {
    const updated = await dbServices.updateProducto(req.params.id, req.body);
    if (!updated) return sendError(res, 404, 'No encontrado');
    res.json({ ...updated, foto_url: updated.foto_base64 || updated.foto_url });
  } catch (err) {
    sendError(res, 500, 'Error actualizando');
  }
});

app.patch('/api/products/:id/stock', requireStoreAuth, async (req, res) => {
  try {
    const { stock } = req.body;
    if (typeof stock !== 'boolean') return sendError(res, 400, 'stock debe ser boolean');
    const updated = await dbServices.toggleProductoStock(req.params.id, stock);
    if (!updated) return sendError(res, 404, 'No encontrado');
    res.json({ ...updated, stock });
  } catch (err) {
    sendError(res, 500, 'Error actualizando stock');
  }
});

app.delete('/api/products/:id', requireStoreAuth, async (req, res) => {
  try {
    await dbServices.deleteProducto(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'Error eliminando');
  }
});

// ================= PEDIDOS (con persistencia) =================
app.post('/api/orders', vOrder, checkValidation, async (req, res) => {
  try {
    const { store_id, items, total, pay, address, pickupName, delivery, clientZone } = req.body;
    
    // Validar items
    if (!Array.isArray(items) || items.length === 0) return sendError(res, 400, 'Pedido vacío');
    
    // Verificar stock y precios
    const productIds = items.map(i => i.product_id);
    const productos = await dbServices.getProductosByIds(productIds);
    const productMap = new Map(productos.map(p => [p.id, p]));
    
    const cleanItems = items.map(it => {
      const p = productMap.get(it.product_id);
      if (!p) throw new Error(`Producto ${it.product_id} no existe`);
      if (!p.stock) throw new Error(`Producto ${p.nombre} sin stock`);
      return {
        product_id: it.product_id,
        nombre: p.nombre,
        qty: it.qty,
        price: p.precio_oferta || p.precio
      };
    });
    
    const subtotal = cleanItems.reduce((a, i) => a + i.price * i.qty, 0);
    const shipping = req.body.delivery === 'delivery' ? subtotal * 0.15 : 0;
    const total = subtotal + shipping;
    
    // Crear pedido en BD
    const pedido = await dbServices.createPedido({
      ferreteria_id: store_id,
      items: cleanItems,
      total,
      pay: pay || 'Efectivo',
      address,
      pickupName,
      delivery: delivery || 'delivery',
      clientZone,
      cliente_nombre: req.body.cliente_nombre,
      cliente_telefono: req.body.cliente_telefono,
      envio_costo: shipping,
      subtotal
    });
    
    // Generar WhatsApp
    const store = await dbServices.getFerreteriaById(store_id);
    const message = buildWhatsAppMessage({ ...pedido, items: cleanItems, subtotal, shipping, total, pay: pay || 'Efectivo', delivery: delivery || 'delivery', address, pickupName }, store);
    const phone = normalizeWhatsapp(store.whatsapp || store.telefono);
    const whatsapp_url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null;
    
    // Notificar SSE (si hay clientes conectados)
    // broadcastOrder(pedido); // TODO: implementar SSE con PostgreSQL
    
    res.status(201).json({ ...pedido, whatsapp_url, whatsapp_message: message });
  } catch (err) {
    console.error('Order error:', err);
    sendError(res, 400, err.message || 'Error creando pedido');
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const { store_id, status, limit } = req.query;
    let orders;
    if (store_id) {
      orders = await dbServices.getPedidosByFerreteria(store_id, status);
    } else {
      orders = await dbServices.getAllPedidos({ status, limit: limit ? parseInt(limit) : 50 });
    }
    res.json(orders);
  } catch (err) {
    sendError(res, 500, 'Error cargando pedidos');
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await dbServices.getPedidoById(req.params.id);
    if (!order) return sendError(res, 404, 'No encontrado');
    res.json(order);
  } catch (err) {
    sendError(res, 500, 'Error cargando pedido');
  }
});

app.patch('/api/orders/:id', requireStoreAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !ORDER_STATUS.includes(status)) return sendError(res, 400, 'Estado inválido');
    
    const order = await dbServices.getPedidoById(req.params.id);
    if (!order) return sendError(res, 404, 'No encontrado');
    if (order.ferreteria_id !== req.authStoreId) return sendError(res, 403, 'No autorizado');
    
    // Validar transición
    if (order.status !== status && !(NEXT[order.status] || []).includes(status)) {
      return sendError(res, 400, `Transición inválida: ${order.status} → ${status}`);
    }
    
    const updated = await dbServices.updatePedidoEstado(req.params.id, status);
    res.json(updated);
  } catch (err) {
    sendError(res, 500, 'Error actualizando');
  }
});

// ================= INVENTARIO (Ferretería) =================
app.get('/api/inventory', requireStoreAuth, async (req, res) => {
  try {
    const products = await dbServices.getProductosByFerreteria(req.authStoreId, false);
    res.json(products.map(p => ({ 
      ...p, 
      foto_url: p.foto_base64 || p.foto_url,
      stock_badge: p.stock ? 'HAY' : 'SIN STOCK',
      stock_class: p.stock ? 'in-stock' : 'out-stock'
    })));
  } catch (err) {
    sendError(res, 500, 'Error cargando inventario');
  }
});

app.post('/api/inventory', requireStoreAuth, uploadLimiter, upload.single('foto'), async (req, res) => {
  try {
    if (req.file && rejectFakeImage(req.file)) return sendError(res, 400, 'Imagen inválida');
    
    let fotoBase64 = null;
    if (req.file) {
      const fs = require('fs');
      const base64 = fs.readFileSync(req.file.path, 'base64');
      fotoBase64 = `data:${req.file.mimetype};base64,${base64}`;
      fs.unlinkSync(req.file.path);
    }
    
    const producto = await dbServices.createProducto({
      ferreteria_id: req.authStoreId,
      codigo: req.body.codigo || `SKU-${Date.now()}`,
      nombre: req.body.nombre?.trim(),
      precio: parseFloat(req.body.precio),
      categoria: req.body.categoria,
      stock_qty: parseInt(req.body.stock_qty) || 0,
      precio_oferta: req.body.precio_oferta ? parseFloat(req.body.precio_oferta) : null,
      categoria_enum: req.body.categoria,
      foto_base64: fotoBase64
    });
    
    res.status(201).json({ ...producto, foto_url: producto.foto_base64 });
  } catch (err) {
    console.error('Inventory create error:', err);
    sendError(res, 400, err.message || 'Error creando producto');
  }
});

app.patch('/api/inventory/:id', requireStoreAuth, async (req, res) => {
  try {
    const updated = await dbServices.updateProducto(req.params.id, req.body);
    if (!updated) return sendError(res, 404, 'No encontrado');
    res.json({ ...updated, foto_url: updated.foto_base64 || updated.foto_url });
  } catch (err) {
    sendError(res, 500, 'Error actualizando');
  }
});

app.patch('/api/inventory/:id/stock', requireStoreAuth, async (req, res) => {
  try {
    const { stock } = req.body;
    if (typeof stock !== 'boolean') return sendError(res, 400, 'stock debe ser boolean');
    const updated = await dbServices.toggleProductoStock(req.params.id, stock);
    if (!updated) return sendError(res, 404, 'No encontrado');
    res.json({ ...updated, stock });
  } catch (err) {
    sendError(res, 500, 'Error actualizando stock');
  }
});

app.delete('/api/inventory/:id', requireStoreAuth, async (req, res) => {
  try {
    await dbServices.deleteProducto(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'Error eliminando');
  }
});

// ================= SUPERADMIN =================
app.post('/api/admin/login', authLimiter, vLogin, checkValidation, async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const admin = await dbServices.verifySuperAdmin(identifier, password);
    if (!admin) return sendError(res, 401, 'Credenciales inválidas');
    
    const token = jwt.sign({ aid: admin.id, type: 'superadmin' }, JWT_KEY, { expiresIn: '8h' });
    res.cookie('admin_session', token, { httpOnly: true, secure: IS_HTTPS, sameSite: IS_HTTPS ? 'none' : 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' });
    res.json({ ok: true, admin: { id: admin.id, email: admin.email, nombre: admin.nombre } });
  } catch (err) {
    sendError(res, 500, 'Error en login admin');
  }
});

app.get('/api/admin/me', requireSuperAdminAuth, async (req, res) => {
  // Verificar token
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireSuperAdminAuth, async (req, res) => {
  try {
    const stats = await dbServices.getPedidosStats();
    const ferreterias = await dbServices.getAllFerreterias();
    res.json({ ...stats, total_ferreterias: ferreterias.length });
  } catch (err) {
    sendError(res, 500, 'Error cargando stats');
  }
});

app.get('/api/admin/orders', requireSuperAdminAuth, async (req, res) => {
  try {
    const { status, limit, ferreteria_id } = req.query;
    const orders = await dbServices.getAllPedidos({ 
      status, 
      limit: limit ? parseInt(limit) : 100,
      ferreteria_id 
    });
    res.json(orders);
  } catch (err) {
    sendError(res, 500, 'Error cargando pedidos');
  }
});

app.get('/api/admin/ferreterias', requireSuperAdminAuth, async (req, res) => {
  try {
    const ferreterias = await dbServices.getAllFerreterias();
    res.json(ferreterias);
  } catch (err) {
    sendError(res, 500, 'Error cargando ferreterías');
  }
});

// ================= UPLOADS =================
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: true }));

// ================= FRONTEND =================
const FRONT_DIR = path.join(__dirname, '..');
app.use('/', express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

// 404 solo API
app.use('/api/', (req, res) => sendError(res, 404, 'Ruta API no encontrada'));

// Fallback
app.get('*', (req, res, next) => {
  const indexPath = path.join(FRONT_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(404).send('Frontend no encontrado');
  res.sendFile(indexPath, err => { if (err) next(); });
});

// Error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, 'Imagen muy pesada: máximo 5MB');
    return sendError(res, 400, 'Error subiendo: ' + err.message);
  }
  if (err?.message) {
    const status = err.status || 400;
    return sendError(res, status >= 500 ? 500 : status, err.message);
  }
  console.error(err);
  sendError(res, 500, 'Error interno');
});

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 FERREX API v2.0 en ${BASE_URL} (port ${PORT})`);
    console.log(`Uploads: ${UPLOAD_DIR}`);
  });
}

module.exports = app;