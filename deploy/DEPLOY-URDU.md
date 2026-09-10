# PowerX — VPS Deployment Guide (Roman Urdu, step-by-step)

Archive: `powerx-deploy-<date>.tar.gz` — ye poora panel code hai (backend + frontend + scripts + deploy kit).
Node_modules archive mein NAHI hote — VPS par `npm install` se bante hain (2 min).

---

## 1. VPS kharidein (specs)

| Target | Specs | Andaza |
|---|---|---|
| 2–5M numbers, 100–150 users | 4 vCPU / 8GB RAM / 80GB NVMe | Hetzner CPX31 / Contabo / DO ~$15-25/mo |
| 10–20M numbers, 150+ users | 8 vCPU / 16GB RAM / 200GB NVMe | Hetzner CPX41 ~$30-40/mo |

OS: **Ubuntu 22.04 ya 24.04**. NVMe disk zaroori (SATA HDD par query times 5-10x).

## 2. Archive upload + extract

Apni local machine se:
```bash
scp powerx-deploy-<date>.tar.gz root@VPS_IP:/opt/
ssh root@VPS_IP
mkdir -p /opt/powerx
tar xzf /opt/powerx-deploy-<date>.tar.gz -C /opt/powerx
cd /opt/powerx
ls   # backend, public files, scripts, deploy ... sab dikhe
```

## 3. Node.js 20 + dependencies

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential
cd /opt/powerx
npm install --omit=dev        # 2-3 min (better-sqlite3 compile hota hai)
node -e "require('better-sqlite3'); console.log('deps OK')"
```

## 4. Data directory + environment

```bash
mkdir -p /opt/powerx/data
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
cat > /etc/powerx.env <<EOF
DB_FILE=/opt/powerx/data/powerx.db
JWT_SECRET=$SECRET
PORT=4000
EOF
chmod 600 /etc/powerx.env
```
DB **hamesha NVMe disk par** (/opt ya /var) — /tmp aur RAM-disk par KABHI nahi.

## 5. Pehli boot (manual test)

```bash
cd /opt/powerx && set -a && . /etc/powerx.env && set +a && node backend/server.js
```
`✅ Power X SMS backend running: http://localhost:4000` dikhe to sab theek. Ctrl+C.

- Fresh DB par admin khud ban jata hai: **vibepk / vibepk123**
- **PEHLA KAAM: login karke admin ka password change karein** (profile se). Ye default sab jagah same hota hai.

## 6. PM2 (production process manager)

```bash
npm install -g pm2
# Option A — ek process (chhoti machine / simple):
cd /opt/powerx && set -a && . /etc/powerx.env && set +a
pm2 start backend/server.js --name powerx --time && pm2 save && pm2 startup
# Option B — 8GB+ par api/sync split (recommended):
pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
```
**Cluster mode KABHI on na karein** — SQLite single-writer hai; fork mode hi sahi.

## 7. Domain + nginx + TLS (HTTPS)

DNS mein panel domain ka A record VPS IP par point karein, phir:
```bash
apt-get install -y nginx certbot python3-certbot-nginx
cp /opt/powerx/deploy/nginx-powerx.conf /etc/nginx/sites-available/powerx
nano /etc/nginx/sites-available/powerx        # server_name apna domain likhein
ln -sf /etc/nginx/sites-available/powerx /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d panel.yourdomain.com       # free HTTPS auto-renew
```

## 8. Litestream continuous backup (RPO ~1 second) — strongly recommended

```bash
bash /opt/powerx/deploy/litestream/install-litestream.sh
# S3-compatible storage (Wasabi/B2/DO Spaces ~$1-5/mo) account + bucket bana kar:
mkdir -p /etc/powerx /mnt/backup/litestream
cat > /etc/powerx/litestream.env <<EOF
LITESTREAM_ACCESS_KEY_ID=xxxx
LITESTREAM_SECRET_ACCESS_KEY=xxxx
LITESTREAM_S3_BUCKET=your-bucket
LITESTREAM_S3_REGION=us-east-1
POWERX_DB_FILE=/opt/powerx/data/powerx.db
LITESTREAM_LOCAL_DIR=/mnt/backup/litestream
EOF
cp /opt/powerx/deploy/litestream/litestream.yml /etc/litestream.yml
cp /opt/powerx/deploy/litestream/powerx-litestream.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now litestream
litestream replicas /etc/litestream.yml       # replica 'synced' dikhe to OK
# monthly auto-verify (Telegram alert on fail):
cron -e   # ye line add karein:
# 0 4 1 * * TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx /opt/powerx/deploy/verify-backups.sh >> /var/log/pw-verify.log 2>&1
```
3-hour snapshots (nova-sms-backups) apne aap chalte rehte hain — Litestream unka REPLACE nahi, EXTRA layer hai.

## 9. Firewall

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
# backend port (4000) sirf localhost — ufw usay block hi rakhta hai, sahi hai
```

## 10. Health checks (deploy ke baad)

```bash
curl -s http://127.0.0.1:4000/api/health | head -c 400; echo
pm2 logs powerx --lines 50         # ya powerx-api / powerx-sync
```
Browser: `https://panel.yourdomain.com` → login → numbers/CSV export/import ek dafa manually test karein.

## 11. 20M benchmark — claim ko MEASURED banane ke liye

```bash
cd /opt/powerx
# Pehla chhota dry-run (2M, ~5 min):
BENCH_N=2000000 node scripts/bench-20m.js
# Phir poora 20M (load ~3-5 min + suite + full export ~8-12 min):
node scripts/bench-20m.js
```
- Benchmark DB `/var/tmp/pw20/` mein banti hai — **panel DB se bilkul alag, zero risk**
- Aakhri report PASS/FAIL table deta hai — **sab PASS = "20M" ab is box par MEASURED hai**
- Report screenshot rakh lein; `BENCH_CLEANUP=1` ke saath chalayein to benchmark DB end par delete ho jati hai
-SKIP options: `SKIP_LOAD=1` (db reuse), `SKIP_ALLOC=1`, `BENCH_SKIP_EXPORT=1`, `BENCH_SMS=2000`

## 12. Troubleshooting

| Masla | Hal |
|---|---|
| `npm install` better-sqlite3 error | `apt-get install -y build-essential python3` phir dobara |
| Port busy | `ss -tlnp | grep 4000` → PID dekh kar `kill` |
| 502 nginx se | `pm2 logs` — server down/restarting? memory `pm2 monit` |
| Disk full | backups + data alag disk; `deploy/verify-backups.sh` alert deta hai |
| Disaster restore | `systemctl stop pm2-root && litestream restore -o /opt/powerx/data/powerx.db /etc/litestream.yml` → start (detail: `deploy/DEPLOY.md` §4) |
| Login rate-limit lagi | 5 min wait (security feature: 10/5min/IP) |

## 13. Update kabhi naya code aaye

```bash
cd /opt/powerx
systemctl stop litestream 2>/dev/null   # optional safety
pm2 stop powerx    # ya powerx-api powerx-sync
# naya archive extract karein (data/ directory KO MAT CHHEDEN)
npm install --omit=dev
pm2 restart powerx && curl -s localhost:4000/api/health
```
Migrations `CREATE IF NOT EXISTS` hain — data safe rehta hai. Phir bhi pehle snapshot: `curl -X POST .../api/admin/backup` ya `cp powerx.db powerx.db.bak` (band process ke doran).
