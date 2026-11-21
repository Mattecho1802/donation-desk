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
  for (const el of $$('[data-admin-only]')) el.hidden = !state.user.isAdmin;
  // Always start on the Desk tab after logging in
  $('.tab[data-tab=desk]').click();
  fillSettingsForm();
  showScreen('main');
  if (!donorTable) buildDonorTable();
  loadDonors();
  resetDesk();
  call(window.api.lastReceipt).then(showLastReceipt).catch(() => {});
}

// ---------- tabs ----------
for (const btn of $$('.tab')) {
  btn.addEventListener('click', () => {
    for (const b of $$('.tab')) b.classList.toggle('active', b === btn);
    for (const p of $$('.tab-panel')) p.hidden = p.id !== 'tab-' + btn.dataset.tab;
    if (btn.dataset.tab === 'donors' && donorTable) donorTable.redraw(true);
    if (btn.dataset.tab === 'desk' && !desk.donor) searchInput.focus();
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
    title, field, hozAlign: 'right', sorter: 'number', cssClass: 'readonly', width: 115,
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
        width: 90,
        editor: 'list',
        editorParams: { values: SALUTATIONS, autocomplete: true, freetext: true, allowEmpty: true, listOnEmpty: true },
      }),
      text('First name', 'first_name', { minWidth: 110 }),
      text('Surname', 'surname', { minWidth: 110 }),
      text('Address', 'address', { minWidth: 150 }),
      text('Postcode', 'postcode', { width: 100 }),
      text('Email', 'email', { minWidth: 150 }),
      text('Phone', 'phone', { width: 125 }),
      {
        title: 'Gift Aid', field: 'ga_declared_on', width: 90, cssClass: 'readonly',
        headerFilter: 'list', headerFilterParams: { values: { yes: 'Yes', no: 'No', due: 'Check due' }, clearable: true },
        headerFilterFunc: (v, _rv, row) => v === 'yes' ? row.ga_active : v === 'no' ? !row.ga_active : v === 'due' ? row.ga_check_due : true,
        sorter: (_a, _b, ra, rb) => Number(ra.getData().ga_active) - Number(rb.getData().ga_active),
        formatter: (cell) => {
          const r = cell.getRow().getData();
          return r.ga_check_due ? 'Check due' : r.ga_active ? 'Yes' : 'No';
        },
        headerTooltip: 'Gift Aid declarations are taken on the Desk screen.',
      },
      moneyCol('Last 12 months', 'last_year_pence'),
      moneyCol('Total donated', 'total_pence'),
      {
        title: '', field: 'id', width: 80, headerSort: false, hozAlign: 'center',
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

// ---------- Gift Aid wording ----------
// The wording is set by an admin on the Settings tab.
function gaWording() {
  return state.settings.ga_declaration;
}

// ---------- settings tab ----------
const settingsForm = $('#settings-form');
function fillSettingsForm() {
  for (const k of ['org_name', 'charity_number', 'ga_declaration', 'org_address', 'org_phone', 'org_email', 'receipt_footer']) {
    settingsForm.elements[k].value = state.settings[k] || '';
  }
  settingsForm.elements.print_silent.checked = state.settings.print_silent === '1';
  $('[data-error]', settingsForm).textContent = '';
}
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const values = formData(settingsForm);
    values.print_silent = settingsForm.elements.print_silent.checked ? '1' : '0';
    await call(window.api.saveSettings, values);
    await refreshState();
    fillSettingsForm();
    toast('Settings saved');
  } catch (ex) { $('[data-error]', settingsForm).textContent = ex.message; }
});
function fillGaWording() {
  for (const el of $$('[data-ga-wording]')) el.textContent = gaWording();
}

// ---------- add donor dialog (used by Donors tab and the Desk) ----------
const donorDialog = $('#donor-dialog');
const donorForm = $('#donor-form');
let onDonorSaved = null;      // callback when a donor is saved or picked
let dupesChecked = false;     // true once the user has seen the duplicate warning

function openDonorDialog(prefill = {}, onSaved = null) {
  donorForm.reset();
  for (const [k, v] of Object.entries(prefill)) if (donorForm.elements[k]) donorForm.elements[k].value = v;
  $('[data-error]', donorForm).textContent = '';
  $('[data-dupes]', donorForm).hidden = true;
  $('[data-save]', donorForm).textContent = 'Save donor';
  dupesChecked = false;
  onDonorSaved = onSaved;
  fillGaWording();
  donorDialog.showModal();
  (prefill.first_name ? donorForm.elements.surname : donorForm.elements.salutation).focus();
}
// Typing again after a duplicate warning means we should check again.
donorForm.addEventListener('input', (e) => {
  if (e.target.name !== 'gift_aid_declaration') { dupesChecked = false; $('[data-save]', donorForm).textContent = 'Save donor'; }
});

$('#add-donor-btn').addEventListener('click', () => openDonorDialog({}, (donor) => {
  donorTable.addRow(donor, true);
  updateCount(donorTable.getDataCount('active'));
}));
$('[data-close]', donorForm).addEventListener('click', () => donorDialog.close());

donorForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(donorForm);
  data.gift_aid_declaration = donorForm.elements.gift_aid_declaration.checked;
  const err = $('[data-error]', donorForm);
  err.textContent = '';
  try {
    if (!dupesChecked) {
      const dupes = await call(window.api.findDuplicates, data);
      if (dupes.length) return showDupes(dupes);
    }
    const donor = await call(window.api.createDonor, data);
    donorDialog.close();
    toast('Donor added');
    if (onDonorSaved) onDonorSaved(donor);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

function showDupes(dupes) {
  const box = $('[data-dupes]', donorForm);
  box.innerHTML = '<b>This might be someone already saved:</b><ul>' + dupes.slice(0, 5).map((d) =>
    `<li>${escapeHtml(d.name || '(no name)')} — ${escapeHtml([d.postcode, d.email].filter(Boolean).join(', ') || 'no details')}
      <span class="muted">(${d.reasons.join(', ')})</span>
      <button type="button" data-use="${d.id}">Use this donor</button></li>`).join('') +
    '</ul>If it\'s a different person, click <b>Save anyway</b>.';
  box.hidden = false;
  dupesChecked = true;
  $('[data-save]', donorForm).textContent = 'Save anyway';
  for (const b of $$('[data-use]', box)) {
    b.addEventListener('click', () => {
      const d = dupes.find((x) => x.id === Number(b.dataset.use));
      donorDialog.close();
      if (onDonorSaved) onDonorSaved(d, { existing: true });
    });
  }
}

// ---------- Gift Aid declaration dialog ----------
const gaDialog = $('#ga-dialog');
let gaDonor = null;
let gaDone = null;
function openGaDialog(donor, done) {
  gaDonor = donor;
  gaDone = done;
  $('[data-ga-name]', gaDialog).textContent = donor.name;
  $('[data-error]', gaDialog).textContent = '';
  fillGaWording();
  gaDialog.showModal();
}
$('[data-close]', gaDialog).addEventListener('click', () => gaDialog.close());
$('[data-confirm]', gaDialog).addEventListener('click', async () => {
  try {
    const updated = await call(window.api.declareGiftAid, gaDonor.id);
    gaDialog.close();
    toast('Gift Aid declaration recorded');
    if (gaDone) gaDone(updated);
  } catch (ex) { $('[data-error]', gaDialog).textContent = ex.message; }
});

// ---------- DESK ----------
const desk = { donor: null, amount: null, giftAid: null, receipt: null };
const searchInput = $('#donor-search');
const resultsList = $('#search-results');
let searchResults = [];
let activeResult = -1;
let searchSeq = 0;

function todayStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function resetDesk() {
  desk.donor = null; desk.amount = null; desk.giftAid = null; desk.receipt = null;
  searchInput.value = '';
  resultsList.hidden = true;
  $('#donor-search-box').hidden = false;
  $('#donor-selected').hidden = true;
  for (const b of $$('.amount')) b.classList.remove('selected');
  $('#other-amount-box').hidden = true;
  $('#other-amount').value = '';
  $('#amount-error').textContent = '';
  $('#don-date').value = todayStr();
  $('#don-date').max = todayStr();
  $('#don-note').value = '';
  $('#desk-error').textContent = '';
  renderDesk();
  searchInput.focus();
}

searchInput.addEventListener('input', async () => {
  const seq = ++searchSeq;
  const q = searchInput.value;
  if (!q.trim()) { resultsList.hidden = true; return; }
  const results = await call(window.api.searchDonors, q);
  if (seq !== searchSeq) return; // a newer search has started
  searchResults = results;
  activeResult = results.length ? 0 : -1;
  renderResults();
});
searchInput.addEventListener('keydown', (e) => {
  if (resultsList.hidden) return;
  if (e.key === 'ArrowDown') { activeResult = Math.min(activeResult + 1, searchResults.length - 1); renderResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { activeResult = Math.max(activeResult - 1, 0); renderResults(); e.preventDefault(); }
  if (e.key === 'Enter' && searchResults[activeResult]) { selectDonor(searchResults[activeResult]); e.preventDefault(); }
  if (e.key === 'Escape') resultsList.hidden = true;
});
function renderResults() {
  if (!searchResults.length) {
    resultsList.innerHTML = '<li class="none">No match. Click “+ New donor” to add them.</li>';
  } else {
    resultsList.innerHTML = searchResults.map((d, i) => `
      <li data-i="${i}" class="${i === activeResult ? 'active' : ''}">
        <span><b>${escapeHtml(d.name || '(no name)')}</b> <span class="muted">${escapeHtml(d.postcode || '')}</span></span>
        <span class="muted">${d.ga_active ? 'Gift Aid · ' : ''}${money(d.total_pence)} total</span>
      </li>`).join('');
  }
  resultsList.hidden = false;
}
resultsList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) selectDonor(searchResults[Number(li.dataset.i)]);
});

// "+ New donor" pre-fills the name typed in the search box.
$('#desk-new-donor').addEventListener('click', () => {
  const words = searchInput.value.trim().split(/\s+/).filter(Boolean);
  const prefill = words.length > 1
    ? { first_name: words.slice(0, -1).join(' '), surname: words[words.length - 1] }
    : words.length ? { surname: words[0] } : {};
  openDonorDialog(prefill, (donor) => { selectDonor(donor); loadDonors(); });
});
$('#change-donor').addEventListener('click', () => {
  desk.donor = null; desk.giftAid = null;
  $('#donor-selected').hidden = true;
  $('#donor-search-box').hidden = false;
  renderDesk();
  searchInput.select();
  searchInput.focus();
});

function selectDonor(donor) {
  desk.donor = donor;
  desk.giftAid = null;
  resultsList.hidden = true;
  $('#donor-search-box').hidden = true;
  $('#donor-selected').hidden = false;
  renderDesk();
}

// Amount buttons
for (const b of $$('.amount')) {
  b.addEventListener('click', () => {
    for (const x of $$('.amount')) x.classList.toggle('selected', x === b);
    $('#amount-error').textContent = '';
    if (b.dataset.amount === 'other') {
      $('#other-amount-box').hidden = false;
      desk.amount = null;
      $('#other-amount').focus();
      checkOtherAmount();
    } else {
      $('#other-amount-box').hidden = true;
      desk.amount = b.dataset.amount + '.00';
    }
    renderDesk();
  });
}
// Positive, max 2 decimal places, e.g. 12.50
function checkOtherAmount() {
  const v = $('#other-amount').value.trim().replace(/^£/, '');
  const ok = /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0 && Number(v) <= 100000;
  desk.amount = ok ? Number(v).toFixed(2) : null;
  $('#amount-error').textContent = !v || ok ? '' :
    Number(v) > 100000 ? 'That amount looks too large.' : 'Enter pounds and pence, e.g. 12.50 (more than £0, up to 2 decimal places).';
  renderDesk();
}
$('#other-amount').addEventListener('input', checkOtherAmount);
$('#other-amount').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDonation(); });

// Gift Aid yes/no
for (const b of $$('[data-ga]')) {
  b.addEventListener('click', () => { desk.giftAid = b.dataset.ga === 'yes'; renderDesk(); });
}

function renderDesk() {
  const d = desk.donor;
  if (d) {
    $('#sel-name').textContent = d.name || '(no name)';
    $('#sel-details').textContent = [d.address, d.postcode, d.email, d.phone].filter(Boolean).join(' · ') || 'No contact details';
    $('#sel-totals').textContent = `Last 12 months ${money(d.last_year_pence)} · Total ${money(d.total_pence)}`;
    renderGaStatus(d);
  }
  // Gift Aid choice only possible with a valid declaration
  const canGa = !!(d && d.ga_active);
  if (!canGa) desk.giftAid = d ? false : null;
  $('#ga-choice').classList.toggle('disabled', !canGa);
  for (const b of $$('[data-ga]')) {
    b.disabled = !canGa;
    b.classList.toggle('selected', canGa && desk.giftAid === (b.dataset.ga === 'yes'));
  }
  $('#ga-choice-note').textContent = !d ? 'Choose a donor first.'
    : !canGa ? 'No Gift Aid declaration for this donor, so this donation won\'t be Gift Aided.'
    : desk.giftAid === null ? 'Please choose Yes or No.' : '';

  // Receipt: Email only if the donor has an email address saved
  const hasEmail = !!(d && d.email);
  if (desk.receipt === 'email' && !hasEmail) desk.receipt = null;
  for (const b of $$('[data-receipt]')) {
    b.disabled = !d || (b.dataset.receipt === 'email' && !hasEmail);
    b.classList.toggle('selected', desk.receipt === b.dataset.receipt);
  }
  $('#receipt-note').textContent = !d ? 'Choose a donor first.'
    : desk.receipt === 'email' ? `Will be emailed to ${d.email}. (Email sending is switched on in the next version; until then it waits in the outbox.)`
    : !hasEmail ? 'Email isn\'t available: no email address saved for this donor.' : '';

  const ready = d && desk.amount && desk.giftAid !== null && desk.receipt;
  $('#save-donation').disabled = !ready;
  $('#save-donation').textContent = { print: 'Save & print receipt', email: 'Save & email receipt' }[desk.receipt] || 'Save donation';
  $('#desk-summary').textContent = ready
    ? `£${desk.amount} from ${d.name}${desk.giftAid ? ' with Gift Aid' : ''}`
    : !d ? 'Choose a donor' : !desk.amount ? 'Choose an amount'
    : desk.giftAid === null ? 'Choose Gift Aid Yes or No' : 'Choose a receipt type';
}

for (const b of $$('[data-receipt]')) {
  b.addEventListener('click', () => { desk.receipt = b.dataset.receipt; renderDesk(); });
}

// The last receipt, with a (Re)print button, e.g. if the printer jammed
let lastReceipt = null;
function showLastReceipt(r) {
  lastReceipt = r;
  const box = $('#last-receipt');
  if (!r) { box.hidden = true; return; }
  const how = r.method === 'email'
    ? `email to ${r.email_to || '(deleted)'}: ${r.email_status}`
    : r.print_count ? 'printed' : 'not printed yet';
  box.innerHTML = `<span>Last receipt <b>${String(r.id).padStart(6, '0')}</b>: ${money(r.amount_pence)} from ${escapeHtml(r.donor_name)}
    <span class="muted">(${escapeHtml(how)})</span></span>
    <button id="reprint-btn">🖨 ${r.print_count ? 'Reprint' : 'Print'}</button>`;
  box.hidden = false;
  $('#reprint-btn').addEventListener('click', () => doPrint(r.id));
}
async function doPrint(id) {
  try {
    const r = await call(window.api.printReceipt, id);
    toast(`Receipt ${String(id).padStart(6, '0')} sent to the printer`);
    showLastReceipt(r);
  } catch (ex) {
    toast(ex.message + ' Use the Print button to try again.', true);
  }
}

function renderGaStatus(d) {
  const box = $('#ga-status');
  if (d.ga_active && d.ga_check_due) {
    box.className = 'ga-status due';
    box.innerHTML = `<div><b>Gift Aid check due.</b> Last confirmed ${fmtDate(d.ga_confirmed_on || d.ga_declared_on)}.
      Ask: <i>“Do you still pay UK Income Tax or Capital Gains Tax?”</i></div>
      <div class="buttons"><button data-act="confirm">Yes, still a taxpayer</button>
      <button data-act="cancel" class="danger">No, cancel their Gift Aid</button></div>`;
  } else if (d.ga_active) {
    box.className = 'ga-status ok';
    box.innerHTML = `<div>✓ Gift Aid declaration since ${fmtDate(d.ga_declared_on)}</div>`;
  } else {
    box.className = 'ga-status none';
    box.innerHTML = `<div>No Gift Aid declaration${d.ga_cancelled_on ? ` (cancelled ${fmtDate(d.ga_cancelled_on)})` : ''}.</div>
      <div class="buttons"><button data-act="declare">Take Gift Aid declaration</button></div>`;
  }
  for (const b of $$('[data-act]', box)) {
    b.addEventListener('click', async () => {
      try {
        if (b.dataset.act === 'declare') return openGaDialog(d, (u) => { desk.donor = u; desk.giftAid = null; renderDesk(); loadDonors(); });
        if (b.dataset.act === 'cancel' && !confirm(`Cancel ${d.name}'s Gift Aid declaration? Future donations won't be Gift Aided.`)) return;
        desk.donor = await call(b.dataset.act === 'confirm' ? window.api.confirmGiftAid : window.api.cancelGiftAid, d.id);
        toast(b.dataset.act === 'confirm' ? 'Taxpayer status confirmed' : 'Gift Aid cancelled');
        renderDesk();
        loadDonors();
      } catch (ex) { toast(ex.message, true); }
    });
  }
}

$('#save-donation').addEventListener('click', saveDonation);
async function saveDonation() {
  if ($('#save-donation').disabled) return;
  $('#save-donation').disabled = true;
  try {
    const res = await call(window.api.createDonation, {
      donorId: desk.donor.id,
      amount: desk.amount,
      date: $('#don-date').value,
      note: $('#don-note').value,
      giftAid: desk.giftAid,
      receipt: desk.receipt,
    });
    toast(`Saved: ${money(res.donation.amount_pence)} from ${res.donor.name}${res.donation.gift_aid ? ' (Gift Aid)' : ''}`);
    resetDesk();
    loadDonors();
    if (res.receipt) showLastReceipt(res.receipt);
    if (res.receipt && res.receipt.method === 'print') await doPrint(res.receipt.id);
  } catch (ex) {
    $('#desk-error').textContent = ex.message;
    renderDesk();
  }
}

function closeAllDialogs() {
  for (const d of $$('dialog')) if (d.open) d.close();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
