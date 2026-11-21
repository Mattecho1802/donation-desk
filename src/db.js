// Database layer. The whole database lives in ONE file (donations.db).
// We use sql.js (SQLite compiled to WebAssembly) so nothing needs compiling
// on Windows. The database is kept in memory and written to disk after
// every change (written to a temp file first, then renamed, so a crash
// can never leave a half-written file).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

let SQL = null;
let db = null;
let dbFile = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_salt   TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  salutation TEXT,
  first_name TEXT,
  surname    TEXT,
  address    TEXT,
  postcode   TEXT,
  email      TEXT,
  phone      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Amounts are stored in PENCE (whole numbers) to avoid rounding errors.
-- donor_id becomes NULL if a donor is erased on request (GDPR); the money
-- record stays for the accounts but no longer identifies anyone.
CREATE TABLE IF NOT EXISTS donations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id     INTEGER,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  date         TEXT NOT NULL,          -- YYYY-MM-DD
  note         TEXT,
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  voided_at    TEXT,
  voided_by    INTEGER,
  void_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations(donor_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  user_id INTEGER,
  action  TEXT NOT NULL,
  details TEXT
);
`;

function now() {
  return new Date().toISOString();
}

async function open(file) {
  dbFile = file;
  SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
  });
  if (fs.existsSync(file)) {
    db = new SQL.Database(fs.readFileSync(file));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  save();
}

function save() {
  const data = db.export();
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, dbFile);
}

// --- tiny query helpers -------------------------------------------------
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) {
  return all(sql, params)[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
}
function lastId() {
  return get('SELECT last_insert_rowid() AS id').id;
}
// Run several statements as one all-or-nothing change, then save to disk.
function transaction(fn) {
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    save();
    return result;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function audit(userId, action, details) {
  run('INSERT INTO audit_log (at, user_id, action, details) VALUES (?,?,?,?)', [
    now(), userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// --- settings -----------------------------------------------------------
function getSettings() {
  const out = {};
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

// --- users / PINs -------------------------------------------------------
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}
function hasUsers() {
  return get('SELECT COUNT(*) AS n FROM users').n > 0;
}
function listUsers() {
  return all('SELECT id, name, is_admin, active FROM users ORDER BY name');
}
function createUser(name, pin, isAdmin, byUserId) {
  name = String(name || '').trim();
  if (!name) throw new Error('Please enter a name.');
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4 to 8 digits.');
  if (get('SELECT id FROM users WHERE name = ?', [name])) throw new Error('A user with that name already exists.');
  const salt = crypto.randomBytes(16).toString('hex');
  return transaction(() => {
    run('INSERT INTO users (name, pin_salt, pin_hash, is_admin, created_at) VALUES (?,?,?,?,?)', [
      name, salt, hashPin(pin, salt), isAdmin ? 1 : 0, now(),
    ]);
    const id = lastId();
    audit(byUserId ?? id, 'user.create', { id, name, isAdmin: !!isAdmin });
    return id;
  });
}
function checkLogin(userId, pin) {
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1', [userId]);
  if (!u) return null;
  const a = Buffer.from(hashPin(pin, u.pin_salt), 'hex');
  const b = Buffer.from(u.pin_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: u.id, name: u.name, isAdmin: !!u.is_admin };
}

// --- donors -------------------------------------------------------------
const DONOR_FIELDS = ['salutation', 'first_name', 'surname', 'address', 'postcode', 'email', 'phone'];

function cleanDonorField(field, value) {
  let v = value == null ? '' : String(value).trim();
  if (field === 'postcode') v = v.toUpperCase().replace(/\s+/g, ' ');
  if (field === 'email') {
    v = v.toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('That email address doesn\'t look right.');
  }
  if (field === 'phone') {
    v = v.replace(/[^\d+ ]/g, '');
  }
  return v || null;
}

// Each donor row includes the two calculated totals (voided donations excluded).
const DONOR_SELECT = `
  SELECT d.*,
    COALESCE(SUM(CASE WHEN n.voided_at IS NULL AND n.date >= date('now','localtime','-12 months') THEN n.amount_pence END), 0) AS last_year_pence,
    COALESCE(SUM(CASE WHEN n.voided_at IS NULL THEN n.amount_pence END), 0) AS total_pence
  FROM donors d
  LEFT JOIN donations n ON n.donor_id = d.id
`;

function listDonors() {
  return all(DONOR_SELECT + ' GROUP BY d.id ORDER BY d.surname COLLATE NOCASE, d.first_name COLLATE NOCASE');
}
function getDonor(id) {
  return get(DONOR_SELECT + ' WHERE d.id = ? GROUP BY d.id', [id]);
}
function createDonor(data, userId) {
  const values = DONOR_FIELDS.map((f) => cleanDonorField(f, data[f]));
  if (!values[1] && !values[2]) throw new Error('Please enter at least a first name or surname.');
  return transaction(() => {
    run(`INSERT INTO donors (${DONOR_FIELDS.join(',')}, created_at, updated_at) VALUES (${DONOR_FIELDS.map(() => '?').join(',')}, ?, ?)`, [
      ...values, now(), now(),
    ]);
    const id = lastId();
    audit(userId, 'donor.create', { id });
    return getDonor(id);
  });
}
function updateDonorField(id, field, value, userId) {
  if (!DONOR_FIELDS.includes(field)) throw new Error('That column can\'t be edited.');
  const v = cleanDonorField(field, value);
  return transaction(() => {
    run(`UPDATE donors SET ${field} = ?, updated_at = ? WHERE id = ?`, [v, now(), id]);
    audit(userId, 'donor.update', { id, field });
    return getDonor(id);
  });
}
// GDPR erasure: the donor's personal details are permanently removed.
// Their donations stay (for the accounts) but are no longer linked to anyone.
function eraseDonor(id, userId) {
  return transaction(() => {
    run('UPDATE donations SET donor_id = NULL WHERE donor_id = ?', [id]);
    run('DELETE FROM donors WHERE id = ?', [id]);
    audit(userId, 'donor.erase', { id });
    return true;
  });
}

module.exports = {
  open, save, getSettings, setSetting, transaction, audit,
  hasUsers, listUsers, createUser, checkLogin,
  listDonors, getDonor, createDonor, updateDonorField, eraseDonor,
  get dbFile() { return dbFile; },
};
