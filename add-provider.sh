#!/usr/bin/env bash
# =============================================================================
# Power X SMS — Add / update a provider API key (interactive)
# =============================================================================
# Run this ON THE VPS:   cd /root/Power X-sms && ./add-provider.sh
#
# It asks you for the API key + URL, builds the JSON for you, registers the
# provider through the admin API, then runs one test sync and shows the result.
#
# Nothing in the UI changes. This only writes a row into the sync_providers
# table, which is what the background sync worker reads.
# =============================================================================

set -u

BASE="${BASE:-http://localhost:4000}"

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

ask() {  # ask <var> <prompt> <default>
  local __v="$1" __p="$2" __d="${3:-}" __in=""
  if [ -n "$__d" ]; then printf '%s [%s]: ' "$__p" "$__d"; else printf '%s: ' "$__p"; fi
  read -r __in </dev/tty
  [ -z "$__in" ] && __in="$__d"
  printf -v "$__v" '%s' "$__in"
}

jsonesc() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

command -v python3 >/dev/null || { err "python3 is required"; exit 1; }
command -v curl    >/dev/null || { err "curl is required";    exit 1; }

bold ""
bold "==============================================="
bold " Power X SMS — add a provider API key"
bold "==============================================="
say ""

# ---------------------------------------------------------------- 1. login
ask ADMIN_USER "Power X admin username" "Power Xsms"
printf 'Power X admin password: '
read -rs ADMIN_PASS </dev/tty; echo

TOKEN=$(curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d "{\"username\":$(jsonesc "$ADMIN_USER"),\"password\":$(jsonesc "$ADMIN_PASS")}" \
  | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("token",""))
except Exception: print("")')

if [ -z "$TOKEN" ]; then
  err "Login failed. Check the username/password, and that Power X is running on $BASE"
  exit 1
fi
ok "✓ Logged in"
say ""

# ---------------------------------------------------------------- 2. details
say "--- Provider details -------------------------------------------"
ask P_NAME "Provider name (any label)"           "Lamix"
ask P_URL  "API base URL"                        "http://51.77.216.195/crapi/lamix/viewstats"
say ""
say "How is the API key sent?"
say "  1) In the URL as a query parameter   (?token=KEY)   <- lamix/viewstats"
say "  2) Authorization: Bearer KEY"
say "  3) A custom header                    (X-API-Key: KEY)"
ask AUTH_CHOICE "Choose 1/2/3" "1"

case "$AUTH_CHOICE" in
  2) AUTH_MODE="bearer"; AUTH_FIELD="" ;;
  3) AUTH_MODE="header"; ask AUTH_FIELD "Header name" "X-API-Key" ;;
  *) AUTH_MODE="query";  ask AUTH_FIELD "Query parameter name" "token" ;;
esac

printf 'API key / token: '
read -r P_TOKEN </dev/tty
[ -z "$P_TOKEN" ] && { err "API key cannot be empty"; exit 1; }

say ""
say "--- Date window parameters (leave defaults for lamix) -----------"
ask FROM_PARAM  "'from' parameter name"  "dt1"
ask TO_PARAM    "'to' parameter name"    "dt2"
ask REC_PARAM   "record-count parameter" "records"
ask REC_COUNT   "records per poll"       "50"
ask RECPATH     "JSON path to the array" "data"

say ""
say "--- Field mapping (provider field -> Power X field) ----------------"
ask M_NUMBER  "number field"  "num"
ask M_CLI     "CLI field"     "cli"
ask M_MESSAGE "message field" "message"
ask M_DATE    "date field"    "dt"
ask M_PAYOUT  "payout field"  "payout"

say ""
ask INTERVAL "Poll interval in seconds" "12"
ask OVERLAP  "Safety overlap seconds"   "30"

# ---------------------------------------------------------------- 3. build
CONFIG=$(python3 - "$P_URL" "$AUTH_MODE" "$AUTH_FIELD" "$P_TOKEN" "$FROM_PARAM" "$TO_PARAM" \
                   "$REC_PARAM" "$REC_COUNT" "$RECPATH" \
                   "$M_NUMBER" "$M_CLI" "$M_MESSAGE" "$M_DATE" "$M_PAYOUT" <<'PY'
import json,sys
(url,auth,field,token,fp,tp,rp,rc,path,mn,mc,mm,md,mp)=sys.argv[1:15]
cfg={"url":url,"method":"GET","auth":auth,"token":token,
     "from_param":fp,"to_param":tp,"since_format":"sql",
     "records_param":rp,"records":int(rc),"records_path":path,
     "map":{"number":mn,"cli":mc,"message":mm,"date":md,"payout":mp}}
if auth=="query":  cfg["auth_query"]=field
if auth=="header": cfg["auth_header"]=field
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
bold "Configuration to be saved (key hidden):"
printf '%s\n' "$CONFIG" | python3 -c 'import sys,json
c=json.load(sys.stdin); c["token"]="********"; print(json.dumps(c,indent=2))'
say ""
ask CONFIRM "Save this provider? (y/n)" "y"
[ "$CONFIRM" = "y" ] || { say "Cancelled."; exit 0; }

# ---------------------------------------------------------------- 4. save
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/sync/providers" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY")
CODE=$(printf '%s' "$RESP" | tail -n1)
JSON=$(printf '%s' "$RESP" | sed '$d')

if [ "$CODE" = "409" ] || printf '%s' "$JSON" | grep -qi 'UNIQUE'; then
  say "A provider named '$P_NAME' already exists — updating it instead."
  PID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/providers" \
    | python3 -c 'import sys,json;n=sys.argv[1]
rows=json.load(sys.stdin)
print(next((str(r["id"]) for r in rows if r["name"]==n),""))' "$P_NAME")
  [ -z "$PID" ] && { err "Could not find the existing provider id"; exit 1; }
  curl -s -X PUT "$BASE/api/sync/providers/$PID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" >/dev/null
  ok "✓ Provider #$PID updated"
elif [ "$CODE" = "200" ]; then
  ok "✓ Provider saved"
  PID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/providers" \
    | python3 -c 'import sys,json;n=sys.argv[1]
rows=json.load(sys.stdin)
print(next((str(r["id"]) for r in rows if r["name"]==n),""))' "$P_NAME")
else
  err "Save failed (HTTP $CODE): $JSON"
  exit 1
fi

# ---------------------------------------------------------------- 5. test
say ""
bold "Running one test sync..."
RESULT=$(curl -s -X POST "$BASE/api/sync/providers/$PID/run" -H "Authorization: Bearer $TOKEN")
printf '%s\n' "$RESULT" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESULT"

FETCHED=$(printf '%s' "$RESULT"  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("fetched",0))' 2>/dev/null || echo 0)
INSERTED=$(printf '%s' "$RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("inserted",0))' 2>/dev/null || echo 0)
FAILED=$(printf '%s' "$RESULT"   | python3 -c 'import sys,json;print(json.load(sys.stdin).get("failed",0))' 2>/dev/null || echo 0)

say ""
if [ "$FETCHED" = "0" ]; then
  err "The API returned 0 records."
  say "  -> Wrong API key, wrong URL, or no data in the current time window."
  say "  -> Check:  curl -s -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sync/logs | head -40"
elif [ "$INSERTED" != "0" ]; then
  ok "✓ SUCCESS — fetched $FETCHED, saved $INSERTED. Sync is live every ${INTERVAL}s."
elif [ "$FAILED" != "0" ]; then
  err "Fetched $FETCHED but saved 0 — all $FAILED were rejected."
  say ""
  say "  This is almost always: the provider's numbers are not imported"
  say "  and allocated in Power X. Power X only stores an SMS if the number"
  say "  exists in a range AND is allocated to a client."
  say ""
  say "  Open the panel -> Failed SMS to see the exact reason,"
  say "  import those numbers into a range with the right rate card,"
  say "  allocate them, then run:"
  say "    curl -X POST $BASE/api/sync/providers/$PID/run?full=1 -H \"Authorization: Bearer \$TOKEN\""
else
  ok "✓ Connected. fetched=$FETCHED, all records already stored (no duplicates)."
fi

say ""
bold "Useful commands"
say "  Status : curl -s -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sync/status | python3 -m json.tool"
say "  Logs   : pm2 logs powerx --lines 50 | grep SYNC"
say "  Pause  : curl -X PUT $BASE/api/sync/providers/$PID -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"active\":0}'"
say "  Delete : curl -X DELETE $BASE/api/sync/providers/$PID -H \"Authorization: Bearer \$TOKEN\""
say ""
