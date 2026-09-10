#!/usr/bin/env bash
# PowerX — monthly backup verification (cron: 1st of month, 4am)
# Runs integrity_check on the newest Litestream RESTORABLE snapshot + newest
# file-backup. Telegram alert on failure (same bot as alert-check.js).
set -uo pipefail
DB_FILE="${POWERX_DB_FILE:?set POWERX_DB_FILE}"
REPLICA_DIR="${LITESTREAM_LOCAL_DIR:-/mnt/backup/litestream}"
BACKUP_DIR="${POWERX_BACKUP_DIR:-$HOME/nova-sms-backups}"
TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"; TG_CHAT="${TELEGRAM_CHAT_ID:-}"

fail() {
  echo "FAIL: $1"
  [ -n "$TG_TOKEN" ] && curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" -d text="🚨 PowerX backup verify FAILED: $1" >/dev/null
  exit 1
}

LATEST=$(ls -t "${REPLICA_DIR}"/*.db 2>/dev/null | head -1)
[ -z "$LATEST" ] && fail "no litestream replica file in ${REPLICA_DIR}"

TMP=$(mktemp /tmp/pw-verify.XXXXXX.db)
litestream restore -o "$TMP" -config /etc/litestream.yml "${DB_FILE}" >/dev/null 2>&1 || fail "litestream restore failed"
RESULT=$(node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1], { readonly: true });
  console.log(db.prepare('PRAGMA integrity_check').get().integrity_check + ' numbers=' + db.prepare('SELECT COUNT(*) c FROM numbers').get().c);
" "$TMP" 2>/dev/null) || fail "restored DB will not open"
rm -f "$TMP"
echo "$RESULT" | grep -q "^ok " || fail "integrity: $RESULT"
echo "✓ litestream replica verified: $RESULT"

NEWEST_SNAP=$(ls -t "${BACKUP_DIR}"/nova-sms-backup-*.sqlite 2>/dev/null | head -1)
if [ -n "$NEWEST_SNAP" ]; then
  RESULT2=$(node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);
  " "$NEWEST_SNAP" 2>/dev/null) || fail "snapshot DB will not open"
  [ "$RESULT2" = "ok" ] || fail "snapshot integrity: $RESULT2"
  echo "✓ snapshot verified: $(basename "$NEWEST_SNAP")"
fi
echo "✓ all backups verified $(date -Iseconds)"
