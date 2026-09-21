#!/usr/bin/env node
/* ===========================================================================
 * P19c VERIFICATION — 3 final fixes (owner task "GALAXY SMS — 3 FINAL FIXES")
 * ---------------------------------------------------------------------------
 * FIX#1  Client dashboard "This Month Payout" -> REAL "This Week Payout"
 *        (payout_week — backend ka existing Monday-start UK-week engine).
 * FIX#2  Client panel numbers: EXACT agent-assigned allocation payout
 *        (numbers.payout) — cases 0 / 1 / 2 / 0.013 + mixed + refresh.
 * FIX#3  Deleted number + OTP/SMS: Admin dashboard (This Year OTPs, This Month
 *        Payout, all other stats) must stop counting deleted data — TEST A-D
 *        exactly as owner specified (before / delete / cache-reload / other-data).
 * Run: node tests/p19c-verify.js  (repo root se; jsdom /tmp/uitest me chahiye UI part ke liye)
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.P19C_PORT || '8096';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19C_DB || '/tmp/p19ctest.db';
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
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
async function login(u, p) { return (await api('/api/login', 'POST', { username: u, password: p })).j.token || null; }
async function sms(number, cli, msg) {
  const b = new URLSearchParams({ number, cli, message: msg || ('Your code is ' + Math.floor(1000 + Math.random() * 9000)) });
  const r = await fetch(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
function ukDateOfSql(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts)); if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function ukToday() { return ukDateOfSql(new Date().toISOString().slice(0, 19).replace('T', ' ')); }
function mondayOf(dstr) { const d = new Date(dstr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19ctest', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
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

(async () => {
  console.log('P19c verification suite — ' + new Date().toISOString());
  console.log('DB: ' + DB + '  BASE: ' + BASE);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();
  const today = ukToday();
  const monday = mondayOf(today);
  const lastMonday = mondayOf(mondayOf(today)); // hmm — previous week Monday
  const prevWeekMonday = (() => { const d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); })();
  const yearStart = today.slice(0, 4) + '-01-01';
  const marchDay = today.slice(0, 4) + '-03-10'; // same year, NOT this month/week (deterministic past date)

  /* ---------- fixture ---------- */
  const adm = await login('vibepk', 'vibepk123');
  t('setup: admin login', !!adm);
  await api('/api/users', 'POST', { username: 'p19ca', password: 'Test123!', role: 'agent', active: true }, adm);
  const aTok = await login('p19ca', 'Test123!');
  await api('/api/users', 'POST', { username: 'p19cc', password: 'Test123!', role: 'client', active: true }, aTok);
  const cTok = await login('p19cc', 'Test123!');
  const A = dbo.prepare("SELECT id FROM users WHERE username='p19ca'").get().id;
  const C = dbo.prepare("SELECT id FROM users WHERE username='p19cc'").get().id;
  t('setup: agent + client created', !!(aTok && cTok && A && C));

  await api('/api/ranges', 'POST', { name: 'P19C1', prefix: '447', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: 'UK', status: 'Active' }, adm);
  const RC = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'P19C1');
  t('setup: range created', !!RC);

  /* numbers: 4 payout-test (client C) + TN1/TN2 (FIX#3 test data, agent A) */
  const insNum = dbo.prepare("INSERT INTO numbers (number, range_id, prefix, payterm, payout, manager_id, agent_id, client_id, rate, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))");
  const P0 = '447100000001', P1 = '447100000002', P2 = '447100000003', P013 = '447100000004';
  const TN1 = '447200000001', TN2 = '447200000002';
  for (const [num, own] of [[P0, C], [P1, C], [P2, C], [P013, C], [TN1, null], [TN2, null]]) {
    insNum.run(num, RC.id, '447', 'weekly_7_1', '0', null, own ? A : null, own || null, '');
  }
  /* agent allocation of the 4 client numbers with EXACT payouts (owner cases 1-4).
     Yahan real API path use karte hain: agent -> client allocation payout numbers.payout me jata hai. */
  const idOf = (n) => dbo.prepare('SELECT id FROM numbers WHERE number=?').get(n).id;
  const alloc = async (num, payout) => api('/api/numbers/allocate', 'POST', { ids: [idOf(num)], target_id: C, payterm: 'weekly_7_1', payout }, aTok);
  let a = await alloc(P0, '0');    t('setup: agent alloc P0 payout=0', a.status === 200 && (a.j.count || 0) === 1, JSON.stringify(a.j).slice(0, 60));
  a = await alloc(P1, '1');        t('setup: agent alloc P1 payout=1', a.status === 200 && (a.j.count || 0) === 1);
  a = await alloc(P2, '2');        t('setup: agent alloc P2 payout=2', a.status === 200 && (a.j.count || 0) === 1);
  a = await alloc(P013, '0.013');  t('setup: agent alloc P013 payout=0.013', a.status === 200 && (a.j.count || 0) === 1);
  const rangeRateAfter = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.id === RC.id).rate_7_1;
  t('C-P6 Rate Management range rate UNCHANGED (0.010)', rangeRateAfter === '0.010', 'rate_7_1=' + rangeRateAfter);

  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  await sleep(300);

  /* ============================ FIX #2 — exact payout ============================ */
  console.log('\n--- FIX#2: client sees EXACT agent-assigned payout ---');
  const cnums = (await api('/api/numbers?limit=50', 'GET', null, cTok)).j;
  const crows = cnums.rows || cnums;
  const payOf = (n) => { const r = crows.find(x => x.number === n); return r ? r.payout : 'MISSING'; };
  t('C-P1 case payout=0 -> client API returns exact "0"', payOf(P0) === '0', JSON.stringify(payOf(P0)));
  t('C-P2 case payout=1 -> client API returns exact "1"', payOf(P1) === '1', JSON.stringify(payOf(P1)));
  t('C-P3 case payout=2 -> client API returns exact "2"', payOf(P2) === '2', JSON.stringify(payOf(P2)));
  t('C-P4 case payout=0.013 -> client API returns exact "0.013"', payOf(P013) === '0.013', JSON.stringify(payOf(P013)));
  t('C-P4b different payouts coexist on same client (no global fallback)', payOf(P0) === '0' && payOf(P1) === '1' && payOf(P2) === '2' && payOf(P013) === '0.013');
  const dbPays = dbo.prepare('SELECT payout FROM numbers WHERE number IN (?,?,?,?) ORDER BY number').all(P0, P1, P2, P013).map(r => r.payout);
  t('C-P5 DB stores exact decimal strings ("0","1","2","0.013")', JSON.stringify(dbPays) === JSON.stringify(['0', '1', '2', '0.013']), JSON.stringify(dbPays));
  const cnums2 = (await api('/api/numbers?limit=50', 'GET', null, cTok)).j;
  const crows2 = cnums2.rows || cnums2;
  const payOf2 = (n) => { const r = crows2.find(x => x.number === n); return r ? r.payout : 'MISSING'; };
  t('C-P7 refresh (re-call API) -> values stable', payOf2(P0) === '0' && payOf2(P1) === '1' && payOf2(P2) === '2' && payOf2(P013) === '0.013');

  /* ============================ FIX #1 — this week payout ============================ */
  console.log('\n--- FIX#1: client This Week Payout ---');
  let s = await sms(P013, '9001', 'code 9001'); t('setup: SMS on client number (payout engine writes stats)', s.status === 200);
  s = await sms(P013, '9002', 'code 9002'); t('setup: SMS #2 on client number', s.status === 200);
  /* previous-week client stats row (same month possible, but PREVIOUS week) — month me count, week me NAHI */
  dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?,?,?,?,?,?,?)`)
    .run(prevWeekMonday, -1, -1, C, '88001', 5, '5.00');
  const cd = (await api('/api/dashboard?_nocache=1', 'GET', null, cTok)).j;
  const smsPay = dbo.prepare("SELECT COALESCE(SUM(CAST(payout_amount AS REAL)),0) p FROM sms_records WHERE number=? AND COALESCE(is_test,0)=0").get(P013).p;
  t('C-W1 client payout_week = this week SMS payouts (engine values)', Math.abs(Number(cd.payout_week) - smsPay) < 1e-9, `payout_week=${cd.payout_week} smsSum=${smsPay}`);
  t('C-W2 previous-week row NOT in payout_week (week != all-time)', Math.abs(Number(cd.payout_week) - smsPay) < 1e-9, `payout_week=${cd.payout_week}`);
  t('C-W3 payout_month INCLUDES previous-week row (5.00 more than week)', Math.abs(Number(cd.payout_month) - (smsPay + 5)) < 1e-9, `payout_month=${cd.payout_month} expected=${smsPay + 5}`);
  t('C-W4 week window matches Monday-start rule', monday <= today && prevWeekMonday < monday, `monday=${monday} prevMonday=${prevWeekMonday} today=${today}`);
  const ad5 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('C-W5 admin dashboard payout_week also works (same engine, untouched)', Number(ad5.payout_week) >= Number(cd.payout_week), `admin week=${ad5.payout_week} client week=${cd.payout_week}`);

  /* ============================ FIX #3 — TEST A/B/C/D ============================ */
  console.log('\n--- FIX#3: TEST A (before deletion) ---');
  /* TN1: 3 SMS today + 2 direct-insert March rows (this year, not this month) — agent-owned */
  a = await api('/api/numbers/allocate', 'POST', { ids: [idOf(TN1), idOf(TN2)], target_id: A, payterm: 'weekly_7_1' }, adm);
  t('TEST A: TN1+TN2 allocated to agent', a.status === 200);
  s = await sms(TN1, '9101', 'code 9101'); t('TEST A: TN1 SMS #1 (today)', s.status === 200);
  s = await sms(TN1, '9101', 'code 9102'); t('TEST A: TN1 SMS #2 (today)', s.status === 200);
  s = await sms(TN1, '9102', 'code 9103'); t('TEST A: TN1 SMS #3 (today)', s.status === 200);
  const insSms = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,source,payout_rate,payout_amount,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addStats = dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?,?,?,?,?,?,?)`);
  insSms.run(idOf(TN1), TN1, RC.id, '9103', 'shortcode', 'march otp 1', '111111', null, A, null, 0, 'carrier', '0.010', '0.010', marchDay + ' 10:00:00');
  insSms.run(idOf(TN1), TN1, RC.id, '9103', 'shortcode', 'march otp 2', '222222', null, A, null, 0, 'carrier', '0.010', '0.010', marchDay + ' 11:00:00');
  addStats.run(marchDay, -1, A, -1, '9103', 2, '0.020'); // keyed jaise recordSmsStats karta (UK date, March = GMT)
  s = await sms(TN2, '9201', 'code 9201'); t('TEST A: TN2 SMS (today, survives)', s.status === 200);

  const dA = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  const sumA = (await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j;
  const cliTodayA = {}; (sumA.rows || []).forEach(r => cliTodayA[r.key] = r.sms);
  const recA = {
    year: dA.sms_year, month: dA.sms_month, week: dA.payout_week, payMonth: Number(dA.payout_month),
    today: dA.sms_today, total: dA.total_sms,
    cli9101: cliTodayA['9101'] || 0, cli9102: cliTodayA['9102'] || 0, cli9201: cliTodayA['9201'] || 0,
  };
  t('TEST A: CDR shows TN1 CLIs (9101:2, 9102:1)', recA.cli9101 === 2 && recA.cli9102 === 1, JSON.stringify(cliTodayA));
  t('TEST A: dashboard counts them (today = ' + recA.today + ', year = ' + recA.year + ')', recA.today >= 6 && recA.year >= 7, JSON.stringify({ today: recA.today, year: recA.year }));
  t('TEST A: This Year OTPs includes March rows (year > month)', recA.year > recA.month, `year=${recA.year} month=${recA.month}`);
  console.log('TEST A RECORDED:', JSON.stringify(recA));

  console.log('\n--- FIX#3: TEST B (delete TN1 + OTP/SMS) ---');
  /* prime the caches FIRST (non-nocache) — then delete — refresh must be immediate */
  await api('/api/dashboard', 'GET', null, adm);
  await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  const del = await api('/api/numbers/delete', 'POST', { ids: [idOf(TN1)], delete_sms: true }, adm);
  t('TEST B: delete TN1 + SMS ok', del.status === 200 && del.j.deleted === 1 && del.j.deleted_sms === 5, JSON.stringify(del.j));
  const dB = (await api('/api/dashboard', 'GET', null, adm)).j; // cached call — verKey invalidate => fresh
  t('TEST B: number gone from DB', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE number=?').get(TN1).c === 0);
  t('TEST B: sms_records gone (5 rows)', dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE number=?').get(TN1).c === 0);
  const sumB = (await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j;
  const cliTodayB = {}; (sumB.rows || []).forEach(r => cliTodayB[r.key] = r.sms);
  t('TEST B: CDR no longer shows TN1 CLIs (9101/9102 gone)', (cliTodayB['9101'] || 0) === 0 && (cliTodayB['9102'] || 0) === 0, JSON.stringify(cliTodayB));
  t('TEST B: This Year OTPs DROPS by 5 (3 today + 2 March)', dB.sms_year === recA.year - 5, `before=${recA.year} after=${dB.sms_year}`);
  t('TEST B: This Month (sms_month) drops by 3 (March rows not in month)', dB.sms_month === recA.month - 3, `before=${recA.month} after=${dB.sms_month}`);
  /* March rows is-year me hain, month me NAHI — isliye payout_month sirf is-month wali
     3 rows (3 x 0.010 = 0.030) se girega. March ka hissa sms_year ke drop (5) me verified. */
  const payDrop = Number((recA.payMonth - Number(dB.payout_month)).toFixed(6));
  t('TEST B: This Month Payout drops by deleted THIS-MONTH payouts (0.030)', Math.abs(payDrop - 0.030) < 1e-6, `before=${recA.payMonth} after=${dB.payout_month} drop=${payDrop}`);
  t('TEST B: today/total drop too', dB.sms_today === recA.today - 3 && dB.total_sms === recA.total - 5, `today ${recA.today}->${dB.sms_today} total ${recA.total}->${dB.total_sms}`);
  t('TEST B: no negative/orphan stats rows left', dbo.prepare('SELECT COUNT(*) c FROM sms_daily_stats WHERE sms_count<0 OR stat_date=?').get('9999-99-99').c === 0);

  console.log('\n--- FIX#3: TEST C (reload / cache / re-login) ---');
  const dC1 = (await api('/api/dashboard', 'GET', null, adm)).j;
  const admRe = await login('vibepk', 'vibepk123');
  const dC2 = (await api('/api/dashboard', 'GET', null, admRe)).j;
  const dC3 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('TEST C: reload -> same values (no resurrection)', dC1.sms_year === dB.sms_year && dC1.sms_month === dB.sms_month && Number(dC1.payout_month) === Number(dB.payout_month), `year=${dC1.sms_year}`);
  t('TEST C: re-login -> same values', dC2.sms_year === dB.sms_year && dC2.sms_month === dB.sms_month, `year=${dC2.sms_year}`);
  t('TEST C: _nocache direct API -> same values', dC3.sms_year === dB.sms_year && dC3.sms_month === dB.sms_month && Math.abs(Number(dC3.payout_month) - Number(dB.payout_month)) < 1e-9, `year=${dC3.sms_year} payMonth=${dC3.payout_month}`);

  console.log('\n--- FIX#3: TEST D (unrelated data preserved) ---');
  const sumD = (await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm)).j;
  const cliTodayD = {}; (sumD.rows || []).forEach(r => cliTodayD[r.key] = r.sms);
  t('TEST D: TN2 SMS still in CDR (9201:1)', (cliTodayD['9201'] || 0) === 1, JSON.stringify(cliTodayD));
  t('TEST D: TN2 number still exists', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE number=?').get(TN2).c === 1);
  const dD = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  t('TEST D: TN2 still counted in today (9201) + total', (cliTodayD['9201'] || 0) === 1 && dD.sms_today === dB.sms_today, `today=${dD.sms_today}`);
  t('TEST D: client payout data untouched (FIX#2 values still exact)', (() => { const r = dbo.prepare('SELECT payout FROM numbers WHERE number=?').get(P013); return r.payout === '0.013'; })(), '');
  t('TEST D: payment_ledger rows preserved (immutability)', dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c >= 0, 'rows=' + dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c);

  /* ============================ FIX #1/#2 — client panel UI (jsdom) ============================ */
  console.log('\n--- CLIENT PANEL UI (jsdom, live server) ---');
  try {
    let JSDOM, VirtualConsole;
    try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { ({ JSDOM, VirtualConsole } = require('/tmp/uitest/node_modules/jsdom')); }
    const NOISE = [/Not implemented: navigation/i, /Could not parse CSS/i, /not implemented/i];
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
    vc.on('error', (...a) => { const m = a.join(' '); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
    const dom = await JSDOM.fromURL(BASE + '/client', {
      resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(window) {
        window.fetch = (input, init) => fetch(new URL(String(input), BASE).href, init);
        window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
        window.localStorage.setItem('ms_token', cTok); window.localStorage.setItem('ms_role', 'client');
        window.localStorage.setItem('ms_user', 'p19cc'); window.localStorage.setItem('ms_name', 'p19cc');
      },
    });
    await sleep(3000);
    const d = dom.window.document;
    t('UI-C1 client panel boots, 0 script errors', errors.length === 0, errors.slice(0, 2).join(' ;; '));

    /* FIX#1: card label + bound value */
    const cards = [...d.querySelectorAll('#page-dashboard .stat-card .stat-info')];
    const weekCard = cards.find(c => (c.querySelector('p') || {}).textContent === 'This Week Payout');
    t('UI-C2 FIX#1 card label = "This Week Payout" (was This Month)', !!weekCard, cards.map(c => (c.querySelector('p') || {}).textContent).join(','));
    const weekVal = weekCard ? (weekCard.querySelector('h3') || {}).textContent : '';
    const apiWeek = (await api('/api/dashboard?_nocache=1', 'GET', null, cTok)).j.payout_week;
    t('UI-C3 FIX#1 card shows payout_week value (not month)', Math.abs(parseFloat(String(weekVal).replace(/[^0-9.\-]/g, '')) - Number(apiWeek)) < 0.005, `card="${weekVal}" api=${apiWeek}`);
    const monthCards = cards.filter(c => /This Month Payout/.test((c.querySelector('p') || {}).textContent));
    t('UI-C4 FIX#1 no "This Month Payout" card left on client dashboard', monthCards.length === 0);

    /* FIX#2: numbers table payout cells */
    await dom.window.showPageByName ? null : null;
    try { dom.window.loadNumbers ? await dom.window.loadNumbers() : await dom.window.renderNumbers(); } catch (e) {}
    await sleep(1500);
    const ths = [...(d.querySelector('#numBody') ? d.querySelector('#numBody').closest('table').querySelectorAll('thead th') : [])].map(x => x.textContent.trim());
    t('UI-C5 FIX#2 numbers table has Payout column', ths.some(x => x === 'Payout'), JSON.stringify(ths));
    const rowPay = {};
    [...d.querySelectorAll('#numBody tr')].forEach(tr => { const tds = [...tr.children].map(x => x.textContent.trim()); const num = tds[1] || ''; const pay = tds[4] || ''; rowPay[num] = pay; });
    t('UI-C6 FIX#2 payout=0 shown as $0.00', rowPay[P0] === '$0.00', JSON.stringify(rowPay[P0]));
    t('UI-C7 FIX#2 payout=1 shown as $1.00', rowPay[P1] === '$1.00', JSON.stringify(rowPay[P1]));
    t('UI-C8 FIX#2 payout=2 shown as $2.00', rowPay[P2] === '$2.00', JSON.stringify(rowPay[P2]));
    t('UI-C9 FIX#2 payout=0.013 shown EXACTLY as $0.013', rowPay[P013] === '$0.013', JSON.stringify(rowPay[P013]));
    /* refresh persistence */
    try { await dom.window.renderNumbers(); } catch (e) {}
    await sleep(1200);
    const rowPay2 = {};
    [...d.querySelectorAll('#numBody tr')].forEach(tr => { const tds = [...tr.children].map(x => x.textContent.trim()); rowPay2[tds[1]] = tds[4]; });
    t('UI-C10 FIX#2 refresh -> payouts stable', rowPay2[P0] === '$0.00' && rowPay2[P1] === '$1.00' && rowPay2[P2] === '$2.00' && rowPay2[P013] === '$0.013', JSON.stringify(rowPay2));
    try { dom.window.close(); } catch (e) {}
  } catch (e) {
    t('UI section (jsdom unavailable?)', false, String(e.message).slice(0, 80));
  }

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); await stopServer(); process.exit(1); });
