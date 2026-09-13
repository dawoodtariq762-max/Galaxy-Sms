/* P12 REGRESSION SUITE — AI Assistant + Per-Allocation Payment Cycles */
/* P12 REGRESSION SUITE — chalane ka tareeqa:
   1) fresh DB copy banayen, users ke passwords set karein
   2) DB_FILE=<copy> PORT=8091 node backend/server.js
   3) P12_DB=<copy> node tests/p12-regression.js
   (carrier integration test DB me direct enable hoti hai — lock feature API se nahi) */
const BASE = process.env.P12_BASE || 'http://127.0.0.1:8091';
const Database = require('better-sqlite3');
const dbo = new Database(process.env.P12_DB || '/tmp/p12test.db');
let PASS = 0, FAIL = 0; const results = [];
function t(name, ok, detail = '') { if (ok) { PASS++; results.push('PASS | ' + name + (detail ? ' | ' + detail : '')); } else { FAIL++; results.push('FAIL | ' + name + (detail ? ' | ' + detail : '')); } }

async function api(path, method = 'GET', body = null, token = null, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); return r.j.token || null; }
async function sms(number, id) {
  const b = new URLSearchParams({ number, cli: 'P12TEST', message: 'Your code is 5521', sms_id: id });
  const r = await fetch(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

(async () => {
  const adm = await login('vibepk', 'Test123!');
  const mgr = await login('demo_mgr', 'Test123!');
  const agt = await login('demo_agt', 'Test123!');
  const cli = await login('demo_cli', 'Test123!');
  t('setup: all 4 logins', !!(adm && mgr && agt && cli));
  dbo.prepare("UPDATE users SET payment_type='weekly' WHERE username='demo_agt'").run();

  /* ================= AI PERMISSIONS (P13: agent-only assistant) ================= */
  const st = await api('/api/assistant/status', 'GET', null, adm);
  t('AI status admin: can_use=false (widget sirf agent)', st.status === 200 && st.j.can_use === false && st.j.enabled === true, JSON.stringify(st.j));
  const stA = await api('/api/assistant/status', 'GET', null, agt);
  t('AI status agent: can_use=true', stA.status === 200 && stA.j.can_use === true, JSON.stringify(stA.j));
  t('AI status client: can_use=false', (await api('/api/assistant/status', 'GET', null, cli)).j.can_use === false);
  t('AI message manager: 403 (agent-only)', (await api('/api/assistant/message', 'POST', { text: 'hi' }, mgr)).status === 403);
  t('AI message admin: 403 (agent-only)', (await api('/api/assistant/message', 'POST', { text: 'hi' }, adm)).status === 403);
  t('AI message client: 403', (await api('/api/assistant/message', 'POST', { text: 'hi' }, cli)).status === 403);
  t('AI message unauthenticated: denied', (await api('/api/assistant/message', 'POST', { text: 'hi' })).status >= 400);

  /* ================= TIER-1: greeting/rates/availability/knowledge ================= */
  const hello = await api('/api/assistant/message', 'POST', { text: 'hi' }, agt);
  t('#1 greeting: username recognized', hello.status === 200 && /demo_agt|demo agent/i.test(hello.j.reply || ''), (hello.j.reply || '').slice(0, 70));
  const rates = await api('/api/assistant/message', 'POST', { text: 'rate' }, agt);
  t('#4 rates: "rate" -> configured rates', rates.status === 200 && /Daily/i.test(rates.j.reply || '') && /Weekly/i.test(rates.j.reply || ''), (rates.j.reply || '').slice(0, 60));
  const avail = await api('/api/assistant/message', 'POST', { text: 'kitne numbers available hain?' }, agt);
  t('#5 availability: pool answer', avail.status === 200 && /available/i.test(avail.j.reply || '') && (/Total|\d|se contact karein/.test(avail.j.reply || '')), (avail.j.reply || '').slice(0, 60));
  const kb1 = await api('/api/assistant/message', 'POST', { text: 'What is Galaxy SMS?' }, agt);
  t('Tier1: knowledge answer', kb1.status === 200 && kb1.j.source === 'knowledge', (kb1.j.reply || '').slice(0, 50));
  const kbList = await api('/api/assistant/knowledge', 'GET', null, adm);
  t('knowledge GET (admin)', kbList.status === 200, 'rows ' + (kbList.j.rows || []).length);
  t('payment knowledge DISABLED by default', kbList.j.settings && kbList.j.settings.payment_enabled === '0', JSON.stringify(kbList.j.settings));
  t('knowledge GET agent DENIED', (await api('/api/assistant/knowledge', 'GET', null, agt)).status === 403);
  const payQ = await api('/api/assistant/message', 'POST', { text: 'payment kab milte hain?' }, agt);
  t('payment schedule -> guard, no invented dates', payQ.status === 200 && /confirm nahi|team/i.test(payQ.j.reply || ''), (payQ.j.reply || '').slice(0, 60));
  const kbAdd = await api('/api/assistant/knowledge', 'POST', { category: 'general', question: 'Refund kaise milega?', answer: 'Refund ke liye team se rabta karein.' }, adm);
  t('knowledge ADD admin OK', kbAdd.status === 200 && kbAdd.j.id > 0, 'id ' + kbAdd.j.id);
  t('knowledge ADD agent DENIED', (await api('/api/assistant/knowledge', 'POST', { question: 'x', answer: 'y' }, agt)).status === 403);
  const kbQ = await api('/api/assistant/message', 'POST', { text: 'Refund kaise milega bhai?' }, agt);
  t('new knowledge served to agent (paraphrase)', kbQ.status === 200 && /team se rabta/i.test(kbQ.j.reply || ''), (kbQ.j.reply || '').slice(0, 50));
  await api('/api/assistant/knowledge/' + kbAdd.j.id, 'PUT', { enabled: false }, adm);
  const kbQ2 = await api('/api/assistant/message', 'POST', { text: 'Refund kaise milega?' }, agt);
  t('disabled knowledge NOT served', kbQ2.j.source !== 'knowledge', 'src ' + kbQ2.j.source);
  await api('/api/assistant/knowledge/' + kbAdd.j.id, 'DELETE', null, adm);
  const exp = await fetch(BASE + '/api/assistant/knowledge/export.txt', { headers: { Authorization: 'Bearer ' + adm } });
  const expTxt = await exp.text();
  t('export.txt admin-downloadable', exp.status === 200 && /GALAXY SMS/.test(expTxt) && (exp.headers.get('content-disposition') || '').includes('.txt'), expTxt.split('\n')[0]);

  /* ================= PAYMENT: setup ================= */
  /* carrier lock-password feature API PUT ko lock rakhta hai — test harness direct DB enable karta hai (ingest getCarrierSettings() DB se parhta hai) */
  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1' WHERE id=1").run();
  const nums = Array.from({ length: 9 }, (_, i) => '92123450' + String(i + 1).padStart(2, '0'));
  await api('/api/ranges', 'POST', { name: 'P12T', prefix: '92123', currency: 'USD', rate_1_1: '0.11', rate_7_1: '0.22', rate_7_7: '0.33', rate_30_45: '0.55', payment_type: 'weekly', status: 'Active' }, adm);
  const imp = await api('/api/numbers/import', 'POST', { range_name: 'P12T', prefix: '92123', numbers: nums, payterm: 'weekly_7_1', payout: '0' }, adm);
  await new Promise(r => setTimeout(r, 700));
  const rP12 = dbo.prepare("SELECT id FROM ranges WHERE name='P12T'").get();
  t('setup: P12T range + import', !!rP12 && imp.status === 200, 'range ' + (rP12 && rP12.id));
  const U = (pt, num) => dbo.prepare('UPDATE numbers SET payterm=? WHERE number=?').run(pt, num);
  U('daily', nums[0]); U('daily', nums[1]); U('monthly_30x45', nums[2]); U('monthly_30x45', nums[3]);
  U('', nums[4]); U('', nums[5]); U('weekly_7_7', nums[6]); U('weekly_7_1', nums[7]); U('daily', nums[8]);
  t('setup: 9 numbers imported', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE range_id=?').get(rP12.id).c === 9);
  const ag = dbo.prepare("SELECT id FROM users WHERE username='demo_agt'").get();
  const mg = dbo.prepare("SELECT id FROM users WHERE username='demo_mgr'").get();
  const all = dbo.prepare("SELECT id FROM numbers WHERE range_id=? ORDER BY id").all(rP12.id).map(r => r.id);
  const ik = () => ({ 'Idempotency-Key': 'p12-' + Math.random().toString(36).slice(2) });
  const fk = () => ({ 'Idempotency-Key': 'p12f-' + Math.random().toString(36).slice(2) });
  /* admin -> manager: sirf manager-pool (nums[2..7]); nums[0,1] unallocated rehte hain (T5 ke liye) */
  const a1 = await api('/api/numbers/allocate', 'POST', { ids: all.slice(2, 8), target_id: mg.id }, adm, ik());
  t('setup: admin->manager allocate', a1.status === 200 && a1.j.allocated === 6, JSON.stringify(a1.j).slice(0, 60));

  /* TEST 5: ADMIN direct allocation (Daily) on unallocated numbers */
  const t5 = await api('/api/numbers/allocate', 'POST', { ids: all.slice(0, 2), target_id: ag.id, payterm: 'daily' }, adm, ik());
  t('T5: admin allocate Daily OK', t5.status === 200 && t5.j.allocated === 2, JSON.stringify(t5.j).slice(0, 60));
  t('T5: numbers.payterm=daily', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE id IN (?,?) AND payterm='daily'").get(all[0], all[1]).c === 2);
  t('T5: allocated to demo_agt', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE id IN (?,?) AND agent_id=?").get(all[0], all[1], ag.id).c === 2);
  t('T5: agent users.payment_type UNTOUCHED (weekly)', dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag.id).payment_type === 'weekly');

  /* TEST 6: manager->agent (manager-owned numbers => force:true, audited) with Monthly */
  const t6 = await api('/api/numbers/allocate', 'POST', { ids: all.slice(2, 4), target_id: ag.id, payterm: 'monthly_30x45', force: true }, mgr, fk());
  t('T6: manager allocate Monthly OK', t6.status === 200);
  t('T6: numbers.payterm=monthly_30x45', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE id IN (?,?) AND payterm='monthly_30x45'").get(all[2], all[3]).c === 2);
  t('T6: Daily allocation (T5) UNCHANGED', dbo.prepare("SELECT payterm FROM numbers WHERE id=?").get(all[0]).payterm === 'daily');

  /* fallback numbers (payterm='') manager->agent WITHOUT payterm */
  await api('/api/numbers/allocate', 'POST', { ids: all.slice(4, 6), target_id: ag.id, force: true }, mgr, fk());
  t('fallback setup: payterm still empty', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE id IN (?,?) AND (payterm='' OR payterm IS NULL)").get(all[4], all[5]).c === 2);

  /* agent default = monthly (agent settings simulate) — poore body ke sath (panel jaisa) */
  const tU = await api('/api/users/' + ag.id, 'PUT', { name: 'Demo Agent', email: '', whatsapp: '', contact: '', skype: '', active: 1, payment_type: 'monthly_30x45' }, adm);
  await new Promise(r => setTimeout(r, 300)); /* server write-txn res-finish par commit hota hai */
  t('agent default set monthly via users API', tU.status === 200 && dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag.id).payment_type === 'monthly_30x45', 'HTTP ' + tU.status + ' db=' + JSON.stringify(dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag.id)));

  /* deterministic smart-divide: nums[7] pehle agent ko (weekly_7_1), sirf nums[6] candidate rahe ga */
  await api('/api/numbers/allocate', 'POST', { ids: [all[7]], target_id: ag.id, payterm: 'weekly_7_1', force: true }, mgr, fk());

  /* TEST 7: smart-divide (manager, weekly_7_7) */
  const t7 = await api('/api/numbers/smart-divide', 'POST', { range_ids: [rP12.id], target_ids: [ag.id], qty: 1, payterm: 'weekly_7_7' }, mgr, ik());
  await new Promise(r => setTimeout(r, 600)); /* smart-divide background job finish hone do */
  t('T7: smart-divide OK', t7.status === 200, JSON.stringify(t7.j).slice(0, 60));
  t('T7: allocated number has weekly_7_7', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=? AND payterm='weekly_7_7'").get(rP12.id, ag.id).c === 1);
  t('T7: agent default STILL monthly', dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag.id).payment_type === 'monthly_30x45');

  /* ================= LEDGER VIA REAL INGEST ================= */
  const before = dbo.prepare('SELECT id,sms_record_id,agent_id,payment_type,amount,cycle_key,eligible_at,status FROM payment_ledger ORDER BY id').all();
  const s1 = await sms(nums[0], 'p12-s1');  /* daily number, agent default monthly */
  await new Promise(r => setTimeout(r, 400));
  const L = (n) => dbo.prepare('SELECT l.payment_type,l.amount FROM payment_ledger l JOIN sms_records s ON s.id=l.sms_record_id WHERE s.number=?').get(n);
  t('T1: ingest OK', s1.status === 200, JSON.stringify(s1.j).slice(0, 60));
  t('T1/T3: daily number -> ledger DAILY (agent default monthly ignored)', L(nums[0]) && L(nums[0]).payment_type === 'daily', JSON.stringify(L(nums[0])));
  t('T1: amount from daily rate card (0.11)', L(nums[0]) && L(nums[0]).amount === '0.11', L(nums[0]) && L(nums[0]).amount);
  await sms(nums[2], 'p12-s2'); await new Promise(r => setTimeout(r, 300));
  t('T2: monthly allocation -> ledger monthly_30x45', L(nums[2]) && L(nums[2]).payment_type === 'monthly_30x45', JSON.stringify(L(nums[2])));
  /* TEST 2: NEW allocation after ledger rows must not change them */
  await api('/api/numbers/allocate', 'POST', { ids: [all[8]], target_id: ag.id, payterm: 'weekly_7_1', force: true }, mgr, fk());
  t('T2: ingest s1 body', s1.j && (s1.j.ok !== false), JSON.stringify(s1.j).slice(0, 80));
  t('T2: old ledger row untouched after new allocation', L(nums[0]).payment_type === 'daily' && dbo.prepare('SELECT payterm FROM numbers WHERE id=?').get(all[0]).payterm === 'daily');
  await sms(nums[4], 'p12-s3'); await new Promise(r => setTimeout(r, 300));
  t('T4: empty payterm -> agent default (monthly_30x45)', L(nums[4]) && L(nums[4]).payment_type === 'monthly_30x45', JSON.stringify(L(nums[4])));
  await sms(nums[6], 'p12-s4'); await new Promise(r => setTimeout(r, 300));
  t('T7-ledger: 7/7 payterm -> weekly bucket with 7/7 rate (0.33)', L(nums[6]) && L(nums[6]).payment_type === 'weekly' && L(nums[6]).amount === '0.33', JSON.stringify(L(nums[6])));
  /* priority-3: agent default EMPTY -> range fallback */
  dbo.prepare("UPDATE users SET payment_type='' WHERE id=?").run(ag.id);
  await sms(nums[5], 'p12-s5'); await new Promise(r => setTimeout(r, 300));
  t('priority-3: empty payterm + empty agent default -> range payment_type (weekly)', L(nums[5]) && /weekly/.test(L(nums[5]).payment_type), JSON.stringify(L(nums[5])));
  dbo.prepare("UPDATE users SET payment_type='monthly_30x45' WHERE id=?").run(ag.id);

  /* TEST 8: historical ledger untouched */
  const after = dbo.prepare('SELECT id,sms_record_id,agent_id,payment_type,amount,cycle_key,eligible_at,status FROM payment_ledger ORDER BY id').all();
  const oldSame = before.every((b, i) => { const a = after[i]; return a && a.id === b.id && a.payment_type === b.payment_type && a.amount === b.amount && a.cycle_key === b.cycle_key && a.eligible_at === b.eligible_at && a.status === b.status; });
  t('T8: ALL pre-existing ledger rows byte-identical', oldSame && after.length >= before.length, 'before ' + before.length + ' after ' + after.length);

  /* sms_records snapshot types */
  const snap = dbo.prepare("SELECT number,payment_type FROM sms_records WHERE cli='P12TEST' ORDER BY id").all();
  t('sms_records.payment_type snapshots correct', snap.length === 5 && snap[0].payment_type === 'daily' && snap[1].payment_type === 'monthly_30x45' && snap[3].payment_type === 'weekly', JSON.stringify(snap));

  /* panel smoke */
  const dash = await api('/api/stats-summary/manager', 'GET', null, adm);
  const numsPg = await api('/api/numbers?paged=1&page=1&limit=25', 'GET', null, adm);
  t('panel smoke: stats + numbers page 200', dash.status === 200 && numsPg.status === 200 && Array.isArray(numsPg.j.rows));

  /* ================= AI GUIDED ALLOCATION (P13: agent self, manager/admin pool) ================= */
  await api('/api/ranges', 'POST', { name: 'P12C', prefix: '92155', currency: 'USD', rate_1_1: '0.11', rate_7_1: '0.22', rate_7_7: '0.33', rate_30_45: '0.55', payment_type: 'weekly', status: 'Active' }, adm);
  const cNums = Array.from({ length: 6 }, (_, i) => '92155500' + String(i + 1).padStart(2, '0'));
  await api('/api/numbers/import', 'POST', { range_name: 'P12C', prefix: '92155', numbers: cNums, payterm: 'weekly_7_1', payout: '0' }, adm);
  await new Promise(r => setTimeout(r, 700));
  const rC = dbo.prepare("SELECT id FROM ranges WHERE name='P12C'").get();
  const cAll = dbo.prepare('SELECT id FROM numbers WHERE range_id=? ORDER BY id').all(rC.id).map(r => r.id);
  await api('/api/numbers/allocate', 'POST', { ids: cAll, target_id: mg.id }, adm, ik());
  t('AI-alloc setup: P12C 6 numbers manager pool me', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE range_id=? AND manager_id=? AND agent_id IS NULL').get(rC.id, mg.id).c === 6);

  const A = (text) => api('/api/assistant/message', 'POST', { text }, agt);
  t('#3 flow: intent', /range/i.test((await A('I need numbers')).j.reply || ''));
  t('#3 flow: wrong range rejected', /wrong range/i.test((await A('zzz-nonexistent-xyz')).j.reply || ''));
  t('#3 flow: valid range -> qty', /kitne numbers/i.test((await A('P12C')).j.reply || ''));
  t('#3 flow: 700 -> 500-cap', /maximum I can provide is 500/i.test((await A('700')).j.reply || ''));
  t('#3 flow: over-pool -> manager contact', /manager.*contact|contact.*manager/i.test((await A('500')).j.reply || ''));
  t('#3 flow: qty 2 -> cycle', /daily|weekly|monthly/i.test((await A('2')).j.reply || ''));
  const conf = await A('daily');
  t('#1 flow: confirmation self-target + cycle', /Aap khud \(demo_agt\)/.test(conf.j.reply || '') && /Daily/.test(conf.j.reply || ''), (conf.j.reply || '').slice(0, 90));
  const yes = await A('haan');
  t('#2/#3 AI alloc: executed (existing logic, no fetch-fail)', yes.status === 200 && /✅/.test(yes.j.reply || ''), (yes.j.reply || '').slice(0, 90));
  t('#3 AI alloc: agent_id + manager chain + payterm daily', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=? AND manager_id=? AND payterm='daily'").get(rC.id, ag.id, mg.id).c === 2);
  t('#3 AI alloc: users.payment_type untouched', dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag.id).payment_type === 'monthly_30x45');
  t('#3 AI alloc: audit trail', dbo.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='ai_assistant_allocation'").get().c >= 1);

  await A('I need numbers'); await A('P12C'); await A('1'); await A('weekly');
  t('#3 flow: explicit No cancels', /cancel/i.test((await A('nahi')).j.reply || ''));

  /* #4: admin-child agent (kisi manager ke niche nahi) */
  await api('/api/users', 'POST', { username: 'p13agt2', password: 'Test123!', role: 'agent', name: 'P13 Agent Two' }, adm);
  const ag2row = dbo.prepare("SELECT id,parent_id FROM users WHERE username='p13agt2'").get();
  t('#4 admin-child agent created', !!ag2row, 'parent ' + (ag2row && ag2row.parent_id));
  const ag2ptBefore = dbo.prepare('SELECT payment_type FROM users WHERE id=?').get(ag2row.id).payment_type;
  const ag2 = await login('p13agt2', 'Test123!');
  const B = (text) => api('/api/assistant/message', 'POST', { text }, ag2);
  await api('/api/ranges', 'POST', { name: 'P12B', prefix: '92166', currency: 'USD', rate_1_1: '0.10', rate_7_1: '0.20', rate_7_7: '0.30', rate_30_45: '0.50', payment_type: 'weekly', status: 'Active' }, adm);
  await api('/api/numbers/import', 'POST', { range_name: 'P12B', prefix: '92166', numbers: ['921666001', '921666002', '921666003'], payterm: 'weekly_7_1', payout: '0' }, adm);
  await new Promise(r => setTimeout(r, 700));
  const rB = dbo.prepare("SELECT id FROM ranges WHERE name='P12B'").get();
  t('#4 setup: P12B fully unallocated (admin pool)', dbo.prepare('SELECT COUNT(*) c FROM numbers WHERE range_id=? AND manager_id IS NULL AND agent_id IS NULL').get(rB.id).c === 3);
  await B('I need numbers'); await B('P12B'); await B('1'); await B('monthly');
  const by2 = await B('yes');
  t('#4 admin-child agent: admin pool se allocate', by2.status === 200 && /✅/.test(by2.j.reply || ''), (by2.j.reply || '').slice(0, 90));
  t('#4 admin-child: manager_id NULL + payterm monthly', dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=? AND manager_id IS NULL AND payterm='monthly_30x45'").get(rB.id, ag2row.id).c === 1);
  t('#4 admin-child: users.payment_type untouched', dbo.prepare("SELECT payment_type FROM users WHERE id=?").get(ag2row.id).payment_type === ag2ptBefore, 'before ' + ag2ptBefore);

  /* #2 binding/limits: per-user 429 */
  let capped = false;
  for (let i = 0; i < 45 && !capped; i++) if ((await B('rate ' + i)).status === 429) capped = true;
  t('assistant per-user limit -> 429', capped);

  console.log(results.join('\n'));
  console.log('\n==== PASS ' + PASS + ' / FAIL ' + FAIL + ' ====');
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('SUITE CRASH:', e.message); console.log(results.join('\n')); console.log('==== partial PASS ' + PASS + ' / FAIL ' + FAIL + ' ===='); process.exit(2); });
