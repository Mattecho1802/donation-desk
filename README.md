# Donation Desk

A Windows desktop app for logging in-person donations at the Gurdwara desk
and issuing receipts. It runs on one computer and keeps all data in a local
file. It does **not** take payments; card and cash are handled separately.

Donor data is never stored in this repository. It lives only on the desk PC in
`C:\Users\<you>\AppData\Roaming\Donation Desk\donations.db`.

## Status

- [x] Step 1: first-run setup, staff PIN login, auto-lock, editable donor table (sort, filter, GDPR erase)
- [x] Step 2: desk screen with typo-tolerant search, quick-add donor with duplicate warning, £5/£10/£15/Other, date, note, Gift Aid declarations and per-donation Gift Aid
- [x] Settings: organisation name, charity number, Gift Aid declaration wording
- [ ] Step 3: receipts (A4 print / email / none), sequential receipt numbers, email outbox for offline
- [ ] Donations log with void + audit trail, donor history
- [ ] Staff user management
- [ ] CSV export, HMRC Gift Aid claim export, one-click backup

## Run it from the code (developers)

Needs [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start
```

## Build the Windows installer

```bash
npm run dist:win
```

This needs `makensis` (NSIS) installed. The result is `dist/Donation-Desk-Setup-<version>.exe`.

## Code layout

| File | What it does |
|------|--------------|
| `src/main.js` | Starts the app, owns the logged-in user, connects the window to the database |
| `src/db.js` | **All** database code. See `docs/DATABASE.md` for moving to a shared database later |
| `src/preload.js` | The functions the window is allowed to call |
| `src/renderer/` | The screens (HTML, CSS, JavaScript) |
| `build/` | Windows installer script |
