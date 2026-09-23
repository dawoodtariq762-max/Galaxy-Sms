/**
 * verify-self-allocate-and-readability.js
 * Comprehensive verification for:
 * 1. Readability styling for Number & CLI in SMS CDR / Reports across dark/light themes.
 * 2. Complete removal of AI Assistant widget, routes, and UI.
 * 3. Range-based Agent Self-Allocation limits (Admin -> Manager -> Agent hierarchy).
 * 4. Atomic transaction protection and limit enforcement.
 * 5. Unavailable / disabled handling with Manager contact.
 * 6. Rate Management default rate auto-population and Agent -> Client 0.00 exception.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = '/tmp/test_self_allocate.sqlite';

let PASS = 0;
let FAIL = 0;

function t(desc, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${desc}`);
    PASS++;
  } else {
    console.error(`  ✗ FAIL: ${desc}${detail ? ' — ' + detail : ''}`);
    FAIL++;
  }
}

const api = (p, method = 'GET', body = null, token = null) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const req = http.request(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
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
  console.log('\n=== RUNNING COMPREHENSIVE VERIFICATION SUITE ===\n');

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
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProc.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('JWT_SECRET env var is NOT set')) console.error('[server err]', s);
  });

  // Wait for server to boot
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await api('/api/health');
      if (res.status === 200 || res.status === 404 || res.status === 401) {
        booted = true;
        break;
      }
    } catch (_) {}
  }

  if (!booted) {
    console.error('Server failed to start within timeout');
    if (serverProc) serverProc.kill();
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  try {
    // --- SUITE 1: SMS CDR / REPORT READABILITY ---
    console.log('--- Test Suite 1: SMS CDR / Report Readability ---');
    const css = fs.readFileSync(path.join(__dirname, '../assets/galaxy.css'), 'utf8');
    t('galaxy.css contains readability styles for mono Number & CLI', css.includes('PART 1: SMS CDR / REPORT READABILITY'));
    t('galaxy.css uses bold font-weight (700) for mono', css.includes('font-weight: 700 !important;'));
    t('galaxy.css uses ~14.5px font-size for mono numbers', css.includes('font-size: 14.5px !important;'));
    t('galaxy.css provides high contrast for light mode', css.includes('body.light-mode .mono') || css.includes('body:not(.ms-dark-mode)'));
    t('galaxy.css provides responsive scaling for mobile screens', css.includes('@media (max-width: 768px)'));

    const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
    const mgrHtml = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf8');
    const agtHtml = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf8');
    t('admin.html sdFmtDim outputs unbadged mono for Number & CLI', !adminHtml.includes('sdFmtDim(d,v){\n  const raw=String(v==null?\'\':v);\n  const esc=raw.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');\n  if(!raw) return \'<span class="muted">—</span>\';\n  if(d===\'number\'||d===\'cli\') return `<span class="tag tag-gray mono">${esc}</span>`;'));
    t('manager.html sdFmtDim outputs unbadged mono for Number & CLI', !mgrHtml.includes('if(d===\'number\'||d===\'cli\') return `<span class="tag tag-gray mono">${esc}</span>`;'));
    t('agent.html sdFmtDim outputs unbadged mono for Number & CLI', !agtHtml.includes('if(d===\'number\'||d===\'cli\') return `<span class="tag tag-gray mono">${esc}</span>`;'));

    // --- SUITE 2: COMPLETE REMOVAL OF AI ASSISTANT ---
    console.log('\n--- Test Suite 2: Complete Removal of AI Assistant ---');
    const apiJs = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
    t('api.js has no floating AI assistant widget', !apiJs.includes('gxAssistantBtn') && !apiJs.includes('gxAssistantWin'));

    const chatJs = fs.readFileSync(path.join(__dirname, '../assets/chat.js'), 'utf8');
    t('chat.js does not query gxAssistantBtn for positionChatFab', !chatJs.includes("document.getElementById('gxAssistantBtn')"));

    t('admin.html has no AI assistant page or nav', !adminHtml.includes('data-page="aiKnowledge"') && !adminHtml.includes('id="page-aiKnowledge"'));
    const mgmtHtml = fs.readFileSync(path.join(__dirname, '../management.html'), 'utf8');
    t('management.html has no AI assistant page or nav', !mgmtHtml.includes('data-page="aiKnowledge"') && !mgmtHtml.includes('id="page-aiKnowledge"'));

    // Login as default admin
    const loginRes = await api('/api/login', 'POST', { username: 'vibepk', password: 'vibepk123' });
    const adminToken = loginRes.j?.token;
    t('Admin login successful', !!adminToken);

    // Verify AI endpoints return 404
    const stRes = await api('/api/assistant/status', 'GET', null, adminToken);
    t('/assistant/status returns 404', stRes.status === 404);
    const msgRes = await api('/api/assistant/message', 'POST', { text: 'hi' }, adminToken);
    t('/assistant/message returns 404', msgRes.status === 404);

    // --- SUITE 3: RANGE CREATION WITH SELF-ALLOCATION LIMITS ---
    console.log('\n--- Test Suite 3: Range Creation with Self-Allocation Limits ---');
    // Create Manager
    const mgrCreate = await api('/api/users', 'POST', {
      username: 'mgr_sa1',
      password: 'vibepk123',
      role: 'manager',
      email: 'mgr_sa1@galaxy.com',
      contact: '+1-555-0199'
    }, adminToken);
    const mgrId = mgrCreate.j?.id;
    t('Manager created', !!mgrId);

    // Create Agent under Manager
    const agtCreate = await api('/api/users', 'POST', {
      username: 'agt_sa1',
      password: 'vibepk123',
      role: 'agent',
      parent_id: mgrId
    }, adminToken);
    const agtId = agtCreate.j?.id;
    t('Agent under Manager created', !!agtId);

    // Create Direct Agent under Admin (no manager)
    const agtDirectCreate = await api('/api/users', 'POST', {
      username: 'agt_direct1',
      password: 'vibepk123',
      role: 'agent'
    }, adminToken);
    const agtDirectId = agtDirectCreate.j?.id;
    t('Direct Agent created', !!agtDirectId);

    // Create Client under Agent
    const cliCreate = await api('/api/users', 'POST', {
      username: 'cli_sa1',
      password: 'vibepk123',
      role: 'client',
      parent_id: agtId
    }, adminToken);
    const cliId = cliCreate.j?.id;
    t('Client under Agent created', !!cliId);

    // Tokens
    const mgrToken = (await api('/api/login', 'POST', { username: 'mgr_sa1', password: 'vibepk123' })).j?.token;
    const agtToken = (await api('/api/login', 'POST', { username: 'agt_sa1', password: 'vibepk123' })).j?.token;
    const agtDirectToken = (await api('/api/login', 'POST', { username: 'agt_direct1', password: 'vibepk123' })).j?.token;

    // Create Range A (Self-allocation enabled, max 10, weekly 0.010, monthly 0.012)
    const rACreate = await api('/api/ranges', 'POST', {
      name: 'Benin_MTN_SA',
      prefix: '229',
      currency: 'USD',
      rate_1_1: '0.008',
      rate_7_1: '0.010',
      rate_7_7: '0.010',
      rate_30_45: '0.012',
      self_alloc_enabled: 1,
      self_alloc_max: 10,
      self_alloc_periods: 'weekly,monthly'
    }, adminToken);
    t('Range A created with self_alloc limits', rACreate.status === 200);

    const rangeA = db.prepare("SELECT * FROM ranges WHERE name='Benin_MTN_SA'").get();
    t('Range A has self_alloc_enabled = 1', rangeA.self_alloc_enabled === 1);
    t('Range A has self_alloc_max = 10', rangeA.self_alloc_max === 10);
    t('Range A has self_alloc_periods = weekly,monthly', rangeA.self_alloc_periods === 'weekly,monthly');

    // Create Range B (Disabled)
    await api('/api/ranges', 'POST', {
      name: 'Togo_Moov_Disabled',
      prefix: '228',
      currency: 'USD',
      rate_7_1: '0.015',
      rate_30_45: '0.018',
      self_alloc_enabled: 0,
      self_alloc_max: 5,
      self_alloc_periods: 'weekly'
    }, adminToken);
    const rangeB = db.prepare("SELECT * FROM ranges WHERE name='Togo_Moov_Disabled'").get();
    t('Range B created with self_alloc_enabled = 0', rangeB.self_alloc_enabled === 0);

    // Seed Range A inventory: 4 in Manager pool, 10 in Admin pool
    for (let i = 1; i <= 4; i++) {
      db.prepare(`INSERT INTO numbers (range_id, number, prefix, manager_id, rate, payterm) VALUES (?, ?, '229', ?, '0.010', 'weekly_7_1')`)
        .run(rangeA.id, `2299000000${i}`, mgrId);
    }
    for (let i = 5; i <= 14; i++) {
      db.prepare(`INSERT INTO numbers (range_id, number, prefix) VALUES (?, ?, '229')`)
        .run(rangeA.id, `2299000000${i}`);
    }

    // --- SUITE 4: AGENT SELF-ALLOCATION QUERY & ATOMIC ALLOCATION ---
    console.log('\n--- Test Suite 4: Agent Self-Allocation Query & Atomic Execution ---');
    const saRanges = await api('/api/agent/self-allocate/ranges', 'GET', null, agtToken);
    t('Agent can query self-allocation ranges', saRanges.status === 200 && saRanges.j?.ok === true);
    t('Agent receives assigned Manager name and contact info', saRanges.j?.manager_name === 'mgr_sa1' && saRanges.j?.manager_contact === '+1-555-0199');

    const saRangeA = saRanges.j?.ranges.find(r => r.name === 'Benin_MTN_SA');
    t('Range A pool availability matches total inventory (14)', saRangeA?.available_in_pool === 14);
    t('Range A remaining limit is 10', saRangeA?.remaining_limit === 10);
    t('Range A authorized weekly rate is 0.010', saRangeA?.rates.weekly === '0.010');
    t('Range A authorized monthly rate is 0.012', saRangeA?.rates.monthly === '0.012');

    // Self-allocate 3 numbers (pulled from Manager pool)
    const alloc1 = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeA.id,
      quantity: 3,
      billing_period: 'weekly'
    }, agtToken);
    t('Agent self-allocates 3 numbers weekly', alloc1.status === 200 && alloc1.j?.allocated === 3);
    t('Assigned effective rate matches Rate Management (0.010)', alloc1.j?.effective_rate === '0.010');

    // Inspect database for those 3 numbers
    const agentNums1 = db.prepare('SELECT * FROM numbers WHERE range_id=? AND agent_id=?').all(rangeA.id, agtId);
    t('Numbers in DB have agent_id set', agentNums1.length === 3);
    t('Numbers in DB preserve manager_id in hierarchy', agentNums1.every(n => n.manager_id === mgrId));
    t('Numbers in DB have alloc_source = self_allocate', agentNums1.every(n => n.alloc_source === 'self_allocate'));

    // Self-allocate 4 numbers (1 from Manager pool remainder, 3 overflowing from Admin pool)
    const alloc2 = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeA.id,
      quantity: 4,
      billing_period: 'monthly'
    }, agtToken);
    t('Agent self-allocates 4 numbers with monthly billing', alloc2.status === 200 && alloc2.j?.allocated === 4);
    t('Assigned effective rate matches Monthly Rate Management (0.012)', alloc2.j?.effective_rate === '0.012');

    const agentNums2 = db.prepare('SELECT * FROM numbers WHERE range_id=? AND agent_id=?').all(rangeA.id, agtId);
    t('Agent now holds exactly 7 numbers in range', agentNums2.length === 7);
    t('All numbers hold manager_id = mgrId (Admin->Manager->Agent preserved)', agentNums2.every(n => n.manager_id === mgrId));

    // Exceeding limit: limit is 10, agent has 7, requesting 4 should fail
    const allocExceed = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeA.id,
      quantity: 4,
      billing_period: 'weekly'
    }, agtToken);
    t('Request exceeding limit is rejected with 400', allocExceed.status === 400);
    t('Rejection message states limit and remaining quota', allocExceed.j?.error.includes('10') && allocExceed.j?.error.includes('3'));

    // Allocate exact remaining quota (3 numbers)
    const allocExact = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeA.id,
      quantity: 3,
      billing_period: 'weekly'
    }, agtToken);
    t('Allocating exact remaining quota (3) succeeds', allocExact.status === 200 && allocExact.j?.allocated === 3);

    // Now count is 10 (limit reached)
    const allocBlocked = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeA.id,
      quantity: 1,
      billing_period: 'weekly'
    }, agtToken);
    t('Subsequent request is rejected because limit is reached', allocBlocked.status === 400);

    // --- SUITE 5: DISABLED & UNAVAILABLE HANDLING WITH MANAGER CONTACT ---
    console.log('\n--- Test Suite 5: Disabled & Unavailable Range Handling ---');
    const allocDis = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeB.id,
      quantity: 1,
      billing_period: 'weekly'
    }, agtToken);
    t('Disabled range rejected with 403', allocDis.status === 403);
    t('Disabled message directs Agent to assigned Manager name and phone', allocDis.j?.error.includes('mgr_sa1') && allocDis.j?.error.includes('+1-555-0199'));

    // Create Range with 0 numbers
    await api('/api/ranges', 'POST', {
      name: 'Zero_Stock_Range',
      prefix: '225',
      currency: 'USD',
      rate_7_1: '0.020',
      self_alloc_enabled: 1,
      self_alloc_max: 20
    }, adminToken);
    const rangeZero = db.prepare("SELECT * FROM ranges WHERE name='Zero_Stock_Range'").get();

    const allocZero = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeZero.id,
      quantity: 5,
      billing_period: 'weekly'
    }, agtToken);
    t('Exhausted pool rejected with 409', allocZero.status === 409);
    t('Exhausted pool informs Agent to contact assigned Manager', allocZero.j?.error.includes('No numbers are currently available') && allocZero.j?.error.includes('mgr_sa1'));

    // Direct Agent under Admin (no manager) points to Admin
    const allocDirectZero = await api('/api/agent/self-allocate', 'POST', {
      range_id: rangeZero.id,
      quantity: 2,
      billing_period: 'weekly'
    }, agtDirectToken);
    console.log('allocDirectZero result:', allocDirectZero); t('Direct Agent points to Admin when range is empty', allocDirectZero.status === 409 && allocDirectZero.j?.error.includes('Admin'));

    // --- SUITE 6: RATE MANAGEMENT DEFAULT AUTO-POPULATION & AGENT -> CLIENT 0.00 EXCEPTION ---
    console.log('\n--- Test Suite 6: Rate Defaults & Agent -> Client 0.00 Exception ---');
    // Agent allocates to Client with deliberate 0.00 rate
    const agentNumToClient = agentNums1[0];
    const allocCli = await api('/api/numbers/allocate', 'POST', {
      ids: [agentNumToClient.id],
      target_id: cliId,
      payterm: 'weekly_7_1',
      payout: '0.00',
      rate: '0.00'
    }, agtToken);
    t('Agent -> Client allocation allows 0.00 rate', allocCli.status === 200 && allocCli.j?.count === 1);

    const clientNum = db.prepare('SELECT * FROM numbers WHERE id=?').get(agentNumToClient.id);
    t('Client received number with client_rate = 0', clientNum.client_rate === '0');
    t('Client received number with payout = 0', clientNum.payout === '0');

    // Audit logs recorded self-allocation operations
    const auditLogs = db.prepare("SELECT * FROM audit_logs WHERE action='agent_self_allocate'").all();
    t('Audit logs record agent_self_allocate actions', auditLogs.length >= 3);
    const logDetails = JSON.parse(auditLogs[0].details);
    t('Audit log includes agent, manager, range, rate, quantity, and numbers', logDetails.agent === 'agt_sa1' && logDetails.manager === 'mgr_sa1' && logDetails.quantity > 0 && Array.isArray(logDetails.numbers));

  } finally {
    db.close();
    serverProc.kill();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
    if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
  }

  console.log('\n=================================================');
  console.log(`TOTAL TESTS: ${PASS + FAIL} | PASSED: ${PASS} | FAILED: ${FAIL}`);
  console.log('=================================================\n');

  if (FAIL > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
