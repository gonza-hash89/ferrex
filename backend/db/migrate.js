const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const migrations = [
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`,
  
  `-- Ferreterías`,
  `CREATE TABLE IF NOT EXISTS ferreterias (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre VARCHAR(200) NOT NULL,
    ruc_dni VARCHAR(20),
    zona VARCHAR(100),
    telefono VARCHAR(20),
    whatsapp VARCHAR(20),
    direccion TEXT,
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    password_hash TEXT NOT NULL,
    apertura TIME DEFAULT '08:00',
    cierre TIME DEFAULT '20:00',
    dias_atencion INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6],
    abierta BOOLEAN DEFAULT true,
    logo_url TEXT,
    creada_en TIMESTAMPTZ DEFAULT NOW(),
    actualizada_en TIMESTAMPTZ DEFAULT NOW()
  );`,
  
  `-- Productos`,
  `CREATE TABLE IF NOT EXISTS productos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ferreteria_id UUID NOT NULL REFERENCES ferreterias(id) ON DELETE CASCADE,
    codigo VARCHAR(50),
    nombre VARCHAR(200) NOT NULL,
    categoria VARCHAR(100),
    precio DECIMAL(10,2) NOT NULL,
    precio_oferta DECIMAL(10,2),
    stock_qty INTEGER DEFAULT 0,
    stock BOOLEAN DEFAULT true,
    foto_base64 TEXT,
    foto_url TEXT,
    categoria_enum VARCHAR(50),
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    actualizada_en TIMESTAMPTZ DEFAULT NOW()
  );`,
  
  `-- Pedidos`,
  `CREATE TABLE IF NOT EXISTS pedidos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    codigo VARCHAR(20) UNIQUE NOT NULL,
    ferreteria_id UUID NOT NULL REFERENCES ferreterias(id) ON DELETE CASCADE,
    cliente_nombre VARCHAR(200),
    cliente_telefono VARCHAR(20),
    cliente_direccion TEXT,
    cliente_zona JSONB,
    items JSONB NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    envio_costo DECIMAL(10,2) NOT NULL,
    total DECIMAL(10,2) NOT NULL,
    pago VARCHAR(50) NOT NULL,
    delivery VARCHAR(20) NOT NULL,
    pickup_name VARCHAR(200),
    estado VARCHAR(30) DEFAULT 'Pendiente',
    whatsapp_url TEXT,
    whatsapp_message TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    actualizada_en TIMESTAMPTZ DEFAULT NOW()
  );`,
  
  `-- Sesiones`,
  `CREATE TABLE IF NOT EXISTS sesiones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ferreteria_id UUID NOT NULL REFERENCES ferreterias(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    expira_en TIMESTAMPTZ NOT NULL,
    creada_en TIMESTAMPTZ DEFAULT NOW()
  );`,
  
  `-- SuperAdmins`,
  `CREATE TABLE IF NOT EXISTS superadmins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(200) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nombre VARCHAR(200),
    activo BOOLEAN DEFAULT true,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  );`,
  
  `-- Índices`,
  `CREATE INDEX IF NOT EXISTS idx_ferreterias_zona ON ferreterias(zona);`,
  `CREATE INDEX IF NOT EXISTS idx_productos_ferreteria ON productos(ferreteria_id);`,
  `CREATE INDEX IF NOT EXISTS idx_productos_stock ON productos(stock) WHERE stock = true;`,
  `CREATE INDEX IF NOT EXISTS idx_pedidos_ferreteria ON pedidos(ferreteria_id);`,
  `CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);`,
  `CREATE INDEX IF NOT EXISTS idx_pedidos_creado ON pedidos(creado_en DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_sesiones_token ON sesiones(refresh_token_hash);`,
  
  `-- Trigger para actualizada_en`,
  `CREATE OR REPLACE FUNCTION actualizar_timestamp()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.actualizada_en = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;`,
  
  `DROP TRIGGER IF EXISTS trigger_ferreterias_update ON ferreterias;`,
  `CREATE TRIGGER trigger_ferreterias_update BEFORE UPDATE ON ferreterias FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();`,
  `DROP TRIGGER IF EXISTS trigger_productos_update ON productos;`,
  `CREATE TRIGGER trigger_productos_update BEFORE UPDATE ON productos FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();`,
  `DROP TRIGGER IF EXISTS trigger_pedidos_update ON pedidos;`,
  `CREATE TRIGGER trigger_pedidos_update BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Ejecutando migraciones...');
    for (const migration of migrations) {
      await client.query(migration);
    }
    console.log('✅ Migraciones completadas');
    
    // Crear superadmin por defecto
    const bcrypt = require('bcryptjs');
    const exists = await pool.query('SELECT 1 FROM superadmins WHERE email = $1', ['admin@ferrex.pe']);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash('FerrexAdmin2024!', 12);
      await pool.query(
        'INSERT INTO superadmins (email, password_hash, nombre) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        ['admin@ferrex.pe', hash, 'Super Administrador']
      );
      console.log('✅ SuperAdmin creado: admin@ferrex.pe / FerrexAdmin2024!');
    }
  } catch (error) {
    console.error('❌ Error en migración:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();