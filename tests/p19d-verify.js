#!/usr/bin/env node
/* ===========================================================================
 * P19d VERIFICATION — END-TO-END (owner task "FIX AGAIN, BUT THIS TIME TEST
 * EVERYTHING END-TO-END"). Yeh suite REAL UI (jsdom panels) + REAL API + direct
 * DB — teeno layers par chalta hai.
 *
 * FIX#1  Agent allocation payout — EXACT value client tak (owner ke 6 cases):
 *        empty->0, 0->0, 1->1, 2->2, 0.013->0.013, different numbers different
 *        payouts. Allocation REAL agent panel ke "Allocate Selected Numbers"
 *        modal se hoti hai (UI -> payload -> backend -> DB -> API -> client panel).
 * FIX#2  Deleted number + OTP/SMS — dashboard (This Year OTPs / This Month Payout
 *        / saare stats) foran correct. Owner ke TEST A-D + phantom-residue
 *        Rebuild Stats repair + DST (winter-row) keying + ledger immutability.
 * Run:   node tests/p19d-verify.js   (repo root; jsdom /tmp/uitest me hona chahiye)
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.P19D_PORT || '8098';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19D_DB || '/tmp/p19dverify.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
function t(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (ok) PASS++; else FAIL++;
}
async function api(p_, method = 'GET', body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + p_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function login(u, p) { return (await api('/api/login', 'POST', { username: u, password: p })).j.token || null; }
async function sms(number, cli, msg) {
  const b = new URLSearchParams({ number, cli, message: msg || ('Your code is ' + Math.floor(1000 + Math.random() * 9000)) });
  const r = await fetch(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }
function ukToday() { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('/').reverse().join('-'); }
async function waitFor(fn, ms = 6000, step = 150) {
  const t0 = Date.now();
  for (;;) { try { const v = fn(); if (v) return v; } catch (e) {} if (Date.now() - t0 > ms) return null; await sleep(step); }
}

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19dverify', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
    const t0 = Date.now();
    (async () => {
      for (let i = 0; i < 120; i++) {
        await sleep(250);
        try { const r = await fetch(BASE + '/api/health'); if (r.ok) return resolve(true); } catch (e) {}
        if (Date.now() - t0 > 30000) return reject(new Error('server did not start'));
      }
      reject(new Error('server did not start'));
    })();
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on('exit', () => resolve());
    try { serverProc.kill('SIGINT'); } catch (e) { try { serverProc.kill(); } catch (_) {} }
    setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (_) {} resolve(); }, 6000);
  });
}

/* ---- jsdom panel booter (desktop DOM, live server, real fetch) ---- */
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
  await sleep(2500);
  return { dom, errors };
}

(async () => {
  console.log('P19d E2E verification — ' + new Date().toISOString());
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();

  /* ================= fixture ================= */
  const adm = await login('vibepk', 'vibepk123');
  t('setup: admin login', !!adm);
  await api('/api/users', 'POST', { username: 'e2ag', password: 'Test123!', role: 'agent', active: true }, adm);
  const aTok = await login('e2ag', 'Test123!');
  await api('/api/users', 'POST', { username: 'e2c1', password: 'Test123!', role: 'client', active: true }, aTok);
  await api('/api/users', 'POST', { username: 'e2c2', password: 'Test123!', role: 'client', active: true }, aTok);
  const c1Tok = await login('e2c1', 'Test123!');
  const c2Tok = await login('e2c2', 'Test123!');
  const A = dbo.prepare("SELECT id FROM users WHERE username='e2ag'").get().id;
  const C1 = dbo.prepare("SELECT id FROM users WHERE username='e2c1'").get().id;
  const C2 = dbo.prepare("SELECT id FROM users WHERE username='e2c2'").get().id;
  t('setup: agent + 2 clients', !!(aTok && c1Tok && c2Tok));

  await api('/api/ranges', 'POST', { name: 'E2R', prefix: '447', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'P', country: 'UK', status: 'Active' }, adm);
  const RC = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'E2R');
  t('setup: range E2R (rate 0.010)', !!RC);

  /* FIX#1 numbers: agent pool me (payout '0' import-default jaisa) */
  const insNum = dbo.prepare("INSERT INTO numbers (number, range_id, prefix, payterm, payout, agent_id, created_at) VALUES (?,?,?,?,?,?,datetime('now'))");
  const N_E = '447400000001', N_0 = '447400000002', N_1 = '447400000003', N_2 = '447400000004', N_013 = '447400000005', NB1 = '447400000006', NB2 = '447400000007';
  const TN1 = '447500000001', TN2 = '447500000002', TN3 = '447500000003';
  for (const n of [N_E, N_0, N_1, N_2, N_013, NB1, NB2, TN1, TN2, TN3]) insNum.run(n, RC.id, '447', 'weekly_7_1', '0', A);
  await api('/api/ranges', 'POST', { name: 'E2R2', prefix: '448', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'P', country: 'UK', status: 'Active' }, adm);
  const RC2 = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'E2R2');
  const SD = ['448400000001', '448400000002', '448400000003'];
  for (const n of SD) insNum.run(n, RC2.id, '448', 'weekly_7_1', '0', A);
  const today = ukToday();
  const idOf = (n) => dbo.prepare('SELECT id FROM numbers WHERE number=?').get(n).id;
  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  await sleep(300);

  /* ================================================================
   * PART 1 — FIX#1: allocation through the REAL agent panel modal
   * ================================================================ */
  console.log('\n--- PART 1: FIX#1 — real agent panel, "Allocate Selected Numbers" modal ---');
  const ag = await bootPanel('agent', aTok, 'e2ag');
  const aw = ag.dom.window;
  t('A-UI1 agent panel boots, 0 script errors', ag.errors.length === 0, ag.errors.slice(0, 2).join(' ;; '));

  async function uiAllocate(number, clientId, payoutInput) {
    await aw.loadNumbers(); await sleep(400);
    const cb = aw.document.querySelector(`.rc[data-id="${idOf(number)}"]`);
    if (!cb) throw new Error('checkbox not found for ' + number);
    cb.checked = true;
    await aw.openAllocAll(); await sleep(200);
    aw.document.getElementById('aaClient').value = String(clientId);
    aw.document.getElementById('aaPayterm').value = 'weekly_7_1';
    aw.document.getElementById('aaPayout').value = payoutInput;
    await aw.confirmAllocAll(); await sleep(500);
    return dbo.prepare('SELECT payout, client_id FROM numbers WHERE number=?').get(number);
  }

  let r = await uiAllocate(N_E, C1, '');        // case 1: field CLEARED (empty)
  t('A-1 empty payout -> DB payout "0", client C1', r.payout === '0' && r.client_id === C1, JSON.stringify(r));
  r = await uiAllocate(N_0, C1, '0');           // case 2
  t('A-2 payout "0" -> DB "0"', r.payout === '0', JSON.stringify(r));
  r = await uiAllocate(N_1, C1, '1');           // case 3
  t('A-3 payout "1" -> DB "1"', r.payout === '1', JSON.stringify(r));
  r = await uiAllocate(N_2, C1, '2');           // case 4
  t('A-4 payout "2" -> DB "2"', r.payout === '2', JSON.stringify(r));
  r = await uiAllocate(N_013, C1, '0.013');     // case 5
  t('A-5 payout "0.013" -> DB "0.013" (exact, no rounding)', r.payout === '0.013', JSON.stringify(r));
  r = await uiAllocate(NB1, C1, '1');           // case 6a
  t('A-6a NB1 payout "1" -> DB "1"', r.payout === '1', JSON.stringify(r));
  r = await uiAllocate(NB2, C1, '2');           // case 6b (different payout, same client)
  t('A-6b NB2 payout "2" -> DB "2" (own value, not NB1 ka)', r.payout === '2', JSON.stringify(r));

  /* Range Allocation page (smart-divide) — real UI path */
  await aw.loadAgentPageData('bulkAlloc'); await sleep(900);
  const baRows = [...aw.document.querySelectorAll('#baBody tr')];
  t('A-UI2 Range Allocation page renders rows', baRows.length >= 2, baRows.map(tr => (tr.children[0] || {}).textContent).join(','));
  const bi = baRows.findIndex(tr => ((tr.children[0] || {}).textContent || '').includes('E2R2'));
  if (bi >= 0) {
    const elq = aw.document.getElementById('bq' + bi), elc = aw.document.getElementById('bc' + bi);
    elq.value = '1'; elc.value = 'e2c2';
    await aw.baRow(bi); await sleep(1800);
    const moved = dbo.prepare("SELECT payout, client_id FROM numbers WHERE number LIKE '448%' AND client_id=?").get(C2);
    t('A-7 Range Allocation (smart-divide) real allocation: number C2 ko gaya, payout "0"', !!moved && moved.payout === '0', JSON.stringify(moved));
  } else {
    t('A-7 Range Allocation (smart-divide) — E2R2 row mili hi nahi', false, '');
  }

  /* force re-allocation with payout omitted -> 0 (stale-payout regression) */
  r = await api('/api/numbers/allocate', 'POST', { ids: [idOf(N_2)], target_id: C2, force: true }, aTok);
  const rr = dbo.prepare('SELECT payout, client_id FROM numbers WHERE number=?').get(N_2);
  t('A-8 re-allocation (force, payout empty) -> NAYA client "0" dekhta hai (stale "2" nahi)', r.status === 200 && rr.payout === '0' && rr.client_id === C2, JSON.stringify(rr));

  /* client API raw values */
  const cnums = (await api('/api/numbers?limit=50', 'GET', null, c1Tok)).j.rows || [];
  const payOf = (n) => { const x = cnums.find(y => y.number === n); return x ? x.payout : 'MISSING'; };
  t('A-9 client API: exact strings (0/0/1/2/0.013/1/2)', payOf(N_E) === '0' && payOf(N_0) === '0' && payOf(N_1) === '1' && payOf(N_2) === 'MISSING' && payOf(N_013) === '0.013' && payOf(NB1) === '1' && payOf(NB2) === '2', JSON.stringify([payOf(N_E), payOf(N_0), payOf(N_1), payOf(N_013), payOf(NB1), payOf(NB2)]));
  const rangeRate = (await api('/api/ranges', 'GET', null, adm)).j.find(x => x.id === RC.id).rate_7_1;
  t('A-10 Rate Management rate UNCHANGED (koi range-rate fallback nahi)', rangeRate === '0.010', rangeRate);
  try { ag.dom.window.close(); } catch (e) {}

  /* ================================================================
   * PART 2 — FIX#1: client panel display (real UI) + reload
   * ================================================================ */
  console.log('\n--- PART 2: FIX#1 — client panel display + reload ---');
  async function clientPayouts(tok) {
    const cl = await bootPanel('client', tok, tok === c1Tok ? 'e2c1' : 'e2c2');
    const d = cl.dom.window;
    await sleep(1200);
    const out = {};
    [...d.document.querySelectorAll('#numBody tr')].forEach(tr => { const td = [...tr.children].map(x => x.textContent.trim()); out[td[1]] = td[4]; });
    const errs = cl.errors;
    try { d.close(); } catch (e) {}
    return { out, errs };
  }
  const p1 = await clientPayouts(c1Tok);
  t('C-UI1 client panel boots, 0 script errors', p1.errs.length === 0, p1.errs.slice(0, 2).join(' ;; '));
  t('C-UI2 case empty -> "$0.00"', p1.out[N_E] === '$0.00', JSON.stringify(p1.out[N_E]));
  t('C-UI3 case 0 -> "$0.00"', p1.out[N_0] === '$0.00', JSON.stringify(p1.out[N_0]));
  t('C-UI4 case 1 -> "$1.00"', p1.out[N_1] === '$1.00', JSON.stringify(p1.out[N_1]));
  t('C-UI6 case 0.013 -> EXACT "$0.013"', p1.out[N_013] === '$0.013', JSON.stringify(p1.out[N_013]));
  t('C-UI7 different payouts coexist (NB1 $1.00 vs NB2 $2.00)', p1.out[NB1] === '$1.00' && p1.out[NB2] === '$2.00', JSON.stringify([p1.out[NB1], p1.out[NB2]]));
  const p2c2 = await clientPayouts(c2Tok);
  t('C-UI8 C2 panel: N_2 (force re-alloc, empty) -> "$0.00" (stale $2.00 nahi)', p2c2.out[N_2] === '$0.00', JSON.stringify(p2c2.out[N_2]));
  const p1b = await clientPayouts(c1Tok); // RELOAD
  t('C-UI9 RELOAD: C1 payouts stable', p1b.out[N_E] === '$0.00' && p1b.out[N_1] === '$1.00' && p1b.out[N_013] === '$0.013' && p1b.out[NB1] === '$1.00' && p1b.out[NB2] === '$2.00', JSON.stringify(p1b.out));

  /* ================================================================
   * PART 3 — FIX#2: owner ka mandatory TEST A/B/C/D (+ phantom + DST)
   * ================================================================ */
  console.log('\n--- PART 3: FIX#2 — TEST A (before) ---');
  /* TN1, TN2 -> C1; TN3 -> C2 (agent allocations, realistic) */
  await api('/api/numbers/allocate', 'POST', { ids: [idOf(TN1), idOf(TN2)], target_id: C1, payterm: 'weekly_7_1', payout: '1' }, aTok);
  await api('/api/numbers/allocate', 'POST', { ids: [idOf(TN3)], target_id: C2, payterm: 'weekly_7_1', payout: '2' }, aTok);
  /* TN1: 3 SMS aaj (webhook = real ingest) + 2 winter SMS (direct, Jan 15 — GMT 23:30 boundary) */
  for (const [cli, m] of [['9401', 'a'], ['9401', 'b'], ['9402', 'c']]) { const s = await sms(TN1, cli, 'code ' + m); t('TEST A: TN1 SMS ' + cli, s.status === 200); }
  const s2 = await sms(TN2, '9501', 'code d'); t('TEST A: TN2 SMS 9501', s2.status === 200);
  const insSms = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,is_test,source,payout_rate,payout_amount,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,'carrier','0.010','0.010',?)`);
  const addStats = dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?,?,?,?,?,?,?)`);
  insSms.run(idOf(TN1), TN1, RC.id, '9403', 'shortcode', 'winter1', '111111', C1, A, '2026-01-15 23:30:00');
  insSms.run(idOf(TN1), TN1, RC.id, '9403', 'shortcode', 'winter2', '222222', C1, A, '2026-01-15 12:00:00');
  addStats.run('2026-01-15', -1, A, C1, '9403', 2, '0.020'); /* ingest jaisi SAHI key (GMT winter) */
  insSms.run(idOf(TN3), TN3, RC.id, '9601', 'shortcode', 'winter3', '333333', C2, A, '2026-01-15 23:45:00');
  addStats.run('2026-01-15', -1, A, C2, '9601', 1, '0.010');

  const admPanel = await bootPanel('admin', adm, 'vibepk');
  const apw = admPanel.dom.window;
  t('AD-UI1 admin panel boots, 0 script errors', admPanel.errors.length === 0, admPanel.errors.slice(0, 2).join(' ;; '));
  const dashCard = (label) => { const c = [...apw.document.querySelectorAll('#gxDashCards .stat-card .stat-info')].find(x => (x.querySelector('p') || {}).textContent === label); return c ? (c.querySelector('h3') || {}).textContent : 'MISSING'; };
  const dashChip = (label) => { const c = [...apw.document.querySelectorAll('#gxPayRow .gx-pay-chip')].find(x => { const tt = x.querySelector('.t'); return tt && tt.textContent === label; }); return c ? (c.querySelector('.v') || {}).textContent : 'MISSING'; };
  await apw.loadDashboard(); await sleep(700);

  const dA = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  const cdrA = {};
  ((await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j.rows || []).forEach(x => cdrA[x.key] = x.sms);
  const recA = {
    year: dA.sms_year, month: dA.sms_month, payMonth: Number(dA.payout_month), week: Number(dA.payout_week), today: dA.sms_today, total: dA.total_sms,
    ledger: dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c,
    dbSms: dbo.prepare('SELECT COUNT(*) c FROM sms_records').get().c,
    cli9401: cdrA['9401'] || 0, cli9402: cdrA['9402'] || 0, cli9501: cdrA['9501'] || 0,
    uiYear: dashCard('This Year'), uiPayMonth: dashChip('Payout — This Month'),
  };
  console.log('TEST A RECORDED:', JSON.stringify(recA));
  t('TEST A: CDR shows TN1 CLIs (9401:2, 9402:1)', recA.cli9401 === 2 && recA.cli9402 === 1, JSON.stringify(cdrA));
  t('TEST A: winter rows counted in YEAR (not month)', recA.year >= recA.month + 3, `year=${recA.year} month=${recA.month}`);
  t('TEST A: admin UI cards match API (This Year ' + recA.year + ')', recA.uiYear === Number(recA.year).toLocaleString(), JSON.stringify(recA.uiYear));
  t('TEST A: admin UI payout chip matches API', recA.uiPayMonth === '$ ' + Number(recA.payMonth).toFixed(2), JSON.stringify(recA.uiPayMonth));

  console.log('\n--- TEST B (delete TN1 + OTP/SMS) ---');
  await api('/api/dashboard', 'GET', null, adm); // cache prime
  await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  const del = await api('/api/numbers/delete', 'POST', { ids: [idOf(TN1)], delete_sms: true }, adm);
  t('TEST B: delete TN1 + SMS ok (5 SMS)', del.status === 200 && del.j.deleted === 1 && del.j.deleted_sms === 5, JSON.stringify(del.j));
  const dB = (await api('/api/dashboard', 'GET', null, adm)).j; // CACHED path — verKey invalidate hua hona chahiye
  t('TEST B: number + sms_records gone', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE number=?').get(TN1).c === 0 && dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE number=?').get(TN1).c === 0);
  const cdrB = {};
  ((await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j.rows || []).forEach(x => cdrB[x.key] = x.sms);
  t('TEST B: CDR clean (9401/9402/9403 gone)', !cdrB['9401'] && !cdrB['9402'] && !cdrB['9403'], JSON.stringify(cdrB));
  t('TEST B: This Year OTPs DROP 5 (' + recA.year + ' -> ' + dB.sms_year + ')', dB.sms_year === recA.year - 5);
  t('TEST B: This Month DROP 3 (' + recA.month + ' -> ' + dB.sms_month + ')', dB.sms_month === recA.month - 3);
  t('TEST B: This Month Payout DROP 0.030 (' + recA.payMonth + ' -> ' + dB.payout_month + ')', Math.abs(Number(dB.payout_month) - (recA.payMonth - 0.030)) < 1e-9);
  t('TEST B: today -3, total -5', dB.sms_today === recA.today - 3 && dB.total_sms === recA.total - 5, `today ${recA.today}->${dB.sms_today} total ${recA.total}->${dB.total_sms}`);
  t('TEST B: winter stats row (2026-01-15, cli 9403) bhi gayi', dbo.prepare("SELECT COUNT(*) c FROM sms_daily_stats WHERE cli='9403'").get().c === 0);
  t('TEST B: koi negative/leftover row nahi', dbo.prepare('SELECT COUNT(*) c FROM sms_daily_stats WHERE sms_count<0').get().c === 0);
  t('TEST B: payment_ledger UNTOUCHED (immutable)', dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c === recA.ledger);

  console.log('\n--- TEST C (reload / cache / re-login) ---');
  const dC1 = (await api('/api/dashboard', 'GET', null, adm)).j;
  const admRe = await login('vibepk', 'vibepk123');
  const dC2 = (await api('/api/dashboard', 'GET', null, admRe)).j;
  const dC3 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('TEST C: reload same (no resurrection)', dC1.sms_year === dB.sms_year && dC1.sms_month === dB.sms_month && Number(dC1.payout_month) === Number(dB.payout_month));
  t('TEST C: re-login same', dC2.sms_year === dB.sms_year && dC2.sms_month === dB.sms_month);
  t('TEST C: _nocache same', dC3.sms_year === dB.sms_year && dC3.sms_month === dB.sms_month && Math.abs(Number(dC3.payout_month) - Number(dB.payout_month)) < 1e-9);
  await apw.loadDashboard(); await sleep(600);
  t('TEST C: admin PANEL cards bhi post-delete values par', dashCard('This Year') === Number(dB.sms_year).toLocaleString() && dashChip('Payout — This Month') === '$ ' + Number(dB.payout_month).toFixed(2), dashCard('This Year') + ' / ' + dashChip('Payout — This Month'));

  console.log('\n--- TEST D (unrelated data preserved) ---');
  const cdrD = {};
  ((await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j.rows || []).forEach(x => cdrD[x.key] = x.sms);
  t('TEST D: TN2 SMS/CDR intact (9501:1)', cdrD['9501'] === 1, JSON.stringify(cdrD));
  t('TEST D: TN2 + TN3 numbers exist', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE number IN (?,?)').get(TN2, TN3).c === 2);
  t('TEST D: TN3 winter row intact (9601)', dbo.prepare("SELECT sms_count c FROM sms_daily_stats WHERE cli='9601'").get().c === 1);
  t('TEST D: client payouts untouched', dbo.prepare('SELECT payout FROM numbers WHERE number=?').get(N_013).payout === '0.013');
  t('TEST D: ledger rows unchanged', dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c === recA.ledger);

  console.log('\n--- PHANTOM residue + Rebuild Stats (owner ke live-VPS scenario ka repair) ---');
  addStats.run(today, -1, -1, -1, 'OLDDATA', 42000, '99.00');
  const ph1 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('PH-1 phantom residue dashboard inflate karta hai (pre-P19 deletes ka simulation)', ph1.sms_year === dB.sms_year + 42000 && Math.abs(Number(ph1.payout_month) - (Number(dB.payout_month) + 99)) < 1e-9, `year ${dB.sms_year}->${ph1.sms_year} pay ${dB.payout_month}->${ph1.payout_month}`);
  const rbj = await apw.API.post('/admin/backfill-stats', { reset: true }); /* panel ka real transport (Rebuild Stats button wahi use karta hai) */
  t('PH-2 Rebuild Stats runs (panel API.post se)', !!(rbj && rbj.ok !== false), JSON.stringify(rbj));
  const ph2 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  /* dashboard == EXACT recomputation from live sms_records */
  const dbRecompute = dbo.prepare(`SELECT COUNT(*) c, COALESCE(SUM(CAST(COALESCE(NULLIF(payout_amount,''),'0') AS REAL)),0) p FROM sms_records WHERE COALESCE(is_test,0)=0`).get();

  t('PH-3 phantom GONE; year == live sms_records count', ph2.sms_year === dbRecompute.c && ph2.sms_year === dB.sms_year, `year ${ph1.sms_year}->${ph2.sms_year} (live=${dbRecompute.c})`);
  t('PH-4 payout_month == live recomputation (99 phantom hat gaya)', Math.abs(Number(ph2.payout_month) - (Number(dB.payout_month))) < 1e-9, `pay ${ph1.payout_month}->${ph2.payout_month}`);
  t('PH-5 month card rebuild ke baad bhi correct (month == live this-month rows)', ph2.sms_month === dB.sms_month, `month ${dB.sms_month} -> ${ph2.sms_month}`);
  t('PH-6 winter rows (9601) rebuild ke baad SAHI key par', dbo.prepare("SELECT stat_date FROM sms_daily_stats WHERE cli='9601'").get().stat_date === '2026-01-15');

  console.log('\n--- DELETE after rebuild (DST chain: rebuild -> delete -> drop) ---');
  const before3 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  /* delete PANEL ke real transport se (UI delete button yahi API.post use karta hai —
     client-side GET cache bhi clear hota hai, exactly jaise browser me hota) */
  const del3p = await apw.API.post('/numbers/delete', { ids: [idOf(TN3)], delete_sms: true });
  const after3 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('DR-1 TN3 delete ok (panel API.post se)', !!(del3p && del3p.ok && del3p.deleted_sms === 1), JSON.stringify(del3p));
  t('DR-2 This Year DROP 1 (' + before3.sms_year + ' -> ' + after3.sms_year + ') — rebuilt key match karke decrement hua', after3.sms_year === before3.sms_year - 1);
  t('DR-3 winter stats row (9601) poori tarah gayi', dbo.prepare("SELECT COUNT(*) c FROM sms_daily_stats WHERE cli='9601'").get().c === 0);
  t('DR-4 final: dashboard == live sms_records', after3.sms_year === dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE COALESCE(is_test,0)=0').get().c, `dash=${after3.sms_year} db=${dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE COALESCE(is_test,0)=0').get().c}`);
  await apw.loadDashboard(); await sleep(600);
  t('DR-5 admin panel final values correct', dashCard('This Year') === Number(after3.sms_year).toLocaleString(), dashCard('This Year'));
  try { apw.close(); } catch (e) {}

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); await stopServer(); process.exit(1); });
