#!/usr/bin/env bash
# pwbench uninstall — lab ko poori tarah remove (reports pehle /root me backup)
set -euo pipefail
DEST="/opt/powerx-bench"
[ -d "$DEST" ] || { echo "already gone"; exit 0; }
fuser -k 4888/tcp 2>/dev/null || true
fuser -k 4999/tcp 2>/dev/null || true
sleep 1
if [ -d "$DEST/reports" ]; then mkdir -p /root/pwbench-reports-backup; cp -a "$DEST/reports/." /root/pwbench-reports-backup/ 2>/dev/null || true; fi
sudo rm -rf "$DEST" /var/tmp/pw20
echo "✓ pwbench lab removed (reports backup: /root/pwbench-reports-backup)"
echo "  Note: PowerX production panel (/opt/powerx) ko touch NAHI kiya gaya."
