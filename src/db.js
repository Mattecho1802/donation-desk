// Database layer — the ONLY file that talks to the database.
//
// Today the data lives in ONE local SQLite file (donations.db), using sql.js
// (SQLite compiled to WebAssembly, so nothing needs compiling on Windows).
// The database is held in memory and written to disk after every change
// (temp file first, then renamed, so a crash can't leave a half-written file).
//
// MOVING TO A SHARED DATABASE LATER (e.g. PostgreSQL):
//   * Everything else in the app calls the functions exported at the bottom
//     of this file and never writes SQL itself. Re-implement these functions
//     against the new database and nothing else needs to change.
//   * main.js already `await`s every call, so the new versions can be async.
//   * SQL here is kept standard: no SQLite-only date functions (dates are
//     worked out in JavaScript and passed in), money is whole pence,
//     dates are 'YYYY-MM-DD' text, timestamps are ISO-8601 text.
//   * See docs/DATABASE.md for the table list and a migration checklist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

let db = null;
let dbFile = null;

// Each entry upgrades the database by one version. New installs run them all.
// Never edit an old entry once released — add a new one instead.
const MIGRATIONS = [
  // v1: core tables
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_salt   TEXT NOT NULL,
    pin_hash   TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE donors (
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
  -- donor_id becomes NULL if a donor is erased on request (GDPR); the money
  -- record stays for the accounts but no longer identifies anyone.
  CREATE TABLE donations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_id     INTEGER,
    amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
    date         TEXT NOT NULL,
    note         TEXT,
    created_by   INTEGER,
    created_at   TEXT NOT NULL,
    voided_at    TEXT,
    voided_by    INTEGER,
    void_reason  TEXT
  );
  CREATE INDEX idx_donations_donor ON donations(donor_id);
  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    user_id INTEGER,
    action  TEXT NOT NULL,
    details TEXT
  );
  `,
  // v2: Gift Aid
  `
  ALTER TABLE donors ADD COLUMN ga_declared_on   TEXT;     -- date the declaration was taken
  ALTER TABLE donors ADD COLUMN ga_declared_by   INTEGER;  -- user who took it
  ALTER TABLE donors ADD COLUMN ga_method        TEXT;     -- 'verbal'
  ALTER TABLE donors ADD COLUMN ga_confirmed_on  TEXT;     -- last date taxpayer status was checked
  ALTER TABLE donors ADD COLUMN ga_cancelled_on  TEXT;     -- set if the donor withdraws it
  ALTER TABLE donations ADD COLUMN gift_aid      INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE donations ADD COLUMN ga_claimed_on TEXT;     -- set once included in an HMRC claim
  `,
];

// Older databases (made by version 0.1.0) already have the v1 tables but no
// version number, so detect that and skip v1.
function migrate() {
  let version = get('PRAGMA user_version').user_version;
  if (version === 0 && get("SELECT name FROM sqlite_master WHERE type='table' AND name='donors'")) version = 1;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN;' + MIGRATIONS[v] + `PRAGMA user_version = ${v + 1}; COMMIT;`);
  }
}

// ---------- dates ----------
function now() { return new Date().toISOString(); }
function today() { return localDate(new Date()); }
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return localDate(d);
}

// ---------- open / save ----------
async function open(file) {
  dbFile = file;
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
  });
  if (fs.existsSync(file)) {
    db = new SQL.Database(fs.readFileSync(file));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new SQL.Database();
  }
  migrate();
  save();
}

function save() {
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbFile);
}

// ---------- tiny query helpers ----------
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) { return all(sql, params)[0] || null; }
function run(sql, params = []) { db.run(sql, params); }
function lastId() { return get('SELECT last_insert_rowid() AS id').id; }

// Several statements as one all-or-nothing change, then saved to disk.
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
    now(), userId ?? null, action, details ? JSON.stringify(details) : null,
  ]);
}

// ---------- settings ----------
function getSettings() {
  const out = {};
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  run('DELETE FROM settings WHERE key = ?', [key]);
  run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ---------- users / PINs ----------
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}
function hasUsers() { return get('SELECT COUNT(*) AS n FROM users').n > 0; }
function listUsers() { return all('SELECT id, name, is_admin, active FROM users ORDER BY name'); }
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

// ---------- donors ----------
const DONOR_FIELDS = ['salutation', 'first_name', 'surname', 'address', 'postcode', 'email', 'phone'];

function cleanDonorField(field, value) {
  let v = value == null ? '' : String(value).trim().replace(/\s+/g, ' ');
  if (field === 'postcode') v = v.toUpperCase();
  if (field === 'email') {
    v = v.toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('That email address doesn\'t look right.');
  }
  if (field === 'phone') {
    v = v.replace(/[^\d+ ]/g, '');
    if (v && v.replace(/\D/g, '').length < 10) throw new Error('That phone number looks too short.');
  }
  return v || null;
}

// Each donor row includes the two calculated totals (voided donations excluded).
function donorSelect() {
  return {
    sql: `
      SELECT d.*,
        COALESCE(SUM(CASE WHEN n.voided_at IS NULL AND n.date >= ? THEN n.amount_pence END), 0) AS last_year_pence,
        COALESCE(SUM(CASE WHEN n.voided_at IS NULL THEN n.amount_pence END), 0) AS total_pence
      FROM donors d
      LEFT JOIN donations n ON n.donor_id = d.id`,
    params: [monthsAgo(12)],
  };
}
function decorate(d) {
  if (!d) return d;
  d.name = [d.salutation, d.first_name, d.surname].filter(Boolean).join(' ');
  d.ga_active = !!(d.ga_declared_on && !d.ga_cancelled_on);
  // Yearly reminder: check the donor still pays enough UK tax.
  d.ga_check_due = d.ga_active && (d.ga_confirmed_on || d.ga_declared_on) < monthsAgo(12);
  return d;
}
function listDonors() {
  const q = donorSelect();
  return all(q.sql + ' GROUP BY d.id ORDER BY d.surname, d.first_name', q.params).map(decorate);
}
function getDonor(id) {
  const q = donorSelect();
  return decorate(get(q.sql + ' WHERE d.id = ? GROUP BY d.id', [...q.params, id]));
}

// Likely duplicates of a new/edited donor: same email, same phone,
// same surname + postcode, or a very similar full name.
function findDuplicates(data, excludeId = null) {
  const c = {};
  for (const f of DONOR_FIELDS) {
    try { c[f] = cleanDonorField(f, data[f]); } catch { c[f] = null; }
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const fullName = norm(c.first_name) + ' ' + norm(c.surname);
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const out = [];
  for (const d of listDonors()) {
    if (d.id === excludeId) continue;
    const reasons = [];
    if (c.email && d.email === c.email) reasons.push('same email');
    if (c.phone && digits(d.phone) === digits(c.phone)) reasons.push('same phone');
    if (c.surname && c.postcode && norm(d.surname) === norm(c.surname) &&
        String(d.postcode || '').replace(/\s/g, '') === c.postcode.replace(/\s/g, '')) reasons.push('same surname and postcode');
    if ((c.first_name || c.surname) && !reasons.length) {
      const other = norm(d.first_name) + ' ' + norm(d.surname);
      if (levenshtein(fullName, other) <= (fullName.length > 8 ? 2 : 1)) reasons.push('similar name');
    }
    if (reasons.length) out.push({ ...d, reasons });
  }
  return out;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
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
    if (data.gift_aid_declaration) recordDeclarationInner(id, userId);
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
// GDPR erasure: personal details are permanently removed. Donations stay
// (for the accounts) but are no longer linked to anyone.
function eraseDonor(id, userId) {
  return transaction(() => {
    run('UPDATE donations SET donor_id = NULL WHERE donor_id = ?', [id]);
    run('DELETE FROM donors WHERE id = ?', [id]);
    audit(userId, 'donor.erase', { id });
    return true;
  });
}

// ---------- Gift Aid declarations ----------
function recordDeclarationInner(id, userId) {
  run(`UPDATE donors SET ga_declared_on = ?, ga_declared_by = ?, ga_method = 'verbal',
       ga_confirmed_on = ?, ga_cancelled_on = NULL, updated_at = ? WHERE id = ?`,
      [today(), userId, today(), now(), id]);
  audit(userId, 'giftaid.declare', { id, method: 'verbal' });
}
function recordDeclaration(id, userId) {
  return transaction(() => { recordDeclarationInner(id, userId); return getDonor(id); });
}
function confirmTaxpayer(id, userId) {
  return transaction(() => {
    run('UPDATE donors SET ga_confirmed_on = ?, updated_at = ? WHERE id = ?', [today(), now(), id]);
    audit(userId, 'giftaid.confirm', { id });
    return getDonor(id);
  });
}
function cancelDeclaration(id, userId) {
  return transaction(() => {
    run('UPDATE donors SET ga_cancelled_on = ?, updated_at = ? WHERE id = ?', [today(), now(), id]);
    audit(userId, 'giftaid.cancel', { id });
    return getDonor(id);
  });
}

// ---------- donations ----------
// amount is text in pounds, e.g. "12.50". Converted to whole pence exactly.
function parseAmount(amount) {
  const s = String(amount ?? '').trim().replace(/^£/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Enter an amount in pounds and pence, e.g. 12.50');
  const [pounds, pence = ''] = s.split('.');
  const total = Number(pounds) * 100 + Number(pence.padEnd(2, '0'));
  if (total <= 0) throw new Error('The amount must be more than £0.');
  if (total > 10000000) throw new Error('That amount looks too large (over £100,000).');
  return total;
}
function createDonation({ donorId, amount, date, note, giftAid }, userId) {
  const donor = getDonor(donorId);
  if (!donor) throw new Error('Please choose a donor.');
  const pence = parseAmount(amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Please choose a date.');
  if (date > today()) throw new Error('The date can\'t be in the future.');
  if (giftAid !== true && giftAid !== false) throw new Error('Please choose Gift Aid Yes or No.');
  if (giftAid && !donor.ga_active) throw new Error('This donor has no Gift Aid declaration.');
  return transaction(() => {
    run(`INSERT INTO donations (donor_id, amount_pence, date, note, gift_aid, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [donorId, pence, date, String(note || '').trim() || null, giftAid ? 1 : 0, userId, now()]);
    const id = lastId();
    audit(userId, 'donation.create', { id, donorId, pence, giftAid });
    return { donation: get('SELECT * FROM donations WHERE id = ?', [id]), donor: getDonor(donorId) };
  });
}

module.exports = {
  open, getSettings, setSetting, transaction, audit, today,
  hasUsers, listUsers, createUser, checkLogin,
  listDonors, getDonor, findDuplicates, createDonor, updateDonorField, eraseDonor,
  recordDeclaration, confirmTaxpayer, cancelDeclaration,
  parseAmount, createDonation,
};
