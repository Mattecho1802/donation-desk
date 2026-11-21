// Builds the receipt as a stand-alone HTML page (A4). The same layout is used
// for printing and (in the next step) for email receipts.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (p) => '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ukDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const receiptNo = (id) => String(id).padStart(6, '0');

// Gift Aid is 25p for every £1 donated (basic-rate tax reclaimed), rounded down to the penny.
const giftAidValue = (pence) => Math.floor(pence * 25 / 100);

function receiptHtml(r) {
  const o = r.org || {};
  const contact = [o.phone && `Tel: ${esc(o.phone)}`, o.email && esc(o.email)].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>Receipt ${receiptNo(r.id)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; font-size: 11pt; margin: 0; }
  .head { text-align: center; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .org { font-size: 17pt; font-weight: 700; letter-spacing: .3px; }
  .addr { white-space: pre-line; margin-top: 4px; }
  .small { font-size: 9.5pt; color: #333; }
  h1 { font-size: 15pt; text-align: center; margin: 22px 0 16px; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 9px 4px; border-bottom: 1px solid #ccc; vertical-align: top; }
  td.k { width: 38%; color: #444; }
  td.v { font-weight: 600; }
  .amount { font-size: 15pt; }
  .ga { margin-top: 20px; padding: 12px 14px; border: 1px solid #111; border-radius: 6px; }
  .ga b { display: block; margin-bottom: 4px; }
  .footer { margin-top: 26px; text-align: center; font-size: 12pt; }
  .tiny { margin-top: 30px; text-align: center; font-size: 8.5pt; color: #555; }
</style></head>
<body>
  <div class="head">
    <div class="org">${esc(o.name)}</div>
    ${o.address ? `<div class="addr">${esc(o.address)}</div>` : ''}
    ${contact ? `<div class="small">${contact}</div>` : ''}
    ${o.charity_number ? `<div class="small">Registered Charity No. ${esc(o.charity_number)}</div>` : ''}
  </div>

  <h1>DONATION RECEIPT</h1>

  <table>
    <tr><td class="k">Receipt number</td><td class="v">${receiptNo(r.id)}</td></tr>
    <tr><td class="k">Date of donation</td><td class="v">${ukDate(r.donation_date)}</td></tr>
    <tr><td class="k">Received with thanks from</td><td class="v">${esc(r.donor_name)}</td></tr>
    <tr><td class="k">Amount</td><td class="v amount">${money(r.amount_pence)}</td></tr>
    <tr><td class="k">Gift Aid</td><td class="v">${r.gift_aid ? 'Yes' : 'No'}</td></tr>
  </table>

  ${r.gift_aid ? `
  <div class="ga">
    <b>Gift Aid</b>
    Thanks to your Gift Aid declaration${r.ga_declared_on ? ` (made on ${ukDate(r.ga_declared_on)})` : ''},
    we can claim an extra ${money(giftAidValue(r.amount_pence))} from HMRC on this donation at no cost to you.
    Please let us know if you no longer pay enough Income Tax and/or Capital Gains Tax,
    if you change your name or home address, or if you want to cancel your declaration.
  </div>` : ''}

  ${o.footer ? `<div class="footer">${esc(o.footer)}</div>` : ''}
  <div class="tiny">This receipt confirms a donation. No goods or services were provided in return.</div>
</body></html>`;
}

module.exports = { receiptHtml, receiptNo, giftAidValue };
