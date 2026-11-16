const { Pool } = require('pg');
require('dotenv').config();

// SSL automático: activo en producción o cuando la URL apunta a un host gestionado
const DB_URL = process.env.DATABASE_URL || '';
const USE_SSL = process.env.DB_SSL === 'true'
  || process.env.NODE_ENV === 'production'
  || /render\.com|neon\.tech|supabase\.co|amazonaws\.com|heroku|azure/.test(DB_URL);

const pool = new Pool({
  connectionString: DB_URL,
  ssl: USE_SSL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en pool PG:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};