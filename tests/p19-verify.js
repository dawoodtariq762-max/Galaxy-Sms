/* ============================================================================
 * P19 VERIFICATION SUITE — AI limit, delete+stats cleanup, CLI facets, rate override
 * ----------------------------------------------------------------------------
 * Self-contained: spawns its own server on a scratch DB, builds the fixture via
 * the real APIs, runs all tests, restarts the server for persistence checks.
 *
 * Run:  node tests/p19-verify.js          (from repo root)
 * Env:  P19_PORT (default 8091), P19_DB (default /tmp/p19test.db)
 * NOTE: deletes P19_DB first — never point it at production data.
 * ========================================================================== */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.P19_PORT || '8091';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19_DB || '/tmp/p19test.db';
const ROOT = path.resolve(__dirname, '..');

let PASS = 0, FAIL = 0; const results = [];
function t(name, ok, detail = '') {
  if (ok) { PASS++; results.push('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { FAIL++; results.push('FAIL | ' + name + (detail ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path_, method = 'GET', body = null, token = null, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); return r.j.token || null; }
async function sms(number, cli, msg, id) {
  const b = new URLSearchParams({ number, cli, message: msg || ('Your code is ' + Math.floor(1000 + Math.random() * 9000)) });
  if (id) b.set('sms_id', id);
  const r = await fetch(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

/* UK date helpers (mirror server semantics for fixture inserts) */
function ukOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}
function ukDateOfSql(ts) { // 'YYYY-MM-DD HH:MM:SS' (UTC) -> UK date str
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts)); if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(str, n) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function ukToday() { return ukDateOfSql(new Date().toISOString().slice(0, 19).replace('T', ' ')); }

/* ---- server lifecycle ---- */
let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19test',
        ASSISTANT_USER_RPM: '1000', ASSISTANT_USER_RPD: '10000', ASSISTANT_GLOBAL_RPM: '10000',
        BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.env.P19_VERBOSE && process.stdout.write('[srv] ' + d));
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

/* ---- direct DB access (fixture inserts/updates) ---- */
function openDb() {
  const Database = require('better-sqlite3');
  return new Database(DB);
}

(async () => {
  console.log('P19 verification suite — ' + new Date().toISOString());
  console.log('DB: ' + DB + '  BASE: ' + BASE);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

  /* ================= PHASE 1: fresh server + fixture + all tests ================= */
  await startServer();
  let dbo = openDb();

  const adm = await login('vibepk', 'vibepk123');
  t('setup: admin login', !!adm);

  /* ---------- fixture: users ---------- */
  const mk = async (username, password, role, token) => {
    const r = await api('/api/users', 'POST', { username, password, role, active: true }, token);
    return r;
  };
  const rM1 = await mk('p19m1', 'Test123!', 'manager', adm);
  t('setup: manager created', rM1.status === 200, JSON.stringify(rM1.j).slice(0, 80));
  const m1Tok = await login('p19m1', 'Test123!');
  const rA1 = await mk('p19a1', 'Test123!', 'agent', m1Tok);          // A1 under M1
  const rA2 = await mk('p19a2', 'Test123!', 'agent', adm);            // A2 direct under admin
  t('setup: agents created (M1-child + admin-direct)', rA1.status === 200 && rA2.status === 200);
  const a1Tok = await login('p19a1', 'Test123!');
  const a2Tok = await login('p19a2', 'Test123!');
  // P12 baseline: A1 ka users.payment_type allocation se PEHLE ka value (jo bhi default ho)
  const a1PayBefore = dbo.prepare('SELECT payment_type FROM users WHERE username=?').get('p19a1').payment_type;
  const rC1 = await mk('p19c1', 'Test123!', 'client', a1Tok);
  t('setup: client created', rC1.status === 200);
  const c1Tok = await login('p19c1', 'Test123!');

  /* ---------- fixture: ranges ---------- */
  const rR1 = await api('/api/ranges', 'POST', { name: 'P19R1', prefix: '447', currency: 'USD', rate_1_1: '0.010', rate_7_1: '0.010', rate_7_7: '0.010', rate_30_45: '0.010', payment_type: 'weekly', provider: 'ProvA', country: 'UK', status: 'Active' }, adm);
  const rR2 = await api('/api/ranges', 'POST', { name: 'P19R2', prefix: '448', currency: 'USD', rate_1_1: '0.020', rate_7_1: '0.020', rate_7_7: '0.020', rate_30_45: '0.020', payment_type: 'weekly', provider: 'ProvB', country: 'UK', status: 'Active' }, adm);
  const rR3 = await api('/api/ranges', 'POST', { name: 'P19R3', prefix: '449', currency: 'USD', rate_1_1: '0.030', rate_7_1: '0.030', rate_7_7: '0.030', rate_30_45: '0.030', payment_type: 'weekly', provider: 'ProvA', country: 'UK', status: 'Active' }, adm);
  t('setup: ranges created', rR1.status === 200 && rR2.status === 200 && rR3.status === 200, JSON.stringify(rR1.j).slice(0, 80));
  const ranges = await api('/api/ranges', 'GET', null, adm);
  const R1 = (Array.isArray(ranges.j) ? ranges.j : ranges.j.ranges || []).find(r => r.name === 'P19R1');
  const R2 = (Array.isArray(ranges.j) ? ranges.j : ranges.j.ranges || []).find(r => r.name === 'P19R2');
  const R3 = (Array.isArray(ranges.j) ? ranges.j : ranges.j.ranges || []).find(r => r.name === 'P19R3');

  /* ---------- fixture: numbers ---------- */
  const numsR1 = Array.from({ length: 12 }, (_, i) => '4470000000' + String(i).padStart(2, '0'));
  const numsR2 = Array.from({ length: 10 }, (_, i) => '4480000000' + String(i).padStart(2, '0'));
  const numsR3 = Array.from({ length: 3 }, (_, i) => '4490000000' + String(i).padStart(2, '0'));
  const imp1 = await api('/api/numbers/import', 'POST', { range_id: R1.id, numbers: numsR1 }, adm);
  const imp2 = await api('/api/numbers/import', 'POST', { range_id: R2.id, numbers: numsR2 }, adm);
  const imp3 = await api('/api/numbers/import', 'POST', { range_id: R3.id, numbers: numsR3 }, adm);
  t('setup: number imports accepted', imp1.status === 200 && imp2.status === 200 && imp3.status === 200);
  for (let i = 0; i < 40; i++) { // poll background import jobs
    await sleep(250);
    const j1 = await api('/api/numbers/import-jobs/' + imp1.j.job.job_id, 'GET', null, adm);
    const j2 = await api('/api/numbers/import-jobs/' + imp2.j.job.job_id, 'GET', null, adm);
    const j3 = await api('/api/numbers/import-jobs/' + imp3.j.job.job_id, 'GET', null, adm);
    if (j1.j.status === 'done' && j2.j.status === 'done' && j3.j.status === 'done') { t('setup: imports finished (12+10+3)', j1.j.inserted === 12 && j2.j.inserted === 10 && j3.j.inserted === 3, `R1=${j1.j.inserted} R2=${j2.j.inserted} R3=${j3.j.inserted}`); break; }
    if (i === 39) t('setup: imports finished', false, 'timeout');
  }
  const idOf = async (n) => (dbo.prepare('SELECT id FROM numbers WHERE number=?').get(n) || {}).id;

  /* ---------- fixture: enable carrier (direct DB, p12 style) ---------- */
  dbo.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1'").run();
  await sleep(300);

  /* =========================================================================
   * FIX #1 — AI allocation limit: default 100, configurable, backend enforced
   * ====================================================================== */
  console.log('\n--- FIX #1: AI allocation limit ---');
  let kb = await api('/api/assistant/knowledge', 'GET', null, adm);
  t('F1-1 default alloc_max = 100', kb.j.settings && kb.j.settings.alloc_max === '100', JSON.stringify(kb.j.settings || {}));

  const ai = async (text, tok) => (await api('/api/assistant/message', 'POST', { text }, tok)).j;
  // flow with default limit (agent A1)
  let rep = await ai('i need numbers', a1Tok);
  t('F1-2a intent starts', /range/i.test(rep.reply || ''), (rep.reply || '').slice(0, 60));
  rep = await ai('P19R1', a1Tok);
  t('F1-2b qty step mentions max 100', /max 100/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));
  rep = await ai('150', a1Tok);
  t('F1-3 qty 150 refused (default 100)', /maximum i can provide is 100/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));
  rep = await ai('100', a1Tok);
  t('F1-4 qty 100 passes limit check (availability may still refuse)', !/maximum i can provide/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));

  // admin changes limit
  let put = await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: 50 }, adm);
  t('F1-5 admin sets alloc_max=50', put.status === 200 && put.j.settings.alloc_max === '50', JSON.stringify(put.j.settings || {}));
  rep = await ai('i need numbers', a2Tok); rep = await ai('P19R2', a2Tok); rep = await ai('60', a2Tok);
  t('F1-6 qty 60 refused under limit 50', /maximum i can provide is 50/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));

  // invalid values rejected
  for (const bad of ['abc', 0, -5, 5001, 2.5]) {
    put = await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: bad }, adm);
    t(`F1-7 invalid alloc_max=${JSON.stringify(bad)} rejected`, put.status === 400, 'status ' + put.status);
  }
  // non-admin cannot change
  put = await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: 999 }, m1Tok);
  t('F1-8 manager PUT rejected 403', put.status === 403, 'status ' + put.status);
  put = await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: 999 }, a1Tok);
  t('F1-8b agent PUT rejected 403', put.status === 403, 'status ' + put.status);

  // configurable examples from the requirement
  for (const good of [100, 200, 500, 1000]) {
    put = await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: good }, adm);
    t(`F1-9 alloc_max=${good} accepted`, put.status === 200 && put.j.settings.alloc_max === String(good));
  }

  // execution enforcement: limit 5, ask 3 -> allocated; ask 6 -> refused
  await api('/api/assistant/knowledge-settings', 'PUT', { alloc_max: 5 }, adm);
  rep = await ai('i need numbers', a2Tok); rep = await ai('P19R2', a2Tok); rep = await ai('3', a2Tok); rep = await ai('daily', a2Tok);
  t('F1-10 confirm step reached', /confirm/i.test(rep.reply || ''), (rep.reply || '').slice(0, 90));
  const beforeAi = dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE agent_id=(SELECT id FROM users WHERE username='p19a2')").get().c;
  rep = await ai('yes', a2Tok);
  const afterAi = dbo.prepare("SELECT COUNT(*) c FROM numbers WHERE agent_id=(SELECT id FROM users WHERE username='p19a2')").get().c;
  t('F1-11 AI allocates 3 numbers (limit 5)', /ho gaya/i.test(rep.reply || '') && afterAi === beforeAi + 3, `before=${beforeAi} after=${afterAi} reply=${(rep.reply || '').slice(0, 60)}`);
  rep = await ai('i need numbers', a2Tok); rep = await ai('P19R2', a2Tok); rep = await ai('6', a2Tok);
  t('F1-12 qty 6 refused under limit 5', /maximum i can provide is 5/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));

  // normal admin allocation NOT limited by AI limit
  const bigIds = (await Promise.all(numsR1.slice(0, 8).map(idOf))).filter(Boolean);
  const allocBig = await api('/api/numbers/allocate', 'POST', { ids: bigIds, target_id: R2 ? dbo.prepare("SELECT id FROM users WHERE username='p19a2'").get().id : 0, payterm: 'weekly_7_1' }, adm);
  t('F1-13 normal panel allocation unaffected (8 > AI limit 5)', allocBig.status === 200 && allocBig.j.allocated === 8, JSON.stringify(allocBig.j).slice(0, 80));

  /* =========================================================================
   * FIX #4 — admin allocation rate override (TEST A..H)
   * ====================================================================== */
  console.log('\n--- FIX #4: admin allocation rate override ---');
  const A1ID = dbo.prepare("SELECT id FROM users WHERE username='p19a1'").get().id;
  const A2ID = dbo.prepare("SELECT id FROM users WHERE username='p19a2'").get().id;
  const M1ID = dbo.prepare("SELECT id FROM users WHERE username='p19m1'").get().id;
  const C1ID = dbo.prepare("SELECT id FROM users WHERE username='p19c1'").get().id;
  const rateOf = (n) => (dbo.prepare('SELECT rate FROM numbers WHERE number=?').get(n) || {}).rate;
  const ownersOf = (n) => dbo.prepare('SELECT manager_id, agent_id, client_id, payterm FROM numbers WHERE number=?').get(n) || {};

  // clean slate: unallocate the F1-13 batch first
  await api('/api/numbers/unallocate', 'POST', { ids: bigIds }, adm);
  t('F4-0 unallocate clears rate', rateOf(numsR1[0]) === '', 'rate=' + JSON.stringify(rateOf(numsR1[0])));

  /* TEST A: admin->agent no override -> rate '' (range default applies) */
  const idsA = (await Promise.all([numsR1[0], numsR1[1]].map(idOf)));
  let a = await api('/api/numbers/allocate', 'POST', { ids: idsA, target_id: A1ID, payterm: 'weekly_7_1' }, adm);
  t('F4-A admin->agent default: ok', a.status === 200 && a.j.allocated === 2, JSON.stringify(a.j).slice(0, 60));
  t('F4-A numbers.rate stays empty (Rate Management default)', rateOf(numsR1[0]) === '' && rateOf(numsR1[1]) === '', JSON.stringify([rateOf(numsR1[0]), rateOf(numsR1[1])]));

  /* TEST B: admin->agent override 0.013 */
  const idsB = (await Promise.all([numsR1[2], numsR1[3]].map(idOf)));
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A1ID, payterm: 'weekly_7_1', rate: '0.013' }, adm);
  t('F4-B admin->agent override 0.013: ok', a.status === 200 && a.j.allocated === 2, JSON.stringify(a.j).slice(0, 60));
  t('F4-B numbers.rate = 0.013 on both', rateOf(numsR1[2]) === '0.013' && rateOf(numsR1[3]) === '0.013', JSON.stringify([rateOf(numsR1[2]), rateOf(numsR1[3])]));

  /* TEST C: admin->manager no override */
  const idsC = (await Promise.all([numsR1[4], numsR1[5]].map(idOf)));
  a = await api('/api/numbers/allocate', 'POST', { ids: idsC, target_id: M1ID }, adm);
  t('F4-C admin->manager default: ok, rate empty', a.status === 200 && rateOf(numsR1[4]) === '' && rateOf(numsR1[5]) === '');

  /* TEST D: admin->manager override 0.013 */
  const idsD = (await Promise.all([numsR1[6], numsR1[7]].map(idOf)));
  a = await api('/api/numbers/allocate', 'POST', { ids: idsD, target_id: M1ID, rate: '0.013' }, adm);
  t('F4-D admin->manager override: rate=0.013 kept', a.status === 200 && rateOf(numsR1[6]) === '0.013' && rateOf(numsR1[7]) === '0.013');

  /* TEST E: same agent, two allocations, different rates coexist */
  t('F4-E coexisting rates on same agent (0.010-default + 0.013)',
    ownersOf(numsR1[0]).agent_id === A1ID && rateOf(numsR1[0]) === '' && rateOf(numsR1[2]) === '0.013',
    JSON.stringify({ n0: rateOf(numsR1[0]), n2: rateOf(numsR1[2]) }));

  /* smart-divide with rate (admin->manager) — R3 par: uske numbers fresh/unallocated
     hain, taake smart-divide picker (manager_id IS NULL LIMIT qty — pre-existing
     behaviour jo agent-owned numbers bhi utha sakta hai) kisi existing fixture number
     ko na chheere. */
  const sd = await api('/api/numbers/smart-divide', 'POST', { range_ids: [R3.id], target_ids: [M1ID], qty: 2, payterm: 'weekly_7_1', rate: '0.017', background: false }, adm);
  t('F4-D2 smart-divide admin->manager with rate', sd.status === 200, JSON.stringify(sd.j).slice(0, 60));
  const sdRate = dbo.prepare("SELECT rate FROM numbers WHERE range_id=? AND manager_id=? AND agent_id IS NULL AND rate='0.017'").all(R3.id, M1ID);
  t('F4-D2 smart-divide numbers carry 0.017', sdRate.length === 2, 'count=' + sdRate.length);

  /* manager->agent: rate param IGNORED for manager; existing admin rate PRESERVED */
  const mIdsWithRate = dbo.prepare("SELECT id FROM numbers WHERE manager_id=? AND rate='0.013'").all(M1ID).map(r => r.id);
  const mIdsNoRate = dbo.prepare("SELECT id FROM numbers WHERE manager_id=? AND rate=''").all(M1ID).map(r => r.id);
  a = await api('/api/numbers/allocate', 'POST', { ids: mIdsWithRate.slice(0, 1), target_id: A1ID, payterm: 'weekly_7_1', rate: '0.099' }, m1Tok);
  t('F4-M1 manager allocation ok (rate param sent)', a.status === 200, JSON.stringify(a.j).slice(0, 60));
  const movedRow = dbo.prepare('SELECT rate, agent_id, manager_id FROM numbers WHERE id=?').get(mIdsWithRate[0]);
  t('F4-M1 admin-set 0.013 PRESERVED on manager->agent (rate-lock)', movedRow.rate === '0.013' && movedRow.agent_id === A1ID && movedRow.manager_id === M1ID, JSON.stringify(movedRow));
  a = await api('/api/numbers/allocate', 'POST', { ids: mIdsNoRate.slice(0, 1), target_id: A1ID, payterm: 'weekly_7_1', rate: '0.099' }, m1Tok);
  t('F4-M2 manager rate param silently ignored (no new ability)', a.status === 200 && dbo.prepare('SELECT rate FROM numbers WHERE id=?').get(mIdsNoRate[0]).rate === '');

  /* validation */
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A2ID, rate: '-0.5' }, adm);
  t('F4-V1 negative rate rejected 400', a.status === 400, 'status ' + a.status);
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A2ID, rate: 'abc' }, adm);
  t('F4-V2 malformed rate rejected 400', a.status === 400, 'status ' + a.status);
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A2ID, rate: '0.0000001' }, adm);
  t('F4-V3 7-decimal rate rejected 400', a.status === 400, 'status ' + a.status);
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A2ID, rate: '1000000' }, adm);
  t('F4-V4 too-large rate rejected 400', a.status === 400, 'status ' + a.status);
  a = await api('/api/numbers/allocate', 'POST', { ids: idsB, target_id: A2ID, rate: '0' }, adm);
  t('F4-V5 zero rate rejected 400 (positive required)', a.status === 400, 'status ' + a.status);
  a = await api('/api/numbers/smart-divide', 'POST', { range_ids: [R1.id], target_ids: [M1ID], qty: 1, rate: 'nope', background: false }, adm);
  t('F4-V6 smart-divide bad rate rejected 400', a.status === 400, 'status ' + a.status);

  /* agent->client allocation still works and keeps rate */
  // deterministic pick: A1 ka pehla 0.013-rate number (F4-B ka n2) — agent->client is the flow agent.html uses
  const a1Nums = dbo.prepare("SELECT id FROM numbers WHERE agent_id=? AND rate='0.013' ORDER BY id LIMIT 1").all(A1ID).map(r => r.id);
  a = await api('/api/numbers/allocate', 'POST', { ids: a1Nums, target_id: C1ID, payout: '0.004' }, a1Tok);
  t('F4-AC agent->client allocation ok', a.status === 200, JSON.stringify(a.j).slice(0, 60));
  const cliRow = dbo.prepare('SELECT rate, payout, client_id FROM numbers WHERE id=?').get(a1Nums[0]);
  t('F4-AC agent->client keeps rate, sets payout', (cliRow.rate === '' || cliRow.rate === '0.013') && cliRow.payout === '0.004' && cliRow.client_id === C1ID, JSON.stringify(cliRow));

  /* =========================================================================
   * FIX #2 fixture: SMS on various numbers (+ historical DST + UK-boundary rows)
   * ====================================================================== */
  console.log('\n--- FIX #2: number delete + stats cleanup ---');
  // Rebuild ownership for SMS tests: A1 owns n0(rate ''),n2(0.013); A2 owns R2 numbers; M1 owns n6(0.013)
  // (current state from F4 tests; a1Nums[0] went to client C1 — allocate a fresh one to A1)
  const n0 = numsR1[0], n2 = numsR1[2], n6 = numsR1[6];
  const n5 = numsR1[5]; // manager-owned (rate '')
  // give M1 one number with SMS (for manager scope test): n6 has rate 0.013 manager-owned
  const today = ukToday();
  const yesterday = addDays(today, -1);

  let s = await sms(n0, '111', 'code 1111'); t('F2-setup ingest n0/cli111', s.status === 200, JSON.stringify(s.j).slice(0, 60));
  s = await sms(n0, '111', 'code 1112'); t('F2-setup ingest n0/cli111 #2', s.status === 200);
  s = await sms(n0, '222', 'code 1113'); t('F2-setup ingest n0/cli222', s.status === 200);
  s = await sms(n2, '333', 'code 1114'); t('F2-setup ingest n2(0.013)/cli333', s.status === 200);
  s = await sms(n2, '333', 'code 1115'); t('F2-setup ingest n2/cli333 #2', s.status === 200);
  s = await sms(n6, '555', 'code 1116'); t('F2-setup ingest n6(mgr)/cli555', s.status === 200);
  const a2num = dbo.prepare('SELECT number FROM numbers WHERE agent_id=? AND range_id=? LIMIT 1').get(A2ID, R2.id).number;
  s = await sms(a2num, '444', 'code 1117'); t('F2-setup ingest A2-R2/cli444', s.status === 200);
  s = await sms(a2num, '444', 'code 1118'); t('F2-setup ingest A2-R2/cli444 #2', s.status === 200);

  // historical winter (GMT) SMS on n0 — keyed the way ingest would have keyed it
  /* DST trap: 23:30Z during GMT => UK date = SAME day (2026-01-15). The OLD buggy
     decrement computed date(ts,'+60min') when deleted during BST => 2026-01-16 => key
     mismatch => stale stats. Correct key (ingest-style) = 2026-01-15. */
  const winterTs = '2026-01-15 23:30:00';
  const winterUkDate = ukDateOfSql(winterTs);
  t('F2-setup winter UK date = 2026-01-15 (DST trap row)', winterUkDate === '2026-01-15', winterUkDate);
  const n0id = await idOf(n0);
  const insSms = dbo.prepare(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,is_test,client_id,agent_id,manager_id,source,payout_rate,payout_amount,payment_type,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insSms.run(n0id, n0, R1.id, '999', 'shortcode', 'winter code 778899', '778899', 0, null, A1ID, null, 'carrier', '0.010', '0.010', 'weekly', winterTs);
  // stats row exactly as recordSmsStats(ingest during GMT) would key it: stat_date=2026-01-16
  dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(stat_date,manager_id,agent_id,client_id,cli) DO UPDATE SET sms_count=sms_count+excluded.sms_count, payout_sum=payout_sum+excluded.payout_sum`)
    .run(winterUkDate, -1, A1ID, -1, '999', 1, 0.01);

  // UK-boundary SMS on n5 (manager-owned, survives deletes): yesterday 23:30 UTC = UK TODAY
  const boundaryTs = yesterday + ' 23:30:00'; // Sep 14 23:30Z => UK Sep 15 00:30 BST
  const boundaryUk = ukDateOfSql(boundaryTs);
  t('F2-setup boundary SMS UK date = today', boundaryUk === today, `boundary=${boundaryUk} today=${today}`);
  const n5id = await idOf(n5);
  insSms.run(n5id, n5, R1.id, '888', 'shortcode', 'boundary code 556677', '556677', 0, null, null, M1ID, 'carrier', '0.010', '0.010', 'weekly', boundaryTs);
  dbo.prepare(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(stat_date,manager_id,agent_id,client_id,cli) DO UPDATE SET sms_count=sms_count+excluded.sms_count, payout_sum=payout_sum+excluded.payout_sum`)
    .run(boundaryUk, M1ID, -1, -1, '888', 1, 0.01);

  await sleep(1100); // let short API caches expire

  /* pre-delete baseline (admin, cache-busting) */
  let dash = await api('/api/dashboard?_nocache=1', 'GET', null, adm);
  const preToday = dash.j.sms_today, preTotal = dash.j.total_sms;
  const expectedToday = 9; // 3(n0)+2(n2)+1(n6)+2(a2num)+1(boundary n5)
  t('F2-1 baseline dashboard today = 8', preToday === expectedToday, `got ${preToday}`);
  const expectedTotal = expectedToday + 1; // + winter row = 10
  t('F2-2 baseline dashboard total = 9', preTotal === expectedTotal, `got ${preTotal}`);
  const ledgerBefore = dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c;

  /* PRIME the caches (non-nocache) then delete WITH sms — refresh must not resurrect */
  await api('/api/dashboard', 'GET', null, adm);
  await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  await api('/api/sms/paged?from=' + today + '&to=' + today + '&limit=10', 'GET', null, adm);

  const del = await api('/api/numbers/delete', 'POST', { ids: [n0id], delete_sms: true }, adm);
  t('F2-3 delete n0 + SMS ok', del.status === 200 && del.j.deleted === 1 && del.j.deleted_sms === 4, JSON.stringify(del.j).slice(0, 90)); // 3 today + 1 winter

  dash = await api('/api/dashboard', 'GET', null, adm); // IMMEDIATE refresh (cache was primed!)
  t('F2-4 dashboard today drops by 3 immediately (cache invalidated)', dash.j.sms_today === expectedToday - 3, `got ${dash.j.sms_today}`);
  t('F2-5 dashboard total drops by 4 (incl. winter row)', dash.j.total_sms === expectedTotal - 4, `got ${dash.j.total_sms}`);
  const dash2 = await api('/api/dashboard', 'GET', null, adm);
  t('F2-6 refresh again — same values (no resurrection)', dash2.j.sms_today === expectedToday - 3 && dash2.j.total_sms === expectedTotal - 4, `today=${dash2.j.sms_today} total=${dash2.j.total_sms}`);

  /* CLI/stats/report exclusion */
  let sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  const cliMap = {}; (sum.j.rows || []).forEach(r => cliMap[r.key] = r.sms);
  t('F2-7 deleted CLIs 111/222 gone from today stats', !cliMap['111'] && !cliMap['222'], JSON.stringify(cliMap));
  t('F2-8 surviving CLIs intact (333:2, 444:2, 555:1, 888:1)', cliMap['333'] === 2 && cliMap['444'] === 2 && cliMap['555'] === 1 && cliMap['888'] === 1, JSON.stringify(cliMap));
  sum = await api('/api/stats-summary/cli?from=2026-01-15&to=2026-01-15', 'GET', null, adm);
  t('F2-9 winter stat row removed (999 gone)', !((sum.j.rows || []).find(r => r.key === '999')), JSON.stringify(sum.j.rows || []));
  let pg = await api('/api/sms/paged?from=' + today + '&to=' + today + '&limit=50', 'GET', null, adm);
  t('F2-10 report rows for deleted number gone', !(pg.j.rows || []).some(r => r.number === n0), `rows=${(pg.j.rows || []).length}`);
  pg = await api('/api/sms/paged?from=2026-01-01&to=2026-12-31&limit=50', 'GET', null, adm);
  t('F2-11 winter SMS row gone from reports', !(pg.j.rows || []).some(r => r.number === n0), `rows=${(pg.j.rows || []).length}`);
  const orphanStats = dbo.prepare("SELECT COUNT(*) c FROM sms_daily_stats WHERE sms_count < 0 OR (stat_date='2026-01-15' AND cli='999') OR (stat_date='2026-01-16' AND cli='999')").get().c;
  t('F2-12 no orphan/negative stats rows', orphanStats === 0, 'count=' + orphanStats);
  const ledgerAfterDel = dbo.prepare('SELECT COUNT(*) c FROM payment_ledger').get().c;
  t('F2-13 payment ledger preserved (historical immutability)', ledgerAfterDel === ledgerBefore, `before=${ledgerBefore} after=${ledgerAfterDel}`);
  const smsOrphans = dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE number_id=? OR number=?').get(n0id, n0).c;
  t('F2-14 sms_records for n0 fully deleted', smsOrphans === 0, 'count=' + smsOrphans);

  /* delete WITHOUT sms: history preserved */
  const n2id = await idOf(n2);
  const smsN2Before = dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE number=?').get(n2).c;
  const del2 = await api('/api/numbers/delete', 'POST', { ids: [n2id], delete_sms: false }, adm);
  t('F2-15 delete n2 WITHOUT sms ok', del2.status === 200 && del2.j.deleted === 1 && del2.j.preserved_sms === smsN2Before, JSON.stringify(del2.j).slice(0, 90));
  const smsN2After = dbo.prepare('SELECT COUNT(*) c FROM sms_records WHERE number=?').get(n2).c;
  t('F2-16 n2 SMS history preserved', smsN2After === smsN2Before, `${smsN2Before}->${smsN2After}`);
  pg = await api('/api/sms/paged?from=' + today + '&to=' + today + '&limit=50', 'GET', null, adm);
  t('F2-17 n2 SMS still in reports', (pg.j.rows || []).filter(r => r.number === n2).length === smsN2Before, 'rows=' + (pg.j.rows || []).filter(r => r.number === n2).length);
  dash = await api('/api/dashboard?_nocache=1', 'GET', null, adm);
  t('F2-18 dashboard unchanged by number-only delete', dash.j.sms_today === expectedToday - 3, `got ${dash.j.sms_today}`);

  /* =========================================================================
   * FIX #4 continued — TEST F (rate mgmt change) + TEST G/H (payout calc)
   * ====================================================================== */
  console.log('\n--- FIX #4 (cont.): TEST F/G/H — payment calculation ---');
  // A2's R2 number already has 2 SMS at range rate 0.020 (weekly default)
  const a2sms = dbo.prepare('SELECT payout_amount, payment_type FROM sms_records WHERE number=? ORDER BY id').all(a2num);
  t('F4-H1 A2 SMS payout = range rate 0.020 (no override)', a2sms.every(r => r.payout_amount === '0.02' || r.payout_amount === '0.020' || Number(r.payout_amount) === 0.02), JSON.stringify(a2sms.map(r => r.payout_amount)));

  // new SMS on an overridden number (via manager chain): M1->A1 reallocated number (0.013)
  const relNum = dbo.prepare("SELECT number FROM numbers WHERE id=?").get(mIdsWithRate[0]).number;
  s = await sms(relNum, '666', 'code 2222');
  t('F4-H2 ingest on 0.013-overridden number', s.status === 200, JSON.stringify(s.j).slice(0, 60));
  const relSms = dbo.prepare('SELECT payout_amount, payment_type FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(relNum);
  t('F4-H3 SMS payout uses ALLOCATION rate 0.013 (not range 0.010)', Number(relSms.payout_amount) === 0.013, JSON.stringify(relSms));
  const relLedger = dbo.prepare('SELECT amount, payment_type FROM payment_ledger WHERE sms_record_id=(SELECT id FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1)').get(relNum);
  t('F4-H4 ledger amount snapshots 0.013', relLedger && Number(relLedger.amount) === 0.013, JSON.stringify(relLedger));

  // TEST F: change Rate Management AFTER allocations
  // Rate Mgmt change — full body bhejte hain (endpoint partial body pe undefined bind
  // kar ke 500 deta hai — panel hamesha full form bhejta hai, yahi production behaviour hai)
  const R1full = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.id === R1.id) || {};
  const putR = await api('/api/ranges/' + R1.id, 'PUT', {
    name: R1full.name, prefix: R1full.prefix || '', currency: R1full.currency || 'USD',
    rate_1_1: '0.025', rate_7_1: '0.025', rate_7_7: '0.025', rate_30_45: '0.025',
    memo: R1full.memo || '', payment_type: R1full.payment_type || 'weekly', country: R1full.country || '',
    provider: R1full.provider || '', currency_rate: R1full.currency_rate || '', cli_limit: R1full.cli_limit || '',
    range_start: R1full.range_start || '', range_end: R1full.range_end || '', status: R1full.status || 'Active'
  }, adm);
  t('F4-F0 Rate Mgmt PUT accepted (full body)', putR.status === 200 && putR.j && putR.j.ok, 'status ' + putR.status);
  t('F4-F1 existing override survives Rate Mgmt change', rateOf(relNum) === '0.013', 'rate=' + rateOf(relNum));
  t('F4-F2 existing empty-rate numbers unaffected structurally', rateOf(numsR1[1]) === '');
  // old SMS rows keep their snapshot
  pg = await api('/api/sms/paged?from=' + today + '&to=' + today + '&limit=50', 'GET', null, adm);
  const oldRow = (pg.j.rows || []).find(r => r.number === relNum);
  t('F4-F3 old SMS row keeps 0.013 snapshot after rate change', oldRow && Number(oldRow.payout_amount) === 0.013, JSON.stringify(oldRow && oldRow.payout_amount));
  // new allocation after rate change picks up NEW default
  const idsF = (await Promise.all([numsR1[8], numsR1[9]].map(idOf)));
  a = await api('/api/numbers/allocate', 'POST', { ids: idsF, target_id: A2ID, payterm: 'weekly_7_1' }, adm);
  const newNum = numsR1[8];
  s = await sms(newNum, '777', 'code 3333');
  const newSms = dbo.prepare('SELECT payout_amount FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(newNum);
  t('F4-F4 new allocation (no override) uses NEW range rate 0.025', Number(newSms.payout_amount) === 0.025, JSON.stringify(newSms));

  // TEST G: rate + frequency independence
  const g1 = (await Promise.all([numsR1[10]].map(idOf)));
  await api('/api/numbers/allocate', 'POST', { ids: g1, target_id: A2ID, payterm: 'daily', rate: '0.010' }, adm);
  const g2 = (await Promise.all([numsR1[11]].map(idOf)));
  await api('/api/numbers/allocate', 'POST', { ids: g2, target_id: A2ID, payterm: 'weekly_7_7', rate: '0.013' }, adm);
  const g3 = (await Promise.all([numsR2[9]].map(idOf)));
  await api('/api/numbers/allocate', 'POST', { ids: g3, target_id: A2ID, payterm: 'monthly_30x45' }, adm);
  const g1row = dbo.prepare('SELECT rate, payterm FROM numbers WHERE id=?').get(g1[0]);
  const g2row = dbo.prepare('SELECT rate, payterm FROM numbers WHERE id=?').get(g2[0]);
  const g3row = dbo.prepare('SELECT rate, payterm FROM numbers WHERE id=?').get(g3[0]);
  t('F4-G rate+frequency independent (0.010/daily, 0.013/weekly_7_7, \'\'/monthly)',
    Number(g1row.rate) === 0.010 && g1row.payterm === 'daily' && Number(g2row.rate) === 0.013 && g2row.payterm === 'weekly_7_7' && g3row.rate === '' && g3row.payterm === 'monthly_30x45',
    JSON.stringify([g1row, g2row, g3row]));
  await sms(numsR1[10], '121', 'code 4444');
  await sms(numsR1[11], '131', 'code 5555');
  await sms(numsR2[9], '141', 'code 6666');
  const gSms = {
    daily: dbo.prepare('SELECT payout_amount, payment_type FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(numsR1[10]),
    weekly: dbo.prepare('SELECT payout_amount, payment_type FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(numsR1[11]),
    monthly: dbo.prepare('SELECT payout_amount, payment_type FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1').get(numsR2[9]),
  };
  t('F4-G payout: daily SMS = 0.010 + payment_type daily', Number(gSms.daily.payout_amount) === 0.010 && gSms.daily.payment_type === 'daily', JSON.stringify(gSms.daily));
  t('F4-G payout: weekly_7_7 SMS = 0.013 + payment_type weekly', Number(gSms.weekly.payout_amount) === 0.013 && gSms.weekly.payment_type === 'weekly', JSON.stringify(gSms.weekly));
  t('F4-G payout: monthly SMS = 0.020 (R2 range) + payment_type monthly_30x45', Number(gSms.monthly.payout_amount) === 0.020 && gSms.monthly.payment_type === 'monthly_30x45', JSON.stringify(gSms.monthly));

  // users.payment_type NOT overwritten by allocation (P12 rule, must still hold)
  const a1pay = dbo.prepare('SELECT payment_type FROM users WHERE id=?').get(A1ID).payment_type;
  t('F4-P12 agent users.payment_type untouched by allocation', a1pay === a1PayBefore, `before=${JSON.stringify(a1PayBefore)} after=${JSON.stringify(a1pay)}`);

  // display: numbers list shows effective_rate = override first
  const numList = await api('/api/numbers?search=' + relNum + '&paged=1&limit=5', 'GET', null, adm);
  const shown = (numList.j.rows || []).find(r => r.number === relNum);
  t('F4-DISP numbers list effective_rate shows override 0.013', shown && Number(shown.effective_rate) === 0.013, JSON.stringify(shown && shown.effective_rate));

  /* =========================================================================
   * FIX #3 — CLI facet / report filtering (API level)
   * ====================================================================== */
  console.log('\n--- FIX #3: CLI facet endpoints + role/date scoping ---');
  await sleep(1600); // clear 1.5s stats-summary cache
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  const admClis = {}; (sum.j.rows || []).forEach(r => admClis[r.key] = { sms: r.sms, pay: r.payment });
  t('F3-1 admin CLI facet = today dataset only (no global dump)', Object.keys(admClis).length >= 5 && admClis['333'] && admClis['444'], JSON.stringify(admClis));
  const pay333 = Number(admClis['333'].pay);
  t('F3-2 CLI facet payout matches allocation rate (333 = 2 × 0.013 = 0.026)', Math.abs(pay333 - 0.026) < 1e-9, 'pay=' + pay333);

  // role scoping
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, a1Tok);
  const a1Keys = (sum.j.rows || []).map(r => r.key);
  t('F3-3 agent sees ONLY own CLIs (333,555,666)', ['333','555','666'].every(k => a1Keys.includes(k)) && !['444','888','121','131','141','777'].some(k => a1Keys.includes(k)), JSON.stringify(a1Keys));
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, m1Tok);
  const m1Keys = (sum.j.rows || []).map(r => r.key);
  t('F3-4 manager sees subtree only (333,555,666,888 — no A2-direct CLIs)', ['333','555','666','888'].every(k => m1Keys.includes(k)) && !['444','121','131','141','777'].some(k => m1Keys.includes(k)), JSON.stringify(m1Keys));
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, c1Tok);
  const c1Keys = (sum.j.rows || []).map(r => r.key);
  t('F3-5 client sees only own data', c1Keys.length === 0 || c1Keys.every(k => ['333'].includes(k)), JSON.stringify(c1Keys));

  // UK date behavior: boundary SMS (yesterday 23:30Z = UK today) on n5/CLI 888
  sum = await api('/api/stats-summary/cli?from=' + yesterday + '&to=' + yesterday, 'GET', null, adm);
  t('F3-6 boundary SMS NOT in UK-yesterday range', !((sum.j.rows || []).find(r => r.key === '888')), JSON.stringify((sum.j.rows || []).map(r => r.key)));
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today, 'GET', null, adm);
  t('F3-7 boundary SMS IS in UK-today range (888 present)', !!(sum.j.rows || []).find(r => r.key === '888'), JSON.stringify((sum.j.rows || []).map(r => r.key)));

  // combinations
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today + '&range=P19R2&provider=ProvB', 'GET', null, adm);
  let comb = (sum.j.rows || []).map(r => r.key);
  t('F3-8 cli facet + range + provider combo (only R2/ProvB CLIs)', comb.includes('444') && !comb.includes('333') && !comb.includes('555'), JSON.stringify(comb));
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today + '&manager=p19m1', 'GET', null, adm);
  comb = (sum.j.rows || []).map(r => r.key);
  t('F3-9 cli facet + manager combo (subtree CLIs)', comb.includes('555') && comb.includes('888') && !comb.includes('444'), JSON.stringify(comb));
  sum = await api('/api/stats-summary/range?from=' + today + '&to=' + today + '&cli=333', 'GET', null, adm);
  t('F3-10 range facet filtered by CLI=333 (only P19R1, 2 sms)', (sum.j.rows || []).length === 1 && sum.j.rows[0].key === 'P19R1' && sum.j.rows[0].sms === 2, JSON.stringify(sum.j.rows));
  sum = await api('/api/stats-summary/provider?from=' + today + '&to=' + today, 'GET', null, adm);
  const provMap = {}; (sum.j.rows || []).forEach(r => provMap[r.key] = r.sms);
  t('F3-11 provider facet works (ProvA + ProvB)', provMap['ProvA'] >= 3 && provMap['ProvB'] >= 2, JSON.stringify(provMap));
  // time window combo
  const ttoEnd = '23:59'; // full day window (same-minute seconds boundary se bachne ke liye)
  sum = await api('/api/stats-summary/cli?from=' + today + '&to=' + today + '&tfrom=00:00&tto=' + ttoEnd, 'GET', null, adm);
  t('F3-12 cli facet + time window (00:00-now) includes today CLIs', (sum.j.rows || []).some(r => r.key === '444'), JSON.stringify((sum.j.rows || []).map(r => r.key)));
  // sms/paged with cli param (drill view)
  pg = await api('/api/sms/paged?from=' + today + '&to=' + today + '&cli=333&limit=50', 'GET', null, adm);
  t('F3-13 sms/paged drill by CLI=333 returns only 333 rows', (pg.j.rows || []).length === 2 && (pg.j.rows || []).every(r => r.cli === '333'), `rows=${(pg.j.rows || []).length}`);
  // sms/clis dataset-scoped
  let cl = await api('/api/sms/clis?from=' + today + '&to=' + today, 'GET', null, a1Tok);
  t('F3-14 /sms/clis role+date scoped', (cl.j.items || []).every(x => ['333', '555', '666'].includes(x.cli)) && (cl.j.items || []).length === 3, JSON.stringify(cl.j.items));

  /* ---------- unallocate clears override ---------- */
  await api('/api/numbers/unallocate', 'POST', { ids: g2 }, adm);
  t('F4-U unallocate clears override rate', dbo.prepare('SELECT rate FROM numbers WHERE id=?').get(g2[0]).rate === '');

  /* ================= PHASE 2: restart — persistence ================= */
  console.log('\n--- PHASE 2: server restart — persistence ---');
  dbo.close();
  await stopServer();
  await startServer();
  dbo = openDb();

  kb = await api('/api/assistant/knowledge', 'GET', null, adm2 = await login('vibepk', 'vibepk123'));
  t('P2-1 alloc_max=5 survives restart', kb.j.settings && kb.j.settings.alloc_max === '5', JSON.stringify(kb.j.settings || {}));
  t('P2-2 allocation rates survive restart', Number(dbo.prepare('SELECT rate FROM numbers WHERE id=?').get(g1[0]).rate) === 0.010, 'rate=' + dbo.prepare('SELECT rate FROM numbers WHERE id=?').get(g1[0]).rate);
  const a1Tok2 = await login('p19a1', 'Test123!');
  rep = await ai('i need numbers', a1Tok2); rep = await ai('P19R1', a1Tok2); rep = await ai('9', a1Tok2);
  t('P2-3 limit enforced after restart (9 > 5 refused)', /maximum i can provide is 5/i.test(rep.reply || ''), (rep.reply || '').slice(0, 80));
  dash = await api('/api/dashboard?_nocache=1', 'GET', null, adm2);
  const p2Today = expectedToday - 3 + 5; // -3 n0 deleted; +666,+777,+121,+131,+141 ingested after baseline
  t('P2-4 dashboard consistent after restart', dash.j.sms_today === p2Today, `got ${dash.j.sms_today} want ${p2Today}`);

  /* ---------- report ---------- */
  console.log('\n================= RESULTS =================');
  results.forEach(r => console.log(r));
  console.log('==========================================');
  console.log(`TOTAL: ${PASS} PASS / ${FAIL} FAIL`);
  await stopServer();
  try { dbo.close(); } catch (e) {}
  process.exit(FAIL ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE ERROR:', e);
  results.forEach(r => console.log(r));
  console.log(`TOTAL: ${PASS} PASS / ${FAIL} FAIL (aborted)`);
  await stopServer();
  process.exit(2);
});
