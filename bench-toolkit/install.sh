#!/usr/bin/env bash
# pwbench install — repo/bench-toolkit -> /opt/powerx-bench (TEMPORARY lab; uninstall.sh se poora remove)
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/opt/powerx-bench"
APP_ROOT="${1:-/opt/powerx}"
[ -d "$APP_ROOT/backend" ] || { echo "✗ $APP_ROOT/backend nahi mila — PowerX install path do: sudo ./install.sh /opt/powerx"; exit 1; }
sudo mkdir -p "$DEST"
sudo cp -r "$SRC"/. "$DEST"/
TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p)"
sudo python3 - "$DEST" "$APP_ROOT" "$TOKEN" <<'EOF'
import json,sys
d,a,t=sys.argv[1],sys.argv[2],sys.argv[3]
p=d+'/bench.config.json'
c=json.load(open(p)); c['APP_ROOT']=a; c['TOKEN']=t
json.dump(c,open(p,'w'),indent=2)
EOF
sudo chmod 600 "$DEST/bench.config.json"
sudo chmod +x "$DEST/pwbench" "$DEST"/modes/*.js 2>/dev/null || true
sudo mkdir -p "$DEST/reports" "$DEST/run"
echo "✓ pwbench lab installed: $DEST"
echo "  TOKEN (sambhal lo, har run par chahiye): $TOKEN"
echo
echo "Quick start (VPS par):"
echo "  cd $DEST"
echo "  sudo ./pwbench selftest   --token $TOKEN"
echo "  sudo ./pwbench inventory  --token $TOKEN --SCALE S2"
echo "  sudo SCREEN/PM2 se long runs: soak, combined"
echo "  monitor (optional, alag terminal): node $DEST/monitor.js  → http://127.0.0.1:4999"
echo "  stop: sudo ./pwbench stop --token $TOKEN   |   report: sudo ./pwbench report --token $TOKEN   |   cleanup: sudo ./pwbench cleanup --token $TOKEN"
