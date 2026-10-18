const db = require('./pool');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('crypto');

// Utilidad para generar códigos de pedido
function generateOrderCode() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FX${year}${month}${day}-${random}`;
}

// ==================== FERRETERÍAS ====================
async function createFerreteria(data) {
  const {
    nombre, ruc_dni, zona, telefono, whatsapp, direccion,
    lat, lng, password, apertura, cierre, dias_atencion
  } = data;
  
  const passwordHash = await bcrypt.hash(password, 12);
  
  const result = await db.query(`
    INSERT INTO ferreterias (nombre, ruc_dni, zona, telefono, whatsapp, direccion, lat, lng, password_hash, apertura, cierre, dias_atencion)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [nombre, ruc_dni, zona, telefono, whatsapp, direccion, lat, lng, passwordHash, apertura, cierre, dias_atencion]);
  
  return result.rows[0];
}

async function getFerreteriaById(id) {
  const result = await db.query('SELECT * FROM ferreterias WHERE id = $1', [id]);
  return result.rows[0];
}

async function getFerreteriaByPhone(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  const result = await db.query(`
    SELECT * FROM ferreterias 
    WHERE telefono = $1 OR whatsapp = $1 OR telefono = $2 OR whatsapp = $2
  `, [cleanPhone, phone]);
  return result.rows[0];
}

async function updateFerreteria(id, data) {
  const fields = [];
  const values = [];
  let paramCount = 1;
  
  const allowedFields = ['nombre', 'ruc_dni', 'zona', 'telefono', 'whatsapp', 'direccion', 'lat', 'lng', 'apertura', 'cierre', 'dias_atencion', 'abierta', 'logo_url'];
  
  for (const [key, value] of Object.entries(data)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }
  
  if (fields.length === 0) return null;
  
  values.push(id);
  const query = `UPDATE ferreterias SET ${fields.join(', ')}, actualizada_en = NOW() WHERE id = $${paramCount} RETURNING *`;
  const result = await db.query(query, values);
  return result.rows[0];
}

async function verifyFerreteriaPassword(ferreteria, password) {
  return bcrypt.compare(password, ferreteria.password_hash);
}

async function getFerreteriasByZona(zona) {
  const result = await db.query('SELECT * FROM ferreterias WHERE zona = $1 AND abierta = true ORDER BY nombre', [zona]);
  return result.rows;
}

async function getAllFerreterias() {
  const result = await db.query('SELECT * FROM ferreterias ORDER BY creada_en DESC');
  return result.rows;
}

// ==================== PRODUCTOS ====================
async function createProducto(data) {
  const {
    ferreteria_id, codigo, nombre, categoria, precio, precio_oferta,
    stock_qty, stock, foto_base64, categoria_enum
  } = data;
  
  const result = await db.query(`
    INSERT INTO productos (ferreteria_id, codigo, nombre, categoria, precio, precio_oferta, stock_qty, stock, foto_base64, categoria_enum)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [ferreteria_id, codigo, nombre, categoria, precio, precio_oferta, stock_qty || 0, stock !== false, null, categoria_enum]);
  
  return result.rows[0];
}

async function getProductosByFerreteria(ferreteriaId, onlyStock = true) {
  let query = 'SELECT * FROM productos WHERE ferreteria_id = $1';
  if (onlyStock) query += ' AND stock = true';
  query += ' ORDER BY categoria, nombre';
  const result = await db.query(query, [ferreteriaId]);
  return result.rows;
}

async function getProductoById(id) {
  const result = await db.query('SELECT * FROM productos WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateProducto(id, data) {
  const fields = [];
  const values = [];
  let paramCount = 1;
  
  const allowedFields = ['codigo', 'nombre', 'categoria', 'precio', 'precio_oferta', 'stock_qty', 'stock', 'foto_base64', 'foto_url', 'categoria_enum'];
  
  for (const [key, value] of Object.entries(data)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }
  
  if (fields.length === 0) return null;
  
  values.push(id);
  const query = `UPDATE productos SET ${fields.join(', ')}, actualizada_en = NOW() WHERE id = $${paramCount} RETURNING *`;
  const result = await db.query(query, values);
  return result.rows[0];
}

async function toggleProductoStock(id, stock) {
  const result = await db.query(`
    UPDATE productos SET stock = $1, actualizada_en = NOW() WHERE id = $2 RETURNING *
  `, [stock, id]);
  return result.rows[0];
}

async function deleteProducto(id) {
  const result = await db.query('DELETE FROM productos WHERE id = $1 RETURNING *', [id]);
  return result.rows[0];
}

async function getProductosByIds(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const result = await db.query(`SELECT * FROM productos WHERE id IN (${placeholders})`, ids);
  return result.rows;
}

// ==================== PEDIDOS ====================
async function createPedido(data) {
  const codigo = generateOrderCode();
  const {
    ferreteria_id, items, subtotal, envio_costo, total,
    pago, delivery, address, pickup_name, client_zone, cliente_nombre, cliente_telefono
  } = data;
  
  const result = await db.query(`
    INSERT INTO pedidos (codigo, ferreteria_id, cliente_nombre, cliente_telefono, cliente_direccion, cliente_zona, items, subtotal, envio_costo, total, pago, delivery, pickup_name, cliente_zona)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *
  `, [
    codigo, ferreteria_id, data.cliente_nombre || null, data.cliente_telefono || null,
    address, null, JSON.stringify(items), subtotal, data.envio_costo || 0,
    total, pago, delivery, pickup_name, JSON.stringify(client_zone)
  ]);
  
  return result.rows[0];
}

async function getPedidoById(id) {
  const result = await db.query('SELECT * FROM pedidos WHERE id = $1', [id]);
  return result.rows[0];
}

async function getPedidosByFerreteria(ferreteriaId, estado = null) {
  let query = 'SELECT * FROM pedidos WHERE ferreteria_id = $1';
  const params = [ferreteriaId];
  
  if (estado) {
    query += ' AND estado = $2';
    params.push(estado);
  }
  query += ' ORDER BY creado_en DESC';
  
  const result = await db.query(query, params);
  return result.rows;
}

async function getAllPedidos(filters = {}) {
  let query = 'SELECT p.*, f.nombre as ferreteria_nombre FROM pedidos p JOIN ferreterias f ON p.ferreteria_id = f.id';
  const conditions = [];
  const params = [];
  let paramCount = 1;
  
  if (filters.ferreteria_id) {
    conditions.push(`p.ferreteria_id = $${paramCount}`);
    params.push(filters.ferreteria_id);
    paramCount++;
  }
  if (filters.estado) {
    conditions.push(`p.estado = $${paramCount}`);
    params.push(filters.estado);
    paramCount++;
  }
  if (filters.desde) {
    conditions.push(`p.creado_en >= $${paramCount}`);
    params.push(filters.desde);
    paramCount++;
  }
  if (filters.hasta) {
    conditions.push(`p.creado_en <= $${paramCount}`);
    params.push(filters.hasta);
    paramCount++;
  }
  
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY p.creado_en DESC';
  
  if (filters.limit) {
    query += ` LIMIT $${paramCount}`;
    params.push(filters.limit);
  }
  
  const result = await db.query(query, params);
  return result.rows;
}

async function updatePedidoEstado(id, estado) {
  const result = await db.query(`
    UPDATE pedidos SET estado = $1, actualizada_en = NOW() WHERE id = $2 RETURNING *
  `, [estado, id]);
  return result.rows[0];
}

async function getPedidosStats(ferreteriaId = null) {
  let query = `
    SELECT 
      COUNT(*) as total_pedidos,
      COUNT(*) FILTER (WHERE estado = 'Pendiente') as pendientes,
      COUNT(*) FILTER (WHERE estado = 'Aceptado') as aceptados,
      COUNT(*) FILTER (WHERE estado = 'En Camino') as en_camino,
      COUNT(*) FILTER (WHERE estado = 'Completado') as completados,
      COUNT(*) FILTER (WHERE estado = 'Rechazado') as rechazados,
      COALESCE(SUM(total) FILTER (WHERE estado != 'Rechazado'), 0) as total_ventas,
      COALESCE(SUM(envio_costo) FILTER (WHERE estado != 'Rechazado'), 0) as total_envios
    FROM pedidos
  `;
  const params = [];
  
  if (ferreteriaId) {
    query += ' WHERE ferreteria_id = $1';
    params.push(ferreteriaId);
  }
  
  const result = await db.query(query, params);
  return result.rows[0];
}

// ==================== SESIONES ====================
async function createSession(ferreteriaId, refreshToken) {
  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiraEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días
  
  await db.query(`
    INSERT INTO sesiones (ferreteria_id, refresh_token_hash, expira_en)
    VALUES ($1, $2, $3)
  `, [ferreteriaId, tokenHash, expiraEn]);
  
  return refreshToken;
}

async function validateSession(refreshToken) {
  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  
  const result = await db.query(`
    SELECT s.*, f.* FROM sesiones s
    JOIN ferreterias f ON s.ferreteria_id = f.id
    WHERE s.refresh_token_hash = $1 AND s.expira_en > NOW()
  `, [hash]);
  
  return result.rows[0] || null;
}

async function deleteSession(refreshToken) {
  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await db.query('DELETE FROM sesiones WHERE refresh_token_hash = $1', [tokenHash]);
}

async function cleanExpiredSessions() {
  await db.query('DELETE FROM sesiones WHERE expira_en < NOW()');
}

// ==================== SUPERADMIN ====================
async function verifySuperAdmin(email, password) {
  const result = await db.query('SELECT * FROM superadmins WHERE email = $1 AND activo = true', [email]);
  const admin = result.rows[0];
  if (!admin) return null;
  
  const bcrypt = require('bcryptjs');
  const valid = await bcrypt.compare(password, admin.password_hash);
  return valid ? admin : null;
}

async function createSuperAdmin(email, password, nombre) {
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await db.query(`
    INSERT INTO superadmins (email, password_hash, nombre)
    VALUES ($1, $2, $3)
    RETURNING id, email, nombre, creado_en
  `, [email, passwordHash, nombre]);
  return result.rows[0];
}

module.exports = {
  createFerreteria,
  getFerreteriaById,
  getFerreteriaByPhone,
  updateFerreteria,
  verifyFerreteriaPassword,
  getFerreteriasByZona,
  getAllFerreterias,
  createProducto,
  getProductosByFerreteria,
  getProductoById,
  updateProducto,
  toggleProductoStock,
  deleteProducto,
  getProductosByIds,
  createPedido,
  getPedidoById,
  getPedidosByFerreteria,
  getAllPedidos,
  updatePedidoEstado,
  getPedidosStats,
  createSession,
  validateSession,
  deleteSession,
  cleanExpiredSessions,
  verifySuperAdmin,
  createSuperAdmin,
};