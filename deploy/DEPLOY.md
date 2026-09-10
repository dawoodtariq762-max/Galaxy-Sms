# PowerX — VPS Deployment & DR Runbook (Phase-3)

Target: 4-8 vCPU / 8-16GB NVMe VPS · Ubuntu 22.04+ · SQLite-WAL optimized build.

## 1. Layout & env
```
/opt/powerx/            repo (this code)
/opt/powerx/data/powerx.db   database (NVMe, NEVER tmpfs)  → export DB_FILE=/opt/powerx/data/powerx.db
```
`/etc/powerx.env` (used by systemd + litestream units):
```
DB_FILE=/opt/powerx/data/powerx.db
JWT_SECRET=<64 random chars>
POWERX_FTS=1                      # optional: SMS message trigram search
HISTORY_RETENTION_DAYS=90
# POWERX_ROLE split (8GB+ boxes): api process + sync process (see ecosystem.config.cjs for PM2)
```

## 2. Run (choose one)
**A) PM2 (recommended):**
```
pm2 start deploy/ecosystem.config.cjs   # powerx-api + powerx-sync (fork mode, NEVER cluster)
pm2 save && pm2 startup
```
Single small box: run one process with no POWERX_ROLE (default 'all').

**B) systemd:** copy the two units from `deploy/litestream/` pattern (api: `POWERX_ROLE=api`, sync: `POWERX_ROLE=sync`).

**nginx:** `deploy/nginx-powerx.conf` (TLS, gzip, body-limit, static cache) — already Phase-1 ready.

## 3. Continuous backup (Litstream) — RPO ~1s
```
deploy/litestream/install-litestream.sh          # installs /usr/local/bin/litestream
cp deploy/litestream/litestream.yml /etc/litestream.yml   # set POWERX_DB_FILE + S3 vars
cp deploy/litestream/powerx-litestream.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now litestream
```
- WAL ships every ~1s to S3 + second local disk → VPS total loss = max ~1s data loss.
- 3h `nova-sms-backup` snapshots stay ON (belt + suspenders).

## 4. Monthly restore drill (RTO target <30 min) — MANDATORY
```
deploy/verify-backups.sh    # cron 1st of month 4am; Telegram alert on failure
```
Manual full drill (quarterly):
```
litestream restore -o /tmp/drill.db -config /etc/litestream.yml "$DB_FILE"
node -e "const D=require('better-sqlite3');const db=new D('/tmp/drill.db',{readonly:true});console.log(db.prepare('PRAGMA integrity_check').get(),db.prepare('SELECT COUNT(*) c FROM numbers').get())"
```
Restore procedure (real incident): stop api → `litestream restore -o data/powerx.db ...` → start api. Point-in-time: `litestream restore -timestamp 2026-09-10T08:00:00Z ...`.

## 5. FTS5 message search (optional, POWERX_FTS=1)
- Boot creates `sms_fts` trigram index + sync triggers; new SMS indexed instantly.
- History backfills in background (`GET /api/admin/fts-status` → progress).
- `/api/sms/paged?search=` uses the index only AFTER backfill completes (never partial results).
- Turn OFF (`unset POWERX_FTS`) → endpoints behave exactly as before; index can be dropped: `DROP TABLE sms_fts;` + drop triggers `sms_fts_ai/ad/au`.

## 6. Monitoring
- `scripts/alert-check.js` (cron) → Telegram on health/latency/disk issues.
- `/api/health` → rss, event-loop lag p95/p99, WAL size, numbers_ver.
- Log alerts: `[SLOW_QUERY]`, `[IMPORT-FILE]`, `[EXPORT]`, `[FTS]`, backup errors.

## 7. Upgrade steps (zero-downtime)
1. `git pull` → `npm ci --omit=dev` 2. `pm2 reload powerx-api && pm2 restart powerx-sync`
3. Smoke: `/api/health` + login + one numbers page. Schema migrations are `CREATE IF NOT EXISTS` + additive columns — safe to re-run.

## 8. Capacity notes (MEASURED vs PROJECTED)
- MEASURED @5M numbers: browse p50 ~40-45ms; 5M CSV export ~110s flat-memory (worker); 110k file-import ~1.5s; crash = zero loss (212ms recovery).
- PROJECTED @20M/150 users (needs 16GB box + role split + FTS on): same architecture — verify with `scripts/bench-bulkload.js BENCH_N=20000000` + full suite before claiming.
- PG migration triggers (roadmap E.2): sustained >150-200 SMS/s, p95 >100ms WAL-contention, multi-server, 500+ users → re-read roadmap section E before deciding.
