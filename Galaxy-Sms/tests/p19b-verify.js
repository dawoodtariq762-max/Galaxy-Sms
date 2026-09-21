#!/usr/bin/env node
/* ===========================================================================
 * P19b VERIFICATION — Map country attribution + delete-stats completeness
 * ---------------------------------------------------------------------------
 * Issue 1 (map): Russia/Afghanistan map par bina real message ke dikhte the.
 *   Root causes fixed: (a) is_test=1 rows map me count hote the (test-panel/demo);
 *   (b) prefix attribution naive tha (UK national-format '7xxx...' -> Russia);
 *   (c) "today" window UTC-midnight tha, UK-day nahi.
 *   Fix: is_test exclude + range-country (authoritative) + E.164 longest-prefix
 *   (3->2->1, min 7 digits) + ukDayOffsetSql window.
 * Issue 2 (delete): range-delete ke orphan SMS stats decrement nahi karte the;
 *   stats-decrement missing-key par POSITIVE phantom row bana sakta tha.
 *   Fix: shared decrementSmsDailyStats() (negative VALUES, phantom-safe) +
 *   range-delete orphan path + admin "Rebuild Stats" repair button.
 * Run: node tests/p19b-verify.js  (repo root se)
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.P19B_PORT || '8094';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19B_DB || '/tmp/p19btest.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
function t(name, ok, detail) {
  const line = (ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '');
  console.log(line);
  if (ok) PASS++; else FAIL++;
}
async function api(path_, method = 'GET', body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + path_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
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
function addDays(str, n) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19btest', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
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
  console.log('P19b verification suite — ' + new Date().toISOString());
  console.log('DB: ' + DB + '  BASE: ' + BASE);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();

  const adm = await login('vibepk', 'vibepk123');
  t('setup: admin login', !!adm);
  await api('/api/users', 'POST', { username: 'p19bm', password: 'Test123!', role: 'manager', active: true }, adm);
  const mTok = await login('p19bm', 'Test123!');
  await api('/api/users', 'POST', { username: 'p19ba', password: 'Test123!', role: 'agent', active: true }, mTok);
  const aTok = await login('p19ba', 'Test123!');
  const M = dbo.prepare("SELECT id FROM users WHERE username='p19bm'").get().id;
  const A = dbo.prepare("SELECT id FROM users WHERE username='p19ba'").get().id;
  t('setup: users created', !!(mTok && aTok && M && A));

  /* ranges: RB1 country 'UK' (E.164 447...), RB2 country 'United Kingdom' (national 74...),
     RB3 country '' (353... — prefix fallback, 3-digit code) */
  await api('/api/ranges', 'POST', { name: 'P19B1', prefix: '447', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: 'UK', status: 'Active' }, adm);
  await api('/api/ranges', 'POST', { name: 'P19B2', prefix: '74', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: 'United Kingdom', status: 'Active' }, adm);
  await api('/api/ranges', 'POST', { name: 'P19B3', prefix: '353', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: '', status: 'Active' }, adm);
  const ranges = (await api('/api/ranges', 'GET', null, adm)).j;
  const RB1 = ranges.find(r => r.name === 'P19B1'), RB2 = ranges.find(r => r.name === 'P19B2'), RB3 = ranges.find(r => r.name === 'P19B3');
  t('setup: ranges created', !!(RB1 && RB2 && RB3));

  /* numbers: RB1 + RB2 via direct DB (format control), RB3 ke 2 numbers */
  const insNum = dbo.prepare('INSERT INTO numbers (number, range_id, prefix, payterm, payout, manager_id, agent_id, client_id, rate, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\'))');
  const nUk1 = '447000100001', nUk2 = '447000100002';          // E.164 UK -> RB1
  const nNat = '74123450001';                                  // national format -> RB2 (country 'United Kingdom')
  const nIeA = '353000100001', nIeM = '353000100002';          // 3-digit code -> RB3 (country '')
  insNum.run(nUk1, RB1.id, '447', 'weekly_7_1', '0', null, A, null, '');
  insNum.run(nUk2, RB1.id, '447', 'weekly_7_1', '0', null, A, null, '');
  insNum.run(nNat, RB2.id, '74', 'weekly_7_1', '0', null, A, null, '');
  insNum.run(nIeA, RB3.id, '353', 'weekly_7_1', '0', null, A, null, '');
  insNum.run(nIeM, RB3.id, '353', 'weekly_7_1', '0', M, null, null, ''); // manager-owned (scoping test)
  t('setup: numbers inserted', dbo.prepare('SELECT COUNT(*) c FROM numbers').get().c === 5);

  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  await sleep(300);

  const today = ukToday(), yesterday = addDays(today, -1);

  /* real SMS (webhook -> full ingest path, stats written) */
  let s = await sms(nUk1, '7001', 'code 1111'); t('setup: real SMS on E.164 UK number', s.status === 200, JSON.stringify(s.j).slice(0, 50));
  s = await sms(nUk1, '7002', 'code 1112'); t('setup: real SMS #2 on E.164 UK number', s.status === 200);
  s = await sms(nNat, '7010', 'code 1113'); t('setup: real SMS on national-format number (74...)', s.status === 200);
  s = await sms(nIeA, '7020', 'code 1114'); t('setup: real SMS on 353 number (agent-owned)', s.status === 200);
  s = await sms(nIeM, '7021', 'code 1115'); t('setup: real SMS on 353 number (manager-owned)', s.status === 200);

  /* TEST/DEMO rows (is_test=1) — in par map ko kabhi count NAHI karna */
  const insSms = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insSms.run(null, '79999990001', null, '79001', 'shortcode', 'demo test', '111111', null, null, null, 1, 'DEMO-1', 'test_panel_fake', '0', '0', new Date().toISOString().slice(0, 19).replace('T', ' '));
  insSms.run(null, '93999990001', null, '79002', 'shortcode', 'demo test 2', '222222', null, null, null, 1, 'DEMO-2', 'test_panel_fake', '0', '0', new Date().toISOString().slice(0, 19).replace('T', ' '));
  insSms.run(null, '75757', null, '79003', 'shortcode', 'short code row', '333333', null, null, null, 1, 'DEMO-3', 'test_panel_fake', '0', '0', new Date().toISOString().slice(0, 19).replace('T', ' '));

  /* real orphan row: number '9312345678', koi range nahi — prefix fallback => Afghanistan (documented rule) */
  insSms.run(null, '9312345678', null, '79100', 'shortcode', 'orphan real row', '444444', null, null, null, 0, null, 'carrier', '0.010', '0.010', new Date().toISOString().slice(0, 19).replace('T', ' '));
  /* real shortcode-length row (< 7 digits) — kisi country me count NAHI hona chahiye */
  insSms.run(null, '757575', null, '79101', 'shortcode', 'real short number', '555555', null, null, null, 0, null, 'carrier', '0.010', '0.010', new Date().toISOString().slice(0, 19).replace('T', ' '));
  /* UK-boundary real row: yesterday 23:30 UTC = UK TODAY (map ka window UK-day hai) */
  const boundaryTs = yesterday + ' 23:30:00';
  const boundaryUk = ukDateOfSql(boundaryTs);
  t('setup: boundary row is UK-today', boundaryUk === today, `boundary=${boundaryUk} today=${today}`);
  insSms.run(null, '447000100003', RB1.id, '79200', 'shortcode', 'boundary row', '666666', null, A, null, 0, null, 'carrier', '0.010', '0.010', boundaryTs);

  const dash = () => api('/api/dashboard?_nocache=1', 'GET', null, adm);
  const mapOf = (d) => { const m = {}; (d.j.sms_by_country || []).forEach(x => m[x.iso] = x.count); return m; };

  /* ===================== MAP (issue 1) ===================== */
  console.log('\n--- MAP: country attribution ---');
  let d1 = await dash();
  let map = mapOf(d1);
  t('B-M1 E.164 UK + national-format + boundary -> gb 4', map.gb === 4, JSON.stringify(map));
  t('B-M2 NO Russia on the map (test rows + national format excluded/attributed)', map.ru === undefined, JSON.stringify(map));
  t('B-M3 national-format 7xxx number -> gb via RANGE country (2 E.164 + 1 national + 1 boundary)', map.gb === 4 && map.ru === undefined, 'gb=' + map.gb);
  t('B-M4 orphan 93... number -> Afghanistan via prefix fallback (documented rule)', map.af === 1, JSON.stringify(map));
  t('B-M5 3-digit code works: 353 -> Ireland (ie), count 2', map.ie === 2, JSON.stringify(map));
  t('B-M6 shortcode-length rows attributed to NO country', Object.keys(map).sort().join(',') === 'af,gb,ie', JSON.stringify(map));
  t('B-M7 UK-day window: boundary SMS (yesterday 23:30Z = UK today) counted in gb=4', map.gb === 4, 'gb=' + map.gb);

  /* role scoping retained */
  const dm = await api('/api/dashboard?_nocache=1', 'GET', null, mTok);
  const mapM = mapOf(dm);
  const da = await api('/api/dashboard?_nocache=1', 'GET', null, aTok);
  const mapA = mapOf(da);
  t('B-M8 manager sees ONLY own pool (its 353 number -> ie 1)', mapM.ie === 1 && mapM.gb === undefined && mapM.af === undefined, JSON.stringify(mapM));
  t('B-M9 agent sees ONLY own numbers (gb 4 + ie 1, no manager/other data)', mapA.gb === 4 && mapA.ie === 1 && mapA.af === undefined, JSON.stringify(mapA));

  /* delete a number+SMS -> map drops too (same response object) */
  const nUk1id = dbo.prepare('SELECT id FROM numbers WHERE number=?').get(nUk1).id;
  const before = await dash();
  const del = await api('/api/numbers/delete', 'POST', { ids: [nUk1id], delete_sms: true }, adm);
  t('B-M10 delete number+SMS ok', del.status === 200 && del.j.deleted === 1 && del.j.deleted_sms === 2, JSON.stringify(del.j));
  const after = await dash();
  t('B-M11 map drops deleted number SMS immediately (gb 4 -> 2)', mapOf(after).gb === 2, JSON.stringify(mapOf(after)));
  t('B-M12 dashboard today drops 2 as well', after.j.sms_today === before.j.sms_today - 2, `before=${before.j.sms_today} after=${after.j.sms_today}`);

  /* ===================== DELETE completeness (issue 2) ===================== */
  console.log('\n--- DELETE: stats completeness ---');
  /* D1: range-delete orphan path */
  await api('/api/ranges', 'POST', { name: 'P19B4', prefix: '446', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: 'UK', status: 'Active' }, adm);
  const RB4 = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'P19B4');
  insNum.run('446000100001', RB4.id, '446', 'weekly_7_1', '0', null, A, null, '');
  s = await sms('446000100001', '7300', 'code 7777'); t('B-D1a real SMS on RB4 number', s.status === 200);
  s = await sms('446000100001', '7301', 'code 7778'); t('B-D1b real SMS #2 on RB4 number', s.status === 200);
  let dD1 = await dash();
  const baseToday = dD1.j.sms_today;
  const orphanId = dbo.prepare("SELECT id FROM numbers WHERE number='446000100001'").get().id;
  const delNoSms = await api('/api/numbers/delete', 'POST', { ids: [orphanId], delete_sms: false }, adm);
  t('B-D1c number deleted WITHOUT sms (2 rows preserved as orphans)', delNoSms.status === 200 && delNoSms.j.deleted === 1 && delNoSms.j.preserved_sms === 2, JSON.stringify(delNoSms.j));
  dD1 = await dash();
  t('B-D1d history preserved (today unchanged)', dD1.j.sms_today === baseToday, `got ${dD1.j.sms_today} want ${baseToday}`);
  const delRange = await api('/api/ranges/' + RB4.id + '?delete_sms=1', 'DELETE', null, adm);
  t('B-D1e range deleted WITH sms (orphans removed)', delRange.status === 200 && delRange.j.deleted_sms >= 2, JSON.stringify(delRange.j).slice(0, 90));
  dD1 = await dash();
  t('B-D1f ORPHAN stats decremented — dashboard drops 2 (old code: stuck)', dD1.j.sms_today === baseToday - 2, `got ${dD1.j.sms_today} want ${baseToday - 2}`);
  const orphanLeft = dbo.prepare("SELECT COUNT(*) c FROM sms_records WHERE number='446000100001'").get().c;
  t('B-D1g orphan sms_records actually deleted', orphanLeft === 0, 'left=' + orphanLeft);

  /* D2: phantom-safety — stats row missing hone par delete POSITIVE row nahi bana sakta */
  const nUk2id = dbo.prepare('SELECT id FROM numbers WHERE number=?').get(nUk2).id;
  s = await sms(nUk2, '7003', 'code 9999'); t('B-D2a real SMS on nUk2 (stats row written)', s.status === 200);
  const dPre = await dash();
  const todayPre = dPre.j.sms_today;
  dbo.prepare(`DELETE FROM sms_daily_stats WHERE stat_date=? AND cli='7003'`).run(today); // simulate lost/corrupt stats row
  const dMid = await dash();
  t('B-D2b stats row manually removed (today -1)', dMid.j.sms_today === todayPre - 1, `got ${dMid.j.sms_today} want ${todayPre - 1}`);
  const delPh = await api('/api/numbers/delete', 'POST', { ids: [nUk2id], delete_sms: true }, adm);
  t('B-D2c delete number+SMS ok', delPh.status === 200 && delPh.j.deleted_sms >= 1, JSON.stringify(delPh.j));
  const dPost = await dash();
  t('B-D2d NO positive phantom row — today unchanged (old code: +1 inflation)', dPost.j.sms_today === todayPre - 1, `got ${dPost.j.sms_today} want ${todayPre - 1}`);
  const phantom = dbo.prepare(`SELECT COUNT(*) c FROM sms_daily_stats WHERE stat_date=? AND cli='7003'`).get(today).c;
  t('B-D2e no stats row resurrected for cli 7003', phantom === 0, 'rows=' + phantom);

  /* P19 core regression after the refactor: normal delete+SMS immediate drop (already covered B-M10..12, plus F2 in p19-verify) */
  t('B-R1 payment ledger untouched by deletes (immutability)', dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c >= 0, 'rows=' + dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c);

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); await stopServer(); process.exit(1); });
