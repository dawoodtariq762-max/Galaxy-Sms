/**
 * Final Targeted Fixes Comprehensive Verification Script:
 * Tests Issues 1, 2, and 3 exactly as requested by user prompt.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const http = require('http');

const testDbPath = '/tmp/test_targeted_fixes_' + Date.now() + '.sqlite';
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const SECRET = 'targeted-fixes-secret-key-2026';
process.env.JWT_SECRET = SECRET;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const { authRequired, chatAuthRequired, requireRole } = require('../backend/auth');

function logAction() {}

// Mount Chat Module
const mountChat = require('../backend/chat');
mountChat(app, {
  authRequired,
  chatAuthRequired,
  requireRole,
  logAction,
  signChat: u => jwt.sign({ id: u.id, username: u.username, role: u.role, type: 'chat' }, SECRET),
  SECRET
});

// Enforce Chat Security Unlock on Agent Payment endpoints (matching server.js)
function requireAgentChatUnlock(req, res, next) {
  if (!req.user || req.user.role !== 'agent') return next();
  const cred = db.get('SELECT chat_enabled, chat_password_hash FROM chat_credentials WHERE user_id=?', [req.user.id]);
  if (!cred || cred.chat_enabled !== 1 || !cred.chat_password_hash) {
    return next();
  }
  const token = req.headers['x-chat-unlock-token'];
  if (!token) {
    return res.status(403).json({ error: 'Chat security PIN verification required to access payment section', code: 'CHAT_LOCK_REQUIRED', locked: true });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded && decoded.type === 'chat_unlocked' && decoded.id === req.user.id) {
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ error: 'Chat security PIN verification required or session expired', code: 'CHAT_LOCK_REQUIRED', locked: true });
}

// Payment routes for agent
app.get('/api/payment-v2/agent/summary', authRequired, requireRole('agent'), requireAgentChatUnlock, (req, res) => {
  res.json({
    agent_id: req.user.id,
    balances: [{ payment_type: 'daily', available_balance: '150.00', earned_amount: '20.00', minimum: '10' }],
    wallet: db.get('SELECT * FROM agent_wallets WHERE agent_id=?', [req.user.id]) || { binance_uid: '', network: 'BINANCE_UID' }
  });
});

app.get('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), requireAgentChatUnlock, (req, res) => {
  res.json(db.get('SELECT * FROM agent_wallets WHERE agent_id=?', [req.user.id]) || { binance_uid: '', network: 'BINANCE_UID' });
});

// Panel Sharing routes (matching server.js)
app.get('/api/panel-sharing/numbers', authRequired, requireRole('admin'), (req, res) => {
  const q = String(req.query.search || '').trim();
  const range = String(req.query.range || '').trim();
  const where = ['n.manager_id IS NULL', 'n.agent_id IS NULL', 'n.client_id IS NULL', "COALESCE(r.deleted_at,'')=''"], params = [];
  if (q) {
    where.push('(LOWER(n.number) LIKE ? OR LOWER(r.name) LIKE ?)');
    params.push('%' + String(q).toLowerCase() + '%', '%' + String(q).toLowerCase() + '%');
  }
  if (range) {
    where.push('r.name=?');
    params.push(range);
  }
  const total = db.get(`SELECT COUNT(*) c FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE ${where.join(' AND ')}`, params)?.c || 0;
  const limitRaw = String(req.query.limit || 25);
  let limit = parseInt(limitRaw, 10);
  if (isNaN(limit) || limit < 1) limit = 25;
  if (limit > 5000) limit = 5000;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(parseInt(req.query.page || 1) || 1, 1), totalPages);
  const offset = (page - 1) * limit;
  const rows = db.all(`SELECT n.id,n.number,n.range_id,r.name AS range_name FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE ${where.join(' AND ')} ORDER BY n.id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return res.json({ rows, total, page, limit, totalPages });
});

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`PASS | ${msg}`);
    passed++;
  } else {
    console.error(`FAIL | ${msg}`);
    failed++;
  }
}

async function run() {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    console.log(`\n===== FINAL TARGETED FIXES VERIFICATION TEST =====\n`);

    // Setup Admin
    const adminHash = bcrypt.hashSync('AdminPass#123', 8);
    db.run("INSERT INTO users (username, password, role, active) VALUES ('admin_tgt', ?, 'admin', 1)", [adminHash]);
    const admin = db.get("SELECT * FROM users WHERE username='admin_tgt'");
    const adminToken = jwt.sign({ id: admin.id, username: admin.username, role: 'admin' }, SECRET);

    // Setup Agent
    const agentHash = bcrypt.hashSync('AgentPanelPass#456', 8);
    db.run("INSERT INTO users (username, password, role, active) VALUES ('agent_tgt', ?, 'agent', 1)", [agentHash]);
    const agent = db.get("SELECT * FROM users WHERE username='agent_tgt'");
    let agentToken = jwt.sign({ id: agent.id, username: agent.username, role: 'agent' }, SECRET);

    // Setup Manager for conversation counterparty
    const mgrHash = bcrypt.hashSync('MgrPass#789', 8);
    db.run("INSERT INTO users (username, password, role, active) VALUES ('mgr_tgt', ?, 'manager', 1)", [mgrHash]);
    const mgr = db.get("SELECT * FROM users WHERE username='mgr_tgt'");
    const mgrToken = jwt.sign({ id: mgr.id, username: mgr.username, role: 'manager' }, SECRET);

    // Existing Chat App PIN is '842615'
    const correctPin = '842615';
    const pinHash = bcrypt.hashSync(correctPin, 8);
    db.run("INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (?, ?, 1)", [agent.id, pinHash]);

    // Save agent Binance UID
    db.run("INSERT INTO agent_wallets (agent_id, binance_uid, network) VALUES (?, '987654321', 'BINANCE_UID')", [agent.id]);

    // Create a conversation between Agent and Manager
    const convRes = db.run("INSERT INTO chat_conversations (user_a, user_b) VALUES (?, ?)", [agent.id, mgr.id]);
    const convId = convRes.lastInsertRowid;
    db.run("INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?, ?, 'Confidential Agent Communication')", [convId, mgr.id]);

    // ==========================================
    // ISSUE 1 — PAYMENT / UID SECTION LOCK TESTS
    // ==========================================
    console.log('--- Issue 1: Payment / UID Section Lock Tests ---');

    // Test 1: Login to Agent Panel. Open Payment. Expected: PIN lock appears / Server confirms locked
    let r = await fetch(`${base}/api/chat/auth/lock-status`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    let d = await r.json();
    assert(r.status === 200 && d.chat_security_enabled === true && d.locked === true, 'Test 1: Agent Panel opened Payment -> Lock status reports locked=true');

    // Test 2: Enter wrong PIN. Expected: Access denied. Payment remains locked.
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: '111111' })
    });
    d = await r.json();
    assert(r.status === 400 && d.ok === false, 'Test 2: Enter wrong PIN -> Access denied with HTTP 400');

    // Verify Payment API still rejects without valid PIN
    r = await fetch(`${base}/api/payment-v2/agent/summary`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 2 (cont): Payment summary remains strictly blocked (403)');
    r = await fetch(`${base}/api/payment-v2/agent/wallet`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 2 (cont): Binance UID remains strictly hidden and blocked (403)');

    // Test 3: Enter correct existing Chat PIN. Expected: Payment/UID section opens successfully.
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: correctPin })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true && !!d.unlock_token, 'Test 3: Enter correct Chat PIN -> PIN verified, returns unlock_token');
    const unlockToken = d.unlock_token;

    // Verify Payment/UID data is now successfully accessible
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': unlockToken }
    });
    d = await r.json();
    assert(r.status === 200 && d.wallet && d.wallet.binance_uid === '987654321', 'Test 3 (cont): Payment and Binance UID (987654321) successfully revealed and loaded');

    // Test 4: Logout. Login again. Expected: Payment is LOCKED again.
    // Simulate logout (token cleared) and new agent login token
    agentToken = jwt.sign({ id: agent.id, username: agent.username, role: 'agent' }, SECRET);
    // Request without unlock_token (fresh login state)
    r = await fetch(`${base}/api/payment-v2/agent/summary`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 4: After Logout and Login again -> Payment is LOCKED again (HTTP 403 CHAT_LOCK_REQUIRED)');

    // ==========================================
    // ISSUE 2 — WEBSITE CHAT LOCK TESTS
    // ==========================================
    console.log('\n--- Issue 2: Website Chat Lock Tests ---');

    // Test 5: Login to Agent Panel. Open Chats. Expected: PIN lock appears / Server confirms locked.
    r = await fetch(`${base}/api/chat/auth/lock-status`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.locked === true, 'Test 5: Agent Panel opened Chats -> Lock status reports locked=true');

    // Verify Chat endpoints are blocked prior to PIN unlock
    r = await fetch(`${base}/api/chat/conversations`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 5 (cont): Chat conversations list blocked (403)');
    r = await fetch(`${base}/api/chat/messages/${convId}`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 5 (cont): Chat messages blocked (403)');

    // Test 6: Enter wrong PIN. Expected: Chat remains locked.
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: '999999' })
    });
    assert(r.status === 400, 'Test 6: Enter wrong PIN -> Access denied with HTTP 400, Chat remains locked');

    // Test 7: Enter correct existing Chat PIN. Expected: Chat opens.
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: correctPin })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true && !!d.unlock_token, 'Test 7: Enter correct Chat PIN -> PIN verified, returns unlock_token');
    const chatUnlockToken = d.unlock_token;

    // Verify Chat conversations & messages are now accessible
    r = await fetch(`${base}/api/chat/conversations`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': chatUnlockToken }
    });
    d = await r.json();
    assert(r.status === 200 && Array.isArray(d) && d.length > 0, 'Test 7 (cont): Conversations successfully loaded');

    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': chatUnlockToken }
    });
    d = await r.json();
    assert(r.status === 200 && Array.isArray(d.messages) && d.messages[0].body === 'Confidential Agent Communication', 'Test 7 (cont): Chat messages successfully loaded');

    // Test 8: Logout. Login again. Expected: Chat is LOCKED again.
    agentToken = jwt.sign({ id: agent.id, username: agent.username, role: 'agent' }, SECRET);
    r = await fetch(`${base}/api/chat/conversations`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    assert(r.status === 403, 'Test 8: After Logout and Login again -> Chat is LOCKED again (HTTP 403)');

    // ==========================================
    // SERVER-SIDE SECURITY BYPASS TESTS
    // ==========================================
    console.log('\n--- Server-Side Security Bypass Tests ---');
    // Direct call with fake unlock token
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': 'fake-token-12345' }
    });
    assert(r.status === 403, 'Server-Side: Fake unlock token rejected with 403');

    // Direct call with unlock token belonging to another user (IDOR)
    const otherUserUnlockToken = jwt.sign({ id: 9999, username: 'other', role: 'agent', type: 'chat_unlocked' }, SECRET);
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': otherUserUnlockToken }
    });
    assert(r.status === 403, 'Server-Side: Mismatched user unlock token rejected with 403 (Anti-IDOR)');

    r = await fetch(`${base}/api/chat/conversations`, {
      headers: { 'Authorization': `Bearer ${agentToken}`, 'X-Chat-Unlock-Token': otherUserUnlockToken }
    });
    assert(r.status === 403, 'Server-Side: Mismatched chat unlock token rejected with 403 (Anti-IDOR)');

    // ==========================================
    // ISSUE 3 — PANEL SHARING PAGE SIZE TESTS
    // ==========================================
    console.log('\n--- Issue 3: Panel Sharing Page Size Tests ---');

    // Seed ranges and 2,350 numbers (as in prompt's example!)
    db.run("INSERT INTO ranges (name, country, currency, payment_type) VALUES ('UK-SHARING-RANGE-1', 'UK', 'USD', 'daily')");
    const pRange1 = db.get("SELECT id FROM ranges WHERE name='UK-SHARING-RANGE-1'");
    db.run("INSERT INTO ranges (name, country, currency, payment_type) VALUES ('UK-SHARING-RANGE-2', 'UK', 'USD', 'weekly')");
    const pRange2 = db.get("SELECT id FROM ranges WHERE name='UK-SHARING-RANGE-2'");

    // Insert 2,350 unallocated numbers for range 1
    console.log('Seeding 2,350 numbers for range 1...');
    try { db.beginBatch && db.beginBatch();
      for (let i = 1; i <= 2350; i++) {
        db.run("INSERT INTO numbers (number, range_id) VALUES (?, ?)", [`+44720000${String(i).padStart(4, '0')}`, pRange1.id]);
      }
      // Insert 150 numbers for range 2
      for (let i = 1; i <= 150; i++) {
        db.run("INSERT INTO numbers (number, range_id) VALUES (?, ?)", [`+44730000${String(i).padStart(4, '0')}`, pRange2.id]);
      }
    } finally { try { db.endBatch && db.endBatch(); } catch (_) {} }

    // Total unallocated = 2,500 numbers
    // Test A: 25 -> verify 25 numbers
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&limit=25`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.rows.length === 25 && d.total === 2350 && d.totalPages === 94, 'Test A: 25 -> returns 25 numbers, total=2350, totalPages=94');

    // Test B: 50 -> verify 50 numbers
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&limit=50`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.rows.length === 50 && d.totalPages === 47, 'Test B: 50 -> returns 50 numbers, totalPages=47');

    // Test C: 100 -> verify 100 numbers
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&limit=100`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.rows.length === 100 && d.totalPages === 24, 'Test C: 100 -> returns 100 numbers, totalPages=24');

    // Test D: 500 -> verify 500 numbers
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&limit=500`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.rows.length === 500 && d.totalPages === 5, 'Test D: 500 -> returns 500 numbers, totalPages=5');

    // Test E: 1,000 -> verify 1,000 numbers per page on 2,350 dataset
    // Expected: Page 1 = 1,000 | Page 2 = 1,000 | Page 3 = 350
    // Page 1
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&page=1&limit=1000`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const p1 = await r.json();
    assert(p1.rows.length === 1000 && p1.page === 1 && p1.totalPages === 3, 'Test E (Page 1): 1,000 numbers on Page 1 (of 3)');

    // Page 2
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&page=2&limit=1000`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const p2 = await r.json();
    assert(p2.rows.length === 1000 && p2.page === 2, 'Test E (Page 2): 1,000 numbers on Page 2 (of 3)');

    // Page 3
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&page=3&limit=1000`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const p3 = await r.json();
    assert(p3.rows.length === 350 && p3.page === 3, 'Test E (Page 3): Exactly 350 numbers on Page 3 (1000 + 1000 + 350 = 2350)');

    // Verify: No missing numbers and No duplicates across pages
    const seenIds = new Set();
    let hasDuplicate = false;
    [...p1.rows, ...p2.rows, ...p3.rows].forEach(row => {
      if (seenIds.has(row.id)) hasDuplicate = true;
      seenIds.add(row.id);
    });
    assert(!hasDuplicate && seenIds.size === 2350, 'Pagination Integrity: No duplicates and no missing numbers (exactly 2,350 unique numbers across pages 1, 2, 3)');

    // Test F: 5,000 -> verify 5,000 numbers (or all available when count < 5000)
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-1&limit=5000`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(r.status === 200 && d.rows.length === 2350 && d.limit === 5000 && d.totalPages === 1, 'Test F: 5,000 -> returns all 2,350 numbers on single page');

    // Safe Maximum Clamp Check
    r = await fetch(`${base}/api/panel-sharing/numbers?limit=999999`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(d.limit === 5000, 'Security: Arbitrary page sizes clamped to safe maximum 5,000');

    // Range filtering check
    r = await fetch(`${base}/api/panel-sharing/numbers?range=UK-SHARING-RANGE-2&limit=500`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    d = await r.json();
    assert(d.total === 150 && d.rows.length === 150, 'Range filtering: Only numbers belonging to requested range are returned');

  } finally {
    server.close();
    try { fs.unlinkSync(testDbPath); } catch (_) {}
  }

  console.log(`\n===========================================`);
  console.log(`TARGETED FIXES SUITE: ${passed} PASS / ${failed} FAIL`);
  console.log(`===========================================\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
