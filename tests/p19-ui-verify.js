#!/usr/bin/env node
/* ===========================================================================
 * P19 UI VERIFICATION — jsdom DOM-level runtime check (no real browser in sandbox)
 * ---------------------------------------------------------------------------
 * Kya test hota hai (honest scope — sirf yahi claim kiya jata hai):
 *   - Har panel (admin/manager/agent/client) REAL server ke against jsdom me boot
 *     hota hai (inline scripts + api.js live chalte hain, fetch polyfill se).
 *   - Uncaught script exceptions capture hote hain (navigation/CSS noise filtered).
 *   - FIX#1: AI settings input value load + save (UI write path E2E).
 *   - FIX#3: SMS Report me CLI dropdown/box ka ABSENCE; SMS Detail facet (tick CLI
 *     -> value list -> click -> filtered rows -> unpick) real API data par.
 *   - FIX#4: admin rate UI elements + hint; allocAllModal E2E (default rate auto-fill
 *     Rate Management se + override 0.019 -> numbers.rate par landing).
 *   - Manager/Agent par rate UI ka ABSENCE (no new ability).
 *   - Client: stCli preserved (behaviour as-is).
 *   - Mobile: STATIC checks (viewport meta + @media queries + naye controls ki widths)
 *     — real device rendering sandbox me possible nahi; report me clearly likha hai.
 * Run: node tests/p19-ui-verify.js   (repo root se; jsdom path auto-detected)
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* jsdom resolve: /tmp/uitest me install hai (repo ko clean rakhne ke liye) */
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (e) {
  for (const p of ['/tmp/uitest/node_modules/jsdom', path.join(process.env.HOME || '', 'uitest/node_modules/jsdom')]) {
    try { ({ JSDOM, VirtualConsole } = require(p)); break; } catch (e2) {}
  }
}
if (!JSDOM) { console.error('jsdom not found — npm i jsdom in a scratch dir'); process.exit(2); }

const PORT = process.env.P19_UI_PORT || '8093';
const BASE = 'http://127.0.0.1:' + PORT;
const SRC_DB = '/tmp/p19test.db';        // p19-verify.js ke run ka fixture (rich data)
const DB = process.env.P19_UI_DB || '/tmp/p19ui.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

process.on('unhandledRejection', (e) => { /* jsdom windows ke late async renders close() ke baad — harness artifact, run continue */ if (process.env.P19_VERBOSE) console.error('[late-async]', e && e.message); });
let PASS = 0, FAIL = 0;
const results = [];
function t(name, ok, detail) {
  const line = (ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '');
  results.push(line); console.log(line);
  if (ok) PASS++; else FAIL++;
}

async function api(p, method = 'GET', body, tok) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j; try { j = await r.json(); } catch (e) { j = { parseErr: String(e) }; }
  return { s: r.status, j };
}

/* ---------------- server lifecycle ---------------- */
let srv = null;
function startServer() {
  return new Promise((resolve, reject) => {
    fs.copyFileSync(SRC_DB, DB);
    for (const f of [DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    srv = spawn('node', ['backend/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_FILE: DB, PORT: String(PORT), JWT_SECRET: 'p19test', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    srv.stderr.on('data', d => { if (process.env.P19_VERBOSE) process.stderr.write('[srv] ' + d); });
    setTimeout(() => resolve(), 2500);
  });
}

/* ---------------- jsdom panel boot ---------------- */
const NOISE = [/Not implemented: navigation/i, /Could not parse CSS/i, /not implemented/i];
async function bootPanel(pagePath, { token, role, user, name }) {
  const errors = [];
  const alerts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!NOISE.some(rx => rx.test(m))) errors.push('jsdomError: ' + m.split('\n')[0]); });
  vc.on('error', (...a) => { const m = a.join(' '); if (!NOISE.some(rx => rx.test(m))) errors.push('console.error: ' + m.split('\n')[0]); });
  const dom = await JSDOM.fromURL(BASE + pagePath, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      /* fetch polyfill: relative -> BASE (Node global fetch) */
      window.fetch = (input, init) => {
        const url = new URL(String(input), BASE).href;
        return fetch(url, init);
      };
      window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }));
      window.alert = (m) => { alerts.push(String(m)); };
      window.confirm = (m) => { alerts.push('CONFIRM:' + m); return true; };
      window.scrollTo = () => {};
      try {
        window.localStorage.setItem('ms_token', token);
        window.localStorage.setItem('ms_role', role);
        window.localStorage.setItem('ms_user', user);
        window.localStorage.setItem('ms_name', name);
      } catch (e) { errors.push('localStorage seed: ' + e.message); }
    }
  });
  await sleep(2500); // boot + initial API loads
  return { dom, errors, alerts, window: dom.window, close: async () => { await sleep(1200); try { dom.window.close(); } catch (e) {} } };
}

(async () => {
  console.log('P19 UI verification — ' + new Date().toISOString());
  console.log('DB: ' + DB + '  BASE: ' + BASE);
  if (!fs.existsSync(SRC_DB)) { console.error('fixture ' + SRC_DB + ' missing — pehle node tests/p19-verify.js run karein'); process.exit(2); }
  await startServer();

  /* logins */
  const admTok = (await api('/api/login', 'POST', { username: 'vibepk', password: 'vibepk123' })).j.token;
  const m1Tok = (await api('/api/login', 'POST', { username: 'p19m1', password: 'Test123!' })).j.token;
  const a1Tok = (await api('/api/login', 'POST', { username: 'p19a1', password: 'Test123!' })).j.token;
  const c1Tok = (await api('/api/login', 'POST', { username: 'p19c1', password: 'Test123!' })).j.token;
  t('setup: all four panel logins', !!(admTok && m1Tok && a1Tok && c1Tok));

  /* fixture facts */
  const users = (await api('/api/users', 'GET', null, admTok)).j;
  const allUsers = Array.isArray(users) ? users : (users.users || []);
  const A2 = allUsers.find(u => u.username === 'p19a2');
  const preNum = (await api('/api/numbers?search=448000000003&limit=5', 'GET', null, admTok)).j;
  const preRow = (preNum.rows || [])[0];
  t('setup: target number 448000000003 exists + unallocated', !!preRow && !preRow.manager_id && !preRow.agent_id && !preRow.client_id, JSON.stringify(preRow && { id: preRow.id, agent: preRow.agent || null }));

  /* ======================= ADMIN ======================= */
  console.log('\n--- ADMIN PANEL ---');
  {
    const P = await bootPanel('/admin', { token: admTok, role: 'admin', user: 'vibepk', name: 'vibepk' });
    const w = P.window, d = w.document;
    t('UI-A1 admin boots with 0 uncaught script errors', P.errors.length === 0, P.errors.slice(0, 3).join(' ;; '));

    /* FIX#1 */
    const am = d.getElementById('aiAllocMax');
    t('UI-A2 FIX#1 aiAllocMax input exists (AI settings UI)', !!am);
    if (am) {
      const before = (await api('/api/assistant/knowledge', 'GET', null, admTok)).j.settings.alloc_max;
      await w.loadAiKnowledge(); await sleep(600);
      t('UI-A3 FIX#1 input auto-fills from settings', am.value === String(before), 'input=' + am.value + ' settings=' + before);
      am.value = '120';
      await w.saveAiAllocMax(); await sleep(700);
      const after = (await api('/api/assistant/knowledge', 'GET', null, admTok)).j.settings.alloc_max;
      t('UI-A4 FIX#1 UI save path (set 120, backend reflects)', after === '120' && P.alerts.some(a => /120/.test(a)), 'after=' + after + ' alerts=' + JSON.stringify(P.alerts.slice(-1)));
      am.value = 'abc';
      await w.saveAiAllocMax(); await sleep(300);
      t('UI-A5 FIX#1 invalid UI value blocked client-side', P.alerts.some(a => /1 se 5000/.test(a)), JSON.stringify(P.alerts.slice(-1)));
      am.value = before; await w.saveAiAllocMax(); await sleep(500); // restore
    }

    /* FIX#3 — SMS Report: no CLI dropdown/box (admin pages lazily build via loadAdminPageData) */
    await w.loadAdminPageData('smsReport'); await sleep(700);
    t('UI-A6 FIX#3 SMS Report: srCli element ABSENT', !d.getElementById('srCli'));
    t('UI-A7 FIX#3 SMS Report: Range/Number/Manager filters intact', !!(d.getElementById('srRange') && d.getElementById('srNumber') && d.getElementById('srManager')));

    /* FIX#3 — SMS Detail facet flow (real API data) */
    await w.loadAdminPageData('smsDetail'); await sleep(900);
    const sdUseCli = d.getElementById('sdUseCli');
    t('UI-A8 FIX#3 SMS Detail: CLI dimension tick exists', !!sdUseCli);
    if (sdUseCli) {
      sdUseCli.checked = true;
      w.toggleDetailFilters();
      await w.renderSmsDetail(); await sleep(900);
      const facetRows = [...d.querySelectorAll('#sdBody .gx-facet-row')].map(tr => tr.textContent.trim());
      const has333 = facetRows.some(x => x.includes('333'));
      const has444 = facetRows.some(x => x.includes('444'));
      t('UI-A9 FIX#3 tick CLI -> facet list shows today CLIs (333,444 from live data)', has333 && has444 && facetRows.length >= 5, JSON.stringify(facetRows).slice(0, 160));
      w.sdPick('cli', '333');
      await w.renderSmsDetail(); await sleep(900);
      const drillRows = [...d.querySelectorAll('#sdBody tr')].map(tr => tr.textContent);
      const chip = d.querySelector('.gx-chip');
      t('UI-A10 FIX#3 click CLI 333 -> detail rows only 333 + chip shown', drillRows.length === 2 && drillRows.every(x => x.includes('333')) && !!chip && chip.textContent.includes('333'), 'rows=' + drillRows.length + ' chip=' + (chip ? chip.textContent.trim().slice(0, 40) : 'none'));
      w.sdUnpick('cli');
      await w.renderSmsDetail(); await sleep(700);
      t('UI-A11 FIX#3 unpick -> filter cleared (chip gone)', !d.querySelector('.gx-chip'), 'chips=' + d.querySelectorAll('.gx-chip').length);
      sdUseCli.checked = false; w.toggleDetailFilters();
    }

    /* FIX#4 — elements + E2E */
    t('UI-A12 FIX#4 aaRate + hint + allocRate + refresh exist', !!(d.getElementById('aaRate') && d.getElementById('aaRateHint') && d.getElementById('allocRate') && (typeof w.allocRateRefresh === 'function')));
    const hintTxt = (d.getElementById('aaRateHint') || {}).textContent || '';
    t('UI-A13 FIX#4 hint text (override-only message)', /Default rate Rate Management se aata hai/.test(hintTxt) && /sirf YEH allocation override/.test(hintTxt), hintTxt.slice(0, 90));

    /* numbers page -> select unallocated R2 number -> allocAll modal */
    await w.showPageByName('numbers'); await sleep(400);
    await w.loadNumbers(); await sleep(1200);
    d.getElementById('numSearch').value = '448000000003';
    w.renderNumbers(); await sleep(300);
    const chk = d.querySelector('.rowchk');
    t('UI-A14 FIX#4 numbers page: target row rendered + checkbox', !!chk, 'rows=' + d.querySelectorAll('.rowchk').length);
    if (chk) {
      chk.checked = true;
      await w.openAllocAll(); await sleep(900);
      const aaRate = d.getElementById('aaRate');
      t('UI-A15 FIX#4 allocAllModal: default rate auto-fills from Rate Management (0.020)', aaRate && Number(aaRate.value) === 0.020, 'aaRate=' + JSON.stringify(aaRate && aaRate.value));
      /* pick Agent: p19a2 */
      const sel = d.getElementById('aaClient');
      const opt = [...sel.options].find(o => /p19a2/.test(o.textContent));
      sel.value = opt ? opt.value : '';
      aaRate.value = '0.019'; aaRate.dataset.dirty = '1';
      await w.confirmAllocAll(); await sleep(1400);
      const post = (await api('/api/numbers?search=448000000003&limit=5', 'GET', null, admTok)).j;
      const row = (post.rows || [])[0];
      t('UI-A16 FIX#4 E2E: override 0.019 lands on number (allocation via UI path)', row && Number(row.effective_rate) === 0.019, JSON.stringify(row && { agent: row.agent, rate: row.rate, eff: row.effective_rate }));
      const rangesNow = (await api('/api/ranges', 'GET', null, admTok)).j;
      const r2row = (Array.isArray(rangesNow) ? rangesNow : []).find(x => x.name === 'P19R2');
      t('UI-A17 FIX#4 E2E: Rate Management range rate unchanged (0.020)', r2row && Number(r2row.rate_7_1) === 0.020, 'R2 rate_7_1=' + (r2row ? r2row.rate_7_1 : 'missing'));
    }
    await P.close();
  }

  /* ======================= MANAGER ======================= */
  console.log('\n--- MANAGER PANEL ---');
  {
    const P = await bootPanel('/manager', { token: m1Tok, role: 'manager', user: 'p19m1', name: 'p19m1' });
    const w = P.window, d = w.document;
    t('UI-M1 manager boots with 0 uncaught script errors', P.errors.length === 0, P.errors.slice(0, 3).join(' ;; '));
    t('UI-M2 FIX#3 manager SMS Report: srCli ABSENT, other filters intact', !d.getElementById('srCli') && !!(d.getElementById('srRange') || d.getElementById('srNumber')));
    t('UI-M3 FIX#4 manager has NO rate UI (no new ability)', !d.getElementById('aaRate') && !d.getElementById('allocRate'));
    t('UI-M4 manager allocAll modal intact (payterm+payout)', !!(d.getElementById('aaPayterm') && d.getElementById('aaPayout')));
    const sdUseCli = d.getElementById('sdUseCli');
    if (sdUseCli) {
      sdUseCli.checked = true; w.toggleDetailFilters();
      await w.renderSmsDetail(); await sleep(900);
      const rows = [...d.querySelectorAll('#sdBody .gx-facet-row')].map(tr => tr.textContent.trim());
      const sees = k => rows.some(x => x.includes(k));
      t('UI-M5 FIX#3 manager facet: subtree CLIs (333,555,666,888) not A2-direct (444,121,131)', sees('333') && sees('555') && sees('666') && sees('888') && !sees('444') && !sees('121') && !sees('131'), JSON.stringify(rows).slice(0, 140));
      sdUseCli.checked = false; w.toggleDetailFilters();
    } else t('UI-M5 FIX#3 manager facet tick exists', false, 'sdUseCli missing');
    await P.close();
  }

  /* ======================= AGENT ======================= */
  console.log('\n--- AGENT PANEL ---');
  {
    const P = await bootPanel('/agent', { token: a1Tok, role: 'agent', user: 'p19a1', name: 'p19a1' });
    const w = P.window, d = w.document;
    t('UI-G1 agent boots with 0 uncaught script errors', P.errors.length === 0, P.errors.slice(0, 3).join(' ;; '));
    t('UI-G2 FIX#3 agent SMS Report: srCli ABSENT', !d.getElementById('srCli'));
    t('UI-G3 FIX#4 agent has NO rate UI', !d.getElementById('aaRate') && !d.getElementById('allocRate'));
    const sdUseCli = d.getElementById('sdUseCli');
    const sdUseTime = d.getElementById('sdUseTime');
    t('UI-G4 FIX#3 agent SMS Detail: CLI tick + Time filter present', !!sdUseCli && !!sdUseTime);
    if (sdUseCli) {
      sdUseCli.checked = true; w.toggleDetailFilters();
      await w.renderSmsDetail(); await sleep(900);
      const rows = [...d.querySelectorAll('#sdBody .gx-facet-row')].map(tr => tr.textContent.trim());
      const sees = k => rows.some(x => x.includes(k));
      t('UI-G5 FIX#3 agent facet: own CLIs only (333,555,666) not others (444,888,121)', sees('333') && sees('555') && sees('666') && !sees('444') && !sees('888') && !sees('121'), JSON.stringify(rows).slice(0, 140));
      if (sdUseTime) { /* Time filter wired: tick + render must not throw */
        let err = null;
        try { sdUseTime.checked = true; w.toggleDetailFilters(); await w.renderSmsDetail(); await sleep(700); } catch (e) { err = e.message; }
        t('UI-G6 agent Time filter wired (tick + render no error)', !err, err || 'ok');
        sdUseTime.checked = false;
      }
      sdUseCli.checked = false; w.toggleDetailFilters();
    }
    await P.close();
  }

  /* ======================= CLIENT ======================= */
  console.log('\n--- CLIENT PANEL ---');
  {
    const P = await bootPanel('/client', { token: c1Tok, role: 'client', user: 'p19c1', name: 'p19c1' });
    const w = P.window, d = w.document;
    t('UI-C1 client boots with 0 uncaught script errors', P.errors.length === 0, P.errors.slice(0, 3).join(' ;; '));
    t('UI-C2 client stCli preserved (behaviour as-is)', !!d.getElementById('stCli'));
    await P.close();
  }

  /* ======================= MOBILE (static) ======================= */
  console.log('\n--- MOBILE (static analysis) ---');
  for (const f of ['admin.html', 'manager.html', 'agent.html', 'client.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const vp = /<meta[^>]+name=["']viewport["'][^>]*>/.test(src);
    const media = (src.match(/@media[^{]+{/g) || []).length;
    const wide = [...src.matchAll(/id=["'](aaRate|aiAllocMax|allocRate)["'][^>]*style=["']([^"']*)["']/g)]
      .filter(m => { const wm = m[2].match(/width:\s*(\d+)px/); return wm && parseInt(wm[1], 10) > 400; }).length;
    t('UI-X ' + f + ': viewport meta + ' + media + ' media queries + no wide fixed inputs', vp && media > 0 && wide === 0, 'vp=' + vp + ' media=' + media + ' wide=' + wide);
  }

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  if (srv) srv.kill();
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); if (srv) srv.kill(); process.exit(1); });
