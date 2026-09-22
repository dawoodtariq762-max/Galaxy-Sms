/**
 * Comprehensive Multi-Tier Explicit Allocation Rate Test Suite
 * Validates:
 * 1. Schema columns: manager_rate, agent_rate, client_rate on numbers table
 * 2. Case 1: Admin -> Manager allocation (with explicit override and with Rate Management fallback)
 * 3. Case 2: Admin -> Agent allocation (with explicit override and with Rate Management fallback)
 * 4. Case 3: Admin -> Client allocation (with explicit override and zero payout)
 * 5. Case 4: Manager -> Agent allocation (preserves Admin -> Manager rate, sets Agent rate)
 * 6. Case 5: Manager -> Client allocation (direct from Manager pool)
 * 7. Case 6: Agent -> Client allocation (preserves Manager -> Agent and Admin -> Manager rates)
 * 8. Real Provider Cost independence on ranges table
 * 9. End-to-end SMS Ingestion on fully chained number (Admin -> Manager -> Agent -> Client)
 * 10. Rate Card update preservation (historical rates and ledgers untouched)
 * 11. Tiered unallocation (downstream reset preserves upstream rates)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

const PORT = 8095;
const BASE = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/test_hierarchy_rates.db';

let PASS = 0;
let FAIL = 0;

function t(title, condition, detail = '') {
  if (condition) {
    console.log(`PASS | ${title}`);
    PASS++;
  } else {
    console.error(`FAIL | ${title}${detail ? ' — ' + detail : ''}`);
    FAIL++;
  }
}

const near = (a, b, eps = 1e-6) => Math.abs((parseFloat(a) || 0) - (parseFloat(b) || 0)) < eps;

const api = (p, method = 'GET', body = null, token = null, extraHeaders = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const req = http.request(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...extraHeaders,
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }
  }, res => {
    let b = '';
    res.on('data', d => b += d);
    res.on('end', () => {
      let j = null;
      try { j = JSON.parse(b); } catch (_) {}
      resolve({ status: res.statusCode, j, b });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Starting Multi-Tier Hierarchy Rates Verification...');

  // Clean old db files
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
  if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');

  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_FILE: DB_PATH,
    JWT_SECRET: 'test-secret-12345678901234567890',
    ENABLE_CRON: '0',
    DISABLE_AUTO_BACKUP: '1'
  };

  const serverProc = spawn('node', ['backend/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit'
  });

  // Wait for health check
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const h = await api('/api/health');
      if (h.status === 200) { ready = true; break; }
    } catch (_) {}
  }

  if (!ready) {
    console.error('Server failed to start');
    serverProc.kill('SIGKILL');
    process.exit(1);
  }

  const qGet = (sql, ...args) => { const d = new Database(DB_PATH); try { return d.prepare(sql).get(...args); } finally { d.close(); } };
  const qAll = (sql, ...args) => { const d = new Database(DB_PATH); try { return d.prepare(sql).all(...args); } finally { d.close(); } };

  try {
    // Schema Check: verify columns on numbers table
    const numCols = qAll("PRAGMA table_info(numbers)").map(c => c.name);
    t('Schema: numbers has manager_rate', numCols.includes('manager_rate'));
    t('Schema: numbers has agent_rate', numCols.includes('agent_rate'));
    t('Schema: numbers has client_rate', numCols.includes('client_rate'));

    // Admin login
    const rLog = await api('/api/login', 'POST', { username: 'vibepk', password: 'vibepk123' });
    t('Setup: Admin login', rLog.status === 200 && rLog.j.token);
    const adm = rLog.j.token;

    // Create Hierarchy Users:
    // Manager 1
    const rM1 = await api('/api/users', 'POST', { username: 'mgr1', password: 'Password123!', role: 'manager' }, adm);
    t('Setup: Manager 1 created', rM1.status === 200);
    const m1Tok = (await api('/api/login', 'POST', { username: 'mgr1', password: 'Password123!' })).j.token;

    // Agent 1 under Manager 1
    const rA1 = await api('/api/users', 'POST', { username: 'agt1', password: 'Password123!', role: 'agent' }, m1Tok);
    t('Setup: Agent 1 created under Manager 1', rA1.status === 200);
    const a1Tok = (await api('/api/login', 'POST', { username: 'agt1', password: 'Password123!' })).j.token;

    // Agent 2 directly under Admin
    const rA2 = await api('/api/users', 'POST', { username: 'agt2', password: 'Password123!', role: 'agent' }, adm);
    t('Setup: Agent 2 created under Admin', rA2.status === 200);
    const a2Tok = (await api('/api/login', 'POST', { username: 'agt2', password: 'Password123!' })).j.token;

    // Client 1 under Agent 1
    const rC1 = await api('/api/users', 'POST', { username: 'cli1', password: 'Password123!', role: 'client' }, a1Tok);
    t('Setup: Client 1 created under Agent 1', rC1.status === 200);
    const c1Tok = (await api('/api/login', 'POST', { username: 'cli1', password: 'Password123!' })).j.token;

    // Client 2 under Manager 1
    const rC2 = await api('/api/users', 'POST', { username: 'cli2', password: 'Password123!', role: 'client' }, m1Tok);
    t('Setup: Client 2 created under Manager 1', rC2.status === 200);
    const c2Tok = (await api('/api/login', 'POST', { username: 'cli2', password: 'Password123!' })).j.token;

    // Client 3 directly under Admin
    const rC3 = await api('/api/users', 'POST', { username: 'cli3', password: 'Password123!', role: 'client' }, adm);
    t('Setup: Client 3 created under Admin', rC3.status === 200);
    const c3Tok = (await api('/api/login', 'POST', { username: 'cli3', password: 'Password123!' })).j.token;

    // Create Test Ranges with Rate Cards and Provider Rates
    // Range 1: Default weekly rate = 0.010, Provider cost = 0.005
    const rR1 = await api('/api/ranges', 'POST', {
      name: 'Range-UK-Alpha', prefix: '4471', currency: 'USD',
      rate_1_1: '0.008', rate_7_1: '0.010', rate_7_7: '0.012', rate_30_45: '0.015',
      provider_rate_1_1: '0.004', provider_rate_7_1: '0.005', provider_rate_7_7: '0.006', provider_rate_30_45: '0.007',
      payment_type: 'weekly'
    }, adm);
    t('Setup: Range 1 created with rate card & provider rate', rR1.status === 200);
    const range1 = (await api('/api/ranges', 'GET', null, adm)).j.find(r => r.name === 'Range-UK-Alpha');

    // Import Numbers into Range 1
    const nums = [
      '447100000001', '447100000002', '447100000003', '447100000004',
      '447100000005', '447100000006', '447100000007', '447100000008',
      '447100000009', '447100000010'
    ];
    const imp1 = await api('/api/numbers/import', 'POST', { range_id: range1.id, numbers: nums }, adm);
    t('Setup: Numbers import accepted', imp1.status === 200);
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const j1 = await api('/api/numbers/import-jobs/' + imp1.j.job.job_id, 'GET', null, adm);
      if (j1.j && j1.j.status === 'done') break;
    }
    const numRows = qAll("SELECT * FROM numbers WHERE range_id=? ORDER BY id ASC", range1.id);
    t('Setup: 10 numbers populated', numRows.length === 10);

    const M1ID = qGet("SELECT id FROM users WHERE username='mgr1'").id;
    const A1ID = qGet("SELECT id FROM users WHERE username='agt1'").id;
    const A2ID = qGet("SELECT id FROM users WHERE username='agt2'").id;
    const C1ID = qGet("SELECT id FROM users WHERE username='cli1'").id;
    const C2ID = qGet("SELECT id FROM users WHERE username='cli2'").id;
    const C3ID = qGet("SELECT id FROM users WHERE username='cli3'").id;

    // Enable Carrier Settings via Admin API
    const carRes = await api('/api/carrier-settings', 'PUT', {
      integration_status: 'enabled',
      carrier_ip: '127.0.0.1'
    }, adm, { 'x-carrier-lock': 'Dawood' });
    t('Setup: Carrier integration enabled', carRes.status === 200);

    console.log('\n--- TEST CASE 1: Admin -> Manager ---');
    // Admin allocates N1 to Manager 1 with explicit rate override 0.050
    const alloc1 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[0].id], target_id: M1ID, rate: '0.050', payterm: 'weekly_7_1'
    }, adm);
    t('Case 1.1: Admin -> Manager allocation API succeeds', alloc1.status === 200 && alloc1.j.allocated === 1);
    const n1Db = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Case 1.1: numbers.manager_rate is 0.05', near(n1Db.manager_rate, 0.05));
    t('Case 1.1: numbers.manager_id is M1', n1Db.manager_id === M1ID);

    // Manager 1 queries numbers: effective_rate must be 0.05
    const m1Nums = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, m1Tok);
    t('Case 1.1: Manager sees effective rate = 0.05', m1Nums.j.rows && near(m1Nums.j.rows[0].effective_rate, 0.05));

    // Admin allocates N2 to Manager 1 WITHOUT override (Rate Management default)
    const alloc1b = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[1].id], target_id: M1ID, payterm: 'weekly_7_1'
    }, adm);
    t('Case 1.2: Admin -> Manager without override succeeds', alloc1b.status === 200 && alloc1b.j.allocated === 1);
    const n2Db = qGet("SELECT * FROM numbers WHERE id=?", numRows[1].id);
    t('Case 1.2: numbers.manager_rate is empty (no override)', n2Db.manager_rate === '');
    const m1Nums2 = await api('/api/numbers?search=' + numRows[1].number + '&paged=1', 'GET', null, m1Tok);
    t('Case 1.2: Manager sees Rate Management default 0.010', m1Nums2.j.rows && near(m1Nums2.j.rows[0].effective_rate, 0.010));

    console.log('\n--- TEST CASE 2: Admin -> Agent (Direct) ---');
    // Admin allocates N3 directly to Agent 2 with rate 0.045
    const alloc2 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[2].id], target_id: A2ID, rate: '0.045', payterm: 'weekly_7_1'
    }, adm);
    t('Case 2.1: Admin -> Agent direct succeeds', alloc2.status === 200 && alloc2.j.allocated === 1);
    const n3Db = qGet("SELECT * FROM numbers WHERE id=?", numRows[2].id);
    t('Case 2.1: numbers.agent_rate is 0.045 and manager_id is NULL', near(n3Db.agent_rate, 0.045) && n3Db.manager_id === null);
    const a2Nums = await api('/api/numbers?search=' + numRows[2].number + '&paged=1', 'GET', null, a2Tok);
    t('Case 2.1: Agent sees effective rate = 0.045', a2Nums.j.rows && near(a2Nums.j.rows[0].effective_rate, 0.045));

    // Admin allocates N4 directly to Agent 2 WITHOUT override
    const alloc2b = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[3].id], target_id: A2ID, payterm: 'weekly_7_1'
    }, adm);
    t('Case 2.2: Admin -> Agent without override succeeds', alloc2b.status === 200);
    const a2Nums2 = await api('/api/numbers?search=' + numRows[3].number + '&paged=1', 'GET', null, a2Tok);
    t('Case 2.2: Agent sees Rate Management default 0.010', a2Nums2.j.rows && near(a2Nums2.j.rows[0].effective_rate, 0.010));

    console.log('\n--- TEST CASE 3: Admin -> Client (Direct) ---');
    // Admin allocates N5 directly to Client 3 with rate/payout 0.025
    const alloc3 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[4].id], target_id: C3ID, rate: '0.025', payterm: 'weekly_7_1'
    }, adm);
    t('Case 3: Admin -> Client direct succeeds', alloc3.status === 200 && alloc3.j.allocated === 1);
    const n5Db = qGet("SELECT * FROM numbers WHERE id=?", numRows[4].id);
    t('Case 3: numbers.client_rate and payout are 0.025', near(n5Db.client_rate, 0.025) && near(n5Db.payout, 0.025));
    const c3Nums = await api('/api/numbers?search=' + numRows[4].number + '&paged=1', 'GET', null, c3Tok);
    t('Case 3: Client sees payout = 0.025', c3Nums.j.rows && (near(c3Nums.j.rows[0].payout, 0.025) || near(c3Nums.j.rows[0].effective_rate, 0.025)));

    console.log('\n--- TEST CASE 4: Manager -> Agent ---');
    // Manager 1 allocates N1 (which has manager_rate=0.050) to Agent 1 with rate 0.040
    const alloc4 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[0].id], target_id: A1ID, rate: '0.040', payterm: 'weekly_7_1'
    }, m1Tok);
    t('Case 4: Manager -> Agent allocation succeeds', alloc4.status === 200 && alloc4.j.allocated === 1);
    const n1DbAfterA = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Case 4: numbers.agent_rate is 0.04', near(n1DbAfterA.agent_rate, 0.04));
    t('Case 4: numbers.manager_rate is STILL 0.05 (Manager rate preserved!)', near(n1DbAfterA.manager_rate, 0.05));
    t('Case 4: numbers.manager_id is STILL M1', n1DbAfterA.manager_id === M1ID);
    t('Case 4: numbers.agent_id is A1', n1DbAfterA.agent_id === A1ID);

    // Verify Manager perspective: Manager STILL sees their own effective_rate as 0.05
    const m1Check = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, m1Tok);
    t('Case 4: Manager STILL sees own rate = 0.05', m1Check.j.rows && near(m1Check.j.rows[0].effective_rate, 0.05));

    // Verify Agent perspective: Agent sees their assigned effective_rate as 0.04
    const a1Check = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, a1Tok);
    t('Case 4: Agent sees assigned rate = 0.04', a1Check.j.rows && near(a1Check.j.rows[0].effective_rate, 0.04));

    // Provider Rate remains untouched
    const r1Check = qGet("SELECT provider_rate_7_1 FROM ranges WHERE id=?", range1.id);
    t('Case 4: Range provider_rate_7_1 is STILL 0.005 (Real cost untouched)', near(r1Check.provider_rate_7_1, 0.005));

    console.log('\n--- TEST CASE 5: Manager -> Client ---');
    // Manager 1 allocates N2 (manager_rate empty -> 0.010 default) to Client 2 with payout 0.007
    const alloc5 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[1].id], target_id: C2ID, rate: '0.007', payout: '0.007'
    }, m1Tok);
    t('Case 5: Manager -> Client direct succeeds', alloc5.status === 200 && alloc5.j.allocated === 1);
    const n2DbAfterC = qGet("SELECT * FROM numbers WHERE id=?", numRows[1].id);
    t('Case 5: numbers.client_rate and payout are 0.007', near(n2DbAfterC.client_rate, 0.007) && near(n2DbAfterC.payout, 0.007));
    t('Case 5: numbers.manager_id is M1', n2DbAfterC.manager_id === M1ID);
    const c2Check = await api('/api/numbers?search=' + numRows[1].number + '&paged=1', 'GET', null, c2Tok);
    t('Case 5: Client sees payout = 0.007', c2Check.j.rows && (near(c2Check.j.rows[0].payout, 0.007) || near(c2Check.j.rows[0].effective_rate, 0.007)));
    const m1Check2 = await api('/api/numbers?search=' + numRows[1].number + '&paged=1', 'GET', null, m1Tok);
    t('Case 5: Manager still sees own rate = 0.010', m1Check2.j.rows && near(m1Check2.j.rows[0].effective_rate, 0.010));

    console.log('\n--- TEST CASE 6: Agent -> Client ---');
    // Agent 1 allocates N1 (manager_rate=0.050, agent_rate=0.040) to Client 1 with payout 0.020
    const alloc6 = await api('/api/numbers/allocate', 'POST', {
      ids: [numRows[0].id], target_id: C1ID, payout: '0.020'
    }, a1Tok);
    t('Case 6: Agent -> Client allocation succeeds', alloc6.status === 200 && alloc6.j.allocated === 1);
    const n1DbFinal = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Case 6: numbers.client_rate and payout are 0.02', near(n1DbFinal.client_rate, 0.02) && near(n1DbFinal.payout, 0.02));
    t('Case 6: numbers.agent_rate is STILL 0.04 (Agent rate preserved!)', near(n1DbFinal.agent_rate, 0.04));
    t('Case 6: numbers.manager_rate is STILL 0.05 (Manager rate preserved!)', near(n1DbFinal.manager_rate, 0.05));
    t('Case 6: numbers.manager_id, agent_id, client_id all linked',
      n1DbFinal.manager_id === M1ID && n1DbFinal.agent_id === A1ID && n1DbFinal.client_id === C1ID);

    // Client perspective
    const c1Check = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, c1Tok);
    t('Case 6: Client 1 sees payout = 0.02', c1Check.j.rows && (near(c1Check.j.rows[0].payout, 0.02) || near(c1Check.j.rows[0].effective_rate, 0.02)));

    // Agent perspective: Agent STILL sees 0.04
    const a1CheckFinal = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, a1Tok);
    t('Case 6: Agent STILL sees own rate = 0.04', a1CheckFinal.j.rows && near(a1CheckFinal.j.rows[0].effective_rate, 0.04));

    // Manager perspective: Manager STILL sees 0.05
    const m1CheckFinal = await api('/api/numbers?search=' + numRows[0].number + '&paged=1', 'GET', null, m1Tok);
    t('Case 6: Manager STILL sees own rate = 0.05', m1CheckFinal.j.rows && near(m1CheckFinal.j.rows[0].effective_rate, 0.05));

    console.log('\n--- COMPLETE CHAIN & FINANCIALS: Admin -> Manager -> Agent -> Client ---');
    // SMS Ingestion on N1 via webhook:
    const smsRes = await api('/api/webhook/sms', 'POST', {
      number: numRows[0].number,
      cli: '447999888777',
      message: 'Your verification OTP code is 987654'
    });
    t('Chain: SMS received on full-chain number N1', smsRes.status === 200 && smsRes.j.ok);

    // Check sms_records:
    const smsRecord = qGet("SELECT * FROM sms_records WHERE number=? ORDER BY id DESC LIMIT 1", numRows[0].number);
    t('Chain: sms_record has payout_amount = 0.04 (Agent payout rate)', near(smsRecord.payout_amount, 0.04));
    t('Chain: sms_record correctly links manager_id, agent_id, client_id',
      smsRecord.manager_id === M1ID && smsRecord.agent_id === A1ID && smsRecord.client_id === C1ID);

    // Check payment_ledger:
    const ledgerRow = qGet("SELECT * FROM payment_ledger WHERE sms_record_id=?", smsRecord.id);
    t('Chain: payment_ledger records 0.04 for Agent', ledgerRow && near(ledgerRow.amount, 0.04) && ledgerRow.agent_id === A1ID);

    // Check Real Provider Cost on Admin Dashboard:
    const adminDash = await api('/api/dashboard', 'GET', null, adm);
    t('Chain: Admin dashboard has Real Provider Cost today', adminDash.j.provider_cost_today !== undefined);

    console.log('\n--- PRESERVATION: Rate Card Updates do NOT alter Historical Allocations ---');
    // Update Range 1 rate card: rate_7_1 changes from 0.010 to 0.099
    const putRange = await api('/api/ranges/' + range1.id, 'PUT', {
      name: range1.name, prefix: range1.prefix, currency: range1.currency,
      rate_1_1: '0.099', rate_7_1: '0.099', rate_7_7: '0.099', rate_30_45: '0.099',
      provider_rate_1_1: '0.004', provider_rate_7_1: '0.005', provider_rate_7_7: '0.006', provider_rate_30_45: '0.007',
      payment_type: 'weekly'
    }, adm);
    t('Preserve: Range 1 rate card updated', putRange.status === 200);

    // Verify N1 rates are 100% PRESERVED:
    const n1Preserved = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Preserve: Manager rate on N1 is STILL 0.05', near(n1Preserved.manager_rate, 0.05));
    t('Preserve: Agent rate on N1 is STILL 0.04', near(n1Preserved.agent_rate, 0.04));
    t('Preserve: Client rate on N1 is STILL 0.02', near(n1Preserved.client_rate, 0.02));

    // Verify Historical SMS and Ledger are 100% PRESERVED:
    const smsPreserved = qGet("SELECT payout_amount FROM sms_records WHERE id=?", smsRecord.id);
    t('Preserve: Historical SMS record payout is STILL 0.04', near(smsPreserved.payout_amount, 0.04));
    const ledgerPreserved = qGet("SELECT amount FROM payment_ledger WHERE id=?", ledgerRow.id);
    t('Preserve: Historical ledger amount is STILL 0.04', near(ledgerPreserved.amount, 0.04));

    console.log('\n--- UNALLOCATION PRESERVATION ---');
    // Agent 1 unallocates N1 from Client:
    const unallocCli = await api('/api/numbers/unallocate', 'POST', { ids: [numRows[0].id] }, a1Tok);
    t('Unallocate: Agent unallocates client succeeds', unallocCli.status === 200);
    const n1AfterUnallocCli = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Unallocate: client_id is cleared', n1AfterUnallocCli.client_id === null);
    t('Unallocate: client_rate and payout are cleared', n1AfterUnallocCli.client_rate === '' && n1AfterUnallocCli.payout === '0');
    t('Unallocate: Agent rate 0.04 is PRESERVED', near(n1AfterUnallocCli.agent_rate, 0.04));
    t('Unallocate: Manager rate 0.05 is PRESERVED', near(n1AfterUnallocCli.manager_rate, 0.05));
    t('Unallocate: Agent id and Manager id are PRESERVED', n1AfterUnallocCli.agent_id === A1ID && n1AfterUnallocCli.manager_id === M1ID);

    // Manager 1 unallocates N1 from Agent:
    const unallocAgt = await api('/api/numbers/unallocate', 'POST', { ids: [numRows[0].id] }, m1Tok);
    t('Unallocate: Manager unallocates agent succeeds', unallocAgt.status === 200);
    const n1AfterUnallocAgt = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Unallocate: agent_id is cleared', n1AfterUnallocAgt.agent_id === null);
    t('Unallocate: agent_rate is cleared', n1AfterUnallocAgt.agent_rate === '');
    t('Unallocate: Manager rate 0.05 is PRESERVED', near(n1AfterUnallocAgt.manager_rate, 0.05));
    t('Unallocate: Manager id is PRESERVED', n1AfterUnallocAgt.manager_id === M1ID);

    // Admin unallocates N1:
    const unallocMgr = await api('/api/numbers/unallocate', 'POST', { ids: [numRows[0].id] }, adm);
    t('Unallocate: Admin unallocates manager succeeds', unallocMgr.status === 200);
    const n1AfterUnallocMgr = qGet("SELECT * FROM numbers WHERE id=?", numRows[0].id);
    t('Unallocate: All ownership and rates cleared',
      n1AfterUnallocMgr.manager_id === null && n1AfterUnallocMgr.agent_id === null && n1AfterUnallocMgr.client_id === null &&
      n1AfterUnallocMgr.manager_rate === '' && n1AfterUnallocMgr.agent_rate === '' && n1AfterUnallocMgr.client_rate === '');

  } finally {
    serverProc.kill('SIGTERM');
  }

  console.log('\n==========================================');
  console.log(`TOTAL: ${PASS} PASS / ${FAIL} FAIL`);
  console.log('==========================================');
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failure:', err);
  process.exit(1);
});
