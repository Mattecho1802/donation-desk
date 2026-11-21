// Window (renderer) code. Talks to the main process only through window.api.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;      // { needsSetup, user, settings, users }
let donorTable = null;

// ---------- helpers ----------
async function call(fn, arg) {
  const res = await fn(arg);
  if (res.error) throw new Error(res.error);
  return res.ok;
}
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}
function money(pence) {
  return '£' + (Number(pence || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function showScreen(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== 'screen-' + name;
}
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- start-up & login ----------
async function refreshState() {
  state = await call(window.api.state);
  for (const el of $$('[data-org-name]')) el.textContent = state.settings.org_name || 'Donation Desk';
}

async function boot() {
  await refreshState();
  if (state.needsSetup) return showScreen('setup');
  if (!state.user) return showLogin();
  enterApp();
}

function showLogin() {
  const sel = $('#login-form select');
  sel.innerHTML = state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  $('#login-form [name=pin]').value = '';
  $('#login-form [data-error]').textContent = '';
  showScreen('login');
  $('#login-form [name=pin]').focus();
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const err = $('[data-error]', e.target);
  if (f.pin !== f.pin2) return (err.textContent = 'The two PINs don\'t match.');
  try {
    await call(window.api.setup, { orgName: f.orgName, userName: f.userName, pin: f.pin });
    await refreshState();
    enterApp();
  } catch (ex) { err.textContent = ex.message; }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  try {
    await call(window.api.login, { userId: Number(f.userId), pin: f.pin });
    await refreshState();
    enterApp();
  } catch (ex) {
    $('[data-error]', e.target).textContent = ex.message;
    $('[name=pin]', e.target).select();
  }
});

async function lock() {
  await call(window.api.logout);
  await refreshState();
  closeAllDialogs();
  showLogin();
}
$('#lock-btn').addEventListener('click', lock);

// Auto-lock after 10 minutes with no mouse or keyboard activity.
const AUTO_LOCK_MS = 10 * 60 * 1000;
let lastActivity = Date.now();
for (const ev of ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel']) {
  window.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true });
}
setInterval(() => {
  if (state && state.user && Date.now() - lastActivity > AUTO_LOCK_MS) lock();
}, 15000);

function enterApp() {
  $('#user-name').textContent = state.user.name;
  showScreen('main');
  if (!donorTable) buildDonorTable();
  loadDonors();
}

// ---------- tabs ----------
for (const btn of $$('.tab')) {
  btn.addEventListener('click', () => {
    for (const b of $$('.tab')) b.classList.toggle('active', b === btn);
    for (const p of $$('.tab-panel')) p.hidden = p.id !== 'tab-' + btn.dataset.tab;
  });
}

// ---------- donor table ----------
const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Mx'];

function buildDonorTable() {
  const text = (title, field, extra = {}) => ({
    title, field, editor: 'input', headerFilter: 'input', headerFilterPlaceholder: 'Filter…', ...extra,
  });
  // Filter money columns with e.g. ">50", "<10" or "25"
  const moneyFilter = (filterVal, rowVal) => {
    const m = String(filterVal).trim().match(/^([<>]=?)?\s*£?\s*(\d+(?:\.\d+)?)$/);
    if (!m) return true;
    const v = rowVal / 100, n = Number(m[2]);
    switch (m[1]) {
      case '>': return v > n; case '>=': return v >= n;
      case '<': return v < n; case '<=': return v <= n;
      default: return v === n;
    }
  };
  const moneyCol = (title, field) => ({
    title, field, hozAlign: 'right', sorter: 'number', cssClass: 'readonly', width: 150,
    formatter: (cell) => money(cell.getValue()),
    headerFilter: 'input', headerFilterPlaceholder: 'e.g. >50', headerFilterFunc: moneyFilter,
    headerTooltip: 'Calculated from donation records. Not editable.',
  });

  donorTable = new Tabulator('#donor-table', {
    height: 'calc(100vh - 210px)',
    layout: 'fitColumns',
    index: 'id',
    placeholder: 'No donors yet. Click “+ Add donor” to add one.',
    columns: [
      text('Salutation', 'salutation', {
        width: 120,
        editor: 'list',
        editorParams: { values: SALUTATIONS, autocomplete: true, freetext: true, allowEmpty: true, listOnEmpty: true },
      }),
      text('First name', 'first_name', { minWidth: 130 }),
      text('Surname', 'surname', { minWidth: 130 }),
      text('Address', 'address', { minWidth: 200 }),
      text('Postcode', 'postcode', { width: 120 }),
      text('Email', 'email', { minWidth: 180 }),
      text('Phone', 'phone', { width: 140 }),
      moneyCol('Last 12 months', 'last_year_pence'),
      moneyCol('Total donated', 'total_pence'),
      {
        title: '', field: 'id', width: 90, headerSort: false, hozAlign: 'center',
        formatter: () => '<button class="row-btn danger">Erase</button>',
        cellClick: (e, cell) => { if (e.target.closest('button')) confirmErase(cell.getRow().getData()); },
      },
    ],
  });

  donorTable.on('cellEdited', async (cell) => {
    const row = cell.getRow().getData();
    const field = cell.getField();
    if ((cell.getOldValue() ?? '') === (cell.getValue() ?? '')) return;
    try {
      const updated = await call(window.api.updateDonor, { id: row.id, field, value: cell.getValue() });
      cell.getRow().update(updated); // shows the cleaned-up value, e.g. upper-case postcode
      toast('Saved');
    } catch (ex) {
      cell.restoreOldValue();
      toast(ex.message, true);
    }
  });
  donorTable.on('dataFiltered', (_f, rows) => updateCount(rows.length));
  donorTable.on('tableBuilt', loadDonors);
}

function updateCount(shown) {
  const total = donorTable.getDataCount();
  $('#donor-count').textContent = shown === total ? `${total} donor${total === 1 ? '' : 's'}` : `${shown} of ${total} shown`;
}

async function loadDonors() {
  if (!donorTable || !donorTable.initialized) return;
  try {
    const donors = await call(window.api.listDonors);
    await donorTable.replaceData(donors);
    updateCount(donorTable.getDataCount('active'));
  } catch (ex) { toast(ex.message, true); }
}

$('#clear-filters').addEventListener('click', () => donorTable.clearHeaderFilter());

async function confirmErase(donor) {
  if (!state.user.isAdmin) return toast('Only an admin can erase a donor.', true);
  const name = [donor.salutation, donor.first_name, donor.surname].filter(Boolean).join(' ');
  const ok = confirm(
    `Permanently erase ${name || 'this donor'}?\n\n` +
    'Their personal details will be deleted and cannot be recovered. ' +
    'Their donations stay in the accounts as "Deleted donor".\n\n' +
    'Use this when someone asks to be removed (GDPR).'
  );
  if (!ok) return;
  try {
    await call(window.api.eraseDonor, donor.id);
    donorTable.deleteRow(donor.id);
    updateCount(donorTable.getDataCount('active'));
    toast('Donor erased');
  } catch (ex) { toast(ex.message, true); }
}

// ---------- add donor dialog ----------
const donorDialog = $('#donor-dialog');
$('#add-donor-btn').addEventListener('click', () => {
  $('#donor-form').reset();
  $('#donor-form [data-error]').textContent = '';
  donorDialog.showModal();
  $('#donor-form [name=salutation]').focus();
});
$('#donor-form [data-close]').addEventListener('click', () => donorDialog.close());
$('#donor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const donor = await call(window.api.createDonor, formData(e.target));
    donorDialog.close();
    await donorTable.addRow(donor, true);
    updateCount(donorTable.getDataCount('active'));
    toast('Donor added');
  } catch (ex) {
    $('[data-error]', e.target).textContent = ex.message;
  }
});

function closeAllDialogs() {
  for (const d of $$('dialog')) if (d.open) d.close();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
