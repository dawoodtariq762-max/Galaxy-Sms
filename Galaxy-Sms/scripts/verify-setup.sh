#!/usr/bin/env bash
# =============================================================================
# Power X SMS — post-install verification
# =============================================================================
#   bash scripts/verify-setup.sh
#
# Read-only. Changes nothing. Prints PASS / WARN / FAIL for every part of the
# 24/7 setup, and tells you the exact command to fix anything that is wrong.
# =============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PM2_NAME="${PM2_NAME:-powerx}"
PORT="${PORT:-4000}"
LOG_DIR="/root/powerx-logs"

P=0; W=0; F=0
pass() { printf '  \033[32m[PASS]\033[0m %s\n' "$*"; P=$((P+1)); }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$*"; W=$((W+1)); }
fail() { printf '  \033[31m[FAIL]\033[0m %s\n' "$*"; F=$((F+1)); }
fix()  { printf '         \033[36mfix:\033[0m %s\n' "$*"; }
hdr()  { echo; printf '\033[1m%s\033[0m\n' "$*"; }

cd "$APP_DIR" 2>/dev/null || { echo "App dir not found: $APP_DIR"; exit 1; }

echo "=========================================="
echo " Power X SMS — setup verification"
echo " $(date '+%F %T')"
echo "=========================================="

# ---------------------------------------------------------------- runtime ---
hdr "1. Runtime"
NV="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NV" -ge 20 ]; then pass "Node $(node -v)"
else fail "Node $(node -v 2>/dev/null) — need 20+"
     fix "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"; fi

if npm ls better-sqlite3 --depth=0 >/dev/null 2>&1; then
  pass "better-sqlite3 installed ($(node -p "require('better-sqlite3/package.json').version" 2>/dev/null))"
else
  fail "better-sqlite3 missing"; fix "npm install --omit=dev"
fi

# -------------------------------------------------------------------- env ---
hdr "2. Configuration (.env)"
if [ ! -f .env ]; then
  fail ".env missing — app is running on insecure defaults"
  fix "bash scripts/install-service.sh"
else
  pass ".env exists"

  SEC="$(grep -E '^JWT_SECRET=' .env | cut -d= -f2- | tr -d '[:space:]')"
  if [ -z "$SEC" ] || [ "$SEC" = "change-this-to-a-long-random-secret" ]; then
    fail "JWT_SECRET is the placeholder — anyone can forge an admin login token"
    fix "sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=\$(openssl rand -hex 32)|\" .env && pm2 restart $PM2_NAME --update-env"
  elif [ "${#SEC}" -lt 32 ]; then
    warn "JWT_SECRET is only ${#SEC} chars — 64 recommended"
    fix "sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=\$(openssl rand -hex 32)|\" .env && pm2 restart $PM2_NAME --update-env"
  else
    pass "JWT_SECRET set (${#SEC} chars, not the default)"
  fi

  PERM="$(stat -c %a .env 2>/dev/null)"
  if [ "$PERM" = "600" ]; then pass ".env permissions 600"
  else warn ".env permissions are $PERM — secret readable by other users"
       fix "chmod 600 .env"; fi

  # --- backup schedule: the disk-full risk ---------------------------------
  BH="$(grep -E '^BACKUP_INTERVAL_HOURS=' .env | cut -d= -f2 | tr -dc '0-9.')"
  BR="$(grep -E '^BACKUP_RETENTION_DAYS=' .env | cut -d= -f2 | tr -dc '0-9')"
  BH="${BH:-3}"; BR="${BR:-30}"
  COPIES="$(awk -v h="$BH" -v d="$BR" 'BEGIN{printf "%d", (24/h)*d}')"

  DBF="$APP_DIR/backend/data.sqlite"
  DBMB=0
  [ -f "$DBF" ] && DBMB="$(du -m "$DBF" | cut -f1)"
  DISKFREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"

  echo "         schedule: every ${BH}h, keep ${BR}d  =  ${COPIES} full copies on disk"
  if [ "$DBMB" -gt 0 ]; then
    PROJ_GB="$(awk -v c="$COPIES" -v m="$DBMB" 'BEGIN{printf "%.1f", c*m/1024}')"
    echo "         db is ${DBMB} MB  ->  backups will reach ~${PROJ_GB} GB (free: ${DISKFREE_GB} GB)"
  fi

  if [ "$COPIES" -gt 120 ]; then
    warn "$COPIES full copies is a disk-full risk as the database grows"
    echo "         (each backup is a FULL copy, not incremental — backup.js exportBuffer)"
    fix "sed -i 's|^BACKUP_INTERVAL_HOURS=.*|BACKUP_INTERVAL_HOURS=6|; s|^BACKUP_RETENTION_DAYS=.*|BACKUP_RETENTION_DAYS=14|' .env && pm2 restart $PM2_NAME --update-env"
  else
    pass "backup schedule is disk-safe ($COPIES copies)"
  fi

  BD="$(grep -E '^BACKUP_DIR=' .env | cut -d= -f2)"
  if [ -n "$BD" ]; then
    case "$BD" in
      "$APP_DIR"*) warn "BACKUP_DIR is inside the app folder — a bad git operation could wipe it"
                   fix "set BACKUP_DIR=/root/powerx-sms-backups in .env" ;;
      *) pass "BACKUP_DIR outside app folder: $BD" ;;
    esac
  else
    warn "BACKUP_DIR not set — falling back to ~/nova-sms-backups"
  fi
fi

# ---------------------------------------------------------------- process ---
hdr "3. Process (PM2)"
if ! command -v pm2 >/dev/null 2>&1; then
  fail "pm2 not installed"; fix "npm i -g pm2"
else
  ST="$(pm2 jlist 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
try{const a=JSON.parse(s).find(x=>x.name==='$PM2_NAME');
if(!a){console.log('MISSING');process.exit(0)}
const e=a.pm2_env;
console.log([e.status,e.exec_mode,e.restart_time,Math.round(a.monit.memory/1048576),
Math.round((Date.now()-e.pm_uptime)/1000),e.max_memory_restart||0,e.kill_timeout||0].join('|'));
}catch(_){console.log('ERR')}})" 2>/dev/null)"

  if [ "$ST" = "MISSING" ] || [ "$ST" = "ERR" ] || [ -z "$ST" ]; then
    fail "'$PM2_NAME' not found in pm2"; fix "pm2 start ecosystem.config.js && pm2 save"
  else
    IFS='|' read -r status mode restarts mem uptime maxmem killto <<< "$ST"
    [ "$status" = "online" ] && pass "status: online" || fail "status: $status"
    if [ "$mode" = "fork_mode" ] || [ "$mode" = "fork" ]; then
      pass "fork mode (correct — cluster would duplicate the sync/backup timers)"
    else
      fail "exec_mode is '$mode' — cluster mode duplicates provider sync + backups"
      fix "pm2 delete $PM2_NAME && pm2 start ecosystem.config.js && pm2 save"
    fi
    pass "memory: ${mem} MB   uptime: ${uptime}s   restarts: ${restarts}"
    [ "${restarts:-0}" -gt 5 ] && warn "restart count is ${restarts} — check: pm2 logs $PM2_NAME --err --lines 50"
    if [ "${killto:-0}" -ge 10000 ]; then pass "kill_timeout ${killto}ms (WAL checkpoint has time to finish)"
    else warn "kill_timeout ${killto}ms — shutdown checkpoint may be cut short"
         fix "pm2 delete $PM2_NAME && pm2 start ecosystem.config.js && pm2 save"; fi
  fi

  PM2_HOME_DIR="${PM2_HOME:-$HOME/.pm2}"
  if [ -f "$PM2_HOME_DIR/dump.pm2" ]; then pass "pm2 process list saved (survives reboot)"
  else fail "pm2 list not saved — panel will not come back after reboot"; fix "pm2 save"; fi
fi

# ------------------------------------------------------------------- boot ---
hdr "4. Start on boot"
if systemctl is-enabled pm2-root >/dev/null 2>&1; then
  pass "pm2-root service enabled"
else
  fail "pm2-root not enabled — panel will NOT come back after reboot"
  fix "pm2 startup systemd -u root --hp /root && pm2 save"
fi

# ----------------------------------------------------------------- timers ---
hdr "5. Watchdog + disk guard"
for t in powerx-watchdog powerx-diskguard; do
  if systemctl is-active "$t.timer" >/dev/null 2>&1; then
    NEXT="$(systemctl show "$t.timer" -p NextElapseUSecRealtime --value 2>/dev/null)"
    pass "$t.timer active${NEXT:+  (next: $NEXT)}"
  else
    fail "$t.timer not active"; fix "systemctl enable --now $t.timer"
  fi
done
for s in powerx-watchdog powerx-diskguard; do
  R="$(systemctl show "$s.service" -p ExecMainStatus --value 2>/dev/null)"
  [ "${R:-0}" != "0" ] && warn "$s last run exited $R — see $LOG_DIR/${s#powerx-}.log"
done
[ -x "$APP_DIR/scripts/powerx-watchdog.sh" ]  || { fail "watchdog script not executable"; fix "chmod +x scripts/*.sh"; }
[ -x "$APP_DIR/scripts/powerx-diskguard.sh" ] || { fail "diskguard script not executable"; fix "chmod +x scripts/*.sh"; }

# ----------------------------------------------------------------- health ---
hdr "6. Panel health"
H="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
if echo "$H" | grep -q '"ok":true'; then pass "GET /api/health -> $H"
else fail "health check failed"; fix "pm2 logs $PM2_NAME --err --lines 50"; fi

LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$PORT/panel-login" 2>/dev/null)"
[ "$LOGIN_CODE" = "200" ] && pass "GET /panel-login -> 200" || warn "/panel-login returned $LOGIN_CODE"

# --------------------------------------------------------------- database ---
hdr "7. Database"
DBF="$APP_DIR/backend/data.sqlite"
if [ -f "$DBF" ]; then
  pass "data.sqlite present ($(du -h "$DBF" | cut -f1))"
  if git -C "$APP_DIR" ls-files --error-unmatch backend/data.sqlite >/dev/null 2>&1; then
    fail "data.sqlite is TRACKED BY GIT — a pull could overwrite live data"
    fix "git rm --cached backend/data.sqlite && git commit -m 'untrack db'"
  else
    pass "data.sqlite untracked by git (safe from git pull)"
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    IC="$(sqlite3 "$DBF" 'PRAGMA quick_check;' 2>/dev/null | head -1)"
    [ "$IC" = "ok" ] && pass "integrity check: ok" || warn "integrity check: $IC"
    JM="$(sqlite3 "$DBF" 'PRAGMA journal_mode;' 2>/dev/null)"
    [ "$JM" = "wal" ] && pass "journal_mode: WAL" || warn "journal_mode: $JM (expected wal)"
    UC="$(sqlite3 "$DBF" 'SELECT COUNT(*) FROM users;' 2>/dev/null)"
    echo "         users: ${UC:-?}"
  else
    warn "sqlite3 CLI not installed — skipped integrity check"; fix "apt install -y sqlite3"
  fi
else
  fail "data.sqlite not found at $DBF"
fi

if git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$APP_DIR" check-ignore -q .env 2>/dev/null; then pass ".env is git-ignored"
  else fail ".env is NOT git-ignored — the secret could be pushed to GitHub"
       fix "echo '.env' >> .gitignore"; fi
fi

# ---------------------------------------------------------------- backups ---
hdr "8. Backups"
BDIR="${BD:-/root/powerx-sms-backups}"
if [ -d "$BDIR" ]; then
  N="$(find "$BDIR" -maxdepth 1 -name 'nova-sms-backup-*.sqlite' -type f 2>/dev/null | wc -l)"
  if [ "$N" -gt 0 ]; then
    NEWEST="$(find "$BDIR" -maxdepth 1 -name 'nova-sms-backup-*.sqlite' -type f -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
    AGE_MIN=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST") ) / 60 ))
    pass "$N backup(s), total $(du -sh "$BDIR" | cut -f1), newest ${AGE_MIN} min old"
  else
    warn "no backups yet (the first one is written ~15s after start)"
  fi
else
  warn "backup dir missing: $BDIR"; fix "mkdir -p $BDIR && pm2 restart $PM2_NAME --update-env"
fi

# --------------------------------------------------------------- firewall ---
hdr "9. Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  pass "ufw active"
  ufw status 2>/dev/null | grep -qE "^22[/ ]"     && pass "  port 22 (SSH) allowed"   || fail "  port 22 NOT allowed"
  ufw status 2>/dev/null | grep -qE "^$PORT[/ ]"  && pass "  port $PORT allowed"      || fail "  port $PORT NOT allowed — panel unreachable"
else
  warn "ufw not active"; fix "ufw allow 22/tcp && ufw allow $PORT/tcp && ufw enable"
fi

# ----------------------------------------------------------------- system ---
hdr "10. System"
USEDPCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if   [ "$USEDPCT" -lt 80 ]; then pass "disk ${USEDPCT}% used ($(df -h / | tail -1 | awk '{print $4}') free)"
elif [ "$USEDPCT" -lt 90 ]; then warn "disk ${USEDPCT}% used"
else fail "disk ${USEDPCT}% used — SQLite writes can fail when full"; fi

MEMFREE="$(free -m | awk '/^Mem:/{print $7}')"
[ "$MEMFREE" -gt 500 ] && pass "RAM ${MEMFREE} MB available" || warn "only ${MEMFREE} MB RAM available"

RK="$(uname -r)"
EK="$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|.*vmlinuz-||' | sort -V | tail -1)"
if [ -n "$EK" ] && [ "$RK" != "$EK" ]; then
  warn "running kernel $RK but $EK is installed — reboot pending"
  fix "reboot   (pm2 will bring the panel back automatically)"
else
  pass "kernel $RK is current"
fi

if [ -f "$LOG_DIR/watchdog.log" ]; then
  WF="$(grep -c 'health FAILED' "$LOG_DIR/watchdog.log" 2>/dev/null || echo 0)"
  [ "$WF" -eq 0 ] && pass "watchdog log: no failures recorded" \
                  || warn "watchdog recorded $WF health failure(s) — tail $LOG_DIR/watchdog.log"
fi

# --------------------------------------------------------------- security ---
hdr "11. Security"
# Live login probe — needs only the HTTP API, not the sqlite3 CLI.
if echo "$H" | grep -q '"ok":true'; then
  if curl -fsS -m 10 -X POST "http://127.0.0.1:$PORT/api/login" \
       -H 'Content-Type: application/json' \
       -d '{"username":"vibepk","password":"vibepk123"}' 2>/dev/null | grep -q '"token"'; then
    fail "admin still uses the default password vibepk123 (it is in seed.js on a PUBLIC repo)"
    fix "log in at http://\$(hostname -I | awk '{print \$1}'):$PORT/panel-login and change it now"
  else
    pass "default admin password has been changed"
  fi
  if curl -fsS -m 10 -X POST "http://127.0.0.1:$PORT/api/login" \
       -H 'Content-Type: application/json' \
       -d '{"username":"test","password":"test123"}' 2>/dev/null | grep -q '"token"'; then
    warn "'test' account still uses the default password test123"
    fix "change or disable the test account from the panel"
  else
    pass "test account default password changed/disabled"
  fi
else
  warn "panel not answering — skipped default-password check"
fi

# ---------------------------------------------------------------- summary ---
echo
echo "=========================================="
printf ' \033[32mPASS %d\033[0m   \033[33mWARN %d\033[0m   \033[31mFAIL %d\033[0m\n' "$P" "$W" "$F"
echo "=========================================="
if [ "$F" -eq 0 ] && [ "$W" -eq 0 ]; then
  printf '\033[32m Everything is correct. Panel is production ready.\033[0m\n'
elif [ "$F" -eq 0 ]; then
  printf '\033[33m No failures. Review the warnings above.\033[0m\n'
else
  printf '\033[31m %d item(s) need fixing — each one shows its fix command.\033[0m\n' "$F"
fi
echo
exit 0
