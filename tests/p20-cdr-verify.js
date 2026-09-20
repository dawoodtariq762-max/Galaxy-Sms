#!/usr/bin/env node
/**
 * tests/p20-cdr-verify.js — P20 CDR / SMS DETAILED REPORT REBUILD verification
 *
 * Reference-panel design (owner screenshots): FROM/TO + SEARCH NUMBER + SEARCH CLI
 * + Range/Manager/Agent/Client/Provider dropdowns + Group by (Hour/Day/Month/
 * Range/Number/CLI/Client/Agent/Manager/Currency/Provider) + aggregated table
 * (SMS count + My Payout + Client Payout + totals row) + server-side pagination.
 *
 * R) Backend /api/sms/report: multi-dim group-by, UK DST-safe Hour/Day/Month
 *    buckets, AND-combined filters (buildSmsPagedQuery reuse), role-dim guards
 *    (provider/manager admin-only; agent admin+manager; client a+m+a), client
 *    payout = numbers.payout on client rows, pagination + grand totals.
 * F) Fixture: real ownership chain, rate-locks, OTP-limit zero rows, GMT+BST
 *    backdated rows (DST boundary correctness).
 * C) Detail mode: /api/sms/paged + range_currency/range_provider columns +
 *    number_like/cli_like contains-filters (all roles).
 * U) UI (jsdom + HTML source asserts): admin/manager/agent/client panels —
 *    group-by rows role-appropriate, SEARCH NUMBER/CLI inputs, client panel
 *    renamed "SMS Detailed Report", client has NO provider/manager/agent/client
 *    filters or dims, pagination buttons render, totals row renders, reset
 *    clears state (no stale filters).
 *
 * Run: node tests/p20-cdr-verify.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB = '/tmp/p20cdr.db';
const PORT = process.env.P20_PORT || '8098';
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
  if (data) req.write(data); req.end();
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
function ukHourBucket(sqlUtc) { /* UK wall-clock 'YYYY-MM-DD HH:00' for a UTC sql ts */
  const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
}
function dbOpen() {
  let Database; try { Database = require('better-sqlite3'); } catch (e) { Database = require(path.join(ROOT, 'node_modules/better-sqlite3')); }
  return new Database(DB);
}
async function bootServer(keepDb) {
  if (!keepDb) for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  serverProc = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p20', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => { const s = String(d); if (!/INCOMING_SMS|IMPORT|BACKFILL|backup/i.test(s)) process.stderr.write('[srv-err] ' + s); });
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
      window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} onopen() {} onerror() {} close() {} };
      window.localStorage.setItem('ms_token', tok); window.localStorage.setItem('ms_role', page.replace('.html', ''));
      window.localStorage.setItem('ms_user', user); window.localStorage.setItem('ms_name', user);
    },
  });
  await sleep(2600);
  return { dom, errors };
}

(async () => {
  console.log('===== P20 CDR VERIFICATION — ' + new Date().toISOString() + ' =====');
  await bootServer();
  const dbo = dbOpen();
  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  const adm = await login('vibepk', 'vibepk123');

  /* ================= FIXTURE ================= */
  await api('/api/users', 'POST', { username: 'k_mgr', password: 'mgr1234', role: 'manager', name: 'M' }, adm);
  await api('/api/users', 'POST', { username: 'k_agt', password: 'agt1234', role: 'agent', name: 'A' }, adm);
  await api('/api/users', 'POST', { username: 'k_cli', password: 'cli1234', role: 'client', name: 'C' }, adm);
  const M1 = dbo.prepare("SELECT id FROM users WHERE username='k_mgr'").get().id;
  const A1 = dbo.prepare("SELECT id FROM users WHERE username='k_agt'").get().id;
  const C1 = dbo.prepare("SELECT id FROM users WHERE username='k_cli'").get().id;
  dbo.prepare('UPDATE users SET parent_id=? WHERE id=?').run(M1, A1);
  dbo.prepare('UPDATE users SET parent_id=? WHERE id=?').run(A1, C1);
  await api('/api/ranges', 'POST', { name: 'PK-ONE', prefix: '92310', currency: 'USD', provider: 'ProvA', rate_7_1: '0.014', payment_type: 'weekly', provider_rate_7_1: '0.009' }, adm);
  await api('/api/ranges', 'POST', { name: 'PK-TWO', prefix: '92320', currency: 'EUR', provider: 'ProvB', rate_7_1: '0.020', payment_type: 'weekly', provider_rate_7_1: '0.012' }, adm);
  const R1 = dbo.prepare("SELECT id FROM ranges WHERE name='PK-ONE'").get().id;
  const R2 = dbo.prepare("SELECT id FROM ranges WHERE name='PK-TWO'").get().id;
  await api('/api/numbers/import', 'POST', { range_id: R1, numbers: ['9231000000001', '9231000000002'] }, adm);
  await api('/api/numbers/import', 'POST', { range_id: R2, numbers: ['9232000000001'] }, adm);
  for (let i = 0; i < 40; i++) {
    const check = dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE number IN ('9231000000001','9231000000002','9232000000001')").get().c;
    if (check >= 3) break;
    await sleep(200);
  }
  const N1 = dbo.prepare("SELECT id FROM numbers WHERE number='9231000000001'").get().id;
  const N2 = dbo.prepare("SELECT id FROM numbers WHERE number='9231000000002'").get().id;
  const N4 = dbo.prepare("SELECT id FROM numbers WHERE number='9232000000001'").get().id;
  /* REAL chain: admin->manager (N1,N2,N4); manager->agent (N1,N4); agent->client (N4, payout lock 0.020) */
  const allocM = await api('/api/numbers/allocate', 'POST', { ids: [N1, N2, N4], target_id: M1, payterm: 'weekly_7_1' }, adm);
  const mgrTok0 = await login('k_mgr', 'mgr1234');
  const agtTok0 = await login('k_agt', 'agt1234');
  const cliTok0 = await login('k_cli', 'cli1234');
  const allocAg = await api('/api/numbers/allocate', 'POST', { ids: [N1, N4], target_id: A1 }, mgrTok0);
  const allocCl = await api('/api/numbers/allocate', 'POST', { ids: [N4], target_id: C1, payout: '0.020' }, agtTok0);
  t('F1 chain allocation (N4 client C1 tak, payout lock 0.020)', allocM.status === 200 && allocAg.status === 200 && allocCl.status === 200 && dbo.prepare('SELECT payout FROM numbers WHERE id=?').get(N4).payout === '0.020', JSON.stringify(allocCl.j));
  await api('/api/limit-management/cli', 'POST', { cli: '44LIMIT', daily_limit: 2 }, adm);
  const s = [];
  s.push(await smsPost('9231000000001', '7001', 'Your code is 111111'));
  s.push(await smsPost('9231000000001', '7001', 'Your code is 111112'));
  s.push(await smsPost('9231000000001', '7002', 'Your code is 111113'));
  s.push(await smsPost('9231000000002', '7001', 'Your code is 111114'));
  for (let i = 0; i < 4; i++) s.push(await smsPost('9232000000001', '44LIMIT', 'Your code is 22222' + i));
  t('F2 8 webhook SMS (N1x3, N2x1, N4x4 with cli-limit)', s.every(x => x.status === 200), s.map(x => x.status).join(','));
  /* Backdated direct inserts: GMT + BST boundary rows (DST proof) */
  const ins = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,agent_id,manager_id,client_id,is_test,source,payout_rate,payout_amount,payment_type,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,'carrier',?,?,?,?)`);
  ins.run(N1, '9231000000001', R1, '7001', 'shortcode', 'jan gmt', '333301', A1, M1, null, '0.014', '0.014', 'weekly_7_1', '2026-01-15 23:30:00');  /* GMT  +0 => UK 15 Jan 23:30 */
  ins.run(N1, '9231000000001', R1, '7001', 'shortcode', 'jul bst', '333302', A1, M1, null, '0.014', '0.014', 'weekly_7_1', '2026-07-10 23:30:00');  /* BST  +1 => UK 11 Jul 00:30 */
  ins.run(N4, '9232000000001', R2, '44LIMIT', 'shortcode', 'jul ccode', '333303', A1, M1, C1, '0.020', '0.020', 'weekly_7_1', '2026-07-10 12:00:00'); /* BST => UK 10 Jul 13:00 */
  await api('/api/admin/backfill-stats', 'POST', { reset: true }, adm);
  const T = ukToday(0);
  const cnt = dbo.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
  t('F3 backdated rows (GMT jan + BST jul x2) — total 11 records', cnt === 11, 'count=' + cnt);
  /* Expected matrix (admin, ALL TIME):
     R1: N1 today 3 + jan 1 + jul 1 = 5 SMS, my 5x0.014=0.070 ; N2 today 1, my 0.014
     R2: N4 today 4 (2 paid 0.020 + 2 zero) + jul 1 paid 0.020 = 5 SMS, my 0.060, client 5x0.020=0.100
     TOTALS: sms 11, my 0.144, client 0.100
     Manager scope = same 11 (poori chain M1 ke neeche). Agent = 10 (N2 manager-owned).
     Client = 5 (N4 only). */

  /* ================= R: /api/sms/report ================= */
  console.log('\n--- R: grouped CDR report (backend) ---');
  let r = await api('/api/sms/report?group=range', 'GET', null, adm);
  const rMap = {}; (r.j.rows || []).forEach(x => rMap[x.dims.range] = x);
  t('R1 group=range: PK-ONE 6/0.084 (N1 5 + N2 1) + PK-TWO 5/0.060, client_payout sirf PK-TWO (0.100)', r.status === 200 && (r.j.rows || []).length === 2
    && rMap['PK-ONE'] && rMap['PK-ONE'].sms === 6 && near(rMap['PK-ONE'].my_payout, 0.084) && near(rMap['PK-ONE'].client_payout, 0)
    && rMap['PK-TWO'] && rMap['PK-TWO'].sms === 5 && near(rMap['PK-TWO'].my_payout, 0.060) && near(rMap['PK-TWO'].client_payout, 0.100),
    JSON.stringify(r.j.rows));

  r = await api('/api/sms/report?group=number,client&sort=sms&dir=desc', 'GET', null, adm);
  const rn = (r.j.rows || []).find(x => x.dims.number === '9232000000001');
  const rn1 = (r.j.rows || []).find(x => x.dims.number === '9231000000001');
  t('R2 group=number,client (reference style): N4=>client k_cli 5/0.060/0.100 + N1=>no client 5/0.070/0', r.status === 200 && rn && rn.dims.client === 'k_cli' && rn.sms === 5 && near(rn.client_payout, 0.100) && rn1 && rn1.dims.client === '' && near(rn1.my_payout, 0.070), JSON.stringify((r.j.rows || []).map(x => x.dims)));

  r = await api('/api/sms/report?group=range,number', 'GET', null, adm);
  const rr = (r.j.rows || []).find(x => x.dims.number === '9231000000001');
  t('R3 group=range,number: N1 row range=PK-ONE', r.status === 200 && rr && rr.dims.range === 'PK-ONE' && rr.sms === 5, JSON.stringify(rr && rr.dims));

  r = await api('/api/sms/report?group=day&sort=sms&dir=desc', 'GET', null, adm);
  const dMap = {}; (r.j.rows || []).forEach(x => dMap[x.dims.day] = x);
  t('R4 group=day DST: jul-10 23:30 UTC => UK 2026-07-11 (BST +1), jan-15 => 2026-01-15 (GMT)', dMap['2026-07-11'] && dMap['2026-07-11'].sms === 1 && dMap['2026-01-15'] && dMap['2026-01-15'].sms === 1 && dMap['2026-07-10'] && dMap['2026-07-10'].sms === 1 && dMap[T] && dMap[T].sms === 8, JSON.stringify(Object.keys(dMap)));

  r = await api('/api/sms/report?group=hour&from=' + T + '&to=' + T, 'GET', null, adm);
  const dbRows = dbo.prepare("SELECT received_at FROM sms_records WHERE date(received_at)=?").all(T);
  const wantBuckets = new Set(dbRows.map(x => ukHourBucket(x.received_at)));
  const gotBuckets = new Set((r.j.rows || []).map(x => x.dims.hour));
  t('R5 group=hour (aaj): buckets EXACT UK wall-clock hours se match', r.status === 200 && wantBuckets.size > 0 && [...wantBuckets].every(b => gotBuckets.has(b)) && (r.j.rows || []).reduce((a, x) => a + x.sms, 0) === 8, 'want=' + [...wantBuckets] + ' got=' + [...gotBuckets]);

  r = await api('/api/sms/report?group=month', 'GET', null, adm);
  const mMap = {}; (r.j.rows || []).forEach(x => mMap[x.dims.month] = x);
  t('R6 group=month: 2026-01 (1) + 2026-07 (2) + aaj ka month (8)', mMap['2026-01'] && mMap['2026-01'].sms === 1 && mMap['2026-07'] && mMap['2026-07'].sms === 2 && mMap[T.slice(0, 7)] && mMap[T.slice(0, 7)].sms === 8, JSON.stringify(Object.keys(mMap)));

  r = await api('/api/sms/report?group=currency', 'GET', null, adm);
  const cMap = {}; (r.j.rows || []).forEach(x => cMap[x.dims.currency] = x);
  t('R7 group=currency: USD 6 + EUR 5 (ranges.currency se)', cMap['USD'] && cMap['USD'].sms === 6 && cMap['EUR'] && cMap['EUR'].sms === 5, JSON.stringify(Object.keys(cMap)));

  r = await api('/api/sms/report?group=provider', 'GET', null, adm);
  const pMap = {}; (r.j.rows || []).forEach(x => pMap[x.dims.provider] = x);
  t('R8 group=provider (admin): ProvA 6 + ProvB 5', pMap['ProvA'] && pMap['ProvA'].sms === 6 && pMap['ProvB'] && pMap['ProvB'].sms === 5, JSON.stringify(Object.keys(pMap)));

  /* Role guards on group dims */
  r = await api('/api/sms/report?group=provider', 'GET', null, mgrTok0);
  t('R9 manager group=provider => dim DROPPED (400 no dims left)', r.status === 400, 'status=' + r.status);
  r = await api('/api/sms/report?group=manager,range', 'GET', null, mgrTok0);
  t('R10 manager group=manager,range => sirf range bachta hai', r.status === 200 && (r.j.group || []).length === 1 && r.j.group[0] === 'range', JSON.stringify(r.j.group));
  r = await api('/api/sms/report?group=agent,client,manager', 'GET', null, agtTok0);
  t('R11 agent group=agent,client,manager => sirf client bachta hai', r.status === 200 && (r.j.group || []).length === 1 && r.j.group[0] === 'client', JSON.stringify(r.j.group));
  r = await api('/api/sms/report?group=client,cli,provider,manager,agent,currency', 'GET', null, cliTok0);
  t('R12 client group=client,cli,provider,manager,agent,currency => sirf cli,currency', r.status === 200 && (r.j.group || []).length === 2 && r.j.group.includes('cli') && r.j.group.includes('currency'), JSON.stringify(r.j.group));

  /* Scope totals per role */
  r = await api('/api/sms/report?group=range', 'GET', null, mgrTok0);
  t('R13 manager scope: totals 11/0.144 (poori chain)', r.status === 200 && r.j.totals.sms === 11 && near(r.j.totals.my_payout, 0.144) && near(r.j.totals.client_payout, 0.100), JSON.stringify(r.j.totals));
  r = await api('/api/sms/report?group=range', 'GET', null, agtTok0);
  t('R14 agent scope: totals 10 (N2 manager-owned bahar)', r.status === 200 && r.j.totals.sms === 10 && near(r.j.totals.my_payout, 0.130), JSON.stringify(r.j.totals));
  r = await api('/api/sms/report?group=cli', 'GET', null, cliTok0);
  t('R15 client scope: totals 5 SMS sirf 44LIMIT CLI (apna hi data)', r.status === 200 && r.j.totals.sms === 5 && (r.j.rows || []).length === 1 && r.j.rows[0].dims.cli === '44LIMIT', JSON.stringify(r.j.totals));

  /* Filters AND-combine with group */
  r = await api('/api/sms/report?group=number&from=' + T + '&to=' + T + '&cli_like=70&range=PK-ONE', 'GET', null, adm);
  t('R16 AND: date + cli_like(70) + range(PK-ONE) => N1(3)+N2(1) = 4 SMS', r.status === 200 && (r.j.rows || []).length === 2 && r.j.rows.reduce((a, x) => a + x.sms, 0) === 4, JSON.stringify(r.j.rows));
  r = await api('/api/sms/report?group=range,number&provider=ProvA&from=2026-01-01&to=2026-12-31', 'GET', null, adm);
  t('R17 AND: provider(ProvA) + year range => N1 + N2 (6 SMS, backdated included)', r.status === 200 && (r.j.rows || []).length === 2 && r.j.rows.reduce((a, x) => a + x.sms, 0) === 6, JSON.stringify((r.j.rows || []).map(x => x.dims.number)));
  r = await api('/api/sms/report?group=range&from=' + T + '&to=' + T + '&provider=ProvB', 'GET', null, mgrTok0);
  t('R18 manager: provider param IGNORED (admin-only) => aaj ke saare 8 (ProvB filter lagu nahi)', r.status === 200 && r.j.totals.sms === 8, JSON.stringify(r.j.totals));
  r = await api('/api/sms/report?group=number&number_like=000002&from=' + T + '&to=' + T, 'GET', null, adm);
  t('R19 number_like contains: "000002" => N2 (1 SMS)', r.status === 200 && (r.j.rows || []).length === 1 && r.j.rows[0].dims.number === '9231000000002', JSON.stringify((r.j.rows || []).map(x => x.dims.number)));
  r = await api('/api/sms/report?group=number&cli_like=44LIM', 'GET', null, adm);
  t('R20 cli_like contains: "44LIM" => N4 (5 SMS)', r.status === 200 && (r.j.rows || []).length === 1 && r.j.rows[0].dims.number === '9232000000001' && r.j.rows[0].sms === 5, JSON.stringify((r.j.rows || []).map(x => x.dims.number)));
  r = await api('/api/sms/report?group=client&agent=k_agt', 'GET', null, adm);
  t('R21 user filter: agent=k_agt + group=client => k_cli 5', r.status === 200 && (r.j.rows || []).some(x => x.dims.client === 'k_cli' && x.sms === 5), JSON.stringify((r.j.rows || []).map(x => x.dims)));
  r = await api('/api/sms/report?group=agent&manager=k_mgr', 'GET', null, adm);
  t('R22 user filter: manager=k_mgr + group=agent => k_agt 10', r.status === 200 && (r.j.rows || []).some(x => x.dims.agent === 'k_agt' && x.sms === 10), JSON.stringify((r.j.rows || []).map(x => x.dims)));
  r = await api('/api/sms/report?group=range&client=k_cli', 'GET', null, mgrTok0);
  t('R23 manager client-filter: client=k_cli => PK-TWO 5', r.status === 200 && (r.j.rows || []).length === 1 && r.j.rows[0].dims.range === 'PK-TWO' && r.j.rows[0].sms === 5, JSON.stringify((r.j.rows || []).map(x => x.dims)));
  r = await api('/api/sms/report?group=range&range=PK-ONE', 'GET', null, cliTok0);
  t('R24 client unauthorized range filter (PK-ONE) => 0 rows (scope enforced)', r.status === 200 && (r.j.rows || []).length === 0 && r.j.totals.sms === 0, JSON.stringify(r.j.totals));

  /* client_payout semantics: numbers.payout x client rows — zero-rate rows bhi count */
  r = await api('/api/sms/report?group=number&from=' + T + '&to=' + T, 'GET', null, adm);
  const n4today = (r.j.rows || []).find(x => x.dims.number === '9232000000001');
  t('R25 client_payout = payout-lock x HAR client SMS (2 paid + 2 zero = 4x0.020=0.080), my_payout sirf paid (0.040)', n4today && near(n4today.client_payout, 0.080) && near(n4today.my_payout, 0.040), JSON.stringify(n4today));

  /* Pagination of grouped rows */
  r = await api('/api/sms/report?group=cli&limit=1&page=1&from=' + T + '&to=' + T, 'GET', null, adm);
  const p1 = r.j;
  r = await api('/api/sms/report?group=cli&limit=1&page=2&from=' + T + '&to=' + T, 'GET', null, adm);
  const p2 = r.j;
  t('R26 pagination: page1/page2 SAME filtered query continue (total 3 CLIs aaj)', p1.total === 3 && p1.rows.length === 1 && p2.rows.length === 1 && p1.rows[0].dims.cli !== p2.rows[0].dims.cli && p2.page === 2, `p1=${p1.total}/${p1.rows.length} p2=${p2.rows.length}`);
  t('R27 pagination: grand totals har page par SAME (filtered dataset)', p1.totals.sms === 8 && p2.totals.sms === 8 && near(p1.totals.my_payout, 0.096) && near(p2.totals.my_payout, 0.096), JSON.stringify(p2.totals));
  r = await api('/api/sms/report?group=cli&limit=1&page=99&from=' + T + '&to=' + T, 'GET', null, adm);
  t('R28 last-page clamp (page 99 => page 3)', r.j.page === 3 && r.j.rows.length === 1, 'page=' + r.j.page);
  r = await api('/api/sms/report?group=cli&sort=sms&dir=asc&from=' + T + '&to=' + T, 'GET', null, adm);
  const smsAsc = (r.j.rows || []).map(x => x.sms);
  t('R29 grouped sort=sms asc', smsAsc.length === 3 && smsAsc[0] <= smsAsc[1] && smsAsc[1] <= smsAsc[2], JSON.stringify(smsAsc));
  r = await api('/api/sms/report', 'GET', null, adm);
  t('R30 no group param => 400 (detail mode ke liye /api/sms/paged hai)', r.status === 400, 'status=' + r.status);

  /* Empty results behavior */
  r = await api('/api/sms/report?group=range&from=2030-01-01&to=2030-01-02', 'GET', null, adm);
  t('R31 no results => rows [], totals 0 (koi error nahi)', r.status === 200 && (r.j.rows || []).length === 0 && r.j.totals.sms === 0, JSON.stringify(r.j.totals));

  /* ================= C: detail mode (/api/sms/paged) ================= */
  console.log('\n--- C: detail mode (/api/sms/paged) ---');
  r = await api('/api/sms/paged?from=' + T + '&to=' + T + '&limit=3&page=1', 'GET', null, adm);
  const c1 = (r.j.rows || [])[0] || {};
  t('C1 detail rows me range_currency + range_provider columns (naye fields)', r.status === 200 && c1.range_currency !== undefined && c1.range_provider !== undefined, `cur=${c1.range_currency} prov=${c1.range_provider}`);
  r = await api('/api/sms/paged?from=' + T + '&to=' + T + '&number_like=000002&cli_like=70', 'GET', null, adm);
  t('C2 detail number_like + cli_like AND => N2/7001 (1 row)', r.status === 200 && r.j.total === 1 && r.j.rows[0].number === '9231000000002', 'total=' + r.j.total);
  r = await api('/api/sms/paged?from=' + T + '&to=' + T + '&cli_like=44LIM', 'GET', null, cliTok0);
  t('C3 client detail cli_like => apne 4 hi rows', r.status === 200 && r.j.total === 4, 'total=' + r.j.total);
  r = await api('/api/sms/paged?from=' + T + '&to=' + T + '&tfrom=00:00&tto=23:59', 'GET', null, adm);
  t('C4 detail time-window (existing behavior preserved)', r.status === 200 && r.j.total === 8, 'total=' + r.j.total);

  /* ================= U: UI (jsdom + source) ================= */
  console.log('\n--- U: panel UI ---');
  const admH = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const mgrH = fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
  const agtH = fs.readFileSync(path.join(ROOT, 'agent.html'), 'utf8');
  const cliH = fs.readFileSync(path.join(ROOT, 'client.html'), 'utf8');
  const gbIds = f => ['hour','day','month','range','number','cli','client','agent','manager','currency','provider'].filter(d => f.includes('id="sdGb_' + d + '"'));
  /* admin checkboxes template-literal se runtime par bante hain (id="sdGb_${x[0]}") — array literal check */
  const admDims = ['hour','day','month','range','number','cli','client','agent','manager','currency','provider'].filter(d => admH.includes("'" + d + "','"));
  t('U1 admin: Group by Hour..Provider (11 dims) + SEARCH NUMBER/CLI + Agent/Client/Provider selects', admDims.length === 11 && admH.includes('sdGb_') && admH.includes('id="sdNumSearch"') && admH.includes('id="sdCliSearch"') && admH.includes('id="sdSelAgent"') && admH.includes('id="sdSelClient"') && admH.includes('id="sdSelProvider"'), JSON.stringify(admDims));
  t('U2 manager: dims provider/manager NAHI (9), agent+client selects hain', gbIds(mgrH).length === 9 && !gbIds(mgrH).includes('provider') && !gbIds(mgrH).includes('manager') && mgrH.includes('id="sdSelAgent"') && mgrH.includes('id="sdSelClient"') && !mgrH.includes('id="sdSelProvider"'), JSON.stringify(gbIds(mgrH)));
  t('U3 agent: dims client tak (8), sirf client select', gbIds(agtH).length === 8 && !gbIds(agtH).includes('agent') && !gbIds(agtH).includes('manager') && !gbIds(agtH).includes('provider') && agtH.includes('id="sdSelClient"') && !agtH.includes('id="sdSelProvider"'), JSON.stringify(gbIds(agtH)));
  const cliGb = ['hour','day','month','range','number','cli','currency'].filter(d => cliH.includes('id="stGb_' + d + '"'));
  t('U4 client: rename "SMS Detailed Report" + group-by hour..currency (7) + CLI text search', cliH.includes('SMS Detailed Report') && !cliH.includes('>SMS Stats<') && cliGb.length === 7 && cliH.includes('id="stCliSearch"'), 'gb=' + cliGb.length);
  t('U5 client: koi provider/manager/agent/client filter ya dim NAHI', !cliH.includes('id="stGb_provider"') && !cliH.includes('id="stGb_manager"') && !cliH.includes('id="stGb_agent"') && !cliH.includes('id="stGb_client"') && !cliH.includes('id="stSelProvider"'), '');

  /* jsdom: admin panel — grouped + detail + pagination */
  const admBoot = await bootPanel('admin.html', adm, 'vibepk');
  const w = admBoot.dom.window, doc = w.document;
  t('U6 admin panel boots, 0 script errors', admBoot.errors.length === 0, admBoot.errors.slice(0, 2).join(' | '));
  if (w.loadAdminPageData) { await w.loadAdminPageData('smsDetail'); await sleep(1200); }
  const gbRange = doc.getElementById('sdGb_range');
  t('U7 admin smsDetail page: group-by checkboxes + search inputs render', !!gbRange && !!doc.getElementById('sdGb_hour') && !!doc.getElementById('sdNumSearch') && !!doc.getElementById('sdCliSearch'), '');
  if (gbRange) {
    gbRange.checked = true; gbRange.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(1500);
    const headTxt = (doc.getElementById('sdHead') || {}).textContent || '';
    const bodyRows = [...doc.querySelectorAll('#sdBody tr')];
    const footTxt = (doc.getElementById('sdFoot') || {}).textContent || '';
    t('U8 group=range tick => grouped table (Range + SMS + My Payout + Client Payout)', headTxt.includes('Range') && headTxt.includes('SMS') && headTxt.includes('My Payout') && headTxt.includes('Client Payout') && bodyRows.length >= 2, 'head=' + headTxt.slice(0, 60));
    t('U9 totals footer row (Totals + aaj ke 8 SMS, default date=today)', footTxt.includes('Totals') && /8/.test(footTxt) && footTxt.includes('0.096'), footTxt.slice(0, 80));
    const pagBtns = [...doc.querySelectorAll('.table-foot .pagination button')];
    t('U10 pagination buttons render (grouped mode)', pagBtns.length >= 3, 'btns=' + pagBtns.length);
    /* add CLI search filter — AND combine visible */
    const cs = doc.getElementById('sdCliSearch');
    if (cs) { cs.value = '44LIM'; cs.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(1600);
      const foot2 = (doc.getElementById('sdFoot') || {}).textContent || '';
      t('U11 grouped + CLI search filter => totals sirf N4 ke 4 SMS (AND live)', /4/.test(foot2) && !/8/.test(foot2.replace(/\$ 0\.0\d+/g,'')) && foot2.includes('0.04'), foot2.slice(0, 80));
      /* reset => no stale filters */
      w.sdReset(); await sleep(1200);
      const foot3 = (doc.getElementById('sdFoot') || {}).textContent || '';
      t('U12 reset => sab clear (CLI input khaali, totals wapas default 8)', (doc.getElementById('sdCliSearch') || {}).value === '' && /8/.test(foot3), foot3.slice(0, 80));
    }
    /* detail mode */
    const gbRange2 = doc.getElementById('sdGb_range');
    if (gbRange2) { gbRange2.checked = false; gbRange2.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(1500);
      const headD = (doc.getElementById('sdHead') || {}).textContent || '';
      t('U13 group hata => detail table (Date + Currency + Message)', headD.includes('Date') && headD.includes('Currency') && headD.includes('Message'), headD.slice(0, 70));
    }
  }

  /* jsdom: client panel */
  const cliBoot = await bootPanel('client.html', cliTok0, 'k_cli');
  const wc = cliBoot.dom.window, dc = wc.document;
  t('U14 client panel boots, 0 script errors', cliBoot.errors.length === 0, cliBoot.errors.slice(0, 2).join(' | '));
  const tabTxt = [...dc.querySelectorAll('.tab')].map(x => x.textContent).join(' ');
  t('U15 client nav tab "SMS Detailed Report"', tabTxt.includes('SMS Detailed Report'), tabTxt.slice(0, 80));
  if (wc.renderStats) {
    const gbDay = dc.getElementById('stGb_day');
    if (gbDay) {
      gbDay.checked = true; gbDay.dispatchEvent(new wc.Event('change', { bubbles: true }));
      await sleep(1600);
      const headC = (dc.getElementById('stHead') || {}).textContent || '';
      const footC = (dc.getElementById('stFoot') || {}).textContent || '';
      t('U16 client group=day => SMS-count-only table (no payout columns)', headC.includes('Day') && headC.includes('SMS') && !headC.includes('Payout') && footC.includes('Totals'), headC.slice(0, 60) + ' | ' + footC.slice(0, 40));
    } else t('U16 client group=day checkbox missing', false, '');
  }

  dbo.close();
  await stopServer();
  console.log('\n===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); try { await stopServer(); } catch (_) {} process.exit(1); });
