#!/usr/bin/env node
/* P19d REPRODUCTION — owner ke dono complaints ko CURRENT code par reproduce karna.
 * REPRO-A: agent allocation me payout EMPTY chhoda -> numbers.payout purana/stale rehta hai
 *          (force re-allication par naya client purane client ka payout dekhta hai).
 * REPRO-C: Rebuild Stats (backfill) stat_date ko CURRENT UK offset se banata hai (DST galat)
 *          -> winter rows galat date par; delete ke decrement ka key mismatch -> dashboard
 *          stale rehta hai (owner ka exact symptom).
 * REPRO-P: phantom stats rows (pre-P19 deletes ka residue) dashboard me count hote hain —
 *          sirf Rebuild Stats unhe hatata hai.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = '8097';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = '/tmp/p19d.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(p_, method = 'GET', body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + p_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }

let srv;
function startServer() {
  return new Promise((resolve, reject) => {
    srv = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19d', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
    (async () => {
      for (let i = 0; i < 120; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return resolve(); } catch (e) {} }
      reject(new Error('no start'));
    })();
  });
}
(async () => {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();
  const adm = (await api('/api/login', 'POST', { username: 'vibepk', password: 'vibepk123' })).j.token;
  await api('/api/users', 'POST', { username: 'd agent', password: 'Test123!', role: 'agent', active: true }, adm); // avoid dup names
  // (agar space wale username reject hue to simple name)
  let aTok = (await api('/api/login', 'POST', { username: 'd agent', password: 'Test123!' })).j.token;
  if (!aTok) { await api('/api/users', 'POST', { username: 'dagent', password: 'Test123!', role: 'agent', active: true }, adm); aTok = (await api('/api/login', 'POST', { username: 'dagent', password: 'Test123!' })).j.token; }
  await api('/api/users', 'POST', { username: 'dcl1', password: 'Test123!', role: 'client', active: true }, aTok);
  await api('/api/users', 'POST', { username: 'dcl2', password: 'Test123!', role: 'client', active: true }, aTok);
  const c1 = (await api('/api/login', 'POST', { username: 'dcl1', password: 'Test123!' })).j.token;
  const c2 = (await api('/api/login', 'POST', { username: 'dcl2', password: 'Test123!' })).j.token;
  const A = dbo.prepare("SELECT id FROM users WHERE role='agent' AND username LIKE 'd%'").get().id;
  const C1 = dbo.prepare("SELECT id FROM users WHERE username='dcl1'").get().id;
  const C2 = dbo.prepare("SELECT id FROM users WHERE username='dcl2'").get().id;
  await api('/api/ranges', 'POST', { name: 'D1', prefix: '447', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'P', country: 'UK', status: 'Active' }, adm);
  const RC = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'D1');
  const insNum = dbo.prepare("INSERT INTO numbers (number, range_id, prefix, payterm, payout, agent_id, created_at) VALUES (?,?,?,?,?,?,datetime('now'))");
  const N1 = '447300000001', NW = '447300000002';
  insNum.run(N1, RC.id, '447', 'weekly_7_1', '0', A);   // agent pool me (fresh, payout '0')
  insNum.run(NW, RC.id, '447', 'weekly_7_1', '0', A);
  const idOf = n => dbo.prepare('SELECT id FROM numbers WHERE number=?').get(n).id;

  /* ================= REPRO A ================= */
  console.log('\n===== REPRO A: empty payout on agent->client allocation =====');
  let r = await api('/api/numbers/allocate', 'POST', { ids: [idOf(N1)], target_id: C1, payout: '2' }, aTok);
  console.log('1) alloc N1->C1 payout "2":', r.status, JSON.stringify(r.j));
  console.log('   C1 sees payout:', JSON.stringify((await api('/api/numbers?limit=10', 'GET', null, c1)).j.rows.find(x => x.number === N1)?.payout), '(expect "2")');
  // force re-allocate to C2 WITHOUT payout field (agent ne payout set NAHI kiya)
  r = await api('/api/numbers/allocate', 'POST', { ids: [idOf(N1)], target_id: C2, force: true }, aTok);
  console.log('2) force re-alloc N1->C2, payout EMPTY:', r.status, JSON.stringify(r.j));
  const c2pay = (await api('/api/numbers?limit=10', 'GET', null, c2)).j.rows.find(x => x.number === N1)?.payout;
  console.log('3) C2 sees payout:', JSON.stringify(c2pay));
  console.log(c2pay === '2'
    ? '   >>> BUG REPRODUCED: naya client purane client ka payout "2" dekh raha hai (chahiye "0") <<<'
    : '   (no repro — value: ' + JSON.stringify(c2pay) + ')');
  const dbA = dbo.prepare('SELECT payout FROM numbers WHERE number=?').get(N1).payout;
  console.log('4) DB numbers.payout after empty alloc:', JSON.stringify(dbA), dbA === '2' ? '<<< STALE — empty ko "0" hona chahiye' : '');

  /* ================= REPRO C ================= */
  console.log('\n===== REPRO C: Rebuild Stats DST mis-keying =====');
  // winter SMS: 2026-01-15 23:30:00 UTC — UK January = GMT => correct UK date 2026-01-15
  dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,agent_id,is_test,source,payout_rate,payout_amount,received_at)
    VALUES (?,?,?,?,?,?,?,?,0,'carrier','0.010','0.010','2026-01-15 23:30:00')`).run(idOf(NW), NW, RC.id, '9301', 'shortcode', 'winter', '111111', A);
  const ukDate = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):/.exec(ts); const d = new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], 0, 0)); return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('/').reverse().join('-'); };
  console.log('1) winter SMS 2026-01-15 23:30 UTC -> correct UK stat_date =', ukDate('2026-01-15 23:30:00'));
  r = await api('/api/admin/backfill-stats', 'POST', { reset: true }, adm);
  console.log('2) Rebuild Stats:', r.status, JSON.stringify(r.j));
  const wrow = dbo.prepare("SELECT stat_date, sms_count FROM sms_daily_stats WHERE cli='9301'").get();
  console.log('3) stats row after rebuild:', JSON.stringify(wrow));
  console.log(wrow && wrow.stat_date === '2026-01-16'
    ? '   >>> BUG REPRODUCED: rebuild ne winter row ko 2026-01-16 par rakha (correct: 2026-01-15) <<<'
    : '   (stat_date=' + (wrow && wrow.stat_date) + ')');
  // ab number delete karo (SMS ke saath) — decrement 2026-01-15 key par jayega
  const before = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  r = await api('/api/numbers/delete', 'POST', { ids: [idOf(NW)], delete_sms: true }, adm);
  console.log('4) delete NW + SMS:', r.status, JSON.stringify(r.j));
  const after = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  const leftover = dbo.prepare("SELECT stat_date, sms_count FROM sms_daily_stats WHERE cli='9301'").all();
  console.log('5) dashboard year: ' + before.sms_year + ' -> ' + after.sms_year + ' | leftover stats rows for deleted SMS:', JSON.stringify(leftover));
  console.log(leftover.length
    ? '   >>> BUG REPRODUCED: deleted SMS ka stats row bacha hua hai — dashboard ab bhi use count karta hai <<<'
    : '   (clean)');

  /* ================= REPRO P (repair path proof) ================= */
  console.log('\n===== REPRO P: phantom rows — Rebuild Stats hi repair karta hai =====');
  dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES ('2026-02-10',-1,-1,-1,'PHANTOM',50000,'183.00')`);
  const p1 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  console.log('1) phantom insert (50000 SMS, $183) -> dashboard year:', p1.sms_year, 'payout_month:', p1.payout_month);
  r = await api('/api/admin/backfill-stats', 'POST', { reset: true }, adm);
  const p2 = (await api('/api/dashboard?_nocache=1', 'GET', null, adm)).j;
  console.log('2) Rebuild Stats:', r.status, JSON.stringify(r.j), '-> dashboard year:', p2.sms_year, 'payout_month:', p2.payout_month);
  console.log('3) phantom gone:', dbo.prepare("SELECT COUNT(*) c FROM sms_daily_stats WHERE cli='PHANTOM'").get().c === 0 ? 'YES' : 'NO');
  console.log('\n(repro done — server rakhna hai final suite ke liye? nahi — yeh sirf repro tha)');
  try { srv.kill('SIGINT'); } catch (e) {}
  setTimeout(() => { try { srv.kill('SIGKILL'); } catch (e) {} process.exit(0); }, 1500);
})().catch(e => { console.error('REPRO ERROR:', e); try { srv.kill('SIGKILL'); } catch (_) {} process.exit(1); });
