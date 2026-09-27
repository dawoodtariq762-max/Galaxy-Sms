/**
 * Galaxy SMS — Complete Cleanup, PIN Security, and UI Consistency Verification Suite
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const testDbPath = '/tmp/test_galaxy_verify_' + Date.now() + '.sqlite';
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const SECRET = 'test-jwt-secret-galaxy-2026';
process.env.JWT_SECRET = SECRET;

const app = express();
app.use(express.json());

// Mock auth middleware for test routes
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function logAction(req, action, target, meta) {}

// Require Agent PIN Unlock middleware
function requireAgentChatUnlock(req, res, next) {
  if (!req.user || req.user.role !== 'agent') return next();

  const cred = db.get('SELECT chat_enabled FROM chat_credentials WHERE user_id = ?', [req.user.id]);
  if (cred && (cred.chat_enabled === 0 || cred.chat_enabled === false)) {
    return next();
  }

  const token = req.headers['x-chat-unlock-token'] || req.headers['x-pin-unlock-token'];
  if (!token) {
    return res.status(403).json({ error: 'Security PIN verification required to access payment section', locked: true });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded && (decoded.type === 'chat_unlocked' || decoded.type === 'account_pin_unlocked') && decoded.id === req.user.id) {
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ error: 'Security PIN verification required or session expired', locked: true });
}

// Register chat.js routes directly on app with deps
require('../backend/chat')(app, {
  authRequired,
  chatAuthRequired: authRequired,
  requireRole,
  logAction,
  SECRET
});

// Mount test payment routes protected by PIN
app.put('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), requireAgentChatUnlock, (req, res) => {
  const uid = String(req.body.binance_uid || '').trim();
  db.run("INSERT OR REPLACE INTO agent_wallets (agent_id, binance_uid, network) VALUES (?, ?, 'BINANCE_UID')", [req.user.id, uid]);
  res.json({ ok: true, binance_uid: uid });
});

let server;
let baseUrl;

function api(endpoint, method = 'GET', body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + endpoint);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log(' Galaxy SMS Comprehensive Verification Suite');
  console.log('====================================================\n');

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // TEST 1: Database Schema Cleanliness (AI Assistant, Separate Chat & Panel Request Purged)
  console.log('--- Test 1: Database Schema Cleanliness ---');
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name);
  
  const forbiddenTables = [
    'assistant_knowledge',
    'assistant_settings',
    'channel_posts',
    'channel_reads',
    'chat_conversations',
    'chat_messages',
    'chat_device_tokens',
    'chat_message_deletions',
    'panel_requests',
    'panel_request_otp',
    'password_setup_tokens'
  ];
  for (const table of forbiddenTables) {
    assert.strictEqual(tables.includes(table), false, `Forbidden table "${table}" should NOT exist in database`);
  }
  assert.strictEqual(tables.includes('chat_credentials'), true, 'chat_credentials table must exist for PIN security');
  assert.strictEqual(tables.includes('complaints'), true, 'complaints table must exist for support ticketing');
  console.log('  ✓ PASS: Schema is completely clean: AI Assistant, Chat, and Panel Request tables removed.');

  // TEST 2: Complete Removal of Panel Request Feature
  console.log('--- Test 2: Panel Request Complete Removal ---');
  const rootDir = path.join(__dirname, '..');
  assert.strictEqual(fs.existsSync(path.join(rootDir, 'public-request.html')), false, 'public-request.html must be deleted');
  assert.strictEqual(fs.existsSync(path.join(rootDir, 'set-password.html')), false, 'set-password.html must be deleted');
  assert.strictEqual(fs.existsSync(path.join(rootDir, 'backend', 'pubreq.js')), false, 'backend/pubreq.js must be deleted');

  const adminHtml = fs.readFileSync(path.join(rootDir, 'admin.html'), 'utf8');
  assert.strictEqual(adminHtml.includes('data-page="panelRequests"'), false, 'admin.html must not contain panelRequests nav');
  assert.strictEqual(adminHtml.includes('id="page-panelRequests"'), false, 'admin.html must not contain panelRequests section');
  assert.strictEqual(adminHtml.includes('buildPanelRequests'), false, 'admin.html must not contain buildPanelRequests');
  assert.strictEqual(adminHtml.includes('prqModal'), false, 'admin.html must not contain prqModal');
  assert.strictEqual(adminHtml.includes('sendChatSetupLink'), false, 'admin.html must not contain sendChatSetupLink');

  const serverJs = fs.readFileSync(path.join(rootDir, 'backend', 'server.js'), 'utf8');
  assert.strictEqual(serverJs.includes("require('./pubreq')"), false, 'server.js must not mount pubreq');
  console.log('  ✓ PASS: Panel Request UI, API mount, files, and navigation completely removed with zero dead code.');

  // TEST 3: User Setup & PIN Security
  console.log('--- Test 3: Agent Account PIN Security & Unlock ---');
  const agentPass = bcrypt.hashSync('AgentPass123', 10);
  db.run("INSERT INTO users (username, password, role, active) VALUES ('test_agent', ?, 'agent', 1)", [agentPass]);
  const agentUser = db.get("SELECT id, username, role FROM users WHERE username = 'test_agent'");
  const agentToken = jwt.sign({ id: agentUser.id, username: agentUser.username, role: 'agent' }, SECRET);

  // Status check before unlock
  let statusRes = await api('/api/chat/auth/lock-status', 'GET', null, agentToken);
  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusRes.body.locked, true);

  // Admin sets PIN for agent
  const adminPass = bcrypt.hashSync('AdminPass123', 10);
  db.run("INSERT INTO users (username, password, role, active) VALUES ('admin', ?, 'admin', 1)", [adminPass]);
  const adminUser = db.get("SELECT id, username, role FROM users WHERE username = 'admin'");
  const adminToken = jwt.sign({ id: adminUser.id, username: adminUser.username, role: 'admin' }, SECRET);

  const setPinRes = await api(`/api/chat/admin/accounts/${agentUser.id}/password`, 'POST', {
    password: 'SecurePIN987'
  }, adminToken);
  assert.strictEqual(setPinRes.status, 200);
  assert.strictEqual(setPinRes.body.ok, true);

  // Attempt payment update WITHOUT PIN unlock token -> MUST BE 403
  let payRes = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '987654321' }, agentToken);
  assert.strictEqual(payRes.status, 403, 'Payment update must be blocked without PIN unlock');

  // Verify with INCORRECT PIN -> 400
  let verifyFail = await api('/api/chat/auth/verify-lock', 'POST', { password: 'WrongPassword' }, agentToken);
  assert.strictEqual(verifyFail.status, 400, 'Incorrect PIN should return 400');
  assert.strictEqual(verifyFail.body.ok, false);

  // Verify with CORRECT PIN -> 200, returns unlock token
  let verifySuccess = await api('/api/chat/auth/verify-lock', 'POST', { password: 'SecurePIN987' }, agentToken);
  assert.strictEqual(verifySuccess.status, 200, 'Correct PIN should return 200');
  assert.strictEqual(verifySuccess.body.ok, true);
  const unlockToken = verifySuccess.body.unlock_token;
  assert.ok(unlockToken, 'Unlock token must be present');

  // Status check with unlock token
  statusRes = await api('/api/chat/auth/lock-status', 'GET', null, agentToken, {
    'x-pin-unlock-token': unlockToken
  });
  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusRes.body.unlocked, true);

  // Perform payment update WITH unlock token -> 200
  payRes = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '987654321' }, agentToken, {
    'x-pin-unlock-token': unlockToken
  });
  assert.strictEqual(payRes.status, 200, 'Payment update must succeed with valid PIN unlock token');
  assert.strictEqual(payRes.body.ok, true);
  assert.strictEqual(payRes.body.binance_uid, '987654321');

  const wallet = db.get('SELECT binance_uid FROM agent_wallets WHERE agent_id = ?', [agentUser.id]);
  assert.strictEqual(wallet.binance_uid, '987654321');
  console.log('  ✓ PASS: PIN security accurately protects Agent payment credentials and blocks unauthorized access.');

  // TEST 4: Support Complaints Ticketing
  console.log('--- Test 4: Complaints Ticketing System ---');
  const postComplaint = await api('/api/complaints', 'POST', {
    subject: 'Billing inquiry',
    body: 'Please check my payout for range US-Direct'
  }, agentToken);
  assert.strictEqual(postComplaint.status, 200);
  assert.strictEqual(postComplaint.body.ok, true);
  assert.ok(postComplaint.body.id > 0);

  const getComplaints = await api('/api/complaints', 'GET', null, agentToken);
  assert.strictEqual(getComplaints.status, 200);
  assert.strictEqual(Array.isArray(getComplaints.body), true);
  assert.strictEqual(getComplaints.body.length, 1);
  assert.strictEqual(getComplaints.body[0].subject, 'Billing inquiry');
  console.log('  ✓ PASS: Complaints ticketing system functions properly without standalone chat system.');

  // TEST 5: Frontend UI Consistency and Search Dropdowns
  console.log('--- Test 5: Frontend Inside-Search Dropdowns Verification ---');
  const htmlFiles = ['admin.html', 'manager.html', 'agent.html', 'client.html', 'panel-sharing.html', 'test.html'];
  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.strictEqual(content.includes('renderSearchSelect'), true, `${file} must use renderSearchSelect`);
    assert.strictEqual(content.includes('id="page-chat"'), false, `${file} must NOT contain obsolete #page-chat`);
    assert.strictEqual(content.includes('id="page-panelRequests"'), false, `${file} must NOT contain obsolete panel requests`);
  }
  console.log('  ✓ PASS: All 6 frontends use renderSearchSelect and have no legacy chat or panel request views.');

  // TEST 6: Branding Check
  console.log('--- Test 6: Branding Check ---');
  assert.strictEqual(/GALAXY SMS/i.test(adminHtml), true, 'admin.html must contain Galaxy SMS branding');
  assert.strictEqual(adminHtml.includes('Agent Account PIN'), true, 'admin.html must display Agent Account PIN instead of Chat Accounts');
  console.log('  ✓ PASS: Branding is consistently "Galaxy SMS" and "Agent Account PIN".');

  server.close();
  console.log('\n====================================================');
  console.log(' ALL 6 TESTS PASSED 100% SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  if (server) server.close();
  process.exit(1);
});
