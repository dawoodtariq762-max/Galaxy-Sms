#!/usr/bin/env bash
# ============================================================================
# Galaxy SMS — Chat deployment self-check
# VPS par run karo:   bash scripts/verify-chat-deploy.sh
# (koi secret/password NAHI hai — sirf file-level checks. Fix #1 deployment
#  gap pakarne ke liye banaya gaya: pichhli deploy me NAYI files commit nahi
#  hui thi, sirf MODIFIED files push hui thi.)
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
FAIL=0
ok()   { echo "OK   $1"; }
bad()  { echo "FAIL $1"; FAIL=1; }

echo "== 1) Chat files maujood hain? =="
[ -f backend/chat.js ]    && ok "backend/chat.js exists"    || bad "backend/chat.js MISSING (chat backend — deploy incomplete)"
[ -f assets/chat.js ]     && ok "assets/chat.js exists"     || bad "assets/chat.js MISSING (chat UI — panel me Chat blank isliye tha)"

echo "== 2) server.js chat module mount karta hai? =="
if grep -q "require('./chat')" backend/server.js 2>/dev/null; then
  ok "server.js mounts chat module"
  # mount hai lekin module missing = restart par CRASH — sanity warn
  [ -f backend/chat.js ] || bad "server.js mount hai lekin backend/chat.js MISSING — pm2 restart pe server crash hoga!"
else
  bad "server.js me chat mount NAHI hai (purana server.js deploy hua hai)"
fi

echo "== 3) Panels chat.js load karte hain + nav items? =="
for f in admin.html manager.html agent.html client.html; do
  if grep -q 'assets/chat.js?v=gxchat' "$f" 2>/dev/null; then ok "$f loads chat.js"; else bad "$f chat.js tag missing"; fi
  if grep -q 'data-page="chat"' "$f" 2>/dev/null; then ok "$f has Chat nav item"; else bad "$f Chat nav missing"; fi
done

echo "== 4) Schema tables? =="
grep -q "chat_conversations" backend/schema.js 2>/dev/null && ok "schema.js has chat tables" || bad "schema.js chat tables missing"

echo "== 5) Range scoping (P19f) applied? =="
grep -q "P19f FIX (owner: Range selectors role-scoped)" backend/server.js 2>/dev/null && ok "/api/ranges role-scoping present" || bad "/api/ranges scoping missing (purana server.js)"

echo
if [ "$FAIL" = "0" ]; then
  echo "SAB OK — ab:"
  echo "  pm2 restart galaxy"
  echo "  phir browser me Ctrl+Shift+R (hard refresh) — Chat nav dikhna chahiye."
else
  echo ">>> DEPLOYMENT INCOMPLETE — upar wale FAIL fix karo (files push karo),"
  echo ">>> sirf uske BAAD pm2 restart galaxy chalao."
  exit 1
fi
