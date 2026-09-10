#!/usr/bin/env bash
# =============================================================================
# Power X SMS — health watchdog
# =============================================================================
# WHY THIS EXISTS (proven by test, not assumed):
#
#   PM2 only restarts a process that DIES. It does not notice a process that
#   is alive but frozen. Tested on this exact app:
#
#       kill -STOP <pid>
#       pm2 status            -> "online", restarts: 0
#       curl /api/health      -> TIMEOUT
#
#   So the panel was completely down while PM2 reported everything fine.
#   That can happen in production from an event-loop block, a stuck native
#   call inside better-sqlite3, or the DB being locked by a runaway query.
#
#   This script closes that gap: it actually asks the HTTP endpoint whether
#   the panel is answering, and restarts it only if it is genuinely not.
#
# BEHAVIOUR
#   - Calls /api/health with a 10 s timeout.
#   - One failure is ignored (a single slow response is not an outage).
#     It only restarts after FAIL_THRESHOLD consecutive failures.
#   - Everything is logged to /root/powerx-logs/watchdog.log
#
# INSTALL: run scripts/install-service.sh (adds the systemd timer)
# =============================================================================
set -uo pipefail

URL="${PX_HEALTH_URL:-http://127.0.0.1:4000/api/health}"
PM2_NAME="${PX_PM2_NAME:-powerx}"
LOG="${PX_WATCHDOG_LOG:-/root/powerx-logs/watchdog.log}"
STATE="${PX_WATCHDOG_STATE:-/run/powerx-watchdog.fails}"
FAIL_THRESHOLD="${PX_FAIL_THRESHOLD:-2}"
TIMEOUT="${PX_HEALTH_TIMEOUT:-10}"

PM2_BIN="$(command -v pm2 || echo /usr/bin/pm2)"

mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

body="$(curl -fsS -m "$TIMEOUT" "$URL" 2>/dev/null)"
rc=$?

if [ $rc -eq 0 ] && echo "$body" | grep -q '"ok":true'; then
  # Healthy — clear the failure counter.
  [ -f "$STATE" ] && rm -f "$STATE"
  exit 0
fi

# Unhealthy — count consecutive failures.
fails=0
[ -f "$STATE" ] && fails="$(cat "$STATE" 2>/dev/null || echo 0)"
fails=$((fails + 1))
echo "$fails" > "$STATE"

log "health FAILED (curl rc=$rc) — consecutive failure #$fails"

if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
  log "  below threshold ($FAIL_THRESHOLD) — waiting for next check before acting"
  exit 0
fi

log "  threshold reached — restarting '$PM2_NAME'"
"$PM2_BIN" restart "$PM2_NAME" --update-env >> "$LOG" 2>&1

sleep 12
if curl -fsS -m "$TIMEOUT" "$URL" 2>/dev/null | grep -q '"ok":true'; then
  log "  restart OK — panel is answering again"
  rm -f "$STATE"
else
  log "  STILL DOWN after restart — check: pm2 logs $PM2_NAME --err --lines 50"
fi
