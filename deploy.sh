#!/usr/bin/env bash
# =============================================================================
# Power X SMS — safe VPS deploy
#
#   ./deploy.sh
#
# Guarantees:
#   1. Backs up the live database BEFORE touching git.
#   2. Refuses to continue if the backup did not succeed.
#   3. Never runs a destructive git command (no reset --hard, no clean).
#   4. Verifies the database is still present and readable afterwards.
#   5. Restores automatically if the database vanished during the update.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/Power X-sms}"
DB="$APP_DIR/backend/data.sqlite"
SAFE_DIR="${SAFE_DIR:-/root/powerx-db-safety}"
PM2_NAME="${PM2_NAME:-powerx}"
STAMP="$(date +%F-%H%M%S)"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

cd "$APP_DIR"

echo "=== 1/6  Backing up production data ==============================="
mkdir -p "$SAFE_DIR"

if [ ! -f "$DB" ]; then
  red "FATAL: $DB not found. Refusing to deploy."
  red "If this is a first install, create the DB by starting the app once."
  exit 1
fi

BEFORE_BYTES=$(stat -c%s "$DB")
cp "$DB" "$SAFE_DIR/data.sqlite.$STAMP"
[ -d "$APP_DIR/backend/backups" ] && cp -r "$APP_DIR/backend/backups" "$SAFE_DIR/backups.$STAMP" 2>/dev/null || true

if [ ! -s "$SAFE_DIR/data.sqlite.$STAMP" ]; then
  red "FATAL: backup is empty. Aborting before any git operation."
  exit 1
fi

# Record row counts so we can prove nothing was lost.
if command -v sqlite3 >/dev/null 2>&1; then
  BEFORE_COUNTS=$(sqlite3 "$DB" "
    SELECT 'users='||(SELECT COUNT(*) FROM users)
      ||' ranges='||(SELECT COUNT(*) FROM ranges)
      ||' numbers='||(SELECT COUNT(*) FROM numbers)
      ||' sms='||(SELECT COUNT(*) FROM sms_records);" 2>/dev/null || echo "n/a")
else
  BEFORE_COUNTS="n/a (sqlite3 not installed)"
fi
grn "  backup: $SAFE_DIR/data.sqlite.$STAMP  ($BEFORE_BYTES bytes)"
echo  "  before: $BEFORE_COUNTS"

echo
echo "=== 2/6  Checking the database is NOT tracked by git =============="
if git ls-files --error-unmatch backend/data.sqlite >/dev/null 2>&1; then
  red "WARNING: backend/data.sqlite is tracked by git!"
  ylw "  A pull could overwrite live data. Untracking it now (file stays on disk)."
  git rm --cached backend/data.sqlite >/dev/null
  git commit -m "Stop tracking runtime database" >/dev/null || true
fi
grn "  database is untracked - git cannot overwrite it"

echo
echo "=== 3/6  Pulling ==================================================="
git pull --ff-only origin main

echo
echo "=== 4/6  Dependencies =============================================="
npm install --no-audit --no-fund

echo
echo "=== 5/6  Verifying production data ================================="
if [ ! -f "$DB" ]; then
  red "  DATABASE MISSING after update - restoring from backup"
  cp "$SAFE_DIR/data.sqlite.$STAMP" "$DB"
  grn "  restored"
fi
AFTER_BYTES=$(stat -c%s "$DB")
if command -v sqlite3 >/dev/null 2>&1; then
  AFTER_COUNTS=$(sqlite3 "$DB" "
    SELECT 'users='||(SELECT COUNT(*) FROM users)
      ||' ranges='||(SELECT COUNT(*) FROM ranges)
      ||' numbers='||(SELECT COUNT(*) FROM numbers)
      ||' sms='||(SELECT COUNT(*) FROM sms_records);" 2>/dev/null || echo "n/a")
else
  AFTER_COUNTS="n/a"
fi
echo "  before: $BEFORE_COUNTS"
echo "  after : $AFTER_COUNTS"
if [ "$BEFORE_COUNTS" != "n/a" ] && [ "$BEFORE_COUNTS" != "$AFTER_COUNTS" ]; then
  ylw "  NOTE: counts changed. This is normal if SMS arrived during the deploy."
  ylw "  Rollback copy: $SAFE_DIR/data.sqlite.$STAMP"
fi
grn "  database present: $AFTER_BYTES bytes"

echo
echo "=== 6/6  Restarting ================================================"
pm2 restart "$PM2_NAME" --update-env
pm2 save
pm2 list

echo
grn "=== DONE ==========================================================="
echo "Health:"
curl -s "http://localhost:4000/api/health" || true
echo
echo "Rollback if needed:"
echo "  cp $SAFE_DIR/data.sqlite.$STAMP $DB && pm2 restart $PM2_NAME"
echo
echo "Old safety copies (keep the recent ones):"
ls -1t "$SAFE_DIR" | head -5 | sed 's/^/  /'
