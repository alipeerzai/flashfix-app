import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "../data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, "flashfix.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const isPostgres = Boolean(process.env.DATABASE_URL);
const sqlite3 = isPostgres ? null : (await import("sqlite3")).default;
export const db = isPostgres
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    })
  : new sqlite3.Database(dbPath);

function toPostgresSql(sql) {
  let i = 0;
  let converted = sql.replace(/\?/g, () => `$${++i}`);
  if (/^\s*INSERT\s+/i.test(converted) && !/\sRETURNING\s+/i.test(converted)) {
    converted += " RETURNING id";
  }
  return converted;
}

export function run(sql, params = []) {
  if (isPostgres) {
    return db.query(toPostgresSql(sql), params).then((result) => ({
      id: result.rows[0]?.id,
      changes: result.rowCount
    }));
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

export function all(sql, params = []) {
  if (isPostgres) {
    return db.query(toPostgresSql(sql), params).then((result) => result.rows);
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

export function get(sql, params = []) {
  if (isPostgres) {
    return db.query(toPostgresSql(sql), params).then((result) => result.rows[0]);
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function ensureColumn(table, column, definition) {
  const columns = isPostgres
    ? await all(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
        [table]
      )
    : await all(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function initDb() {
  const idColumn = isPostgres ? "id SERIAL PRIMARY KEY" : "id INTEGER PRIMARY KEY AUTOINCREMENT";
  const binaryColumn = isPostgres ? "BYTEA" : "BLOB";
  const timestampColumn = isPostgres ? "TIMESTAMPTZ" : "TEXT";

  await run(`CREATE TABLE IF NOT EXISTS users (
    ${idColumn},
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin'
  )`);

  await run(`CREATE TABLE IF NOT EXISTS technicians (
    ${idColumn},
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    skillset TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS customers (
    ${idColumn},
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    address TEXT NOT NULL,
    tags TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn("customers", "tags", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS jobs (
    ${idColumn},
    customer_name TEXT NOT NULL,
    service TEXT NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    technician TEXT,
    notes TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS appointments (
    ${idColumn},
    job_id INTEGER,
    technician_id INTEGER,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    window_end TEXT,
    status TEXT NOT NULL DEFAULT 'Scheduled',
    notes TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS estimates (
    ${idColumn},
    customer_name TEXT NOT NULL,
    job_id INTEGER,
    subtotal REAL NOT NULL,
    tax REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',
    valid_until TEXT,
    notes TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS estimate_items (
    ${idColumn},
    estimate_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS invoices (
    ${idColumn},
    customer_name TEXT NOT NULL,
    amount REAL NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    estimate_id INTEGER,
    notes TEXT,
    customer_signature_name TEXT,
    customer_signature_data TEXT,
    customer_signature_date TEXT,
    portal_token TEXT,
    portal_token_expires_at TEXT,
    stripe_checkout_session_id TEXT,
    stripe_checkout_url TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn("invoices", "estimate_id", "INTEGER");
  await ensureColumn("invoices", "notes", "TEXT");
  await ensureColumn("invoices", "customer_signature_name", "TEXT");
  await ensureColumn("invoices", "customer_signature_data", "TEXT");
  await ensureColumn("invoices", "customer_signature_date", "TEXT");
  await ensureColumn("invoices", "portal_token", "TEXT");
  await ensureColumn("invoices", "portal_token_expires_at", "TEXT");
  await ensureColumn("invoices", "stripe_checkout_session_id", "TEXT");
  await ensureColumn("invoices", "stripe_checkout_url", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS invoice_items (
    ${idColumn},
    invoice_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS payments (
    ${idColumn},
    invoice_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    payment_date TEXT NOT NULL,
    reference TEXT,
    stripe_checkout_session_id TEXT,
    stripe_payment_intent_id TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn("payments", "stripe_checkout_session_id", "TEXT");
  await ensureColumn("payments", "stripe_payment_intent_id", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS activity_logs (
    ${idColumn},
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    details TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS stored_files (
    ${idColumn},
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,
    data_blob ${binaryColumn} NOT NULL,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS attachments (
    ${idColumn},
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    stored_file_id INTEGER,
    mime_type TEXT,
    file_size INTEGER,
    note TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn("attachments", "stored_file_id", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS reminder_logs (
    ${idColumn},
    reminder_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    reminder_date TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    ${idColumn},
    user_id INTEGER,
    endpoint TEXT UNIQUE NOT NULL,
    subscription_json TEXT NOT NULL,
    user_agent TEXT,
    created_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ${timestampColumn} NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

export async function logActivity(actor, action, entityType, entityId, details = "") {
  await run(
    "INSERT INTO activity_logs(actor, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)",
    [actor || "system", action, entityType, entityId || null, details]
  );
}
