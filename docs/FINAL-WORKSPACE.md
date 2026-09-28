# Final clean workspace — 28 September 2026

## Scope and status

The final application source is `/home/user/Galaxy-Sms`. This finalization performed **no Git commands, GitHub/network repository operations, staging, commit, push, or VPS access**. It removes the explicitly retired local features/tools, preserves required application code and provides a code-only distribution.

**Cleanup is complete for the identified obsolete source. Production readiness is conditional, not certified:** the known Management rendering error still reproduces; startup database mutations require staging review before deployment. Do not describe this as a completely passing full-system acceptance test or a verified zero-data-loss production deployment.

## Removed

- Public registration/email-OTP/one-time password-setup feature: source/UI/routes were already absent; historical feature tests/docs are now removed too.
- AI Assistant: no active UI/module/routes; historical regression/fixture remnants removed.
- Bench Toolkit (entire standalone directory), bulk-load/20M benchmark scripts, audit/crash/load/rate-bypass runners and fixture seeders.
- Historical `visual-rebrand/` HTML snapshots/browser harnesses/results and old one-off UI, Chat/mobile and crash/reproduction tests. The external `/home/user/ui-test-tools` installation and superseded light-release distributions were also removed after verification. Current isolated regression coverage is retained separately.
- Old mobile and standalone Chat application sources/assets/packages were already removed. This pass also removes the overlooked Manager Chat navigation, dead Chat branches, Admin Chat-only Super Manager dialogs/buttons/badges and the unused Chat token issuer. Shared PIN/Complaints remain.
- Superseded root project audit/feature reports, benchmark JSON and old release/Git manifests replaced by current documentation and manifests.
- Five historical test SQLite/WAL/SHM artifacts were **relocated intact**, not destroyed, to `/home/user/finalization-audit/preserved-test-data/` outside the final source.

`release/cleanup-details.json` lists local removal/relocation reasons, sizes and hashes for this finalization. `release/obsolete-code-paths.txt` combines known obsolete code paths from this and previous inspected cleanup; it deliberately excludes runtime DB artifacts. These lists do not authorize deleting similarly named production storage.

A statement or filename referencing a retired feature in a removal manifest or negative regression test is not executable leftover functionality. Shared legacy token, API and database-column names are retained where current behavior depends on them.

## Retained

- All 13 current HTML entry files and light-only theme, supplied Galaxy logo/favicon, role dashboards and existing charts/shortcuts.
- Admin/Manager/Agent/Client business functions; Management, Sharing, Payment and the required SMS Test panel. The SMS Test panel is application functionality, not a historical testing toolkit.
- HTTP SMS ingestion, SMPP modules, processing, deduplication, reports/CDR, users/permissions, numbers/ranges/allocation, rates, providers and payment code.
- Previously approved read-only Credit Notes: implementation files unchanged in this pass. Nothing new was invented or redesigned.
- `backend/chat.js` and `assets/chat.js`: now exclusively the existing account PIN/Complaints implementation and compatibility names. The account PIN UI uses accurate security labels. A missing `pesc` escaping helper that prevented Admin PIN rows rendering was restored; account/PIN/payment rules were not changed.
- Shared `chatAuthRequired`, old unlock headers/token formats, PIN credential fields and existing response fields. Removing/renaming these indiscriminately could change permissions or break clients.
- Existing schema/bootstrap/seed behavior, database files and historical tables/columns. No application database was opened for cleanup, dropped, recreated or migrated.
- Active backup service and **all 91 Nova-named backups**, verified unchanged by SHA-256. They are not obsolete simply because their names contain Nova.
- Provider tooling, watchdog/diskguard, backup verification and deployment/service templates: their actual installation on the VPS is unknown, so retained conservatively.

## Files needing caution / uncertainty

1. `backend/schema.js` and startup code still perform existing schema/backfill/reconciliation work, including conditional relinking of old range IDs. They were deliberately not modified. A no-migration deployment cannot be assumed safe until the production version/schema is inspected and a staging copy is tested.
2. **Management known issue:** its existing `renderAlloc` path reads `.value` from a missing control during `loadRates`. This is a previously documented issue, not fixed as part of retired-feature cleanup. Request a separate targeted fix/acceptance test before claiming every Management workflow is clean.
3. `deploy/` and operational scripts contain legacy installation paths/process names and some maintenance/retention actions. We cannot verify the current VPS configuration. Keep them; do not run blindly. Root `deploy.sh` now refuses automatic deployment and points to the safe guide, replacing the risky automatic pull/copy/restart sequence.
4. User reference uploads, number-supply files, production data and backups outside the source root were not judged obsolete or deleted. Local ignored `backend/data.sqlite*` remains preserved; it is excluded from the source package and must not be deployed.
5. Old signing keys in repository history are outside filesystem cleanup. No Git history inspection or rewrite was performed in this pass. The prior inspection identified a historically tracked mobile keystore; see the safe guide.
6. Operational `powerx`/Nova compatibility names and existing legacy fields do not implement the removed mobile/Chat/Assistant features. They are retained to avoid breaking current APIs, backup discovery or installed service references.

## Dependencies

No root runtime dependency was removed or changed in this finalization. `nodemailer` was already absent from the current manifest/lockfile. The standalone Bench Toolkit and historical browser tooling are removed rather than modifying shared dependencies.

Retained shared packages:

| Package | Current purpose |
|---|---|
| express, cors | API/server/middleware |
| better-sqlite3 | SQLite data layer |
| bcryptjs, jsonwebtoken | Password/PIN hashing, login and scoped tokens |
| dotenv | Runtime environment loading |
| multer | Required uploads/imports/payment-proof input |
| smpp | SMPP transport |
| xlsx | Existing spreadsheet/import/export support |

Node built-ins such as `fs`/`path` are not installable dependencies. Unused imports in the PIN/Complaints module were removed; shared package dependencies remain intact. No permanent limiter bypass was introduced.

## Verification actually performed

- Node syntax checks for every nonempty inline script in all 13 HTML entries, and standalone backend/frontend JS.
- Local HTML asset reference validation: no missing referenced current assets.
- Credit Notes in-memory tests: **10 passed**; no production DB involved.
- Current cleanup/PIN/Complaints regression harness: **6 passed** against a fresh temporary DB with mock authentication. Its fresh-fixture schema assertions do not drop legacy tables from existing databases.
- Real isolated-server/browser checks: all four roles login/dashboard, no retired navigation; Admin account/PIN table renders without Chat-only manager controls; Agent payment PIN unlock succeeds. Sharing and Payment mobile smoke checks passed without document overflow or JS errors.
- Retired Chat login/conversation/app-version, Assistant and panel-request endpoints checked returned 404.
- Management mobile check reproduced the known error above; not counted as a pass.
- Finalization hash checks: schema, DB layer, backup, seed, provider/SMPP modules, Credit Notes files, package/lock files, application SQLite/WAL/SHM and all 91 active backups remain unchanged from the start of this cleanup.
- No new production or sustained-load tests. HTTP/SMPP previously passed isolated smoke tests in the prior light-release phase; their modules are unchanged here. SMPP was disabled during this final browser cleanup check to avoid external activity.
- Local-copy helper fixture checks passed: dry-run/no writes, confirmation gate, exact obsolete deletion, same-name replacement, new files, preservation of unrelated content, environment-bearing and symlink target rejection. This used an empty test marker, not a real Git repository; no Git commands ran.
- Test service stopped afterward. No VPS backup or production before/after data verification is claimed.

The current source/size/archive checks and local-only sync-helper test results accompany the final package. Installed dependencies and `.git` are excluded from distributable source size. Local persistent data is reported separately, never added to the archive.

## How to use

Follow [SAFE-UPDATE.md](SAFE-UPDATE.md), Steps 1–9. The manifest-driven helper updates your separate local clone, not GitHub or the VPS. Git recognizes deletions only when known obsolete tracked files are removed from that local clone and included in a reviewed commit. Unrelated paths are deliberately preserved.
