#!/usr/bin/env bash
# =============================================================================
# Power X SMS — add a CR-API style provider (fly / lamix / astrasms / any clone)
# =============================================================================
#   bash scripts/add-crapi-provider.sh
#
# For any provider whose API matches the "CR API Guide" shape:
#   URL      : http://host/crapi/<name>/viewstats
#   params   : token, dt1, dt2, records, filternum, filtercli
#   success  : {"status":"success","total":N,"data":[{dt,num,cli,message,payout}]}
#   error    : {"status":"error","msg":"Not Authorized"}
#
# Writes ONE row into sync_providers. No UI change, no panel change, no
# restart needed — the background sync worker picks it up on its next tick.
# =============================================================================
set -u

BASE="${BASE:-http://localhost:4000}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
say()  { printf '%s\n' "$*"; }

ask() {
  local __v="$1" __p="$2" __d="${3:-}" __in=""
  if [ -n "$__d" ]; then printf '%s [%s]: ' "$__p" "$__d"; else printf '%s: ' "$__p"; fi
  read -r __in </dev/tty
  [ -z "$__in" ] && __in="$__d"
  printf -v "$__v" '%s' "$__in"
}
jesc() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

command -v python3 >/dev/null || { err "python3 required"; exit 1; }
command -v curl    >/dev/null || { err "curl required";    exit 1; }

bold ""
bold "==============================================="
bold " Power X SMS — add a CR-API provider"
bold "==============================================="
say ""

# ---------------------------------------------------------------- login ----
ask ADMIN_USER "Power X admin username" "vibepk"
printf 'Power X admin password: '
read -rs ADMIN_PASS </dev/tty; echo

TOKEN=$(curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d "{\"username\":$(jesc "$ADMIN_USER"),\"password\":$(jesc "$ADMIN_PASS")}" \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("token",""))
except Exception: print("")')

[ -z "$TOKEN" ] && { err "Login failed. Check credentials and that Power X runs on $BASE"; exit 1; }
ok "✓ Logged in"
say ""

# -------------------------------------------------------------- details ----
say "--- Provider details --------------------------------------------"
ask P_NAME "Provider name (any label, must be unique)" "Fly"
ask P_URL  "API URL" "http://51.77.216.195/crapi/fly/viewstats"
printf 'API token: '
read -r P_TOKEN </dev/tty
[ -z "$P_TOKEN" ] && { err "Token cannot be empty"; exit 1; }

say ""
say "--- Polling ------------------------------------------------------"
# The guide states: "records ... Max value is 200". Asking for the maximum
# minimises the number of round trips; the backlog drain handles the rest.
ask REC_COUNT "Records per request (provider max is 200)" "200"
ask INTERVAL  "Poll interval seconds" "12"
ask OVERLAP   "Safety overlap seconds" "30"

# ---------------------------------------------------------------- build ----
CONFIG=$(python3 - "$P_URL" "$P_TOKEN" "$REC_COUNT" <<'PY'
import json,sys
url,token,rec=sys.argv[1:4]
cfg={
  "url":url,"method":"GET",
  "auth":"query","auth_query":"token","token":token,
  # CR API window parameters, exactly as documented
  "from_param":"dt1","to_param":"dt2","since_format":"sql",
  "records_param":"records","records":int(rec),
  "records_path":"data",
  # documented response fields: dt, num, cli, message, payout
  "map":{"number":"num","cli":"cli","message":"message","date":"dt","payout":"payout"},
  # Drain a truncated backlog by walking dt2 backwards. Only activates when a
  # response comes back completely full (see fetchAllPages in providerSync.js).
  "max_pages":20
}
print(json.dumps(cfg))
PY
)

BODY=$(python3 - "$P_NAME" "$CONFIG" "$INTERVAL" "$OVERLAP" <<'PY'
import json,sys
name,cfg,iv,ov=sys.argv[1:5]
print(json.dumps({"name":name,"connector":"generic_json","active":1,
                  "interval_seconds":int(iv),"overlap_seconds":int(ov),
                  "config_json":cfg}))
PY
)

say ""
bold "Configuration (token hidden):"
printf '%s\n' "$CONFIG" | python3 -c 'import sys,json
c=json.load(sys.stdin); c["token"]="********"; print(json.dumps(c,indent=2))'
say ""
ask CONFIRM "Save this provider? (y/n)" "y"
[ "$CONFIRM" = "y" ] || { say "Cancelled."; exit 0; }

# ----------------------------------------------------------------- save ----
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/sync/providers" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY")
CODE=$(printf '%s' "$RESP" | tail -n1)
JSON=$(printf '%s' "$RESP" | sed '$d')

get_pid() {
  curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/providers" \
   | python3 -c 'import sys,json;n=sys.argv[1]
rows=json.load(sys.stdin)
print(next((str(r["id"]) for r in rows if r["name"]==n),""))' "$P_NAME"
}

if [ "$CODE" = "409" ] || printf '%s' "$JSON" | grep -qi 'UNIQUE'; then
  say "Provider '$P_NAME' already exists — updating it."
  PID="$(get_pid)"
  [ -z "$PID" ] && { err "Could not find existing provider id"; exit 1; }
  curl -s -X PUT "$BASE/api/sync/providers/$PID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" >/dev/null
  ok "✓ Provider #$PID updated"
elif [ "$CODE" = "200" ]; then
  PID="$(get_pid)"
  ok "✓ Provider #$PID saved"
else
  err "Save failed (HTTP $CODE): $JSON"; exit 1
fi

# ----------------------------------------------------------------- test ----
say ""
bold "Running one test sync..."
RESULT=$(curl -s -X POST "$BASE/api/sync/providers/$PID/run" -H "Authorization: Bearer $TOKEN")
printf '%s\n' "$RESULT" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESULT"

val() { printf '%s' "$RESULT" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('$1',0))
except Exception: print(0)" 2>/dev/null || echo 0; }
FETCHED="$(val fetched)"; INSERTED="$(val inserted)"; FAILED="$(val failed)"

say ""
if printf '%s' "$RESULT" | grep -qi 'Not Authorized'; then
  err "Provider says: Not Authorized  ->  the token is wrong."
  say "  Ask your provider administrator for the correct token for this URL."
elif [ "$FETCHED" = "0" ]; then
  say "Connected, but 0 records returned."
  say "  This is normal if no SMS arrived in the polled window."
  say "  Check again in a few minutes:  curl -s -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sync/logs | head -30"
elif [ "$INSERTED" != "0" ]; then
  ok "✓ SUCCESS — fetched $FETCHED, saved $INSERTED. Syncing every ${INTERVAL}s."
elif [ "$FAILED" != "0" ]; then
  err "Fetched $FETCHED but saved 0 — all $FAILED rejected."
  say ""
  say "  Power X only stores an SMS if the number exists in a range AND is"
  say "  allocated to a client. Open the panel -> Failed SMS for the exact"
  say "  reason, import those numbers, allocate them, then run:"
  say "    curl -X POST '$BASE/api/sync/providers/$PID/run?full=1' -H \"Authorization: Bearer \$TOKEN\""
else
  ok "✓ Connected. fetched=$FETCHED, all already stored (no duplicates)."
fi

say ""
bold "Useful"
say "  Status : curl -s -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sync/status | python3 -m json.tool"
say "  Logs   : pm2 logs powerx --lines 50 | grep SYNC"
say "  Pause  : curl -X PUT $BASE/api/sync/providers/$PID -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"active\":0}'"
say "  Delete : curl -X DELETE $BASE/api/sync/providers/$PID -H \"Authorization: Bearer \$TOKEN\""
say ""
