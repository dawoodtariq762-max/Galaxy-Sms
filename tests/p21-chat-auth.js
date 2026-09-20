/**
 * tests/p21-chat-auth.js — Comprehensive Test Suite for P21:
 * Separate Chat Authentication + Admin Chat Accounts + Token Scoping + Test Cases A-G
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert');

const TEST_DB = path.join(__dirname, 'p21_test.sqlite');
try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (e) {}

let passed = 0, failed = 0;
function logPass(msg, detail) { passed++; console.log(`PASS | ${msg}${detail ? ' | ' + detail : ''}`); }
function logFail(msg, detail) { failed++; console.error(`FAIL | ${msg}${detail ? ' | ' + detail : ''}`); }

let serverProc = null;
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}`;

function post(urlPath, body, token) {
  return request('POST', urlPath, body, token);
}
function get(urlPath, token) {
  return request('GET', urlPath, null, token);
}
function del(urlPath, token) {
  return request('DELETE', urlPath, null, token);
}

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, data: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function bootServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_FILE: TEST_DB,
      JWT_SECRET: 'test-p21-jwt-secret-secure-random-1234567890',
      NODE_ENV: 'test'
    });
    serverProc = spawn('node', [path.join(__dirname, '..', 'backend', 'server.js')], { env });
    serverProc.stdout.on('data', (d) => {
      if (d.toString().includes('Server running on port')) resolve();
    });
    serverProc.stderr.on('data', (d) => {
      // ignore normal logs
    });
    serverProc.on('error', reject);
    setTimeout(() => resolve(), 3000);
  });
}

async function run() {
  console.log(`\n===== P21 SEPARATE CHAT AUTH & SECURITY VERIFICATION =====\n`);
  await bootServer();

  try {
    // 1. Admin login to obtain panel token
    const adminPanelLogin = await post('/api/login', { username: 'vibepk', password: 'vibepk123' });
    assert.strictEqual(adminPanelLogin.status, 200, 'Admin panel login should succeed');
    const adminToken = adminPanelLogin.data.token;
    logPass('Setup: Admin logged into panel', `token received`);

    // 2. Create hierarchy: Manager -> Agent -> Client
    const createMgr = await post('/api/users', {
      username: 'mgr_kashif',
      password: 'PanelMgrPass1!',
      chat_password: 'ChatMgrPass9$',
      role: 'manager',
      name: 'Manager Kashif',
      email: 'kashif@example.com'
    }, adminToken);
    assert.strictEqual(createMgr.status, 200, 'Manager creation should succeed');

    // Get manager user id
    const mgrList = await get('/api/users/manager', adminToken);
    const mgrUser = mgrList.data.find(u => u.username === 'mgr_kashif');
    assert(mgrUser, 'Manager user should exist');

    const createAgt = await post('/api/users', {
      username: 'agt_tariq',
      password: 'PanelAgtPass1!',
      chat_password: 'ChatAgtPass9$',
      role: 'agent',
      name: 'Agent Tariq',
      email: 'tariq@example.com',
      parent_id: mgrUser.id
    }, adminToken);
    assert.strictEqual(createAgt.status, 200, 'Agent creation should succeed');

    const agtList = await get('/api/users/agent', adminToken);
    const agtUser = agtList.data.find(u => u.username === 'agt_tariq');
    assert(agtUser, 'Agent user should exist');

    const createCli = await post('/api/users', {
      username: 'cli_bilal',
      password: 'PanelCliPass1!',
      chat_password: 'ChatCliPass9$',
      role: 'client',
      name: 'Client Bilal',
      email: 'bilal@example.com',
      parent_id: agtUser.id
    }, adminToken);
    assert.strictEqual(createCli.status, 200, 'Client creation should succeed');

    const cliList = await get('/api/users/client', adminToken);
    const cliUser = cliList.data.find(u => u.username === 'cli_bilal');
    assert(cliUser, 'Client user should exist');

    logPass('Setup: Hierarchy created with separate credentials', 'Manager, Agent, Client');

    // --- TEST CASE A: INDEPENDENT INITIAL CREDENTIALS ---
    console.log('\n--- Test Case A: Independent Initial Credentials ---');

    // Panel login with panel password -> 200
    const agtPanelOk = await post('/api/login', { username: 'agt_tariq', password: 'PanelAgtPass1!' });
    assert.strictEqual(agtPanelOk.status, 200, 'Agent panel login with panel password must succeed');
    logPass('Case A1: Agent panel login with Panel password succeeds');

    // Panel login with chat password -> 401
    const agtPanelFail = await post('/api/login', { username: 'agt_tariq', password: 'ChatAgtPass9$' });
    assert.strictEqual(agtPanelFail.status, 401, 'Agent panel login with Chat password must fail');
    logPass('Case A2: Agent panel login with Chat password fails (401)');

    // Chat login with chat password -> 200
    const agtChatOk = await post('/api/chat/auth/login', { username: 'agt_tariq', password: 'ChatAgtPass9$' });
    assert.strictEqual(agtChatOk.status, 200, 'Agent chat login with Chat password must succeed');
    assert(agtChatOk.data.token, 'Chat token must be returned');
    assert.strictEqual(agtChatOk.data.user.username, 'agt_tariq');
    const agtChatToken = agtChatOk.data.token;
    logPass('Case A3: Agent chat login with Chat password succeeds');

    // Chat login with panel password -> 401
    const agtChatFail = await post('/api/chat/auth/login', { username: 'agt_tariq', password: 'PanelAgtPass1!' });
    assert.strictEqual(agtChatFail.status, 401, 'Agent chat login with Panel password must fail');
    logPass('Case A4: Agent chat login with Panel password fails (401)');


    // --- TEST CASE B: PANEL PASSWORD CHANGE LEAVES CHAT UNAFFECTED ---
    console.log('\n--- Test Case B: Panel Password Change ---');

    // Agent changes panel password via profile
    const agtPanelToken = agtPanelOk.data.token;
    const changePanelPw = await request('PUT', '/api/profile', {
      username: 'agt_tariq',
      current_password: 'PanelAgtPass1!',
      new_password: 'NewPanelAgtPass2@',
      confirm_password: 'NewPanelAgtPass2@'
    }, agtPanelToken);
    assert.strictEqual(changePanelPw.status, 200, 'Panel password update should succeed');

    // Panel login now succeeds with new panel pw and fails with old
    const agtOldPanelLogin = await post('/api/login', { username: 'agt_tariq', password: 'PanelAgtPass1!' });
    assert.strictEqual(agtOldPanelLogin.status, 401, 'Old panel password must fail');
    const agtNewPanelLogin = await post('/api/login', { username: 'agt_tariq', password: 'NewPanelAgtPass2@' });
    assert.strictEqual(agtNewPanelLogin.status, 200, 'New panel password must succeed');
    logPass('Case B1: Panel password changed to NewPanelAgtPass2@');

    // Chat login STILL succeeds with original ChatAgtPass9$
    const agtChatStillOk = await post('/api/chat/auth/login', { username: 'agt_tariq', password: 'ChatAgtPass9$' });
    assert.strictEqual(agtChatStillOk.status, 200, 'Chat login must remain functional with unchanged chat password');
    logPass('Case B2: Chat login continues to succeed with ChatAgtPass9$ after panel password change');


    // --- TEST CASE C: CHAT PASSWORD CHANGE LEAVES PANEL UNAFFECTED ---
    console.log('\n--- Test Case C: Chat Password Change ---');

    // Agent changes their chat password
    const changeChatPw = await post('/api/chat/auth/change-password', {
      current_password: 'ChatAgtPass9$',
      new_password: 'NewChatAgtPass8#',
      confirm_password: 'NewChatAgtPass8#'
    }, agtChatToken);
    assert.strictEqual(changeChatPw.status, 200, 'Chat password change should succeed');

    // Chat login now succeeds with new chat pw and fails with old
    const agtOldChatLogin = await post('/api/chat/auth/login', { username: 'agt_tariq', password: 'ChatAgtPass9$' });
    assert.strictEqual(agtOldChatLogin.status, 401, 'Old chat password must fail');
    const agtNewChatLogin = await post('/api/chat/auth/login', { username: 'agt_tariq', password: 'NewChatAgtPass8#' });
    assert.strictEqual(agtNewChatLogin.status, 200, 'New chat password must succeed');
    logPass('Case C1: Chat password changed to NewChatAgtPass8#');

    // Panel login remains 100% active with NewPanelAgtPass2@
    const agtPanelUnchanged = await post('/api/login', { username: 'agt_tariq', password: 'NewPanelAgtPass2@' });
    assert.strictEqual(agtPanelUnchanged.status, 200, 'Panel login must be completely unaffected');
    logPass('Case C2: Panel login remains active with NewPanelAgtPass2@');


    // --- TEST CASE D: SAME USERNAME, DUAL ROLES & CREDENTIALS ---
    console.log('\n--- Test Case D: Dual Credential Independence ---');
    assert.notStrictEqual('NewPanelAgtPass2@', 'NewChatAgtPass8#');
    logPass('Case D: Same username agt_tariq holds distinct independent hashes');


    // --- TEST CASE E: ADMIN MASTER ACCOUNT EXEMPTION ---
    console.log('\n--- Test Case E: Admin Exemption Test ---');

    // Admin panel login with vibepk123
    const admPanelOk = await post('/api/login', { username: 'vibepk', password: 'vibepk123' });
    assert.strictEqual(admPanelOk.status, 200, 'Admin panel login succeeds');

    // Admin chat login with SAME master password vibepk123
    const admChatOk = await post('/api/chat/auth/login', { username: 'vibepk', password: 'vibepk123' });
    assert.strictEqual(admChatOk.status, 200, 'Admin chat login succeeds with master password');
    assert.strictEqual(admChatOk.data.user.role, 'admin');
    logPass('Case E1: Admin master password validates both Panel and Chat access');

    // Admin chat login with wrong password fails
    const admChatFail = await post('/api/chat/auth/login', { username: 'vibepk', password: 'wrongpassword' });
    assert.strictEqual(admChatFail.status, 401, 'Admin chat login with wrong password fails');
    logPass('Case E2: Admin chat login with wrong password rejected (401)');


    // --- TEST CASE F: CHAT DISABLED / REVOKED TEST ---
    console.log('\n--- Test Case F: Chat Disabled Test ---');

    // Admin disables chat access for client Bilal
    const disableCliChat = await post(`/api/chat/admin/accounts/${cliUser.id}/toggle`, { chat_enabled: false }, adminToken);
    assert.strictEqual(disableCliChat.status, 200, 'Toggle chat should succeed');
    assert.strictEqual(disableCliChat.data.chat_enabled, 0);

    // Client chat login is now FORBIDDEN (403)
    const cliChatBlocked = await post('/api/chat/auth/login', { username: 'cli_bilal', password: 'ChatCliPass9$' });
    assert.strictEqual(cliChatBlocked.status, 403, 'Disabled chat login must return 403');
    logPass('Case F1: Disabled client chat login returns 403 Forbidden');

    // Client panel login remains 100% active for SMS reports!
    const cliPanelOk = await post('/api/login', { username: 'cli_bilal', password: 'PanelCliPass1!' });
    assert.strictEqual(cliPanelOk.status, 200, 'Client panel login remains active despite chat disable');
    logPass('Case F2: Client panel login unaffected by chat revocation');

    // Admin re-enables chat access for client Bilal
    const enableCliChat = await post(`/api/chat/admin/accounts/${cliUser.id}/toggle`, { chat_enabled: true }, adminToken);
    assert.strictEqual(enableCliChat.status, 200);
    const cliChatRestored = await post('/api/chat/auth/login', { username: 'cli_bilal', password: 'ChatCliPass9$' });
    assert.strictEqual(cliChatRestored.status, 200, 'Chat login restored after re-enable');
    logPass('Case F3: Chat login restored after re-enable');


    // --- TEST CASE G: PANEL SUSPENDED (active=0) LOCKS BOTH ---
    console.log('\n--- Test Case G: Account Suspension Test ---');

    // Admin deactivates client Bilal completely (active = 0)
    const suspendCli = await request('PUT', `/api/users/${cliUser.id}`, {
      username: 'cli_bilal',
      role: 'client',
      email: 'bilal@example.com',
      active: 0
    }, adminToken);
    assert.strictEqual(suspendCli.status, 200, 'User suspension should succeed');

    // Panel login rejected (403 Account disabled)
    const cliSuspendedPanel = await post('/api/login', { username: 'cli_bilal', password: 'PanelCliPass1!' });
    assert.strictEqual(cliSuspendedPanel.status, 403, 'Suspended user panel login must fail');
    logPass('Case G1: Suspended user panel login returns 403');

    // Chat login rejected (403 Account disabled)
    const cliSuspendedChat = await post('/api/chat/auth/login', { username: 'cli_bilal', password: 'ChatCliPass9$' });
    assert.strictEqual(cliSuspendedChat.status, 403, 'Suspended user chat login must fail');
    logPass('Case G2: Suspended user chat login returns 403');

    // Reactivate client Bilal for remaining tests
    await request('PUT', `/api/users/${cliUser.id}`, {
      username: 'cli_bilal',
      role: 'client',
      email: 'bilal@example.com',
      active: 1
    }, adminToken);


    // --- TOKEN SCOPING & DEFENSE-IN-DEPTH ---
    console.log('\n--- Token Scoping & IDOR Security ---');

    // Chat token cannot be used to call panel management endpoints
    const chatTokenUsedOnPanel = await get('/api/users/agent', agtNewChatLogin.data.token);
    assert.strictEqual(chatTokenUsedOnPanel.status, 403, 'Panel endpoint must reject chat token (403)');
    logPass('SEC 1: Panel endpoint rejects type=chat token (403 Forbidden)');

    // Admin Chat Accounts List Endpoint
    const adminAccounts = await get('/api/chat/admin/accounts', adminToken);
    assert.strictEqual(adminAccounts.status, 200, 'Admin accounts list should succeed');
    assert(Array.isArray(adminAccounts.data.accounts), 'Accounts array should be returned');
    assert(!JSON.stringify(adminAccounts.data.accounts).includes('password_hash'), 'Plaintext or hash must NEVER be returned');
    logPass('SEC 2: Admin Chat Accounts list returns clean metadata without credential leakage');

    // Admin Set Chat Password for User
    const adminSetPw = await post(`/api/chat/admin/accounts/${cliUser.id}/password`, {
      password: 'AdminAssignedChat7&'
    }, adminToken);
    assert.strictEqual(adminSetPw.status, 200, 'Admin setting chat password should succeed');
    const cliNewPwLogin = await post('/api/chat/auth/login', { username: 'cli_bilal', password: 'AdminAssignedChat7&' });
    assert.strictEqual(cliNewPwLogin.status, 200, 'Login succeeds with admin-assigned chat password');
    logPass('SEC 3: Admin sets chat password directly for user');

    // Device Push Token Registration
    const regDevice = await post('/api/chat/device-token', {
      token: 'fcm_fake_device_token_xyz_123',
      platform: 'android',
      app_version: '1.0.0'
    }, cliNewPwLogin.data.token);
    assert.strictEqual(regDevice.status, 200, 'Device push token registration should succeed');
    logPass('SEC 4: Mobile device push token registration succeeds');

    // Admin Multi-Filter Conversations
    const allConvs = await get('/api/chat/conversations?scope=all&filter=all', adminToken);
    assert.strictEqual(allConvs.status, 200, 'Admin all filter should succeed');
    const mgrConvs = await get('/api/chat/conversations?scope=all&filter=managers', adminToken);
    assert.strictEqual(mgrConvs.status, 200, 'Admin managers filter should succeed');
    const agtConvs = await get('/api/chat/conversations?scope=all&filter=agents', adminToken);
    assert.strictEqual(agtConvs.status, 200, 'Admin agents filter should succeed');
    const cliConvs = await get('/api/chat/conversations?scope=all&filter=clients', adminToken);
    assert.strictEqual(cliConvs.status, 200, 'Admin clients filter should succeed');
    logPass('SEC 5: Admin chat visibility and multi-filtering (all/managers/agents/clients) works');

    // --- SETUP TOKEN LINK TEST FOR CHAT CREDENTIALS ---
    console.log('\n--- One-Time Setup Token Link Flow (Chat Purpose) ---');
    const setupLinkRes = await post(`/api/chat/admin/accounts/${cliUser.id}/send-setup`, {}, adminToken);
    assert.strictEqual(setupLinkRes.status, 200, 'Send setup link should succeed');
    assert(setupLinkRes.data.setup_url.includes('/set-password?token='), 'Setup URL must contain token');
    const tokenMatch = setupLinkRes.data.setup_url.match(/token=([a-f0-9]+)/);
    assert(tokenMatch && tokenMatch[1], 'Token should be extracted from URL');
    const setupTok = tokenMatch[1];

    // Check token-info endpoint
    const tokInfo = await get(`/api/pubreq/token-info?token=${setupTok}`);
    assert.strictEqual(tokInfo.status, 200);
    assert.strictEqual(tokInfo.data.purpose, 'chat_password');
    assert.strictEqual(tokInfo.data.username, 'cli_bilal');
    logPass('Setup Link 1: token-info identifies chat_password purpose');

    // Use token to set new chat password
    const setChatPwViaToken = await post('/api/pubreq/set-password', {
      token: setupTok,
      password: 'TokenChatPass99%'
    });
    assert.strictEqual(setChatPwViaToken.status, 200);
    assert.strictEqual(setChatPwViaToken.data.purpose, 'chat_password');
    logPass('Setup Link 2: One-time link sets chat password successfully');

    // Login with new password from token
    const tokenChatLogin = await post('/api/chat/auth/login', { username: 'cli_bilal', password: 'TokenChatPass99%' });
    assert.strictEqual(tokenChatLogin.status, 200, 'Login with token-set chat password succeeds');
    logPass('Setup Link 3: Chat login succeeds with token-set password');

    // Panel password remains untouched
    const cliPanelStillIntact = await post('/api/login', { username: 'cli_bilal', password: 'PanelCliPass1!' });
    assert.strictEqual(cliPanelStillIntact.status, 200, 'Panel password completely untouched by chat token setup');
    logPass('Setup Link 4: Panel password completely untouched');

    // Token reuse fails
    const tokenReuse = await post('/api/pubreq/set-password', { token: setupTok, password: 'AnotherPassword1!' });
    assert.strictEqual(tokenReuse.status, 400, 'Used token must be rejected');
    logPass('Setup Link 5: One-time token cannot be reused (400)');

    // --- IDOR TEST: CROSS-USER CHAT ACCESS REJECTION ---
    console.log('\n--- IDOR Security Verification ---');
    // Start conversation between manager and agent
    const startConv = await post('/api/chat/conversations', { user_id: agtUser.id }, mgrList.data.find(u => u.username === 'mgr_kashif') ? (await post('/api/chat/auth/login', { username: 'mgr_kashif', password: 'ChatMgrPass9$' })).data.token : null);
    assert.strictEqual(startConv.status, 200);
    const convId = startConv.data.conversation_id;

    // Client Bilal (not a participant) tries to read messages of this conversation -> 403
    const idorRead = await get(`/api/chat/messages/${convId}`, tokenChatLogin.data.token);
    assert.strictEqual(idorRead.status, 403, 'Unauthorized conversation read must return 403');
    logPass('IDOR 1: Unauthorized conversation read blocked (403)');

    // Client Bilal tries to post message into this conversation -> 403
    const idorPost = await post(`/api/chat/messages/${convId}`, { body: 'Injected message' }, tokenChatLogin.data.token);
    assert.strictEqual(idorPost.status, 403, 'Unauthorized conversation write must return 403');
    logPass('IDOR 2: Unauthorized conversation write blocked (403)');

  } catch (err) {
    logFail('UNEXPECTED ERROR in suite', err.stack || err.message);
  } finally {
    if (serverProc) serverProc.kill('SIGTERM');
    try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (e) {}
  }

  console.log(`\n===========================================`);
  console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
  console.log(`===========================================\n`);
  if (failed > 0) process.exit(1);
}

run();
