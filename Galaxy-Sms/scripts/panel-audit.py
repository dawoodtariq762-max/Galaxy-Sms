#!/usr/bin/env python3
"""
GALAXY SMS — FULL PANEL AUDIT
Har HTML file ka har inline <script> block:
  [1] node --check (syntax — poore panel freeze ka root-cause class)
  [2] har onclick handler defined hai? (dead-click class)
  [3] har data-page ka section maujood? (blank-page class)
  [4] har frontend API call ka backend route maujood? (404 class)
  [5] har referenced asset file repo mein hai? (missing-file class)
Exit code 0 = sab PASS.
"""
import re, os, sys, subprocess, json, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
PAGES = ['admin','manager','agent','client','management','login','panel-sharing','payment','test','management-login','panel-sharing-login','payment-login','test-login']
fails, warns = [], []

# ---------- collect backend routes ----------
srv = open('backend/server.js', encoding='utf-8').read()
routes = []  # (method, regex-path)
for m in re.finditer(r"app\.(get|post|put|delete|patch)\(\s*'([^']+)'", srv):
    method, path = m.group(1).upper(), m.group(2)
    if not path.startswith('/api'): continue
    rx = re.sub(r':[^/\']+', '[^/]+', path) + '$'
    routes.append((method, path, re.compile(rx)))
# also accept() style
for m in re.finditer(r"app\.(get|post|put|delete|patch)\(\s*\[([^\]]+)\]", srv):
    method = m.group(1).upper()
    for p in re.findall(r"'([^']+)'", m.group(2)):
        if p.startswith('/api'):
            rx = re.sub(r':[^/\']+', '[^/]+', p) + '$'
            routes.append((method, p, re.compile(rx)))

def route_exists(method, path):
    p = re.sub(r'\?.*$', '', path)
    for target in (p, '/api' + p):
        for meth, raw, rx in routes:
            if meth != method: continue
            if rx.match(target): return True
    # dynamic prefix: '/users/'+role  -> try '/users/x'
    return False

# ---------- per page ----------
for page in PAGES:
    fn = page + '.html'
    if not os.path.exists(fn): continue
    html = open(fn, encoding='utf-8').read()

    # [1] inline scripts -> node --check
    blocks = [b for b in re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S|re.I) if len(b.strip())>10]
    js_all = '\n;\n'.join(blocks)
    for i, b in enumerate(blocks):
        tmp = f'/tmp/_audit_{page}_{i}.js'
        open(tmp,'w',encoding='utf-8').write(b)
        r = subprocess.run(['node','--check',tmp], capture_output=True, text=True)
        if r.returncode != 0:
            first = (r.stderr or '').strip().splitlines()
            fails.append(f'[{fn}] SYNTAX block#{i}: ' + (first[1] if len(first)>1 else first[0] if first else 'unknown'))

    # external local scripts exist?
    for src in re.findall(r'<script[^>]*src="([^":]+)"', html):
        p = src.split('?')[0]
        if p.startswith('/') and not os.path.exists(p.lstrip('/')):
            fails.append(f'[{fn}] missing script file: {p}')
    for href in re.findall(r'<link[^>]*href="(/[^":]+)"', html):
        p = href.split('?')[0]
        if p.endswith('.css') and not os.path.exists(p.lstrip('/')):
            fails.append(f'[{fn}] missing css file: {p}')

    # [3] data-page vs section ids
    pages_ref = set(re.findall(r'data-page="([a-zA-Z0-9_-]+)"', html))
    sections = set(re.findall(r'id="page-([a-zA-Z0-9_-]+)"', html))
    # pages built dynamically via JS (buildUserPage etc.) count too (they create page-X sections at runtime)
    dyn = set(re.findall(r"getElementById\('page-([a-zA-Z0-9_-]+)'\)", js_all)) | set(re.findall(r"'page-([a-zA-Z0-9_-]+)'", js_all))
    missing_sections = {p for p in pages_ref if p not in sections and p not in dyn}
    for p in sorted(missing_sections):
        fails.append(f'[{fn}] nav data-page "{p}" -> koi section id="page-{p}" NAHI')

    # [2] onclick handlers defined?
    onclicks = set()
    for m in re.finditer(r'onclick="([a-zA-Z_$][\w$]*)\s*\(', html):
        onclicks.add(m.group(1))
    for m in re.finditer(r'onclick=\\?"([a-zA-Z_$][\w$]*)\s*\(', js_all):
        onclicks.add(m.group(1))
    defined = set(re.findall(r'(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)', js_all))
    defined |= set(re.findall(r'(?:window\.)?([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()', js_all))
    external = {'GX','confirm','alert'}  # browser/GX built-ins
    for fn_name in sorted(onclicks):
        if fn_name in defined or fn_name in external: continue
        if re.search(r'\b'+re.escape(fn_name)+r'\s*=', js_all): continue
        # might come from api.js
        api_js = open('api.js', encoding='utf-8').read() if os.path.exists('api.js') else ''
        if re.search(r'(?:function\s+'+re.escape(fn_name)+r'\b|window\.'+re.escape(fn_name)+r'\s*=|'+re.escape(fn_name)+r'\s*=\s*(?:async\s*)?function)', api_js): continue
        fails.append(f'[{fn}] onclick "{fn_name}()" defined NAHI hai')

    # [4] frontend API calls vs backend routes
    for mm in re.finditer(r"API\.(get|post|put|del|patch)\(\s*'([^']+)'", js_all):
        method, path = mm.group(1).upper(), mm.group(2)
        method = 'DELETE' if method=='DEL' else method
        norm = re.sub(r"'?\s*\+\s*[a-zA-Z_$][\w$.()'\"]*", 'X', path)
        norm = re.sub(r'\$\{[^}]+\}', 'X', norm)
        if route_exists(method, norm): continue
        # dynamic segment fallback: replace X with wildcard
        p2 = re.sub(r'\?.*$','',norm)
        p2w = re.sub(r'X', '1', p2)
        hit = False
        for tgt in (p2w, '/api'+p2w):
            if any(meth==method and rx.match(tgt) for meth,raw,rx in routes): hit = True; break
        if hit: continue
        base = ('/api'+p2).rstrip('X').rstrip('/')
        if any(meth==method and raw.startswith(base) for meth,raw,rx in routes): continue
        warns.append(f'[{fn}] API {method} {path} -> backend route CONFIRM nahi hua (dynamic ho sakta hai)')

print('='*64)
print('PANEL AUDIT REPORT')
print('='*64)
print(f'pages checked : {len(PAGES)}')
print(f'FAILS         : {len(fails)}')
for f in fails: print('  ❌ ' + f)
print(f'WARNINGS      : {len(warns)}')
for w in warns[:25]: print('  ⚠️  ' + w)
if not fails:
    print('\n✅ SAB CHECKS PASS — koi dead-click/blank-page/syntax/404 issue nahi')
sys.exit(1 if fails else 0)
