// Database layer — one interface, two engines.
//
//   Local dev (default): SQLite via Node 22+ built-in `node:sqlite`
//     (no native dependency, no server to install). File at DB_PATH.
//   Prod / docker-compose: Postgres when DATABASE_URL is set.
//
// App code NEVER writes engine-specific SQL: it calls db.all/get/run with
// `?` placeholders and db.withTransaction(fn). This module translates
// `?` -> $1, $2… for Postgres and normalises INSERT ids.
//
// Concurrency note: stock safety comes from the DB transaction, not from
// this file — see the conditional UPDATE in server/app.js:
//   UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?
// That UPDATE is atomic: two concurrent orders for the last unit cannot
// both succeed, on either engine.
const fs = require('fs');
const path = require('path');

const isPostgres = Boolean(process.env.DATABASE_URL);
let sqliteDb = null;
let pgPool = null;

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// --- Schema (kept in sync across engines; types differ only where needed) ---
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  spice_level TEXT NOT NULL DEFAULT 'medium',
  veg INTEGER NOT NULL DEFAULT 1, image_emoji TEXT NOT NULL DEFAULT '🫙',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  size_label TEXT NOT NULL, price_paise INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id, size_label)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, pincode TEXT NOT NULL,
  delivery_slot TEXT NOT NULL DEFAULT 'tomorrow-morning',
  payment_method TEXT NOT NULL, status TEXT NOT NULL,
  subtotal_paise INTEGER NOT NULL, gst_paise INTEGER NOT NULL,
  delivery_fee_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL,
  razorpay_order_id TEXT, razorpay_payment_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  variant_id INTEGER NOT NULL, product_name TEXT NOT NULL,
  size_label TEXT NOT NULL, unit_price_paise INTEGER NOT NULL,
  qty INTEGER NOT NULL, line_total_paise INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, order_id INTEGER NOT NULL,
  response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS processed_payments (
  razorpay_payment_id TEXT PRIMARY KEY, order_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  spice_level TEXT NOT NULL DEFAULT 'medium',
  veg INT NOT NULL DEFAULT 1, image_emoji TEXT NOT NULL DEFAULT '🫙',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS variants (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  size_label TEXT NOT NULL, price_paise INT NOT NULL, stock INT NOT NULL DEFAULT 0,
  UNIQUE(product_id, size_label)
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, pincode TEXT NOT NULL,
  delivery_slot TEXT NOT NULL DEFAULT 'tomorrow-morning',
  payment_method TEXT NOT NULL, status TEXT NOT NULL,
  subtotal_paise INT NOT NULL, gst_paise INT NOT NULL,
  delivery_fee_paise INT NOT NULL, total_paise INT NOT NULL,
  razorpay_order_id TEXT, razorpay_payment_id TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  variant_id INT NOT NULL, product_name TEXT NOT NULL,
  size_label TEXT NOT NULL, unit_price_paise INT NOT NULL,
  qty INT NOT NULL, line_total_paise INT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, order_id INT NOT NULL,
  response_json TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS processed_payments (
  razorpay_payment_id TEXT PRIMARY KEY, order_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function openSqlite(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sqliteDb.exec(SQLITE_SCHEMA);
}

function openPg() {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
}

// Generic query surface: { all, get, run } — each works on either engine.
function makeClient(executor) {
  return {
    all: async (sql, params = []) => executor('all', sql, params),
    get: async (sql, params = []) => executor('get', sql, params),
    run: async (sql, params = []) => executor('run', sql, params),
  };
}

async function sqliteExec(kind, sql, params) {
  const stmt = sqliteDb.prepare(sql);
  if (kind === 'all') return stmt.all(...params);
  if (kind === 'get') return stmt.get(...params);
  const info = stmt.run(...params); // { changes, lastInsertRowid }
  return { changes: info.changes, id: Number(info.lastInsertRowid) || null };
}

async function pgExec(kind, sql, params, client = null) {
  const pgSql = toPgPlaceholders(sql);
  const target = client || pgPool;
  if (kind === 'run') {
    // Normalise INSERT id: append RETURNING id when the caller inserts a row.
    const isInsert = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
    const res = await target.query(isInsert ? `${pgSql} RETURNING id` : pgSql, params);
    return { changes: res.rowCount, id: res.rows[0] ? res.rows[0].id : null };
  }
  const res = await target.query(pgSql, params);
  return kind === 'all' ? res.rows : res.rows[0] || null;
}

const db = makeClient((kind, sql, params) =>
  isPostgres ? pgExec(kind, sql, params) : sqliteExec(kind, sql, params),
);

async function withTransaction(fn) {
  if (!isPostgres) {
    sqliteDb.exec('BEGIN IMMEDIATE'); // IMMEDIATE = write lock up front, so
    // two concurrent writers serialise instead of one failing with SQLITE_BUSY.
    try {
      const result = await fn(db);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      try { sqliteDb.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const tx = makeClient((kind, sql, params) => pgExec(kind, sql, params, client));
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) AS c FROM products');
  if (row && Number(row.c) > 0) return false;
  const seed = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'),
  );
  for (const p of seed.products) {
    const r = await db.run(
      'INSERT INTO products (name, description, spice_level, veg, image_emoji) VALUES (?, ?, ?, ?, ?)',
      [p.name, p.description, p.spice_level, p.veg ? 1 : 0, p.image_emoji],
    );
    for (const v of p.variants) {
      await db.run(
        'INSERT INTO variants (product_id, size_label, price_paise, stock) VALUES (?, ?, ?, ?)',
        [r.id, v.size_label, v.price_paise, v.stock],
      );
    }
  }
  return true;
}

async function initDb(dbPath) {
  if (isPostgres) {
    openPg();
    await pgPool.query(PG_SCHEMA);
  } else {
    openSqlite(dbPath || process.env.DB_PATH || './data/pickles.db');
  }
  await seedIfEmpty();
  return db;
}

async function close() {
  if (sqliteDb) { sqliteDb.close(); sqliteDb = null; }
  if (pgPool) { await pgPool.end(); pgPool = null; }
}

module.exports = { close, db, initDb, isPostgres, seedIfEmpty, withTransaction };
