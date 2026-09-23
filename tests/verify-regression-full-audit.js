const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/test_audit_${Date.now()}.db`;

let serverProc = null;
let db = null;

function api(urlPath, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(fullUrl, { method, headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_FILE: DB_PATH,
    JWT_SECRET: 'test-secret-audit-full'
  };

  serverProc = spawn('node', [path.join(__dirname, '../backend/server.js')], {
    env,
    cwd: path.join(__dirname, '..')
  });

  serverProc.stdout.on('data', d => {
    // console.log('[SRV]', d.toString().trim());
  });
  serverProc.stderr.on('data', d => {
    console.error('[SRV ERR]', d.toString().trim());
  });

  // Wait for server to listen
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await api('/api/health');
      if (res.status === 200) {
        db = new Database(DB_PATH);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Server did not start in time');
}

async function run() {
  console.log('===== FULL REGRESSION AUDIT & VERIFICATION SUITE =====\n');
  await startServer();
  console.log(`✓ Test server running on port ${PORT} with DB: ${DB_PATH}`);

  let adminTok, mgr1Tok, mgr2Tok, agentDirectTok, agentMgrTok;
  let adminUser, mgr1User, mgr2User, agentDirectUser, agentMgrUser;
  let testRangeId;

  // 1. Setup Admin
  adminUser = db.prepare("SELECT * FROM users WHERE role='admin'").get();
  assert.ok(adminUser, 'Admin created by seed');
  const aLogin = await api('/api/login', 'POST', { username: adminUser.username, password: 'vibepk123' });
  adminTok = aLogin.body.token;
  assert.ok(adminTok, 'Admin login succeeded');

  // 2. Create Managers: mgr1 and mgr2
  await api('/api/users', 'POST', { username: 'audit_mgr1', password: 'MgrPass123!', role: 'manager', name: 'Manager One' }, adminTok);
  mgr1User = db.prepare("SELECT * FROM users WHERE username='audit_mgr1'").get();
  const m1Login = await api('/api/login', 'POST', { username: 'audit_mgr1', password: 'MgrPass123!' });
  mgr1Tok = m1Login.body.token;

  await api('/api/users', 'POST', { username: 'audit_mgr2', password: 'MgrPass123!', role: 'manager', name: 'Manager Two' }, adminTok);
  mgr2User = db.prepare("SELECT * FROM users WHERE username='audit_mgr2'").get();
  const m2Login = await api('/api/login', 'POST', { username: 'audit_mgr2', password: 'MgrPass123!' });
  mgr2Tok = m2Login.body.token;

  // 3. Create Direct Agent (parent = admin) and Manager Agent (parent = mgr1)
  await api('/api/users', 'POST', { username: 'audit_agent_dir', password: 'AgentPass123!', role: 'agent', parent_id: adminUser.id, name: 'Direct Agent' }, adminTok);
  agentDirectUser = db.prepare("SELECT * FROM users WHERE username='audit_agent_dir'").get();
  const agDirLogin = await api('/api/login', 'POST', { username: 'audit_agent_dir', password: 'AgentPass123!' });
  agentDirectTok = agDirLogin.body.token;

  await api('/api/users', 'POST', { username: 'audit_agent_mgr', password: 'AgentPass123!', role: 'agent', parent_id: mgr1User.id, name: 'Manager Agent' }, adminTok);
  agentMgrUser = db.prepare("SELECT * FROM users WHERE username='audit_agent_mgr'").get();
  const agMgrLogin = await api('/api/login', 'POST', { username: 'audit_agent_mgr', password: 'AgentPass123!' });
  agentMgrTok = agMgrLogin.body.token;

  // 4. Create Range with 10 numbers
  const rRes = await api('/api/ranges', 'POST', {
    name: 'Audit-Range-UK',
    prefix: '4479',
    currency: 'USD',
    rate_1_1: '0.01',
    rate_7_1: '0.02',
    rate_7_7: '0.03',
    rate_30_45: '0.04',
    self_alloc_enabled: 1,
    self_alloc_max: 2,
    self_alloc_periods: 'weekly,monthly,daily'
  }, adminTok);
  testRangeId = db.prepare("SELECT id FROM ranges WHERE name='Audit-Range-UK'").get().id;

  // Insert numbers 4479000001 to 4479000010
  for (let i = 1; i <= 10; i++) {
    const numStr = `44790000${String(i).padStart(2, '0')}`;
    db.prepare("INSERT INTO numbers (range_id, number, rate, payterm, alloc_source) VALUES (?, ?, '0.02', 'weekly_7_1', 'manual')").run(testRangeId, numStr);
  }
  console.log('✓ Initial setup completed: Admin, 2 Managers, 2 Agents (1 direct, 1 under mgr1), Range with 10 numbers.\n');

  // =========================================================================
  // SECTION A: RANGE ALLOCATION MUST ONLY USE UNALLOCATED NUMBERS
  // =========================================================================
  console.log('--- TEST SECTION A: RANGE ALLOCATION ONLY USES UNALLOCATED NUMBERS ---');

  // Setup:
  // N1: unallocated (id: 1)
  // N2: allocated to mgr1 (id: 2)
  // N3: allocated to direct agent (id: 3)
  // N4: unallocated (id: 4)
  db.prepare("UPDATE numbers SET manager_id=?, manager_rate='0.02' WHERE id=2").run(mgr1User.id);
  db.prepare("UPDATE numbers SET agent_id=?, agent_rate='0.015' WHERE id=3").run(agentDirectUser.id);

  // Verify DB state
  const beforeN2 = db.prepare("SELECT * FROM numbers WHERE id=2").get();
  const beforeN3 = db.prepare("SELECT * FROM numbers WHERE id=3").get();
  assert.strictEqual(beforeN2.manager_id, mgr1User.id, 'N2 is owned by Mgr1');
  assert.strictEqual(beforeN3.agent_id, agentDirectUser.id, 'N3 is owned by Direct Agent');

  // Admin requests 2 numbers via Range Allocation (smart-divide) for Mgr2
  const sdRes = await api('/api/numbers/smart-divide', 'POST', {
    range_ids: [testRangeId],
    target_ids: [mgr2User.id],
    qty: 2
  }, adminTok);

  assert.strictEqual(sdRes.status, 200, 'smart-divide returned 200');
  assert.strictEqual(sdRes.body.total, 2, 'allocated exactly 2 numbers');

  // Verify that N2 and N3 were NOT stolen!
  const afterN2 = db.prepare("SELECT * FROM numbers WHERE id=2").get();
  const afterN3 = db.prepare("SELECT * FROM numbers WHERE id=3").get();
  assert.strictEqual(afterN2.manager_id, mgr1User.id, 'PASS: N2 is STILL owned by Mgr1 (NOT stolen)');
  assert.strictEqual(afterN3.agent_id, agentDirectUser.id, 'PASS: N3 is STILL owned by Direct Agent (NOT stolen)');

  // Verify that the allocated numbers are N1 and N4 (the unallocated ones)
  const afterN1 = db.prepare("SELECT * FROM numbers WHERE id=1").get();
  const afterN4 = db.prepare("SELECT * FROM numbers WHERE id=4").get();
  assert.strictEqual(afterN1.manager_id, mgr2User.id, 'PASS: N1 was unallocated and is now allocated to Mgr2');
  assert.strictEqual(afterN4.manager_id, mgr2User.id, 'PASS: N4 was unallocated and is now allocated to Mgr2');
  console.log('PASS: Range allocation strictly took only unallocated numbers (N1 and N4), leaving N2 and N3 untouched.\n');

  // =========================================================================
  // SECTION B: CONCURRENCY IN RANGE ALLOCATION
  // =========================================================================
  console.log('--- TEST SECTION B: CONCURRENCY IN RANGE ALLOCATION ---');
  // Currently numbers remaining unallocated in range are: N5, N6, N7, N8, N9, N10 (6 numbers).
  // Fire 2 concurrent allocation requests for 3 numbers each: Request A for mgr1, Request B for mgr2
  const p1 = api('/api/numbers/smart-divide', 'POST', { range_ids: [testRangeId], target_ids: [mgr1User.id], qty: 3 }, adminTok);
  const p2 = api('/api/numbers/smart-divide', 'POST', { range_ids: [testRangeId], target_ids: [mgr2User.id], qty: 3 }, adminTok);

  const [resA, resB] = await Promise.all([p1, p2]);
  assert.strictEqual(resA.status, 200, 'Request A succeeded');
  assert.strictEqual(resB.status, 200, 'Request B succeeded');

  const mgr1Count = db.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND manager_id=?").get(testRangeId, mgr1User.id).c;
  const mgr2Count = db.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND manager_id=?").get(testRangeId, mgr2User.id).c;
  // Mgr1 previously had 1 (N2) + 3 = 4
  // Mgr2 previously had 2 (N1, N4) + 3 = 5
  assert.strictEqual(mgr1Count, 4, 'Mgr1 has exactly 4 numbers');
  assert.strictEqual(mgr2Count, 5, 'Mgr2 has exactly 5 numbers');

  // Check that NO number is assigned to both or in conflict
  const allNums = db.prepare("SELECT id, manager_id FROM numbers WHERE range_id=?").all(testRangeId);
  const mgr1Ids = allNums.filter(n => n.manager_id === mgr1User.id).map(n => n.id);
  const mgr2Ids = allNums.filter(n => n.manager_id === mgr2User.id).map(n => n.id);
  const intersection = mgr1Ids.filter(id => mgr2Ids.includes(id));
  assert.strictEqual(intersection.length, 0, 'PASS: ZERO overlapping or duplicate allocations in concurrent requests');
  console.log('PASS: Concurrent range allocations executed safely without collisions or double-allocations.\n');

  // =========================================================================
  // SECTION C: ADMIN -> AGENT HIERARCHY (Direct Agent vs Manager Agent)
  // =========================================================================
  console.log('--- TEST SECTION C: ADMIN -> AGENT HIERARCHY ---');

  // Allocate a fresh number to Direct Agent (Scenario A: no manager)
  const nDirRes = await api('/api/numbers/allocate', 'POST', {
    ids: [3],
    target_id: agentDirectUser.id,
    rate: '0.018',
    force: true
  }, adminTok);
  assert.strictEqual(nDirRes.status, 200, 'Allocated to direct agent');
  const dirNum = db.prepare("SELECT * FROM numbers WHERE id=3").get();
  assert.strictEqual(dirNum.agent_id, agentDirectUser.id, 'Direct Agent is set');
  assert.strictEqual(dirNum.manager_id, null, 'PASS: Direct Agent number has manager_id = NULL (no invented manager)');

  // Allocate a number to Manager Agent (Scenario B: under mgr1)
  // Make N10 unallocated so we can test cleanly
  db.prepare("UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL WHERE id=10").run();
  const nMgrRes = await api('/api/numbers/allocate', 'POST', {
    ids: [10],
    target_id: agentMgrUser.id,
    rate: '0.016'
  }, adminTok);
  assert.strictEqual(nMgrRes.status, 200, 'Admin allocated number to Manager Agent');
  const mgrNum = db.prepare("SELECT * FROM numbers WHERE id=10").get();
  assert.strictEqual(mgrNum.agent_id, agentMgrUser.id, 'Agent ID is set');
  assert.strictEqual(mgrNum.manager_id, mgr1User.id, 'PASS: manager_id is automatically linked to Manager 1');

  // Test Manager Visibility
  // Manager 1 must see N10 (since Agent belongs to Manager 1)
  const m1NumList = await api('/api/numbers?paged=1', 'GET', null, mgr1Tok);
  const m1NumberIds = (m1NumList.body.rows || []).map(r => r.id);
  assert.ok(m1NumberIds.includes(10), 'PASS: Manager 1 can see N10 in Manager Panel');
  assert.ok(!m1NumberIds.includes(3), 'PASS: Manager 1 CANNOT see Direct Agent N3');

  // Manager 2 must NOT see N10 (no inventory leakage across managers)
  const m2NumList = await api('/api/numbers?paged=1', 'GET', null, mgr2Tok);
  const m2NumberIds = (m2NumList.body.rows || []).map(r => r.id);
  assert.ok(!m2NumberIds.includes(10), 'PASS: Manager 2 CANNOT see Manager 1 Agent N10 (no inventory leakage)');
  console.log('PASS: Admin -> Agent hierarchy correctly distinguishes Direct Agent from Manager Agent.\n');

  // =========================================================================
  // SECTION D: AGENT OTP / SMS VISIBILITY IN MANAGER PANEL
  // =========================================================================
  console.log('--- TEST SECTION D: AGENT OTP / SMS VISIBILITY IN MANAGER PANEL ---');

  // Enable carrier integration
  db.prepare("UPDATE carrier_settings SET integration_status='enabled', carrier_ip='127.0.0.1,::1,::ffff:127.0.0.1'").run();

  // Send incoming SMS to Manager Agent's number (N10: 4479000010)
  const smsRes = await api('/api/incoming-sms', 'POST', {
    number: '4479000010',
    cli: '447888123456',
    message: 'Your verification OTP is 789123'
  });
  assert.strictEqual(smsRes.status, 200, 'Incoming SMS processed successfully');
  const savedSms = db.prepare("SELECT * FROM sms_records WHERE number='4479000010' ORDER BY id DESC LIMIT 1").get();
  assert.strictEqual(savedSms.agent_id, agentMgrUser.id, 'SMS has agent_id set');
  assert.strictEqual(savedSms.manager_id, mgr1User.id, 'PASS: SMS has manager_id set to Manager 1');

  // Check Manager 1 SMS list
  const m1Sms = await api('/api/sms', 'GET', null, mgr1Tok);
  const m1SmsList = Array.isArray(m1Sms.body) ? m1Sms.body : (m1Sms.body.rows || []);
  const m1Found = m1SmsList.find(s => s.number === '4479000010');
  assert.ok(m1Found, 'PASS: OTP appears in Manager 1 Panel');

  // Check Agent SMS list
  const agSms = await api('/api/sms', 'GET', null, agentMgrTok);
  const agSmsList = Array.isArray(agSms.body) ? agSms.body : (agSms.body.rows || []);
  const agFound = agSmsList.find(s => s.number === '4479000010');
  assert.ok(agFound, 'PASS: OTP appears in Agent Panel');

  // Check Manager 2 SMS list (must NOT see Manager 1's OTP)
  const m2Sms = await api('/api/sms', 'GET', null, mgr2Tok);
  const m2SmsList = Array.isArray(m2Sms.body) ? m2Sms.body : (m2Sms.body.rows || []);
  const m2Found = m2SmsList.find(s => s.number === '4479000010');
  assert.strictEqual(m2Found, undefined, 'PASS: Manager 2 CANNOT see Manager 1 OTP (proper scope isolation)');
  console.log('PASS: Agent OTP is visible in Manager 1 Panel and Agent Panel, and isolated from Manager 2.\n');

  // =========================================================================
  // SECTION E: SELF-ALLOCATION LIMIT VS NORMAL ALLOCATION
  // =========================================================================
  console.log('--- TEST SECTION E: SELF-ALLOCATION LIMIT VS NORMAL ALLOCATION ---');

  // Create a dedicated range with self_alloc_max = 2
  const saRange = await api('/api/ranges', 'POST', {
    name: 'SelfAlloc-Test-Range',
    prefix: '4477',
    currency: 'USD',
    rate_7_1: '0.02',
    self_alloc_enabled: 1,
    self_alloc_max: 2,
    self_alloc_periods: 'weekly'
  }, adminTok);
  const saRid = db.prepare("SELECT id FROM ranges WHERE name='SelfAlloc-Test-Range'").get().id;

  // Insert 10 numbers in this range
  for (let i = 1; i <= 10; i++) {
    db.prepare("INSERT INTO numbers (range_id, number, rate, payterm, alloc_source) VALUES (?, ?, '0.02', 'weekly_7_1', 'manual')")
      .run(saRid, `44770000${String(i).padStart(2, '0')}`);
  }

  // 1. Manually allocate 5 numbers to agentMgrUser via Admin
  const manualNums = db.prepare("SELECT id FROM numbers WHERE range_id=? LIMIT 5").all(saRid).map(r => r.id);
  const manAllocRes = await api('/api/numbers/allocate', 'POST', {
    ids: manualNums,
    target_id: agentMgrUser.id,
    rate: '0.02'
  }, adminTok);
  assert.strictEqual(manAllocRes.status, 200, 'Manual allocation of 5 numbers succeeded');
  assert.strictEqual(manAllocRes.body.count, 5, '5 numbers allocated manually');

  // Verify that agent currently holds 5 numbers in this range
  const totalHeld = db.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=?").get(saRid, agentMgrUser.id).c;
  assert.strictEqual(totalHeld, 5, 'Agent holds 5 manual numbers');

  // 2. Check Self Allocation Range Info for Agent
  const saRangesRes = await api('/api/agent/self-allocate/ranges', 'GET', null, agentMgrTok);
  const mySaRange = (saRangesRes.body.ranges || []).find(r => r.id === saRid);
  assert.ok(mySaRange, 'Range found in self-allocate ranges');
  assert.strictEqual(mySaRange.agent_current_count, 0, 'PASS: self-allocated count is 0 (manual numbers do NOT count against quota)');
  assert.strictEqual(mySaRange.remaining_limit, 2, 'PASS: Agent can still self-allocate up to 2 numbers');

  // 3. Agent self-allocates 2 numbers (max allowed)
  const doSaRes = await api('/api/agent/self-allocate', 'POST', {
    range_id: saRid,
    quantity: 2,
    billing_period: 'weekly'
  }, agentMgrTok);
  assert.strictEqual(doSaRes.status, 200, 'Self-allocation of 2 numbers succeeded');

  const afterSaHeld = db.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=?").get(saRid, agentMgrUser.id).c;
  assert.strictEqual(afterSaHeld, 7, 'Agent now holds 7 total numbers (5 manual + 2 self-allocated)');

  // 4. Agent tries to self-allocate 1 more number (exceeds limit 2)
  const failSaRes = await api('/api/agent/self-allocate', 'POST', {
    range_id: saRid,
    quantity: 1,
    billing_period: 'weekly'
  }, agentMgrTok);
  assert.strictEqual(failSaRes.status, 400, 'PASS: Self-allocation over limit rejected with 400');
  assert.ok(failSaRes.body.error.includes('limit exceeded'), 'Error message specifies limit exceeded');

  // 5. Verify NO automatic replacement / unallocation occurred
  const countAfterReject = db.prepare("SELECT COUNT(*) c FROM numbers WHERE range_id=? AND agent_id=?").get(saRid, agentMgrUser.id).c;
  assert.strictEqual(countAfterReject, 7, 'PASS: Zero numbers were automatically unallocated or replaced');
  console.log('PASS: Self-allocation limit is strictly isolated from normal manual allocations; no auto-replacement.\n');

  // =========================================================================
  // SECTION F: SUPER MANAGER CREATION, ASSIGNMENT, USAGE & REVOCATION
  // =========================================================================
  console.log('--- TEST SECTION F: SUPER MANAGER AUDIT ---');

  // Assign Super Manager to Mgr1 with display name "Galaxy Helpdesk"
  const smAssign = await api(`/api/chat/admin/super-manager/${mgr1User.id}`, 'POST', {
    is_super_manager: 1,
    chat_display_name: 'Galaxy Helpdesk'
  }, adminTok);
  assert.strictEqual(smAssign.status, 200, 'Super Manager assigned');

  // Mgr1 logs into chat
  // Set chat password for Mgr1 first
  db.prepare("INSERT OR REPLACE INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (?, ?, 1)")
    .run(mgr1User.id, require('bcryptjs').hashSync('ChatPass123!', 10));

  const chatLoginRes = await api('/api/chat/auth/login', 'POST', {
    username: 'audit_mgr1',
    password: 'ChatPass123!'
  });
  assert.strictEqual(chatLoginRes.status, 200, 'Chat login succeeded');
  const chatTok = chatLoginRes.body.token;
  assert.strictEqual(chatLoginRes.body.user.is_super_manager, 1, 'Token user has is_super_manager: 1');
  assert.strictEqual(chatLoginRes.body.user.chat_display_name, 'Galaxy Helpdesk', 'Token user has chat_display_name');

  // Super Manager accesses All Chats
  const allChatsRes = await api('/api/chat/conversations?scope=all', 'GET', null, chatTok);
  assert.strictEqual(allChatsRes.status, 200, 'PASS: Super Manager can access All Chats (scope=all)');

  // Super Manager replies to a conversation between Agent and Client
  const cUser = db.prepare("INSERT INTO users (username, password, role, parent_id) VALUES ('audit_cli_1', 'pass', 'client', ?)").run(agentMgrUser.id);
  const cliId = Number(cUser.lastInsertRowid);
  const convIns = db.prepare("INSERT INTO chat_conversations (user_a, user_b) VALUES (?, ?)").run(Math.min(agentMgrUser.id, cliId), Math.max(agentMgrUser.id, cliId));
  const convId = Number(convIns.lastInsertRowid);

  const replyRes = await api(`/api/chat/messages/${convId}`, 'POST', {
    body: 'Hello from Super Manager Support!'
  }, chatTok);
  console.log('REPLY RESPONSE:', replyRes.body);
  assert.strictEqual(replyRes.status, 200, 'Super Manager reply sent');
  assert.strictEqual(replyRes.body.message.sender_name, 'Galaxy Helpdesk', 'PASS: Reply displays custom display name "Galaxy Helpdesk"');
  assert.strictEqual(replyRes.body.message.sender_username, 'Galaxy Helpdesk', 'PASS: Reply masks original username');
  assert.strictEqual(replyRes.body.message.sender_role, 'Super Manager', 'PASS: Reply role label is Super Manager');

  // Revoke Super Manager
  const revokeRes = await api(`/api/chat/admin/super-manager/${mgr1User.id}`, 'POST', {
    is_super_manager: 0,
    chat_display_name: ''
  }, adminTok);
  assert.strictEqual(revokeRes.status, 200, 'Super Manager revoked');

  // Verify revoked manager is immediately blocked from scope=all
  const blockedScope = await api('/api/chat/conversations?scope=all', 'GET', null, chatTok);
  assert.strictEqual(blockedScope.status, 403, 'PASS: Revoked Super Manager immediately blocked from scope=all (403)');
  console.log('PASS: Super Manager role assignment, identity masking, and instant revocation fully verified.\n');

  // =========================================================================
  // SECTION G: CHAT APP ARTIFACTS & IN-APP UPDATE SYSTEM
  // =========================================================================
  console.log('--- TEST SECTION G: CHAT APP & IN-APP UPDATE VERIFICATION ---');

  const verRes = await api('/api/chat/app/version', 'GET');
  assert.strictEqual(verRes.status, 200, 'App version endpoint returns 200');
  assert.strictEqual(verRes.body.latestVersion, '2.0.0', 'latestVersion is 2.0.0');
  assert.strictEqual(verRes.body.versionCode, 2, 'versionCode is 2');
  assert.strictEqual(verRes.body.downloadUrl, '/api/chat/app/download', 'downloadUrl matches');

  const dlRes = await api('/api/chat/app/download', 'GET');
  assert.strictEqual(dlRes.status, 200, 'App download endpoint returns 200');
  assert.strictEqual(dlRes.headers['content-type'], 'application/vnd.android.package-archive', 'Content-Type is APK');

  // Verify APK on disk
  const v2Path = path.join(__dirname, '..', 'galaxy-chat-v2.apk');
  assert.ok(fs.existsSync(v2Path), 'galaxy-chat-v2.apk exists in workspace');
  assert.ok(fs.statSync(v2Path).size > 50000, 'galaxy-chat-v2.apk has valid binary size (>50KB)');
  console.log('PASS: Chat App v2 binary and in-app update endpoints verified.\n');

  if (serverProc) serverProc.kill();
  console.log('===========================================================');
  console.log('✅ ALL REGRESSION AUDIT & DATA-INTEGRITY TESTS PASSED!');
  console.log('===========================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Test failed with error:', err);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
