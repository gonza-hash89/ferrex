/**
 * G&A Casero — Backend producción v1.5 (endurecido)
 * Pilares: secretos en .env · JWT corto + refresh httpOnly · rate-limit ·
 *          mediación total vía API · helmet + CORS restringido + firma mágica en uploads.
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

const app = express();
const PORT = Number(process.env.PORT || 3001);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';
// ---- Pilar 1: secretos centralizados, jamás en código ----
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && NODE_ENV === 'production') {
  console.error('[FATAL] JWT_SECRET no definido en producción. Abortando.');
  process.exit(1);
}
if (!JWT_SECRET) console.warn('[WARN] JWT_SECRET ausente: usando secreto efímero de desarrollo (las sesiones se invalidan al reiniciar).');
const JWT_KEY = JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ACCESS_TTL = process.env.ACCESS_TTL || '15m';   // JWT corto
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // refresh 7 días
const IS_HTTPS = BASE_URL.startsWith('https://');
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// ---- 3.3 Directorios garantizados al arrancar ----
for (const d of [UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
try { fs.accessSync(UPLOAD_DIR, fs.constants.W_OK); }
catch { console.error('[FATAL] /uploads no escribible:', UPLOAD_DIR); process.exit(1); }

// ---- Pilar 5: helmet + CORS restringido + cookies ----
app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
// Orígenes permitidos: lista explícita (CORS_ORIGIN) + origen de BASE_URL. Sin '*' + credenciales.
const CORS_LIST = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
try { CORS_LIST.push(new URL(BASE_URL).origin); } catch {}
CORS_LIST.push('http://localhost:3001', 'http://127.0.0.1:3001');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // apps móviles / curl / mismo origen
    cb(null, CORS_LIST.includes(origin.replace(/\/$/, '')));
  },
  credentials: true, maxAge: 86400
}));
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));

// ---- Pilar 3: rate limiting (express-rate-limit) ----
const apiLimiter = rateLimit({
  windowMs: 60_000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas peticiones, espera un minuto' }
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Límite de subidas alcanzado (10 por 15 min)' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos, espera 15 minutos' }
});
app.use('/api/', apiLimiter);

// ================= DB =================
function seed() {
  return {
    seq: { store: 4, product: 20, order: 24 },
    stores: [
      { id: 1, nombre: 'Ferretería Los Andes', distrito: 'Chosica', direccion: 'Jr. Lima 320', telefono: '987654321', whatsapp: '51987654321', logo: null, abierto: true, lat: -11.9434, lng: -76.6982, created_at: new Date().toISOString() },
      { id: 2, nombre: 'Ferretería San José', distrito: 'Chosica', direccion: 'Av. 28 de Julio 140', telefono: '912345678', whatsapp: '51912345678', logo: null, abierto: true, lat: -11.9381, lng: -76.7058, created_at: new Date().toISOString() },
      { id: 3, nombre: 'Ferretería El Tornillo', distrito: 'Ate', direccion: 'Av. Nicolás Ayllón 4560', telefono: '923456789', whatsapp: '51923456789', logo: null, abierto: true, lat: -12.0258, lng: -76.9718, created_at: new Date().toISOString() }
    ],
    products: [
      { id: 1, store_id: 1, nombre: 'Foco LED 9W', categoria: 'Electricidad', precio: 6.50, foto: null, emoji: '💡', stock: true, created_at: new Date().toISOString() },
      { id: 2, store_id: 1, nombre: 'Cinta aislante 3M', categoria: 'Electricidad', precio: 3.00, foto: null, emoji: '🧵', stock: true, created_at: new Date().toISOString() },
      { id: 3, store_id: 1, nombre: 'Candado Forte 40mm', categoria: 'Candados', precio: 14.00, foto: null, emoji: '🔒', stock: true, created_at: new Date().toISOString() },
      { id: 4, store_id: 1, nombre: 'Cinta teflón', categoria: 'Gasfitería', precio: 2.50, foto: null, emoji: '🩹', stock: true, created_at: new Date().toISOString() }
    ],
    orders: []
  };
}
function loadDB() {
  if (!fs.existsSync(DB_FILE)) { const s = seed(); saveDB(s); return s; }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    db.seq = db.seq || { store: 100, product: 100, order: 100 };
    db.stores = db.stores || []; db.products = db.products || []; db.orders = db.orders || [];
    db.sessions = db.sessions || [];
    // Compat: pedidos viejos "Nuevo" => "Pendiente"
    for (const o of db.orders) if (o.status === 'Nuevo') o.status = 'Pendiente';
    // Migración ubicación: backfill lat/lng en tiendas seed sin coordenadas
    const GEO_FIX = { 1: { lat: -11.9434, lng: -76.6982 }, 2: { lat: -11.9381, lng: -76.7058 } };
    let touched = false;
    for (const s of db.stores) {
      if ((s.lat === undefined || s.lat === null || s.lng === undefined || s.lng === null) && GEO_FIX[s.id]) {
        s.lat = GEO_FIX[s.id].lat; s.lng = GEO_FIX[s.id].lng; touched = true;
      }
    }
    if (touched) saveDB(db);
    // Migración catálogo: tienda Ate de ejemplo si no existe (para probar filtro por distrito)
    if (!db.stores.some(s => String(s.id) === '3' || s.nombre === 'Ferretería El Tornillo')) {
      db.stores.push({ id: 3, nombre: 'Ferretería El Tornillo', distrito: 'Ate', direccion: 'Av. Nicolás Ayllón 4560', telefono: '923456789', whatsapp: '51923456789', logo: null, abierto: true, lat: -12.0258, lng: -76.9718, created_at: new Date().toISOString() });
      db.seq.store = Math.max(Number(db.seq.store) || 4, 4);
      saveDB(db);
    }
    // Migración SEO: slug en tiendas (para URLs /tienda/:id-:slug)
    let slugged = false;
    for (const s of db.stores) {
      const want = storeSlug(s);
      if (s.slug !== want) { s.slug = want; slugged = true; }
      if (!s.horario || !validHorario(s.horario)) { s.horario = { ...DEFAULT_HORARIO }; slugged = true; }
    }
    if (slugged) saveDB(db);
    return db;
  } catch (e) {
    const bak = DB_FILE + '.corrupt-' + Date.now();
    try { fs.copyFileSync(DB_FILE, bak); } catch {}
    throw Object.assign(new Error('Base de datos corrupta, respaldo en ' + path.basename(bak)), { status: 500 });
  }
}
function saveDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ================= 3.4 Validaciones estrictas =================
const CATS = ['Electricidad', 'Gasfitería', 'Fijaciones', 'Herramientas', 'Pinturas', 'Candados', 'Ferretería'];
const PAYS = ['Efectivo', 'Yape', 'Plin'];
const DELIVERIES = ['delivery', 'recojo'];
const ORDER_STATUS = ['Pendiente', 'Aceptado', 'En Camino', 'Listo para recojo', 'Completado', 'Rechazado'];
// Transiciones legales (Rechazado solo desde Pendiente/Aceptado)
const NEXT = {
  'Pendiente': ['Aceptado', 'Rechazado'],
  'Aceptado': ['En Camino', 'Listo para recojo', 'Rechazado', 'Completado'],
  'En Camino': ['Completado'],
  'Listo para recojo': ['Completado'],
  'Completado': [], 'Rechazado': []
};
const nonEmpty = (v, max = 120) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const validPrice = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 100000; };
// Teléfono peruano: 9 dígitos que empiezan en 9
const validPeruPhone = v => typeof v === 'string' && /^9\d{8}$/.test(v.trim());
// WhatsApp: acepta 9 dígitos (auto-prefija 51) o 51 + 9 dígitos
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

// ---- Pilar 4: validación declarativa (express-validator) como primera muralla ----
// El frontend JAMstack jamás toca db.json: todo entra por aquí, se valida,
// se sanitiza y el servidor devuelve solo campos públicos (pubStore / foto_url).
function checkValidation(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return sendError(res, 400, 'Datos inválidos', errors.array().map(e => e.path ?? e.param));
}
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
  body('store_id').isInt({ min: 1 }),
  body('nombre').trim().isLength({ min: 2, max: 100 }),
  body('precio').isFloat({ gt: 0, lt: 100000 }),
  body('categoria').optional().isIn(CATS)
];
const vOrder = [
  body('store_id').isInt({ min: 1 }),
  body('items').isArray({ min: 1, max: 50 }),
  body('pay').optional().isIn(PAYS),
  body('delivery').optional().isIn(DELIVERIES),
  body('address').optional().trim().isLength({ max: 160 }),
  body('pickupName').optional().trim().isLength({ max: 80 }),
  body('note').optional().trim().isLength({ max: 280 }).escape()
];

// ================= 3.1 Uploads sanitizados =================
const MIME_TO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // NUNCA usar originalName: colisiones + path traversal. Ext derivada del mimetype real.
    const ext = MIME_TO_EXT[file.mimetype] || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
function fileFilter(req, file, cb) {
  if (!MIME_TO_EXT[file.mimetype]) return cb(new Error('Solo JPG / PNG / WEBP (máx 5MB)'));
  cb(null, true);
}
// Pilar 5: el MIME lo declara el cliente — verificar la firma real del archivo.
// Rechaza .exe/.txt renombrados a .jpg aunque pasen el fileFilter.
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

// Distancia Haversine (km) + ETA moto ~20km/h en ciudad
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1)) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1)) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const etaMin = km => Math.max(3, Math.round(km * 3));
const validLat = v => Number.isFinite(Number(v)) && Number(v) >= -90 && Number(v) <= 90;
const validLng = v => Number.isFinite(Number(v)) && Number(v) >= -180 && Number(v) <= 180;

// ================= SEO: slugs + XML =================
function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'tienda';
}
const storeSlug = s => slugify(s.nombre);
const storePath = s => `/tienda/${s.id}-${storeSlug(s)}`;
function escXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ================= Auth (scrypt, sin dependencias) + Horario =================
const DEFAULT_HORARIO = { apertura: '08:00', cierre: '20:00', dias: [1, 2, 3, 4, 5, 6] }; // Lun–Sáb
const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pass, salt, 64).toString('hex') };
}
function verifyPass(pass, salt, hash) {
  try {
    const a = Buffer.from(crypto.scryptSync(String(pass), String(salt), 64).toString('hex'));
    const b = Buffer.from(String(hash));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function validHorario(h) {
  if (typeof h !== 'object' || !h) return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.apertura || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.cierre || '')) return false;
  if (!Array.isArray(h.dias) || !h.dias.length || !h.dias.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return false;
  return true;
}
// ¿Abierto ahora? Hora de Lima (America/Lima), soporta cierre tras medianoche
function abiertoAhora(s, now = new Date()) {
  if (s.abierto === false) return false;
  const h = s.horario;
  if (!h || !validHorario(h)) return true;
  const lima = new Date(now.toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (!h.dias.includes(lima.getDay())) return false;
  const hm = String(lima.getHours()).padStart(2, '0') + ':' + String(lima.getMinutes()).padStart(2, '0');
  if (h.apertura <= h.cierre) return hm >= h.apertura && hm < h.cierre;
  return hm >= h.apertura || hm < h.cierre;
}
function horarioTxt(s) {
  const h = s.horario;
  if (!h || !validHorario(h)) return 'Horario no definido';
  const names = [...h.dias].sort().map(d => DAY_SHORT[d]).join(' ');
  return `${h.apertura}–${h.cierre} · ${names}`;
}
// Vista pública: NUNCA expone passwordHash/salt
function pubStore(s) {
  const { passwordHash, salt, ...pub } = s;
  return { ...pub, logo_url: fotoUrl(s.logo), abierto_ahora: abiertoAhora(s), horario_txt: horarioTxt(s) };
}

// ================= 1. WhatsApp: mensaje + enlace =================
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function buildWaMessage(store, order) {
  const lines = order.items.map(i => `▪ ${i.qty}x ${i.nombre} — S/ ${(i.price * i.qty).toFixed(2)}`);
  const servicio = order.delivery === 'delivery' ? 'Delivery a Domicilio 🛵' : 'Click & Collect / Recojo Gratis en Tienda 🏃';
  const destino = order.delivery === 'delivery'
    ? `📍 Dirección de entrega: ${order.address}`
    : `🙋 Recoge: ${order.pickupName || 'Cliente G&A'}`;
  const zona = order.clientZone && (order.clientZone.label || order.clientZone.distrito)
    ? `📌 Zona del cliente: ${order.clientZone.label || order.clientZone.distrito}` : null;
  return [
    `🧾 *G&A CASERO - Pedido ${order.code}*`,
    `📅 ${fmtDate(order.created_at)}`,
    `🏪 ${store.nombre} (${store.distrito})`,
    `--------------------------`,
    ...lines,
    `--------------------------`,
    `🚚 Servicio: ${servicio}`,
    destino,
    zona,
    `💳 Pago: ${order.pay} — Total: S/ ${Number(order.total).toFixed(2)}`,
    order.note ? `📝 Nota: ${order.note}` : null
  ].filter(Boolean).join('\n');
}
function waLink(number51, message) {
  return `https://wa.me/${number51}?text=${encodeURIComponent(message)}`;
}

// ================= SSE tiempo real =================
// Mapa: store_id -> Set<res>
const sseClients = new Map();
function sseSend(storeId, event, data) {
  const set = sseClients.get(String(storeId));
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) { try { res.write(payload); } catch { set.delete(res); } }
}
function broadcastOrder(order) {
  sseSend(order.store_id, 'order', order);
}

// ================= Estáticos (robusto a Root Directory del hosting) =================
// Funciona tanto si el servicio arranca en ga-casero-app/backend (recomendado:
// Root Directory = ga-casero-app, Start = npm start --prefix backend)
// como si alguien pone Root Directory = backend.
const FRONT_CANDIDATES = [
  path.join(__dirname, '..', 'frontend'),
  path.join(__dirname, 'frontend'),
  path.join(process.cwd(), 'frontend'),
  path.join(process.cwd(), '..', 'frontend')
];
const FRONT_DIR = FRONT_CANDIDATES.find(d => { try { return fs.existsSync(path.join(d, 'index.html')); } catch { return false; } }) || FRONT_CANDIDATES[0];
const FRONT_OK = (() => { try { return fs.existsSync(path.join(FRONT_DIR, 'index.html')); } catch { return false; } })();
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: true }));
app.use('/', express.static(FRONT_DIR, { extensions: ['html'] }));

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'G&A Casero API', version: '1.5.0', baseUrl: BASE_URL }));

// SSE: GET /api/orders/stream?store_id=1
app.get('/api/orders/stream', (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return sendError(res, 400, 'store_id requerido');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, store_id })}\n\n`);
  const key = String(store_id);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.get(key)?.delete(res); });
});

// ================= Tiendas (con filtro híbrido distrito / GPS) =================
app.get('/api/stores', ah(async (req, res) => {
  const db = loadDB();
  const { distrito, lat, lng } = req.query;
  let list = [...db.stores];
  // Filtro manual por distrito (insensible a mayúsculas/tildes parciales)
  if (distrito && String(distrito).trim()) {
    const d = String(distrito).trim().toLowerCase();
    list = list.filter(s => (s.distrito || '').toLowerCase() === d);
  }
  let out = list.map(s => pubStore(s));
  // Filtro GPS: ordena por distancia Haversine y agrega distance_km / eta_min
  if (lat !== undefined && lng !== undefined && String(lat) !== '' && String(lng) !== '') {
    if (!validLat(lat) || !validLng(lng)) return sendError(res, 400, 'Coordenadas inválidas');
    const la = Number(lat), ln = Number(lng);
    out = out
      .map(s => (Number.isFinite(s.lat) && Number.isFinite(s.lng)
        ? { ...s, distance_km: Math.round(haversineKm(la, ln, s.lat, s.lng) * 10) / 10, eta_min: etaMin(haversineKm(la, ln, s.lat, s.lng)) }
        : { ...s, distance_km: null, eta_min: null }))
      .sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999));
  }
  res.json(out);
}));
app.get('/api/stores/:id', ah(async (req, res) => {
  const db = loadDB();
  const s = db.stores.find(x => String(x.id) === String(req.params.id));
  if (!s) return sendError(res, 404, 'Ferretería no encontrada');
  res.json(pubStore(s));
}));
app.post('/api/stores', uploadLimiter, upload.single('logo'), vRegister, checkValidation, ah(async (req, res) => {
  const { nombre, distrito, direccion, telefono, whatsapp, lat, lng, password, apertura, cierre, dias } = req.body;
  if (!nonEmpty(nombre, 80)) return sendError(res, 400, 'Nombre de ferretería requerido (3-80 letras)', ['nombre']);
  if (String(nombre).trim().length < 3) return sendError(res, 400, 'Nombre muy corto');
  if (!nonEmpty(distrito, 60)) return sendError(res, 400, 'Distrito requerido', ['distrito']);
  if (telefono && String(telefono).trim() && !validPeruPhone(String(telefono))) return sendError(res, 400, 'Celular peruano inválido: 9 dígitos que empiecen en 9', ['telefono']);
  if (!password || String(password).length < 6) return sendError(res, 400, 'Contraseña requerida (mínimo 6 caracteres)', ['password']);
  let wa = null;
  if (whatsapp && String(whatsapp).trim()) {
    wa = normalizeWhatsapp(String(whatsapp));
    if (!wa) return sendError(res, 400, 'WhatsApp inválido: usa 9 dígitos (ej. 987654321) o 51987654321', ['whatsapp']);
  }
  let la = null, ln = null;
  if ((lat !== undefined && String(lat) !== '') || (lng !== undefined && String(lng) !== '')) {
    if (!validLat(lat) || !validLng(lng)) return sendError(res, 400, 'Coordenadas inválidas (lat -90..90, lng -180..180)', ['lat', 'lng']);
    la = Number(lat); ln = Number(lng);
  }
  // Horario de atención (opcional; por defecto Lun–Sáb 08:00–20:00)
  let horario = { ...DEFAULT_HORARIO };
  if (apertura !== undefined || cierre !== undefined || dias !== undefined) {
    let dArr = horario.dias;
    if (dias !== undefined) {
      try { dArr = typeof dias === 'string' ? JSON.parse(dias) : dias; } catch { return sendError(res, 400, 'Días inválidos', ['dias']); }
      dArr = (Array.isArray(dArr) ? dArr : [dArr]).map(Number);
    }
    horario = { apertura: apertura || horario.apertura, cierre: cierre || horario.cierre, dias: dArr };
    if (!validHorario(horario)) return sendError(res, 400, 'Horario inválido (HH:MM y días 0=Dom..6=Sáb)', ['horario']);
  }
  const db = loadDB();
  const tel = String(telefono || '').replace(/\D/g, '');
  if (tel && db.stores.some(s => s.telefono === tel)) return sendError(res, 400, 'Ese celular ya está registrado, inicia sesión', ['telefono']);
  if (rejectFakeImage(req.file)) return sendError(res, 400, 'El archivo no es una imagen válida (firma JPG/PNG/WEBP)');
  const nombreClean = String(nombre).trim();
  const { salt, hash } = hashPass(String(password));
  const s = {
    id: db.seq.store++,
    nombre: nombreClean,
    slug: slugify(nombreClean),
    distrito: String(distrito).trim(),
    direccion: String(direccion || '').trim().slice(0, 160),
    telefono: tel,
    whatsapp: wa || (tel ? normalizeWhatsapp(tel) : null),
    logo: req.file ? req.file.filename : null,
    passwordHash: hash, salt,
    horario,
    abierto: true, lat: la, lng: ln, created_at: new Date().toISOString()
  };
  const token = issueRefresh(db, s.id);
  db.stores.push(s); saveDB(db);
  setRefreshCookie(res, token);
  res.status(201).json({ ...pubStore(s), accessToken: signAccess(s.id) });
}));

// ---- Pilar 2: JWT corto + refresh rotativo en cookie httpOnly ----
function signAccess(storeId) {
  return jwt.sign({ sid: storeId }, JWT_KEY, { expiresIn: ACCESS_TTL });
}
function sha256(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function issueRefresh(db, storeId) {
  const raw = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ hash: sha256(raw), store_id: storeId, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString() });
  return raw;
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
    req.authStoreId = Number(payload.sid);
    return next();
  } catch {
    return sendError(res, 401, 'Sesión vencida, vuelve a entrar');
  }
}

// ---- Sesión ferretera ----
app.post('/api/auth/login', authLimiter, vLogin, checkValidation, ah(async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!nonEmpty(String(identifier || ''), 40) || !password) return sendError(res, 400, 'Celular y contraseña requeridos');
  const db = loadDB();
  const idf = String(identifier).replace(/\D/g, '');
  const s = db.stores.find(x => x.telefono === idf || x.whatsapp === idf || x.whatsapp === ('51' + idf) || String(x.id) === String(identifier).trim());
  if (!s || !s.passwordHash || !verifyPass(password, s.salt, s.passwordHash)) {
    // Tiendas seed sin clave: invitar al registro
    if (s && !s.passwordHash) return sendError(res, 401, 'Esta tienda aún no tiene contraseña, regístrala de nuevo con clave');
    return sendError(res, 401, 'Celular o contraseña incorrectos');
  }
  const token = issueRefresh(db, s.id);
  saveDB(db);
  setRefreshCookie(res, token);
  res.json({ accessToken: signAccess(s.id), store: pubStore(s) });
}));
app.post('/api/auth/refresh', authLimiter, ah(async (req, res) => {
  const raw = req.cookies?.ga_refresh || req.body?.refreshToken;
  if (!raw) return sendError(res, 401, 'Sin sesión, vuelve a entrar');
  const db = loadDB();
  const ses = db.sessions.find(x => x.hash === sha256(raw));
  if (!ses) return sendError(res, 401, 'Sesión inválida');
  if (new Date(ses.expires_at) < new Date()) {
    db.sessions = db.sessions.filter(x => x.hash !== ses.hash); saveDB(db);
    return sendError(res, 401, 'Sesión vencida, vuelve a entrar');
  }
  // Rotación: el refresh usado muere, se emite uno nuevo
  db.sessions = db.sessions.filter(x => x.hash !== ses.hash);
  const next = issueRefresh(db, ses.store_id);
  saveDB(db);
  setRefreshCookie(res, next);
  res.json({ accessToken: signAccess(ses.store_id) });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  const raw = req.cookies?.ga_refresh || req.body?.refreshToken || bearer(req);
  if (raw) {
    const db = loadDB();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(x => x.hash !== sha256(raw) && x.token !== raw);
    if (db.sessions.length !== before) saveDB(db);
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
}));
// La ferretería edita SU ficha: horario, abierto, datos de contacto
app.patch('/api/stores/:id', requireStoreAuth, ah(async (req, res) => {
  if (Number(req.params.id) !== Number(req.authStoreId)) return sendError(res, 403, 'Solo puedes editar tu ferretería');
  const db = loadDB();
  const s = db.stores.find(x => x.id === Number(req.params.id));
  if (!s) return sendError(res, 404, 'Ferretería no encontrada');
  const b = req.body || {};
  if (b.nombre !== undefined) {
    if (!nonEmpty(b.nombre, 80)) return sendError(res, 400, 'Nombre inválido', ['nombre']);
    s.nombre = String(b.nombre).trim(); s.slug = slugify(s.nombre);
  }
  if (b.distrito !== undefined) {
    if (!nonEmpty(b.distrito, 60)) return sendError(res, 400, 'Distrito inválido', ['distrito']);
    s.distrito = String(b.distrito).trim();
  }
  if (b.direccion !== undefined) s.direccion = String(b.direccion).slice(0, 160);
  if (b.telefono !== undefined) {
    if (String(b.telefono).trim() && !validPeruPhone(String(b.telefono))) return sendError(res, 400, 'Celular inválido', ['telefono']);
    s.telefono = String(b.telefono).replace(/\D/g, '');
  }
  if (b.whatsapp !== undefined) {
    if (!String(b.whatsapp).trim()) s.whatsapp = null;
    else { const wa = normalizeWhatsapp(String(b.whatsapp)); if (!wa) return sendError(res, 400, 'WhatsApp inválido', ['whatsapp']); s.whatsapp = wa; }
  }
  if (b.abierto !== undefined) {
    if (typeof b.abierto !== 'boolean') return sendError(res, 400, 'abierto debe ser true/false', ['abierto']);
    s.abierto = b.abierto;
  }
  if (b.horario !== undefined) {
    if (!validHorario(b.horario)) return sendError(res, 400, 'Horario inválido (apertura/cierre HH:MM, dias 0–6)', ['horario']);
    s.horario = { apertura: b.horario.apertura, cierre: b.horario.cierre, dias: [...b.horario.dias] };
  }
  if (b.lat !== undefined || b.lng !== undefined) {
    if (!validLat(b.lat) || !validLng(b.lng)) return sendError(res, 400, 'Coordenadas inválidas', ['lat', 'lng']);
    s.lat = Number(b.lat); s.lng = Number(b.lng);
  }
  if (b.newPassword !== undefined) {
    if (String(b.newPassword).length < 6) return sendError(res, 400, 'Nueva contraseña mín. 6 caracteres', ['newPassword']);
    const { salt, hash } = hashPass(String(b.newPassword));
    s.salt = salt; s.passwordHash = hash;
  }
  s.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(pubStore(s));
}));

// ================= Productos =================
app.get('/api/products', ah(async (req, res) => {
  const db = loadDB();
  const { store_id, q, cat, only_stock } = req.query;
  let list = [...db.products];
  if (store_id) list = list.filter(p => String(p.store_id) === String(store_id));
  if (cat && cat !== 'Todo') list = list.filter(p => p.categoria === cat);
  if (q) list = list.filter(p => p.nombre.toLowerCase().includes(String(q).toLowerCase()));
  if (only_stock === '1') list = list.filter(p => p.stock);
  res.json(list.map(p => ({ ...p, foto_url: fotoUrl(p.foto) })));
}));
app.post('/api/products', requireStoreAuth, uploadLimiter, upload.single('foto'), vProduct, checkValidation, ah(async (req, res) => {
  const { store_id, nombre, precio, categoria, emoji } = req.body;
  if (!store_id) return sendError(res, 400, 'store_id requerido', ['store_id']);
  if (Number(store_id) !== Number(req.authStoreId)) return sendError(res, 403, 'Solo puedes publicar en tu ferretería');
  if (!nonEmpty(nombre, 100) || String(nombre).trim().length < 2) return sendError(res, 400, 'Nombre del producto requerido (mín 2 letras)', ['nombre']);
  if (!validPrice(precio)) return sendError(res, 400, 'Precio debe ser mayor a 0', ['precio']);
  if (categoria && !CATS.includes(String(categoria))) return sendError(res, 400, `Categoría inválida. Usa: ${CATS.join(', ')}`, ['categoria']);
  const db = loadDB();
  if (!db.stores.find(s => String(s.id) === String(store_id))) return sendError(res, 404, 'Tienda no existe');
  if (rejectFakeImage(req.file)) return sendError(res, 400, 'El archivo no es una imagen válida (firma JPG/PNG/WEBP)');
  const p = {
    id: db.seq.product++, store_id: Number(store_id),
    nombre: String(nombre).trim(),
    categoria: String(categoria || 'Ferretería'),
    precio: Math.round(Number(precio) * 100) / 100,
    foto: req.file ? req.file.filename : null,
    emoji: req.file ? null : (String(emoji || '📦').slice(0, 4)),
    stock: true, created_at: new Date().toISOString()
  };
  db.products.unshift(p); saveDB(db);
  res.status(201).json({ ...p, foto_url: fotoUrl(p.foto) });
}));
app.patch('/api/products/:id', requireStoreAuth, ah(async (req, res) => {
  const db = loadDB();
  const p = db.products.find(x => String(x.id) === String(req.params.id));
  if (!p) return sendError(res, 404, 'Producto no encontrado');
  if (p.store_id !== Number(req.authStoreId)) return sendError(res, 403, 'Ese producto es de otra ferretería');
  if (typeof req.body.stock === 'boolean') p.stock = req.body.stock;
  if (req.body.precio !== undefined) {
    if (!validPrice(req.body.precio)) return sendError(res, 400, 'Precio debe ser mayor a 0', ['precio']);
    p.precio = Math.round(Number(req.body.precio) * 100) / 100;
  }
  if (req.body.nombre !== undefined) {
    if (!nonEmpty(req.body.nombre, 100)) return sendError(res, 400, 'Nombre inválido', ['nombre']);
    p.nombre = String(req.body.nombre).trim();
  }
  saveDB(db);
  res.json({ ...p, foto_url: fotoUrl(p.foto) });
}));
app.delete('/api/products/:id', requireStoreAuth, ah(async (req, res) => {
  const db = loadDB();
  const i = db.products.findIndex(x => String(x.id) === String(req.params.id));
  if (i < 0) return sendError(res, 404, 'Producto no existe');
  if (db.products[i].store_id !== Number(req.authStoreId)) return sendError(res, 403, 'Ese producto es de otra ferretería');
  const [del] = db.products.splice(i, 1);
  if (del.foto) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(del.foto))); } catch {} }
  saveDB(db);
  res.json({ ok: true });
}));

// ================= Pedidos =================
app.get('/api/orders', ah(async (req, res) => {
  const db = loadDB();
  let list = [...db.orders].reverse();
  if (req.query.store_id) list = list.filter(o => String(o.store_id) === String(req.query.store_id));
  if (req.query.status) list = list.filter(o => o.status === req.query.status);
  res.json(list);
}));
app.post('/api/orders', vOrder, checkValidation, ah(async (req, res) => {
  const { store_id, items, total, pay, address, pickupName, delivery, note, clientZone } = req.body;
  if (!store_id) return sendError(res, 400, 'store_id requerido', ['store_id']);
  if (!Array.isArray(items) || items.length === 0) return sendError(res, 400, 'Pedido vacío: agrega productos', ['items']);
  if (items.length > 50) return sendError(res, 400, 'Máximo 50 líneas por pedido');
  for (const [idx, it] of items.entries()) {
    if (!nonEmpty(it.nombre, 100)) return sendError(res, 400, `Ítem ${idx + 1}: nombre inválido`, ['items']);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) return sendError(res, 400, `Ítem ${idx + 1}: cantidad 1-99`, ['items']);
    if (!(Number(it.price) >= 0)) return sendError(res, 400, `Ítem ${idx + 1}: precio inválido`, ['items']);
  }
  if (pay && !PAYS.includes(pay)) return sendError(res, 400, 'Método de pago inválido (Efectivo/Yape/Plin)', ['pay']);
  const del = delivery || 'delivery';
  if (!DELIVERIES.includes(del)) return sendError(res, 400, 'delivery inválido', ['delivery']);
  if (del === 'delivery' && !nonEmpty(address, 160)) return sendError(res, 400, 'Dirección de entrega requerida', ['address']);
  if (del === 'recojo' && address && !nonEmpty(address, 160)) return sendError(res, 400, 'Dirección inválida', ['address']);
  const db = loadDB();
  const store = db.stores.find(s => String(s.id) === String(store_id));
  if (!store) return sendError(res, 404, 'Ferretería no existe');
  const clean = items.map(i => ({ product_id: Number(i.product_id) || null, nombre: String(i.nombre).trim().slice(0, 100), qty: i.qty, price: Math.round(Number(i.price) * 100) / 100 }));
  const sub = clean.reduce((a, i) => a + i.price * i.qty, 0);
  // Zona del cliente (módulo ubicación híbrida): valida y sanea sin bloquear el pedido
  let zone = null;
  if (clientZone && typeof clientZone === 'object') {
    const label = String(clientZone.label || clientZone.distrito || '').trim().slice(0, 120);
    if (label) {
      zone = { label };
      if (typeof clientZone.distrito === 'string' && clientZone.distrito.trim()) zone.distrito = clientZone.distrito.trim().slice(0, 60);
      if (validLat(clientZone.lat) && validLng(clientZone.lng)) { zone.lat = Number(clientZone.lat); zone.lng = Number(clientZone.lng); }
      if (clientZone.mode === 'gps' || clientZone.mode === 'manual') zone.mode = clientZone.mode;
    }
  }
  const order = {
    id: db.seq.order++, code: '#GA-' + (1000 + db.seq.order),
    store_id: Number(store_id), items: clean,
    subtotal: Math.round(sub * 100) / 100,
    total: total !== undefined ? Math.round(Number(total) * 100) / 100 : Math.round(sub * 100) / 100,
    pay: pay || 'Efectivo', address: String(address || '').trim().slice(0, 160),
    pickupName: String(pickupName || '').trim().slice(0, 80),
    delivery: del, note: String(note || '').trim().slice(0, 280),
    clientZone: zone,
    status: 'Pendiente', created_at: new Date().toISOString()
  };
  if (!(order.total > 0)) return sendError(res, 400, 'Total inválido', ['total']);
  db.orders.push(order); saveDB(db);
  const msg = buildWaMessage(store, order);
  const whatsapp_url = store.whatsapp ? waLink(store.whatsapp, msg) : null;
  broadcastOrder(order);
  res.status(201).json({ ...order, whatsapp_url, whatsapp_message: msg });
}));
app.patch('/api/orders/:id', requireStoreAuth, ah(async (req, res) => {
  const db = loadDB();
  const o = db.orders.find(x => String(x.id) === String(req.params.id));
  if (!o) return sendError(res, 404, 'Pedido no existe');
  if (o.store_id !== Number(req.authStoreId)) return sendError(res, 403, 'Ese pedido es de otra ferretería');
  const st = req.body.status;
  if (!st) return sendError(res, 400, 'status requerido');
  if (!ORDER_STATUS.includes(st)) return sendError(res, 400, `Estado inválido. Usa: ${ORDER_STATUS.join(', ')}`);
  // Compat legado
  if (o.status === 'Nuevo') o.status = 'Pendiente';
  if (o.status !== st && !(NEXT[o.status] || []).includes(st)) {
    // Permitir corrección: Rechazado no puede salir; Completado es final
    return sendError(res, 400, `Transición inválida: ${o.status} → ${st}. Permitido: ${(NEXT[o.status] || []).join(', ') || 'ninguna'}`);
  }
  o.status = st; saveDB(db);
  broadcastOrder(o);
  res.json(o);
}));

// ================= SEO: sitemap.xml dinámico + robots.txt =================
const SEO_STATIC = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/catalogo', priority: '0.9', changefreq: 'daily' },
  { path: '/ferreterias', priority: '0.8', changefreq: 'weekly' },
  { path: '/nosotros', priority: '0.5', changefreq: 'monthly' },
  { path: '/como-funciona', priority: '0.5', changefreq: 'monthly' },
  { path: '/privacidad', priority: '0.3', changefreq: 'monthly' },
  { path: '/terminos', priority: '0.3', changefreq: 'monthly' },
  { path: '/devoluciones', priority: '0.3', changefreq: 'monthly' }
];
const SEO_DISTRICTS = ['Chosica', 'Ate', 'Chaclacayo', 'San Juan de Lurigancho', 'Santa Anita', 'Santa Clara', 'Ricardo Palma', 'Lurigancho'];
const todayISO = () => new Date().toISOString().slice(0, 10);

app.get('/sitemap.xml', ah(async (req, res) => {
  const db = loadDB();
  const urls = [];
  for (const p of SEO_STATIC) urls.push({ loc: BASE_URL + p.path, lastmod: todayISO(), changefreq: p.changefreq, priority: p.priority });
  // Distritos: unión de fijos + los que existan en DB (landing pages locales)
  const dists = [...new Set([...SEO_DISTRICTS, ...db.stores.map(s => s.distrito).filter(Boolean)])];
  for (const d of dists) urls.push({ loc: `${BASE_URL}/distrito/${slugify(d)}`, lastmod: todayISO(), changefreq: 'daily', priority: '0.8' });
  // Ferreterías activas
  for (const s of db.stores.filter(s => s.abierto !== false)) {
    urls.push({
      loc: BASE_URL + storePath(s),
      lastmod: (s.created_at || new Date().toISOString()).slice(0, 10),
      changefreq: 'daily', priority: '0.7'
    });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url>\n    <loc>${escXml(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
    `\n</urlset>`;
  res.header('Content-Type', 'text/xml; charset=utf-8');
  res.header('Cache-Control', 'public, max-age=3600');
  res.send(xml);
}));

app.get('/robots.txt', (req, res) => {
  res.header('Content-Type', 'text/plain; charset=utf-8');
  res.send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /uploads/\n\nSitemap: ${BASE_URL}/sitemap.xml\n`
  );
});

// 404 solo API
app.use('/api/', (req, res) => sendError(res, 404, 'Ruta API no encontrada'));
// Fallback web (DESPUÉS de la API): sirve el frontend o error claro si falta
app.get('*', (req, res, next) => {
  if (!FRONT_OK) return res.status(404).send(
    '<h1>G&A Casero: frontend no encontrado en el servidor</h1>' +
    '<p>Revisa el <b>Root Directory</b> del servicio: debe ser la carpeta <b>ga-casero-app</b> ' +
    '(que contiene <b>backend/</b> y <b>frontend/</b>), con Start Command <b>npm start --prefix backend</b>.</p>');
  res.sendFile(path.join(FRONT_DIR, 'index.html'), err => { if (err) next(); });
});
// Error handler final → JSON estándar
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, 'Imagen muy pesada: máximo 5MB');
    return sendError(res, 400, 'Error al subir imagen: ' + err.message);
  }
  if (err && err.message) {
    const status = err.status || 400;
    if (err.message.includes('Solo JPG')) return sendError(res, 400, err.message);
    return sendError(res, status >= 500 ? 500 : status, err.message);
  }
  console.error(err);
  return sendError(res, 500, 'Error interno del servidor');
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`G&A Casero API + Web en ${BASE_URL} (port ${PORT})`);
    console.log(`Frontend: ${FRONT_DIR} ${FRONT_OK ? 'OK' : '⚠ FALTA index.html — revisa Root Directory'}`);
    console.log(`Uploads: ${UPLOAD_DIR}`);
  });
}
module.exports = app;
