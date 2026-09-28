# Galaxy SMS

Current multi-role SMS panel: Admin, Manager, Agent and Client, plus Management, Sharing, Payment and the required SMS Test panel. Node.js 20+, Express and SQLite (`better-sqlite3`), HTTP inbound SMS and SMPP.

## Start here

- [Safe local GitHub update and VPS deployment guide](docs/SAFE-UPDATE.md)
- [Final workspace report](docs/FINAL-WORKSPACE.md)
- [SMPP guide](docs/SMPP-GUIDE.md)
- `release/source-manifest.json`: exact distributable source files and SHA-256 hashes.
- `release/obsolete-code-paths.txt`: explicit obsolete source paths; **not** a production cleanup script.
- `tools/sync-local-clone.py`: optional local-only source copier; dry-run by default, exact deletion allowlist, no Git/network operations.

## Application files

- Root HTML pages, `api.js`, `assets/`: current light-only UI and approved Galaxy logo.
- `backend/server.js`: existing APIs, ingress, allocations, payment handling and service startup.
- `backend/auth.js`: authentication, roles, shared PIN middleware and rate limits.
- `backend/chat.js`, `assets/chat.js`: **current PIN/Complaints**, not a standalone Chat application. Legacy filenames, route aliases and token names are retained for compatibility.
- `backend/creditNotes.js`, `assets/credit-notes.js`: the previously approved read-only live settlement statement. This final cleanup does not add or redesign it.
- `backend/db.js`, `schema.js`, `seed.js`: existing database/bootstrap behavior, unchanged during final cleanup.
- `backend/backup.js`, provider and SMPP modules: retained required services.
- `tests/credit-notes.test.js`, `tests/verify-galaxy-cleanup-and-security.js`: isolated current regression checks.
- `scripts/check-html-scripts.js`: current inline-JavaScript syntax check, not a historical UI harness.
- `deploy/`, service/watchdog/backup scripts: retained operational templates. Actual production use/configuration is unknown; do not execute unreviewed installation or maintenance scripts on an existing VPS.

Public email registration/password setup, AI Assistant, Bench Toolkit, historical UI/load/crash tools, mobile application and Chat-only interfaces are retired. Historical database tables/columns are **not dropped** to clean up feature names. Nova-named backup paths/formats remain active and must not be deleted by name.

## Local setup — never point tests at production

1. Install Node.js 20+ and run `npm ci` in a **separate local/staging copy**.
2. Configure a local `.env` from `.env.example`; use a dedicated non-production database and non-production secrets. Disable external provider/SMPP activity when appropriate.
3. Read the startup warning below before running `npm start`.
4. Safe standalone tests: `node tests/credit-notes.test.js` (in-memory database), `node tests/verify-galaxy-cleanup-and-security.js` (temporary fixture DB, mocked auth).

**Production startup warning:** application startup calls `createTables()` and `seed()` and contains existing migration/backfill/reconciliation logic. It can create/alter schema and update data. This cleanup deliberately does not change required database/business behavior. Do not assume that omitting a manual migration command prevents startup writes. Production schema/version and startup actions must be reviewed against a staging copy before deployment; any required migration needs explicit approval.

**Database resolution:** `DB_FILE`, else `DATA_DIR/data.sqlite`, else `backend/data.sqlite`. Use the verified production path—not an example, guessed fallback, or development database. A fresh code directory must not accidentally initialize a fresh production DB.

The local source workspace may contain preserved ignored database files and installed dependencies. The distributable ZIP and source manifest exclude them. `.gitignore` does not protect previously tracked runtime files from Git updates.
