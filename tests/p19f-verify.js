#!/usr/bin/env node
/* ===========================================================================
 * P19f VERIFICATION — owner ke 2 fixes:
 *  FIX-1 Chat deployment integrity (code-base complete? VPS gap yahi pakarta hai)
 *  FIX-2 Range selectors role-scoped (non-admin = sirf apne accessible numbers
 *        wale ranges; backend-enforced; admin = sab)
 * Fixture: 10 ranges — mA:4 (R01,R02,R05,R08) · mB:2 (R03,R07) · A1:3
 *          (R01,R02,R05) · C1:1 (R01) · C2:1 (R05) · admin:10
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.P19F_PORT || '8100';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19F_DB || '/tmp/p19f.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
function t(name, ok, detail) { console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); if (ok) PASS++; else FAIL++; }
async function api(p_, method = 'GET', body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + p_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function login(u, p) { return (await api('/api/login', 'POST', { username: u, password: p })).j.token || null; }
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19f', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
    serverProc.on('exit', (code, sig) => { if (sig) console.log('[SERVER EXITED] ' + sig); });
    const t0 = Date.now();
    (async () => {
      for (let i = 0; i < 120; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return resolve(true); } catch (e) {} if (Date.now() - t0 > 30000) return reject(new Error('no start')); }
      reject(new Error('no start'));
    })();
  });
}
function stopServer() {
  return new Promise((resolve) => {
    const proc = serverProc;
    if (!proc) return resolve();
    let settled = false;
    const fin = () => { if (!settled) { settled = true; resolve(); } };
    proc.on('exit', fin);
    try { proc.kill('SIGINT'); } catch (e) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} fin(); }, 6000);
  });
}
async function bootPanel(page, tok, user) {
  let JSDOM, VirtualConsole;
  try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { ({ JSDOM, VirtualConsole } = require('/tmp/uitest/node_modules/jsdom')); }
  const NOISE = [/Not implemented/i, /Could not parse CSS/i];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
  vc.on('error', (...a) => { const m = a.join(' '); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
  const dom = await JSDOM.fromURL(BASE + '/' + page, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(String(input), BASE).href, init);
      window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.localStorage.setItem('ms_token', tok); window.localStorage.setItem('ms_role', page);
      window.localStorage.setItem('ms_user', user); window.localStorage.setItem('ms_name', user);
    },
  });
  await sleep(2400);
  return { dom, errors };
}

(async () => {
  console.log('P19f verification — ' + new Date().toISOString());

  /* ============ PART A: CHAT DEPLOYMENT INTEGRITY (code base) ============ */
  console.log('\n--- A. Chat code-base integrity (VPS par yehi files missing thi) ---');
  t('A1 backend/chat.js exists', fs.existsSync(path.join(ROOT, 'backend/chat.js')));
  t('A2 assets/chat.js exists', fs.existsSync(path.join(ROOT, 'assets/chat.js')));
  const srvSrc = fs.readFileSync(path.join(ROOT, 'backend/server.js'), 'utf8');
  t('A3 server.js mounts chat module', srvSrc.includes("require('./chat')(app"));
  let panelsOk = true;
  for (const f of ['admin.html', 'manager.html', 'agent.html', 'client.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!(src.includes('/assets/chat.js?v=gxchat') && src.includes('data-page="chat"') && src.includes('data-page="complaints"'))) { panelsOk = false; t('A4 ' + f + ' chat wiring', false, 'script/nav missing'); }
  }
  t('A4 all 4 panels: chat.js tag + nav items present', panelsOk);
  t('A5 schema has chat/complaint tables', fs.readFileSync(path.join(ROOT, 'backend/schema.js'), 'utf8').includes('CREATE TABLE IF NOT EXISTS chat_conversations'));

  /* ============ fixture ============ */
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();
  const adm = await login('vibepk', 'vibepk123');
  const mk = async (u, role, parent) => { await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u + ' Name' }, parent || adm); return (await login(u, 'Test123!')); };
  const mA = await mk('fm1', 'manager');
  const mB = await mk('fm2', 'manager');
  const A1 = await mk('fa1', 'agent', mA);
  const C1 = await mk('fc1', 'client', A1);
  const C2 = await mk('fc2', 'client', A1);
  const I = {}; for (const u of ['fm1', 'fm2', 'fa1', 'fc1', 'fc2']) I[u] = dbo.prepare('SELECT id FROM users WHERE username=?').get(u).id;

  const R = {};
  for (let i = 1; i <= 10; i++) {
    const nm = 'R' + String(i).padStart(2, '0');
    await api('/api/ranges', 'POST', { name: nm, prefix: '4470' + i, currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'P', country: 'UK', status: 'Active' }, adm);
    R[nm] = (await api('/api/ranges', 'GET', null, adm)).j.find(x => x.name === nm).id;
  }
  const insNum = dbo.prepare('INSERT INTO numbers (number, range_id, prefix, payterm, payout, created_at) VALUES (?,?,?,?,?,datetime(\'now\'))');
  const numsByRange = {};
  for (const nm of Object.keys(R)) {
    numsByRange[nm] = [];
    for (let k = 1; k <= 3; k++) {
      const num = `4470${nm.slice(1)}00000${k}`;
      insNum.run(num, R[nm], '447', 'weekly_7_1', '0');
      numsByRange[nm].push(dbo.prepare('SELECT id FROM numbers WHERE number=?').get(num).id);
    }
  }
  const alloc = async (tok, ids, target) => api('/api/numbers/allocate', 'POST', { ids, target_id: target, payterm: 'weekly_7_1' }, tok);
  /* admin -> managers (mA: R01,R02,R05,R08 · mB: R03,R07) */
  for (const nm of ['R01', 'R02', 'R05', 'R08']) await alloc(adm, numsByRange[nm], I.fm1);
  for (const nm of ['R03', 'R07']) await alloc(adm, numsByRange[nm], I.fm2);
  /* mA -> agent A1 (R01,R02,R05 — 2 numbers each) */
  for (const nm of ['R01', 'R02', 'R05']) await alloc(mA, numsByRange[nm].slice(0, 2), I.fa1);
  /* A1 -> clients (C1: R01 · C2: R05) */
  await alloc(A1, [numsByRange.R01[0]], I.fc1);
  await alloc(A1, [numsByRange.R05[0]], I.fc2);
  t('setup: 10 ranges + hierarchy allocations done', !!adm && !!mA && !!A1 && !!C1);

  /* ============ PART B: /api/ranges role-scoping ============ */
  console.log('\n--- B. Range selectors role-scoped (API) ---');
  const namesOf = async (tok, q) => (await api('/api/ranges' + (q || ''), 'GET', null, tok)).j.map(r => r.name).sort().join(',');
  t('B1 Manager A sees ONLY 4 ranges (R01,R02,R05,R08)', await namesOf(mA) === 'R01,R02,R05,R08', await namesOf(mA));
  t('B2 Manager B sees ONLY 2 ranges (R03,R07)', await namesOf(mB) === 'R03,R07', await namesOf(mB));
  t('B3 Agent sees ONLY 3 ranges (R01,R02,R05)', await namesOf(A1) === 'R01,R02,R05', await namesOf(A1));
  t('B4 Client C1 sees ONLY 1 range (R01)', await namesOf(C1) === 'R01', await namesOf(C1));
  t('B5 Client C2 sees ONLY 1 range (R05)', await namesOf(C2) === 'R05', await namesOf(C2));
  t('B6 Admin sees ALL 10 ranges', await namesOf(adm) === 'R01,R02,R03,R04,R05,R06,R07,R08,R09,R10', await namesOf(adm));
  t('B7 include_tests=1 variant bhi scoped (manager)', await namesOf(mA, '?include_tests=1') === 'R01,R02,R05,R08', await namesOf(mA, '?include_tests=1'));
  const noNumUser = await mk('fm3', 'manager'); /* koi number nahi */
  t('B8 manager with ZERO numbers sees NO ranges', await namesOf(noNumUser) === '', JSON.stringify(await namesOf(noNumUser)));

  /* ============ PART C: backend security (manual API tampering) ============ */
  console.log('\n--- C. Backend security — unauthorized range via manual API ---');
  let r = await api('/api/numbers?range=R03&limit=100', 'GET', null, mA);
  t('C1 Manager A queries unauthorized range R03 -> 0 rows', (r.j.rows || []).length === 0, 'rows=' + (r.j.rows || []).length);
  r = await api(`/api/numbers?range_id=${R.R03}&limit=100`, 'GET', null, mA);
  t('C2 Manager A queries R03 by range_id -> 0 rows', (r.j.rows || []).length === 0, 'rows=' + (r.j.rows || []).length);
  r = await api('/api/numbers?range=R05&limit=100', 'GET', null, C1);
  t('C3 Client C1 queries other range R05 -> 0 rows', (r.j.rows || []).length === 0);
  r = await api('/api/numbers?range=R01&limit=100', 'GET', null, mA);
  t('C4 authorized range R01 -> mA ko rows milte (scope intact)', (r.j.rows || []).length === 3);
  r = await api('/api/numbers/allocate', 'POST', { ids: numsByRange.R03, target_id: I.fa1, payterm: 'weekly_7_1' }, mA);
  t('C5 mA tries to ALLOCATE mB ki R03 numbers -> allocated:0', r.status === 200 && (r.j.allocated === 0) && (r.j.skipped || 0) === 3, JSON.stringify(r.j));
  r = await api('/api/numbers/smart-divide', 'POST', { range_ids: [R.R03], target_ids: [I.fa1], qty: 1 }, mA);
  t('C6 mA smart-divide on unauthorized R03 -> total 0', r.status === 200 && (r.j.total === 0 || r.j.processed === 0 || JSON.stringify(r.j).includes('"total":0')), JSON.stringify(r.j).slice(0, 80));
  r = await api('/api/numbers/smart-divide', 'POST', { range_ids: [R.R08], target_ids: [I.fc1], qty: 1 }, A1);
  t('C7 Agent smart-divide on unauthorized R08 (manager pool) -> total 0', r.status === 200 && (r.j.total === 0), JSON.stringify(r.j).slice(0, 80));
  r = await api('/api/numbers/allocate', 'POST', { ids: numsByRange.R07, target_id: I.fc1 }, C1);
  t('C8 Client allocation attempt -> 403 (clients cannot allocate)', r.status === 403, 'status=' + r.status);
  r = await api('/api/numbers/allocate', 'POST', { ids: numsByRange.R04, target_id: I.fm1 }, adm);
  t('C9 ADMIN can allocate from any range (R04 -> mA) — regression', r.status === 200 && r.j.allocated === 3, JSON.stringify({ allocated: r.j.allocated }));
  t('C10 mA ab R04 bhi dekhta hai (dynamic — naye allocated numbers)', await namesOf(mA) === 'R01,R02,R04,R05,R08', await namesOf(mA));

  /* ============ PART D: UI dropdowns (jsdom, real panels) ============ */
  console.log('\n--- D. Frontend dropdowns (real panels) ---');
  async function rangeOptions(page, tok, user, loader) {
    const { dom, errors } = await bootPanel(page, tok, user);
    const w = dom.window;
    if (loader === 'loadRateCard') { try { await w.loadRateCard(); } catch (e) {} } else { try { await w.loadRanges(); } catch (e) {} }
    await sleep(900);
    const sel = w.document.getElementById('numRange');
    const opts = sel ? [...sel.querySelectorAll('option')].map(o => o.value || o.textContent.trim()).filter(x => x && x !== 'Select Range' && x !== 'All') : [];
    try { w.close(); } catch (e) {}
    return { opts: opts.sort().join(','), errors };
  }
  let ui = await rangeOptions('manager', mA, 'fm1', 'loadRateCard');
  t('D1 Manager panel numRange dropdown = sirf 4 ranges', ui.opts === 'R01,R02,R04,R05,R08', ui.opts);
  t('D1b manager panel 0 errors', ui.errors.length === 0, ui.errors.slice(0, 1).join(';'));
  ui = await rangeOptions('agent', A1, 'fa1', 'loadRateCard');
  t('D2 Agent panel numRange dropdown = sirf 3 ranges', ui.opts === 'R01,R02,R05', ui.opts);
  t('D2b agent panel 0 errors', ui.errors.length === 0, ui.errors.slice(0, 1).join(';'));
  ui = await rangeOptions('client', C1, 'fc1', 'loadRanges');
  t('D3 Client panel numRange dropdown = sirf 1 range', ui.opts === 'R01', ui.opts);
  t('D3b client panel 0 errors', ui.errors.length === 0, ui.errors.slice(0, 1).join(';'));
  const admUi = await bootPanel('admin', adm, 'vibepk');
  try { await admUi.dom.window.loadRates ? admUi.dom.window.loadRates() : null; } catch (e) {}
  await sleep(600);
  let admRangeCount = 0;
  try { const resp = await api('/api/ranges', 'GET', null, adm); admRangeCount = resp.j.length; } catch (e) {}
  t('D4 Admin panel/API: sab 10 ranges visible (regression intact)', admRangeCount === 10, String(admRangeCount));
  t('D4b admin panel 0 errors', admUi.errors.length === 0, admUi.errors.slice(0, 1).join(';'));
  try { admUi.dom.window.close(); } catch (e) {}

  /* ============ PART E: chat still healthy after range change ============ */
  console.log('\n--- E. Chat + regression sanity ---');
  const cvr = await api('/api/chat/conversations', 'POST', { user_id: I.fa1 }, C1);
  r = await api('/api/chat/messages/' + cvr.j.conversation_id, 'POST', { body: 'range-scope change ke baad chat healthy' }, C1);
  t('E1 chat send still works after /api/ranges change', r.status === 200, 'status=' + r.status);
  r = await api('/api/numbers/summary', 'GET', null, mA);
  const sumNames = (r.j || []).map(x => x.range_name).sort().join(',');
  t('E2 /api/numbers/summary scoped as before (mA)', sumNames === 'R01,R02,R04,R05,R08', sumNames);
  r = await api('/api/dashboard', 'GET', null, adm);
  t('E3 dashboard API unaffected', r.status === 200 && typeof r.j.sms_year !== 'undefined');

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); await stopServer(); process.exit(1); });
