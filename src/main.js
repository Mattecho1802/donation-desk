// Main process: opens the window, owns the database and the logged-in user.
// The window (renderer) can only do what is exposed in preload.js.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const db = require('./db');
const Fuse = require('fuse.js');
const fs = require('fs');
const { receiptHtml, receiptNo } = require('./receipt');

// UK formats everywhere (e.g. dates as dd/mm/yyyy), whatever the PC's language.
app.commandLine.appendSwitch('lang', 'en-GB');

let win = null;
let currentUser = null; // { id, name, isAdmin } once logged in

// Where the data file lives. On Windows this is
// C:\Users\<you>\AppData\Roaming\Donation Desk\donations.db
// (DONATION_DESK_DATA lets us point it somewhere else for testing.)
function dataDir() {
  return process.env.DONATION_DESK_DATA || app.getPath('userData');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Donation Desk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Register a handler. Unless `open` is set, the user must be logged in.
// Errors are sent back as { error } so the window can show a friendly message.
function handle(channel, fn, { open = false, admin = false } = {}) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (!open && !currentUser) throw new Error('Please log in.');
      if (admin && !currentUser.isAdmin) throw new Error('Only an admin can do that.');
      return { ok: await fn(...args) };
    } catch (e) {
      return { error: e.message };
    }
  });
}

// --- app state & login --------------------------------------------------
handle('app:state', () => ({
  needsSetup: !db.hasUsers(),
  user: currentUser,
  settings: db.getSettings(),
  users: db.listUsers().filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
}), { open: true });

handle('app:setup', ({ orgName, userName, pin }) => {
  if (db.hasUsers()) throw new Error('Setup has already been done.');
  if (!String(orgName || '').trim()) throw new Error('Please enter the organisation name.');
  const id = db.createUser(userName, pin, true, null);
  db.transaction(() => db.setSetting('org_name', String(orgName).trim()));
  currentUser = db.checkLogin(id, pin);
  return currentUser;
}, { open: true });

// Slow down guessing: after 5 wrong PINs, wait 30 seconds.
let failedLogins = 0;
let lockedUntil = 0;
handle('app:login', ({ userId, pin }) => {
  if (Date.now() < lockedUntil) throw new Error('Too many wrong PINs. Please wait 30 seconds.');
  const u = db.checkLogin(userId, pin);
  if (!u) {
    failedLogins += 1;
    if (failedLogins >= 5) { lockedUntil = Date.now() + 30000; failedLogins = 0; }
    db.transaction(() => db.audit(userId, 'login.failed'));
    throw new Error('Wrong PIN.');
  }
  failedLogins = 0;
  currentUser = u;
  db.transaction(() => db.audit(u.id, 'login'));
  return u;
}, { open: true });

handle('app:logout', () => {
  if (currentUser) db.transaction(() => db.audit(currentUser.id, 'logout'));
  currentUser = null;
  return true;
}, { open: true });

// --- settings (admins only) ---------------------------------------------
handle('settings:save', (values) => db.saveSettings(values, currentUser.id), { admin: true });

// --- donors -------------------------------------------------------------
handle('donors:list', () => db.listDonors());
handle('donors:create', (data) => db.createDonor(data, currentUser.id));
handle('donors:update', ({ id, field, value }) => db.updateDonorField(id, field, value, currentUser.id));
handle('donors:erase', (id) => db.eraseDonor(id, currentUser.id), { admin: true });
handle('donors:duplicates', (data) => db.findDuplicates(data));

// Search-as-you-type: matches partial names and tolerates small typos.
handle('donors:search', (query) => {
  const q = String(query || '').trim();
  if (!q) return [];
  const fuse = new Fuse(db.listDonors(), {
    keys: [
      { name: 'fullName', weight: 3, getFn: (d) => `${d.first_name || ''} ${d.surname || ''}` },
      { name: 'surname', weight: 2 },
      { name: 'first_name', weight: 1 },
      { name: 'postcode', weight: 1 },
      { name: 'email', weight: 1 },
      { name: 'phone', weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  });
  return fuse.search(q, { limit: 8 }).map((r) => r.item);
});

// --- Gift Aid -----------------------------------------------------------
handle('giftaid:declare', (id) => db.recordDeclaration(id, currentUser.id));
handle('giftaid:confirm', (id) => db.confirmTaxpayer(id, currentUser.id));
handle('giftaid:cancel', (id) => db.cancelDeclaration(id, currentUser.id));

// --- donations ----------------------------------------------------------
handle('donations:create', (data) => db.createDonation(data, currentUser.id));

// --- receipts -----------------------------------------------------------
// Printing loads the receipt into a hidden window and sends it to the printer.
// Normally the Windows print dialog appears; with "print without asking" on in
// Settings it goes straight to the default printer.
// (DONATION_DESK_PRINT_TO_PDF=<folder> saves PDFs instead, for testing.)
async function printReceipt(id) {
  const r = db.getReceipt(id);
  if (!r) throw new Error('Receipt not found.');
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(receiptHtml(r)));
    if (process.env.DONATION_DESK_PRINT_TO_PDF) {
      const pdf = await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
      fs.mkdirSync(process.env.DONATION_DESK_PRINT_TO_PDF, { recursive: true });
      fs.writeFileSync(path.join(process.env.DONATION_DESK_PRINT_TO_PDF, `receipt-${receiptNo(id)}.pdf`), pdf);
    } else {
      const silent = db.getSettings().print_silent === '1';
      await new Promise((resolve, reject) => {
        pw.webContents.print({ silent, printBackground: true, pageSize: 'A4' }, (ok, reason) => {
          if (ok) resolve();
          else reject(new Error(reason === 'cancelled' ? 'Printing was cancelled.' : `Printing failed (${reason}). Check the printer is on.`));
        });
      });
    }
    return db.markPrinted(id, currentUser.id);
  } finally {
    pw.destroy();
  }
}
handle('receipts:print', (id) => printReceipt(id));
handle('receipts:last', () => db.lastReceipts(1)[0] || null);

// --- start --------------------------------------------------------------
app.whenReady().then(async () => {
  await db.open(path.join(dataDir(), 'donations.db'));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
