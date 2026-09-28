# Galaxy SMS — approved light release

**28 September 2026 • Complete replacement source, not a partial overlay**

## Implemented

- White/light-gray surfaces, blue actions and gray table/card headings across all 13 HTML entry files. Main login is a narrow centered card with rounded inputs and a green sign-in button. Secondary login pages use the shared light theme.
- Approved supplied black-on-white Galaxy image used for the active logo and favicon, without redrawing or changing aspect ratio. Dark selection controls removed; old dark preferences no longer select dark mode. Legal-use dialog and runtime toast/progress presentation updated as well.
- Consolidated shared presentation in `assets/galaxy.css`. Retired PowerX presentation files and redundant light/rebrand stylesheets removed after checking active references.
- Dashboard shortcuts point to existing sections; existing clocks, chart periods and data remain. Agent Self Allocate uses the existing endpoint. No Agent CLI Search, Daily Bonus, Notification/Trusted, Return-to-parent, sending action or persistent bulk-allocation history added.
- Credit Notes in Admin, Manager, Agent and Payment are **read-only live ledger settlement statements**, NOT issued accounting documents. GET `/api/payment-v2/credit-notes` reads existing `payment_ledger` entries only. Agent requires the existing Security PIN; Manager sees direct-child Agents, matching existing payments scope; Admin sees existing payment scope. Client access is denied.
- Decimal totals are calculated with string/BigInt arithmetic. Eligibility uses stored `eligible_at`; maturity and ledger/request status remain separate. Unknown historical currency and weekly sub-term are not invented. Filters use stored cycle-start dates. CSV exports only the current page. No schema, credit issuance, payment mutation or historical repricing added.

## Preservation checks

Baseline SHA-256 comparison: existing backend files unchanged **except `backend/server.js`, whose only phase change is mounting the new endpoint**. Existing schema, DB layer, HTTP/SMPP processing, rate limiters, auth/PIN/Complaints modules, payments and allocation logic were not changed. All baseline SQLite/WAL/SHM files, package manifests and `.env.example` match baseline. All **91 active Nova backups** match their recorded hashes. User uploads/reference material retained.

The repository was already dirty before this phase. Consult the included Git baseline/final reports and phase hash delta rather than attributing every Git modification/deletion to this release. No reset, staging or commit was performed.

Phase hash delta (excluding generated release metadata): **4 added, 20 modified, 11 deleted** project files. Final Git status includes the earlier dirty tree and retained untracked evidence: **30 modified, 32 deleted, 59 untracked files** (`--untracked-files=all`). Exact paths are in `release/git-final.txt`; this count is not the phase delta. The archive contains **153 source/documentation/manifest files**.


## Actual verification — isolated fixtures, not production certification

| Check | Result |
|---|---|
| Credit Notes unit/query tests | 10 passed: exact decimals, scopes, IDOR denial, date/maturity filters, paging, invalid inputs, no writes |
| Real running-backend API checks | 11 passed: auth, Client denial, Agent PIN and scoped access, Admin/Manager scope, exact totals, no ledger mutations, Self Allocate ranges, HTTP ingestion/deduplication |
| Existing security/Complaints suite | 6 passed; temporary database and mock auth harness |
| SMPP | Local bind_transceiver, submit_sm acknowledgement and one stored record passed against isolated service |
| Additional live checks | Payment statement direct route/mobile width and real Agent self-allocation of one fixture number passed |
| Browser viewport sweep | 13 entries × 4 widths (1440/1024/768/390) = 52 cases; no document overflow, no theme buttons, light presentation. Management exception below |
| Browser interactions | 29 recorded successful checks: role statement data/filter/CSV/empty state, 16 existing shortcut routes, main login password visibility/captcha/auth/redirect |
| Syntax | Changed standalone JS and all inline HTML scripts checked with Node |

Desktop/mobile screenshots and logs are in the separate verification bundle. Fixture account names, numbers and earnings are synthetic. No live provider connection, production-load, simultaneous-throughput or sustained-capacity claim is made. The HTTP/SMPP checks are functional smoke checks, not performance benchmarks. The limiter remains in place; repeated test logins hit its limit, and the isolated test process was restarted without changing limiter code.

### Remaining issues / limits

1. **Pre-existing Management error retained:** `renderAlloc` reads `.value` from a missing element during `loadRates`. It reproduces in baseline and current source at all tested widths. Not fixed because functional Management changes were outside approval. Its presence prevents calling the entire suite clean.
2. Older `tests/verify-self-allocate-and-readability.js` stopped early when its created range lookup returned undefined (`self_alloc_enabled`, line 212). Its log is included; it is **not** counted as a pass. The direct real Self Allocate range and allocation checks above passed separately. Several historical tests expect retired dark/Chat features; these are not all current release gates.
3. Main login was exercised end-to-end; secondary logins were rendered/responsively reviewed but their complete auth workflows were not independently exhaustively retested. All payment mutations, proof uploads, allocation combinations and production integrations were not exhaustively retested in this phase; their backend source is unchanged.
4. No new ledger snapshot exists for historical currency or exact weekly sub-term. The statement deliberately reports this limitation.
5. Production deployment and production user acceptance have not been performed. Test servers have been stopped.

## Cleanup and remaining files

**33 verified obsolete files removed, 16,264,628 bytes (15.51 MiB) gross removed.** This is removed file size, not net filesystem savings after creating release packages, test tools or evidence.

- Removed redundant legacy theme/logo/mobile icons with no active references; exclusive old APK-update/chat-conversation tests; obsolete root distribution ZIP/TAR/APK packages; six-file discontinued external Chat/mobile copy.
- Kept `backend/chat.js`, `assets/chat.js` and compatibility aliases because PIN/Complaints use them.
- Kept mixed Chat/PIN/security tests and the shared-module deployment checker conservatively. Old SQLite test targets, user uploads, active Nova backups and historical reference/review evidence were not deleted.
- `release/deletions.json` records every removed path, size, SHA-256 and reason. Outside-project package deletions are workspace cleanup, not instructions to delete similarly named production files.
- Historical reports and `visual-rebrand/` evidence remain in the workspace; they are not current test evidence. Visual review artifacts, databases, secrets, uploads, dependencies, `.git` and old audit result data are excluded from the source archive, not automatically deleted from deployment.

## Safe deployment / preservation manifest

**Never delete the production directory or use an unreviewed `rsync --delete`.** The archive is complete application source; omitted runtime data must survive deployment.

1. Record the current deployment path, process manager, Node version, environment and storage configuration. Make a verified recoverable backup of source, config, uploads and database using SQLite's online backup facilities or a properly quiesced service. Do not copy a live main DB without accounting for WAL.
2. Extract the archive to a **new sibling release directory**, not over the running instance. Review `release/source-manifest.json`, `release/phase-delta.json`, baseline/final Git reports and the deletion manifest.
3. Preserve and reconnect the existing `.env`/secret files, `DB_FILE`/`DATA_DIR`, `backend/data.sqlite` (and any WAL/SHM state if doing an offline move), production uploads/payment screenshots, provider/carrier/SMPP configuration, backup location, proxy/TLS config, process-manager config and permissions. Preserve active Nova backups and all user number-supply/import files. Do not initialize an empty replacement DB by mistake.
4. Run `npm ci` with Node 20+ in the new release directory. Do not run historical mutation tests against production. The new unit test `node tests/credit-notes.test.js` uses an in-memory DB.
5. For staging verification use a separate database/environment and disable external provider activity. Review the known Management issue before production acceptance.
6. For in-place deployment, copy only reviewed source files. Remove only the obsolete **project-relative** entries explicitly listed in the deletion manifest, after confirming the same paths are obsolete on that deployment. Do not turn the manifest into a wildcard cleanup of backups or uploads.
7. Restart through the existing process manager, preserving API/sync roles and HTTP/SMPP settings. Confirm login, all role dashboards, numbers/allocation, reports, PIN/Complaints, Payment and Credit Notes. Check real inbound traffic, logs and backup jobs without load-testing production.
8. Roll back by switching source release back while retaining the same persistent storage/configuration. This feature adds no schema migration; never overwrite a newer production database with a stale test/rollback copy.

The archive supplies `.env.example`, not production credentials. No isolated fixture database, test session token or PIN-unlock token is shipped.
