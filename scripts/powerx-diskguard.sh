#!/usr/bin/env bash
# =============================================================================
# Power X SMS — disk guard
# =============================================================================
# WHY THIS EXISTS (calculated from this project's own backup code):
#
#   backend/backup.js:57  createBackup() does:
#       db.exportBuffer()  ->  fs.readFileSync(WHOLE DATABASE)
#   Every backup is therefore a FULL copy of the database, not an incremental
#   diff. With the default schedule (every 3 hours, keep 30 days) that is
#   240 full copies on disk at any time:
#
#       DB size     240 copies (3h / 30d default)
#        50 MB      ->  11.7 GB
#       100 MB      ->  23.4 GB
#       400 MB      ->  93.8 GB     <-- VPS disk is 95.82 GB = FULL
#
#   A full disk is the worst failure mode for SQLite: writes start failing,
#   the WAL cannot be checkpointed, and the panel can corrupt or freeze.
#
#   The .env shipped with this deployment uses 6h / 14d = 56 copies, which is
#   far safer. This guard is the second line of defence: if the disk still
#   creeps up, it trims the oldest backups before anything breaks.
#
# BEHAVIOUR
#   - WARN_PCT (default 80): log a warning.
#   - CRIT_PCT (default 90): delete oldest backups, keeping at least
#     MIN_KEEP (default 8) so a restore is always possible.
#   - Never touches data.sqlite itself. Only files matching the backup naming
#     pattern nova-sms-backup-*.sqlite are ever considered.
# =============================================================================
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/powerx-sms-backups}"
DB_FILE="${PX_DB_FILE:-/root/PowerX-SMS/backend/data.sqlite}"
LOG="${PX_DISKGUARD_LOG:-/root/powerx-logs/diskguard.log}"
WARN_PCT="${PX_DISK_WARN_PCT:-80}"
CRIT_PCT="${PX_DISK_CRIT_PCT:-90}"
MIN_KEEP="${PX_MIN_BACKUPS:-8}"

mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

used_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
[ -z "$used_pct" ] && exit 0

db_size="n/a"
[ -f "$DB_FILE" ] && db_size="$(du -h "$DB_FILE" | cut -f1)"

bk_count=0
bk_size="0"
if [ -d "$BACKUP_DIR" ]; then
  bk_count="$(find "$BACKUP_DIR" -maxdepth 1 -name 'nova-sms-backup-*.sqlite' -type f 2>/dev/null | wc -l)"
  bk_size="$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
fi

if [ "$used_pct" -lt "$WARN_PCT" ]; then
  exit 0
fi

log "disk ${used_pct}% used | db=${db_size} | backups=${bk_count} files (${bk_size})"

if [ "$used_pct" -lt "$CRIT_PCT" ]; then
  log "  warning level only — no action taken"
  exit 0
fi

log "  CRITICAL — trimming oldest backups (keeping newest $MIN_KEEP)"

if [ ! -d "$BACKUP_DIR" ] || [ "$bk_count" -le "$MIN_KEEP" ]; then
  log "  only $bk_count backups present — nothing safe to delete."
  log "  DISK IS CRITICAL AND CANNOT BE FREED AUTOMATICALLY. Investigate now:"
  log "    du -xh --max-depth=2 / | sort -rh | head -20"
  exit 1
fi

deleted=0
# Oldest first, stop once we are back under the warning level.
while IFS= read -r f; do
  now_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
  [ "$now_pct" -lt "$WARN_PCT" ] && break
  remaining="$(find "$BACKUP_DIR" -maxdepth 1 -name 'nova-sms-backup-*.sqlite' -type f | wc -l)"
  [ "$remaining" -le "$MIN_KEEP" ] && break
  rm -f "$f" && deleted=$((deleted + 1)) && log "  deleted $(basename "$f")"
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'nova-sms-backup-*.sqlite' -type f -printf '%T@ %p\n' \
         | sort -n | cut -d' ' -f2-)

log "  done — $deleted removed, disk now $(df --output=pcent / | tail -1 | tr -d ' ')"
