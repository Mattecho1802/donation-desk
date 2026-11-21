# Data storage

## Today: one local file

All data is in one SQLite file on the desk PC:

    C:\Users\<you>\AppData\Roaming\Donation Desk\donations.db

The app uses only this file. Nothing is sent online (apart from email receipts, added later).

## Tables

| Table       | What it holds |
|-------------|---------------|
| `settings`  | Organisation name and other settings (key/value) |
| `users`     | Staff logins. PINs are stored only as scrypt hashes |
| `donors`    | Donor contact details and Gift Aid declaration dates |
| `donations` | One row per donation. Amounts in **pence**. Voided rows are kept, never deleted |
| `audit_log` | Who did what and when (logins, edits, erasures, Gift Aid changes) |

Conventions: money = whole pence (integer), dates = `YYYY-MM-DD` text,
timestamps = ISO-8601 text, true/false = 1/0.

## Moving to a shared database later (e.g. PostgreSQL)

The app is built so this is a contained job:

1. **Only `src/db.js` talks to the database.** Everything else calls its
   exported functions (`listDonors`, `createDonation`, …). Write a new
   version of `src/db.js` with the same functions, using a PostgreSQL driver
   (`pg`). `src/main.js` already `await`s every call, so async is fine.
2. **Create the tables** in PostgreSQL. The `MIGRATIONS` list in `db.js` is
   the schema. Change `INTEGER PRIMARY KEY AUTOINCREMENT` to
   `BIGINT GENERATED ALWAYS AS IDENTITY` and `COLLATE NOCASE` to `citext`
   or a `lower()` unique index.
3. **Copy the data across** table by table, keeping the `id` values, then
   reset each identity sequence to `max(id) + 1`.
4. **Point every desk PC at the server** with a connection setting instead
   of the local file path. Keep the server on your network or a managed
   host with backups and encryption. The data is personal data under GDPR.
5. **Search** (`donors:search` in `main.js`) loads all donors and searches in
   memory. That's fine for a few thousand donors. With many more, move it
   into SQL (PostgreSQL `pg_trgm` handles typo-tolerant search).
