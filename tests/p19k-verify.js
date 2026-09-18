#!/usr/bin/env node
/**
 * tests/p19k-verify.js — P19k TEN-AREA VERIFICATION (owner task matrix A–H)
 *
 * A) Responsive chat/panel — CSS/layout source fixes (dvh heights, mobile offset,
 *    short-landscape, word-wrap) + FUNCTIONAL FAB visibility (chat page active /
 *    fullscreen conversation) in a real jsdom panel boot.
 * B) Chat flows — panel boots clean with edited chat.js; conversation open/back works.
 * C) SMS Detailed Report multi-filters — CLI+Range+Provider(+Date/Time) AND-combine
 *    (backend /api/sms/paged + /api/stats-summary), Admin/Manager/Agent scope.
 * D) Client SMS Support — CLI/Range/Date/Time filters on client-authorized data;
 *    provider param silently ignored for non-admin (backend-enforced);
 *    client never receives provider/admin/manager filters.
 * E) Provider Rate CRUD (Rate Management, admin-only) + visibility guards
 *    (Manager/Agent/Client responses have NO provider_rate_*; Rate Card none either).
 * F) Real Provider Cost — Provider Rate × ELIGIBLE (paid) SMS count per existing
 *    dashboard periods; rate-limit/zero-rate rows excluded (existing engine reused,
 *    no second OTP-limit calc); admin-only keys.
 * G) Deletion flow end-to-end (owner's section 6) — synthetic data, delete YES =>
 *    gone everywhere (incl. month/year totals); delete NO => records preserved.
 *    Plus boot reconciliation: pre-existing stale stats auto-heal on restart.
 * H) Rate Card shows ALL configured ranges (zero-inventory too); /api/ranges
 *    inventory scope (P19f) untouched elsewhere.
 *
 * Run: node tests/p19k-verify.js   (repo root; jsdom from /tmp/uitest fallback)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB = '/tmp/p19k.db';
const PORT = process.env.P19K_PORT || '8097';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let serverProc = null;
let PASS = 0, FAIL = 0;
const t = (name, ok, info) => { if (ok) { PASS++; console.log('PASS | ' + name + (info !== undefined ? ' | ' + info : '')); } else { FAIL++; console.log('FAIL | ' + name + (info !== undefined ? ' | ' + info : '')); } };
const near = (a, b, eps = 1e-6) => Math.abs((parseFloat(a) || 0) - (parseFloat(b) || 0)) < eps;

const api = (p, method, body, tok) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, j, b }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const smsPost = (number, cli, message) => new Promise((resolve, reject) => {
  const b = new URLSearchParams({ number, cli, message }).toString();
  const req = http.request(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } }, res => {
    let bb = ''; res.on('data', d => bb += d); res.on('end', () => { let j = null; try { j = JSON.parse(bb); } catch (e) {} resolve({ status: res.statusCode, j }); });
  });
  req.on('error', reject); req.write(b); req.end();
});

function ukToday(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('/').reverse().join('-');
}
function dbOpen() {
  let Database; try { Database = require('better-sqlite3'); } catch (e) { Database = require(path.join(ROOT, 'node_modules/better-sqlite3')); }
  return new Database(DB);
}

async function bootServer(keepDb) {
  if (!keepDb) for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  serverProc = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19k', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
  for (let i = 0; i < 90; i++) { await sleep(400); try { const r = await api('/api/health', 'GET'); if (r.status === 200) return; } catch (e) {} }
  throw new Error('server did not start');
}
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on('exit', () => resolve());
    try { serverProc.kill('SIGINT'); } catch (e) {}
    setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (e) {} resolve(); }, 6000);
  });
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status); return r.j.token; }

/* ---- jsdom panel booter (real DOM, live server, real fetch) ---- */
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
      /* minimal SSE stub — chat.js apne polling fallback par chala jayega */
      window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} onopen() {} onerror() {} close() {} };
      window.localStorage.setItem('ms_token', tok); window.localStorage.setItem('ms_role', page.replace('.html', ''));
      window.localStorage.setItem('ms_user', user); window.localStorage.setItem('ms_name', user);
    },
  });
  await sleep(2600);
  return { dom, errors };
}

(async () => {
  console.log('===== P19k VERIFICATION — ' + new Date().toISOString() + ' =====\n');

  /* ================= SECTION A (static responsive source checks) ================= */
  console.log('\n--- A: responsive CSS/layout source fixes ---');
  const chatJs = fs.readFileSync(path.join(ROOT, 'assets/chat.js'), 'utf8');
  t('A1 chat: dvh dynamic-viewport heights (vh fallback bhi)', /height:calc\(100dvh - 132px\)/.test(chatJs) && /height:calc\(100vh - 132px\)/.test(chatJs), 'dvh+vh');
  t('A2 chat: mobile offset 170px (wrapped topbar + page-head) — purana 118px galat tha', /calc\(100dvh - 170px\)/.test(chatJs), '');
  t('A3 chat: short-landscape media block (max-height:560px) — compact input/send/avatars', /max-width:900px\) and \(max-height:560px\)/.test(chatJs), '');
  t('A4 chat: long unbroken strings bubble ke andar wrap (overflow-wrap:anywhere)', /\.gxc-bubble\{overflow-wrap:anywhere\}/.test(chatJs), '');
  t('A5 chat: FAB hide rule (chat page / fullscreen conversation overlap fix)', /#gxChatFab\.gx-fab-hidden\{display:none\}/.test(chatJs), '');
  t('A6 chat: mobile min-height 220px (landscape) — purana 420px layout todta tha', /min-height:220px/.test(chatJs), '');
  for (const f of ['admin.html', 'manager.html', 'agent.html', 'client.html']) {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    t('A7 cache-bust ' + f + ' -> chat.js?v=gxchat4', h.includes('/assets/chat.js?v=gxchat4'), '');
  }
  const gcss = fs.readFileSync(path.join(ROOT, 'assets/galaxy.css'), 'utf8');
  t('A8 galaxy.css: pay/cost chips balanced wrap (4-chip rows)', /\.gx-dash-sub \.gx-pay-chip\{flex:1 1 220px/.test(gcss) && /max-width:620px\)\{\.gx-dash-sub \.gx-pay-chip\{flex:1 1 100%\}/.test(gcss), '');
  const admH0 = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  t('A9 admin: sidebar drawer + overlay (mobile) present', admH0.includes('id="overlay"') && admH0.includes('function openSidebar()'), '');

  /* ================= fixture ================= */
  console.log('\n--- FIXTURE: users / ranges / numbers / synthetic SMS ---');
  await bootServer(false);
  const dbo = dbOpen();
  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  t('F0 server booted on fresh DB', true, 'port ' + PORT);

  const adm = await login('vibepk', 'vibepk123');
  t('F1 admin login', !!adm);
  await api('/api/users', 'POST', { username: 'k_mgr', password: 'mgr1234', role: 'manager', name: 'KMgr' }, adm);
  await api('/api/users', 'POST', { username: 'k_agt', password: 'agt1234', role: 'agent', name: 'KAgt' }, adm);
  await api('/api/users', 'POST', { username: 'k_cli', password: 'cli1234', role: 'client', name: 'KCli' }, adm);
  const M1 = dbo.prepare("SELECT id FROM users WHERE username='k_mgr'").get().id;
  const A1 = dbo.prepare("SELECT id FROM users WHERE username='k_agt'").get().id;
  const C1 = dbo.prepare("SELECT id FROM users WHERE username='k_cli'").get().id;
  /* ownership chain fix: agent under manager, client under agent */
  dbo.prepare('UPDATE users SET parent_id=? WHERE id=?').run(M1, A1);
  dbo.prepare('UPDATE users SET parent_id=? WHERE id=?').run(A1, C1);
  t('F2 users created (manager>agent>client chain)', !!(M1 && A1 && C1), `M1=${M1} A1=${A1} C1=${C1}`);

  const r1 = await api('/api/ranges', 'POST', { name: 'PK-ONE', prefix: '92310', currency: 'USD', rate_1_1: '0.013', rate_7_1: '0.014', rate_7_7: '0.015', rate_30_45: '0.016', payment_type: 'weekly', provider: 'ProvA', provider_rate_1_1: '0.008', provider_rate_7_1: '0.009', provider_rate_7_7: '0.010', provider_rate_30_45: '0.011' }, adm);
  const r2 = await api('/api/ranges', 'POST', { name: 'PK-TWO', prefix: '92320', currency: 'USD', rate_7_1: '0.020', payment_type: 'weekly', provider: 'ProvB', provider_rate_7_1: '0.012' }, adm);
  const r3 = await api('/api/ranges', 'POST', { name: 'PK-EMPTY', prefix: '92330', currency: 'USD', rate_7_1: '0.030', payment_type: 'weekly' }, adm); /* zero-inventory */
  await api('/api/ranges', 'POST', { name: 'PK-GONE', prefix: '92340', currency: 'USD', rate_7_1: '0.040' }, adm);
  const R1 = dbo.prepare("SELECT id FROM ranges WHERE name='PK-ONE'").get().id;
  const R2 = dbo.prepare("SELECT id FROM ranges WHERE name='PK-TWO'").get().id;
  const RG = dbo.prepare("SELECT id FROM ranges WHERE name='PK-GONE'").get().id;
  t('F3 ranges created (2 with provider rates, 1 zero-inventory, 1 to-be-deleted)', r1.status === 200 && r2.status === 200 && r3.status === 200 && !!(R1 && R2 && RG));
  await api('/api/ranges/' + RG + '?delete_sms=0', 'DELETE', null, adm); /* soft-delete (koi number nahi) */

  await api('/api/numbers/import', 'POST', { range_id: R1, numbers: ['9231000000001', '9231000000002', '9231000000003'] }, adm);
  await api('/api/numbers/import', 'POST', { range_id: R2, numbers: ['9232000000001', '9232000000002'] }, adm);
  await sleep(600);
  const N1 = dbo.prepare("SELECT id FROM numbers WHERE number='9231000000001'").get().id;
  const N2 = dbo.prepare("SELECT id FROM numbers WHERE number='9231000000002'").get().id;
  const N3 = dbo.prepare("SELECT id FROM numbers WHERE number='9231000000003'").get().id;
  const N4 = dbo.prepare("SELECT id FROM numbers WHERE number='9232000000001'").get().id;
  t('F4 numbers imported', !!(N1 && N2 && N3 && N4), `N1=${N1} N2=${N2} N3=${N3} N4=${N4}`);
  /* REAL chain (existing system jaisa): admin->manager (N1,N2 + N4), manager->agent (N1,N4),
     agent->client (N4). Admin direct->client allowed NAHI hai (403) — yahi existing rules hain. */
  const allocM = await api('/api/numbers/allocate', 'POST', { ids: [N1, N2, N4], target_id: M1, payterm: 'weekly_7_1' }, adm);
  const mgrTok0 = await login('k_mgr', 'mgr1234');
  const agtTok0 = await login('k_agt', 'agt1234');
  const allocAg = await api('/api/numbers/allocate', 'POST', { ids: [N1, N4], target_id: A1 }, mgrTok0);
  const allocCl = await api('/api/numbers/allocate', 'POST', { ids: [N4], target_id: C1 }, agtTok0);
  const ownOk = dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE manager_id=?').get(M1).c;
  const cliOwn = dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE client_id=?').get(C1).c;
  t('F5 allocation chain admin->mgr->agent->client (N4 client C1 tak)', allocM.status === 200 && allocAg.status === 200 && allocCl.status === 200 && ownOk === 3 && cliOwn === 1, `mgrOwned=${ownOk} cliOwned=${cliOwn} allocCl=${JSON.stringify(allocCl.j)}`);

  /* CLI rate-limit rule (existing limit engine): cli 44LIMIT => 2 paid/day, baad zero */
  const lm = await api('/api/limit-management/cli', 'POST', { cli: '44LIMIT', daily_limit: 2 }, adm);
  t('F6 cli limit rule (44LIMIT=2/day — existing engine)', lm.status === 200, JSON.stringify(lm.j));

  /* synthetic SMS — sab UK today (webhook => recordSmsStats bhi chalta hai) */
  const s = [];
  s.push(await smsPost('9231000000001', '7001', 'Your code is 111111'));
  s.push(await smsPost('9231000000001', '7001', 'Your code is 111112'));
  s.push(await smsPost('9231000000001', '7002', 'Your code is 111113'));
  s.push(await smsPost('9231000000002', '7001', 'Your code is 111114'));
  for (let i = 0; i < 4; i++) s.push(await smsPost('9232000000001', '44LIMIT', 'Your code is 22222' + i));
  t('F7 8 webhook SMS (4 paid R1 + 2 paid + 2 zero R2)', s.every(x => x.status === 200), s.map(x => x.status).join(','));
  /* backdated (month + year) — direct inserts, phir authoritative rebuild */
  const ins = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,agent_id,manager_id,client_id,is_test,source,payout_rate,payout_amount,payment_type,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,'carrier',?,?,?,?)`);
  /* params: N1, number, R1, cli, 'shortcode', msg, otp, agentId, managerId, null(client), payRate, payAmt, cycle, ts */
  ins.run(N1, '9231000000001', R1, '7001', 'shortcode', 'month code', '333301', A1, M1, null, '0.014', '0.014', 'weekly_7_1', ukToday(-10) + ' 12:00:00');
  ins.run(N1, '9231000000001', R1, '7001', 'shortcode', 'year code', '333302', A1, M1, null, '0.014', '0.014', 'weekly_7_1', ukToday(-200) + ' 12:00:00');
  const rb = await api('/api/admin/backfill-stats', 'POST', { reset: true }, adm);
  t('F8 backdated SMS (month-10d, year-200d) + authoritative stats rebuild', rb.status === 200 && rb.j.ok, JSON.stringify(rb.j));

  /* expected state (admin, fresh DB):
     today: 8 SMS — 4 paid @0.014 (R1: N1x3 + N2x1) + 2 paid @0.020 (N4 first two) + 2 zero (N4 last two)
     month: today + 1 backdated paid 0.014  => sms 9, payout 0.096+0.014
     year:  month + 1 more backdated paid   => sms 10, payout 0.124
     provider cost today: 4x0.009 + 2x0.012 = 0.060 ; month 0.069 ; year 0.078 ; week == today (backdates week se bahar) */

  /* ================= SECTION C: detailed-report combined filters ================= */
  console.log('\n--- C: SMS Detailed Report — multi-filter AND-combining ---');
  const mgr = await login('k_mgr', 'mgr1234');
  const agt = await login('k_agt', 'agt1234');
  const cli = await login('k_cli', 'cli1234');
  const T = ukToday(0);
  const paged = async (q, tok) => (await api('/api/sms/paged?' + q, 'GET', null, tok)).j;
  let d = await paged('from=' + T + '&to=' + T, adm);
  t('C1 admin: date-only baseline = 8 today', d.total === 8, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001', adm);
  t('C2 admin: CLI=7001 => 3 (N1x2 + N2x1)', d.total === 3, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&range=PK-ONE', adm);
  t('C3 admin: Range=PK-ONE => 4', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&provider=ProvA', adm);
  t('C4 admin: Provider=ProvA => 4 (R1 ke aaj ke rows)', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&range=PK-ONE', adm);
  t('C5 admin: CLI+Range AND => 3', d.total === 3, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&range=PK-ONE&provider=ProvA', adm);
  t('C6 admin: CLI+Range+Provider AND => 3', d.total === 3, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&range=PK-ONE&provider=ProvA&tfrom=00:00&tto=23:59', adm);
  t('C7 admin: CLI+Range+Provider+Time AND => 3', d.total === 3, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&provider=ProvB', adm);
  t('C8 admin: contradictory combo (cli 7001 + ProvB) => 0 — AND overwrite NAHI hota', d.total === 0, 'total=' + d.total);
  const sum = (await api('/api/stats-summary/range?from=' + T + '&to=' + T + '&cli=7001', 'GET', null, adm)).j;
  const one = (sum.rows || []).find(r => r.key === 'PK-ONE');
  t('C9 admin: stats-summary range facet WITH cli pick => PK-ONE=3', one && one.sms === 3, JSON.stringify(sum.rows));
  /* manager scope: provider IGNORED (backend), baaki filters kaam karein */
  d = await paged('from=' + T + '&to=' + T, mgr);
  t('C10 manager: date-only => 8 (apni chain: N1 3 + N2 1 + N4 4)', d.total === 8, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&provider=ProvA', mgr);
  t('C11 manager: provider param IGNORED (backend-enforced) => 8 unchanged', d.total === 8, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&range=PK-ONE', mgr);
  t('C12 manager: CLI+Range AND => 3 (scoped)', d.total === 3, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=7001&range=PK-ONE', agt);
  t('C13 agent: CLI+Range AND => 2 (sirf N1 ki cli-7001 rows)', d.total === 2, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&range=PK-EMPTY', mgr);
  t('C14 manager: khaali range (scope me nahi) => 0', d.total === 0, 'total=' + d.total);
  /* UI wiring (static) */
  const admH = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  t('C15 admin UI: direct selects CLI/Range/Manager/Provider (provider Manager ke BAAD)', /id="sdSelManager"[\s\S]{0,200}id="sdSelProvider"/.test(admH) && admH.includes('id="sdSelCli"') && admH.includes('id="sdSelRange"'), '');
  t('C16 admin UI: facet list LAST-ticked dim (tick order)', admH.includes('__sdTickOrder') && /order\[order\.length-1\]:ticks\[0\]/.test(admH), '');
  const mgrH = fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
  const agtH = fs.readFileSync(path.join(ROOT, 'agent.html'), 'utf8');
  t('C17 manager/agent UI: CLI/Range selects, provider select NAHI', mgrH.includes('id="sdSelCli"') && mgrH.includes('id="sdSelAgent"') && !mgrH.includes('sdSelProvider') && agtH.includes('id="sdSelClient"') && !agtH.includes('sdSelProvider'), '');
  t('C18 admin UI: provider options existing Provider Management se (/providers-info)', admH.includes("/api/providers-info") || admH.includes("API.get('/providers-info')"), '');

  /* ================= SECTION D: client SMS support ================= */
  console.log('\n--- D: Client SMS Support — filters + scope + provider-denied ---');
  d = await paged('from=' + T + '&to=' + T, cli);
  t('D1 client: date-only => 4 (sirf apna N4)', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=44LIMIT&range=PK-TWO', cli);
  t('D2 client: CLI+Range AND on authorized data => 4', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&cli=44LIMIT&range=PK-TWO&tfrom=00:00&tto=23:59', cli);
  t('D3 client: +Time filter => 4 (existing time filter preserved)', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&provider=ProvB', cli);
  t('D4 client: provider param IGNORED (backend) => 4 unchanged', d.total === 4, 'total=' + d.total);
  d = await paged('from=' + T + '&to=' + T + '&range=PK-ONE', cli);
  t('D5 client: unauthorized range => 0', d.total === 0, 'total=' + d.total);
  const cliRanges = (await api('/api/ranges', 'GET', null, cli)).j;
  t('D6 client: /api/ranges scoped (only ranges with own numbers)', Array.isArray(cliRanges) && cliRanges.length === 1 && cliRanges[0].name === 'PK-TWO', JSON.stringify((cliRanges || []).map(r => r.name)));
  t('D7 client: /api/ranges rows me provider_rate_* NAHI', (cliRanges || []).every(r => !('provider_rate_1_1' in r) && !('provider_rate_7_1' in r) && !('provider_rate_7_7' in r) && !('provider_rate_30_45' in r)), '');
  const p403 = await api('/api/providers-info', 'GET', null, cli);
  t('D8 client: Provider Management endpoint 403', p403.status === 403, 'status=' + p403.status);
  const cliH = fs.readFileSync(path.join(ROOT, 'client.html'), 'utf8');
  t('D9 client UI: CLI/Range/Date/Time filters present, provider NAHI', cliH.includes('id="stCli"') && cliH.includes('id="stRange"') && cliH.includes('id="stFrom"') && cliH.includes('id="stTFrom"') && !cliH.includes('sdSelProvider') && !/provider\s*select/i.test(cliH), '');

  /* ================= SECTION E: provider-rate CRUD + visibility ================= */
  console.log('\n--- E: Provider Rate (admin-internal) CRUD + visibility guards ---');
  const admRanges = (await api('/api/ranges', 'GET', null, adm)).j;
  const ar1 = (admRanges || []).find(r => r.name === 'PK-ONE');
  t('E1 admin: GET /api/ranges me provider_rate_* dikhta hai', ar1 && ar1.provider_rate_7_1 === '0.009' && ar1.provider_rate_30_45 === '0.011', JSON.stringify(ar1 && { p71: ar1.provider_rate_7_1, p3045: ar1.provider_rate_30_45 }));
  const upd = await api('/api/ranges/' + R1, 'PUT', { name: 'PK-ONE', prefix: '92310', currency: 'USD', rate_1_1: '0.013', rate_7_1: '0.014', rate_7_7: '0.015', rate_30_45: '0.016', payment_type: 'weekly', provider: 'ProvA', memo: '', provider_rate_1_1: '0.008', provider_rate_7_1: '0.0095', provider_rate_7_7: '0.010', provider_rate_30_45: '0.011' }, adm);
  const ar1b = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'PK-ONE');
  t('E2 admin: PUT update provider rate persisted (0.009 -> 0.0095)', upd.status === 200 && ar1b.provider_rate_7_1 === '0.0095', ar1b.provider_rate_7_1);
  const mgrRanges = (await api('/api/ranges', 'GET', null, mgr)).j;
  t('E3 manager: /api/ranges me provider_rate_* keys ABSENT (kisi bhi row me nahi)', (mgrRanges || []).every(r => !('provider_rate_1_1' in r) && !('provider_rate_7_1' in r) && !('provider_rate_7_7' in r) && !('provider_rate_30_45' in r)), JSON.stringify((mgrRanges || []).map(r => Object.keys(r).filter(k => k.includes('provider_rate')))));
  const mgmtH = fs.readFileSync(path.join(ROOT, 'management.html'), 'utf8');
  t('E4 management UI: 4 provider-rate inputs + saveRate body me provider_rate_*', ['pr1', 'pr2', 'pr3', 'pr4'].every(id => mgmtH.includes('id="' + id + '"')) && mgmtH.includes('provider_rate_1_1:pr1.value.trim()'), '');
  t('E5 management UI: table me admin-internal Prov. Rate column', mgmtH.includes('Prov. Rate') && /provider_rate_1_1,r\.provider_rate_7_1/.test(mgmtH), '');
  t('E6 admin.html (legacy rate modal copy) bhi synced (pr1-4)', ['pr1', 'pr2', 'pr3', 'pr4'].every(id => admH.includes('id="' + id + '"')), '');

  /* ================= SECTION F: Real Provider Cost ================= */
  console.log('\n--- F: Real Provider Cost (admin-only, existing periods + eligibility) ---');
  let dash = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('F1 dashboard today cards: sms 8 / payout_week 0.096', dash.sms_today === 8 && near(dash.payout_week, 0.096, 1e-6) && near(dash.payout_7d, 0.096, 1e-6), `today=${dash.sms_today} payout_week=${dash.payout_week}`);
  t('F2 provider cost TODAY = eligible only: 4x0.0095 + 2x0.012 = 0.062 (2 zero-rate rows excluded)', near(dash.provider_cost_today, 0.062, 1e-6), 'got=' + dash.provider_cost_today);
  t('F3 provider cost WEEK (Monday-start) = today ka hi (backdates week se bahar)', near(dash.provider_cost_week, 0.062, 1e-6), 'got=' + dash.provider_cost_week);
  t('F4 provider cost MONTH = +1 backdated paid => 0.062+0.0095 = 0.0715', near(dash.provider_cost_month, 0.0715, 1e-6), 'got=' + dash.provider_cost_month);
  t('F5 provider cost YEAR = +2 backdated => 0.062+0.019 = 0.081', near(dash.provider_cost_year, 0.081, 1e-6), 'got=' + dash.provider_cost_year);
  t('F6 sms_month=9 / sms_year=10 (dashboard cards baaki records se derive)', dash.sms_month === 9 && dash.sms_year === 10, `month=${dash.sms_month} year=${dash.sms_year}`);
  t('F7 payout_month=0.110 (payout_year card exist nahi karta — sms_year hi year card hai)', near(dash.payout_month, 0.110, 1e-6), 'm=' + dash.payout_month);
  const mgrDash = (await api('/api/dashboard', 'GET', null, mgr)).j;
  t('F8 manager dashboard: provider_cost_* keys ABSENT (admin-only)', !('provider_cost_today' in mgrDash) && !('provider_cost_year' in mgrDash), Object.keys(mgrDash).filter(k => k.includes('provider_cost')).join(',') || 'none');
  const cliDash = (await api('/api/dashboard', 'GET', null, cli)).j;
  t('F9 client dashboard: provider_cost_* keys ABSENT', !('provider_cost_today' in cliDash), '');
  /* rate-limit/zero-rate rows cost me nahi (already in F2), payout engine untouched: N4 rows 2 paid + 2 zero */
  const n4rows = dbo.prepare("SELECT payout_amount FROM sms_records WHERE number='9232000000001' ORDER BY id").all();
  t('F10 existing rate-limit engine unchanged: 44LIMIT pe 2 paid(0.020) + 2 zero', n4rows.filter(r => parseFloat(r.payout_amount) > 0).length === 2 && n4rows.filter(r => parseFloat(r.payout_amount) === 0).length === 2, JSON.stringify(n4rows.map(r => r.payout_amount)));
  t('F11 admin dashboard UI: Real Provider Cost chips row', admH.includes('id="gxProvCostRow"') && admH.includes('Real Provider Cost — Today'), '');

  /* ================= SECTION H: rate card (G se PEHLE — fixture intact) ================= */
  console.log('\n--- H: SMS Rate Card — ALL configured ranges ---');
  const rcM = await api('/api/rate-card', 'GET', null, mgr);
  const rc = rcM.j;
  t('H1 manager rate-card: 200 + SAB 3 live ranges (zero-inventory PK-EMPTY bhi, PK-GONE nahi)', rcM.status === 200 && Array.isArray(rc) && rc.length === 3 && rc.some(r => r.name === 'PK-EMPTY') && !rc.some(r => r.name === 'PK-GONE'), JSON.stringify((rc || []).map(r => r.name)));
  t('H2 rate-card: configured public rates dikhte hain (PK-EMPTY 7/1=0.030)', (rc.find(r => r.name === 'PK-EMPTY') || {}).rate_7_1 === '0.030', '');
  t('H3 rate-card: provider_rate/memo/internal fields ABSENT', (rc || []).every(r => !('provider_rate_7_1' in r) && !('memo' in r) && !('provider' in r)), '');
  const rcA = await api('/api/rate-card', 'GET', null, agt);
  t('H4 agent rate-card: 200 + 3 ranges', rcA.status === 200 && rcA.j.length === 3, '');
  const rcC = await api('/api/rate-card', 'GET', null, cli);
  t('H5 client rate-card: 403 (client panel me rate card nahi)', rcC.status === 403, 'status=' + rcC.status);
  /* P19f inventory scope UNTOUCHED: /api/ranges (manager) = sirf accessible ranges */
  t('H6 /api/ranges (manager) inventory-scope intact: PK-ONE+PK-TWO (donon me owned numbers), PK-EMPTY nahi (P19f)', Array.isArray(mgrRanges) && mgrRanges.length === 2 && mgrRanges.some(r => r.name === 'PK-ONE') && mgrRanges.some(r => r.name === 'PK-TWO') && !mgrRanges.some(r => r.name === 'PK-EMPTY'), JSON.stringify((mgrRanges || []).map(r => r.name)));
  const mgrRateCardUI = mgrH.includes("API.get('/rate-card')");
  const agtRateCardUI = agtH.includes("API.get('/rate-card')");
  t('H7 manager/agent UI: rate card /api/rate-card se; selectors scoped /ranges se', mgrRateCardUI && agtRateCardUI && mgrH.includes("fillSel('numRange',rangeNames)"), '');

  /* ================= SECTION G: deletion flow end-to-end (owner section 6) ================= */
  console.log('\n--- G: deletion flow — synthetic data, YES/NO semantics ---');
  const dashBefore = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  const repBefore = await paged('from=' + T + '&to=' + T, adm);
  t('G1 pre-delete state: dashboard + report agree (8 today)', dashBefore.sms_today === 8 && repBefore.total === 8, `dash=${dashBefore.sms_today} rep=${repBefore.total}`);

  /* delete N1 with YES (3 today + 2 backdated rows) */
  const del1 = await api('/api/numbers/delete', 'POST', { ids: [N1], delete_sms: true }, adm);
  t('G2 delete N1 + SMS (YES) ok', del1.status === 200 && del1.j.deleted === 1 && del1.j.deleted_sms >= 5, JSON.stringify(del1.j));
  let dashA = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('G3 after YES: sms_today 8->5', dashA.sms_today === 5, 'got=' + dashA.sms_today);
  t('G4 after YES: sms_month 9->5, sms_year 10->5 (monthly/yearly totals bhi drop)', dashA.sms_month === 5 && dashA.sms_year === 5, `m=${dashA.sms_month} y=${dashA.sms_year}`);
  t('G5 after YES: payout_today 0.054 (N2 0.014 + N4 0.040)', near(dashA.payout_week, 0.054, 1e-6), 'payout_week=' + dashA.payout_week);
  t('G6 after YES: payout_month 0.110->0.054', near(dashA.payout_month, 0.054, 1e-6), 'm=' + dashA.payout_month);
  t('G7 after YES: provider cost drops (0.062->0.0335: N2 0.0095 + N4 2x0.012)', near(dashA.provider_cost_today, 0.0335, 1e-6), 'got=' + dashA.provider_cost_today);
  let repA = await paged('from=' + T + '&to=' + T, adm);
  t('G8 report (sms/paged) bhi 5 — dashboard report se agree', repA.total === 5, 'total=' + repA.total);
  const cliA = await paged('from=' + T + '&to=' + T, cli);
  t('G9 client unaffected (N4 intact) => 4', cliA.total === 4, 'total=' + cliA.total);

  /* range-delete YES (PK-TWO: N4+N5 + records) */
  const del2 = await api('/api/ranges/' + R2 + '?delete_sms=1', 'DELETE', null, adm);
  t('G10 range-delete PK-TWO (YES) ok', del2.status === 200, JSON.stringify(del2.j).slice(0, 120));
  let dashB = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('G11 after range YES: sms_today 5->1 (sirf N2 bacha)', dashB.sms_today === 1, 'got=' + dashB.sms_today);
  t('G12 after range YES: payout_today 0.014 only', near(dashB.payout_week, 0.014, 1e-6), 'payout_week=' + dashB.payout_week);
  const cliB = await paged('from=' + T + '&to=' + T, cli);
  t('G13 client: apna data range-delete ke baad 0', cliB.total === 0, 'total=' + cliB.total);
  const left = dbo.prepare("SELECT COUNT(*) c FROM sms_records WHERE number LIKE '9232000%'").get().c;
  t('G14 PK-TWO ke sms_records physically deleted', left === 0, 'left=' + left);

  /* NO-option: R1 numbers delete with NO => records preserved */
  const del3 = await api('/api/numbers/delete', 'POST', { ids: [N2, N3], delete_sms: false }, adm);
  t('G15 delete N2+N3 (NO — records rakhne hain) ok', del3.status === 200 && del3.j.deleted === 2 && del3.j.preserved_sms >= 1, JSON.stringify(del3.j));
  let dashC = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  const n2left = dbo.prepare("SELECT COUNT(*) c FROM sms_records WHERE number='9231000000002'").get().c;
  t('G16 after NO: dashboard UNCHANGED (1 today — records preserved)', dashC.sms_today === 1, 'got=' + dashC.sms_today);
  t('G17 after NO: N2 ka sms_records row physically present', n2left === 1, 'left=' + n2left);
  /* range-delete NO: records preserved (orphan) */
  const del4 = await api('/api/ranges/' + R1 + '?delete_sms=0', 'DELETE', null, adm);
  let dashD = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('G18 range-delete R1 (NO): dashboard still counts preserved records (semantics unchanged)', del4.status === 200 && dashD.sms_today === 1 && dashD.sms_month === 1, `today=${dashD.sms_today} month=${dashD.sms_month}`);

  /* ================= SECTION G2: boot reconciliation (pre-existing drift heal) ================= */
  console.log('\n--- G2: boot reconciliation — pre-existing stale stats auto-heal ---');
  /* stale stats banao (jaise owner ke live DB me pre-fix deletes se bana tha) */
  dbo.prepare("INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?, -1, -1, -1, 'STALE', 500, '99.0')").run(ukToday(0));
  dbo.prepare('UPDATE sms_daily_stats SET sms_count = sms_count + 300 WHERE 1=1').run();
  const staleSum = dbo.prepare('SELECT SUM(sms_count) c FROM sms_daily_stats').get().c;
  t('G19 stale stats injected (owner drift simulation)', staleSum >= 800, 'sum=' + staleSum);
  dbo.prepare("DELETE FROM meta WHERE key='p19k_stats_reconciled'").run();
  await stopServer();
  await bootServer(true); /* same DB, reboot */
  let healed = null;
  for (let i = 0; i < 25; i++) { await sleep(400); const m = (() => { try { return dbOpen().prepare("SELECT value FROM meta WHERE key='p19k_stats_reconciled'").get(); } catch (e) { return null; } })(); if (m) { healed = m; break; } }
  t('G20 reconcile ran on boot (meta flag set)', !!healed, healed ? healed.value : 'timeout');
  const dashE = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('G21 dashboard = remaining records se derive (today 1, STALE row gone)', dashE.sms_today === 1 && dashE.sms_month === 1 && dashE.sms_year === 1, `today=${dashE.sms_today} month=${dashE.sms_month} year=${dashE.sms_year}`);
  t('G22 payout bhi exact (0.014 preserved row)', near(dashE.payout_month, 0.014, 1e-6), 'payout_month=' + dashE.payout_month);
  const statsTruth = dbOpen().prepare('SELECT SUM(sms_count) c FROM sms_daily_stats').get().c;
  t('G23 sms_daily_stats total == sms_records total (authoritative)', statsTruth === 1, 'stats=' + statsTruth);

  /* ================= SECTION A2/B: jsdom panel — FAB visibility + chat flows ================= */
  console.log('\n--- A2/B: real panel boot (jsdom) — FAB responsive fix + chat open/back ---');
  /* admin<->manager conversation banao taake list me item ho */
  const convR = await api('/api/chat/conversations', 'POST', { user_id: M1 }, adm);
  t('B1 admin<->manager conversation created', convR.status === 200 && convR.j.conversation_id, JSON.stringify(convR.j));
  const panel = await bootPanel('admin.html', adm, 'vibepk');
  const w = panel.dom.window, doc = w.document;
  t('B2 admin panel boots, 0 script errors', panel.errors.length === 0, panel.errors.slice(0, 2).join(' ;; '));
  const fab = doc.getElementById('gxChatFab');
  t('B3 chat FAB exists (P19j feature intact)', !!fab, '');
  t('B4 FAB visible on dashboard (no gx-fab-hidden)', fab && !fab.classList.contains('gx-fab-hidden'), '');
  /* chat page kholo */
  const navChat = doc.querySelector('[data-page="chat"]');
  t('B5 sidebar chat nav present', !!navChat, '');
  if (navChat) navChat.click();
  await sleep(2000);
  const pageChat = doc.getElementById('page-chat');
  t('B6 chat page active + UI built (GXChat.open)', pageChat && pageChat.classList.contains('active') && !!doc.getElementById('gxcRoot'), '');
  t('B7 FAB hidden jab chat page active (overlap fix)', fab && fab.classList.contains('gx-fab-hidden'), '');
  /* conversation kholo => conv-open => FAB hidden; back => visible */
  const item = doc.querySelector('#gxcList .gxc-item');
  t('B8 conversation list item rendered', !!item, '');
  if (item) {
    item.click();
    await sleep(1200);
    const root = doc.getElementById('gxcRoot');
    t('B9 conv-open (mobile fullscreen pattern) + FAB hidden', root.classList.contains('conv-open') && fab.classList.contains('gx-fab-hidden'), 'conv-open=' + root.classList.contains('conv-open'));
    t('B10 message area + input + send rendered', !!doc.getElementById('gxcMsgs') && !!doc.getElementById('gxcInput') && !!doc.getElementById('gxcSend'), '');
    const back = doc.getElementById('gxcBack');
    t('B11 back button rendered (mobile pattern)', !!back, '');
    if (back) { back.click(); await sleep(600);
      t('B12 back => conv closed (FAB chat page par hidden hi rehta hai — list view)', !doc.getElementById('gxcRoot').classList.contains('conv-open') && fab.classList.contains('gx-fab-hidden'), 'conv-open=' + doc.getElementById('gxcRoot').classList.contains('conv-open'));
      const navDash = doc.querySelector('[data-page="dashboard"]');
      if (navDash) { navDash.click(); await sleep(800);
        t('B13 dashboard par wapas => FAB visible again', !fab.classList.contains('gx-fab-hidden'), '');
      }
    }
  }
  panel.dom.window.close();

  /* ================= wrap up ================= */
  console.log('\n===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => {
  console.error('SUITE ERROR:', e);
  await stopServer();
  process.exit(1);
});
