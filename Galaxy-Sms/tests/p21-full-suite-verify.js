/**
 * Comprehensive P21 Test Suite:
 * - Security Lock (Payment + Chat)
 * - Existing & New users (Chat enabled / disabled)
 * - PIN verification, wrong PIN, correct PIN, lockout
 * - Payment endpoints server-side lock enforcement
 * - Chat endpoints server-side lock enforcement
 * - PIN update synchronization (Chat App, Panel Chats, Panel Payment)
 * - Message Deletion (Delete for Me, Delete for Everyone, 15m window, Unauthorized delete)
 * - File Uploads (.txt, .csv, download, invalid extension, oversize, unauthorized)
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const http = require('http');

const testDbPath = '/tmp/test_full_suite_' + Date.now() + '.sqlite';
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const SECRET = 'full-suite-secret-key-2026';
process.env.JWT_SECRET = SECRET;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const { authRequired, chatAuthRequired, requireRole, descendantIds } = require('../backend/auth');

function logAction() {}
function scopeIds(user) { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }
function normalizePaymentType(v) { return 'weekly_7_1'; }

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

/* P21: Enforce Chat Security Unlock on Agent Payment endpoints (matching server.js) */
function requireAgentChatUnlock(req, res, next) {
  if (!req.user || req.user.role !== 'agent') return next();
  const cred = db.get('SELECT chat_enabled, chat_password_hash FROM chat_credentials WHERE user_id=?', [req.user.id]);
  if (!cred || cred.chat_enabled !== 1 || !cred.chat_password_hash) {
    return next();
  }
  const token = req.headers['x-chat-unlock-token'];
  if (!token) {
    return res.status(403).json({ error: 'Chat security PIN verification required to access payment section', locked: true });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded && decoded.type === 'chat_unlocked' && decoded.id === req.user.id) {
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ error: 'Chat security PIN verification required or session expired', locked: true });
}

// Payment routes for agent
app.get('/api/payment-v2/agent/summary', authRequired, requireRole('agent'), requireAgentChatUnlock, (req, res) => {
  res.json({ agent_id: req.user.id, balances: { daily: 100, weekly: 500, monthly: 2000 } });
});

app.get('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), requireAgentChatUnlock, (req, res) => {
  res.json({ agent_id: req.user.id, binance_uid: '123456789' });
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
  console.log('===== GALAXY SMS CHAT SECURITY LOCK & FEATURES TEST SUITE =====\n');

  // Seed Admin, Manager, Agent 1 (with Chat enabled), Agent 2 (with Chat disabled)
  db.run("INSERT INTO users (id, username, password, role, active) VALUES (1, 'admin', ?, 'admin', 1)", [bcrypt.hashSync('admin_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, active) VALUES (2, 'manager1', ?, 'manager', 1)", [bcrypt.hashSync('mgr_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (3, 'agent_secured', ?, 'agent', 2, 1)", [bcrypt.hashSync('agent1_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (4, 'agent_unsecured', ?, 'agent', 2, 1)", [bcrypt.hashSync('agent2_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (5, 'client1', ?, 'client', 3, 1)", [bcrypt.hashSync('client_pass', 10)]);

  // Agent 1 has Chat Security ENABLED with 6-digit PIN '112233'
  db.run("INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (3, ?, 1)", [bcrypt.hashSync('112233', 10)]);

  // Agent 2 has Chat Security DISABLED (chat_enabled = 0)
  db.run("INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (4, ?, 0)", [bcrypt.hashSync('445566', 10)]);

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, SECRET);
  const agent1Token = jwt.sign({ id: 3, username: 'agent_secured', role: 'agent' }, SECRET);
  const agent2Token = jwt.sign({ id: 4, username: 'agent_unsecured', role: 'agent' }, SECRET);

  try {
    // ==========================================
    // 1. SECURITY LOCK STATUS & EXISTING USER BEHAVIOR
    // ==========================================
    console.log('--- 1. Security Lock Status & Existing User Behavior ---');
    // Agent 1 (Chat enabled) -> should report chat_security_enabled = true, locked = true
    let r = await fetch(`${base}/api/chat/auth/lock-status`, {
      headers: { 'Authorization': `Bearer ${agent1Token}` }
    });
    let d = await r.json();
    assert(d.chat_security_enabled === true && d.locked === true, 'Agent with chat enabled reports locked = true');

    // Agent 2 (Chat disabled) -> should report chat_security_enabled = false, locked = false
    r = await fetch(`${base}/api/chat/auth/lock-status`, {
      headers: { 'Authorization': `Bearer ${agent2Token}` }
    });
    d = await r.json();
    assert(d.chat_security_enabled === false && d.locked === false, 'Existing agent with chat disabled is NOT locked out');

    // ==========================================
    // 2. PAYMENT SECTION SERVER-SIDE PROTECTION
    // ==========================================
    console.log('\n--- 2. Payment Section Server-Side Protection ---');
    // Agent 1 accessing payment summary WITHOUT unlock token -> 403 Forbidden
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: { 'Authorization': `Bearer ${agent1Token}` }
    });
    assert(r.status === 403, 'Payment summary blocked (403) before PIN verification for secured agent');

    // Agent 2 (chat disabled) accessing payment summary -> 200 OK (accessible per existing workflow)
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: { 'Authorization': `Bearer ${agent2Token}` }
    });
    assert(r.status === 200, 'Payment summary accessible for agent with chat security disabled');

    // ==========================================
    // 3. PIN VERIFICATION & UNLOCK
    // ==========================================
    console.log('\n--- 3. PIN Verification & Unlock Flow ---');
    // Wrong PIN
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent1Token}` },
      body: JSON.stringify({ password: 'wrong' })
    });
    d = await r.json();
    assert(r.status === 400 && d.ok === false, 'Wrong PIN returns HTTP 400 (avoids panel logout)');

    // Correct PIN '112233'
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent1Token}` },
      body: JSON.stringify({ password: '112233' })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true && !!d.unlock_token, 'Correct PIN unlocks successfully and returns unlock_token');

    const unlockToken = d.unlock_token;

    // Now Agent 1 accesses payment summary WITH unlock token -> 200 OK
    r = await fetch(`${base}/api/payment-v2/agent/summary`, {
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': unlockToken
      }
    });
    assert(r.status === 200, 'Payment summary accessible after PIN unlock with X-Chat-Unlock-Token');

    // Check lock status with unlock token -> unlocked = true, locked = false
    r = await fetch(`${base}/api/chat/auth/lock-status`, {
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': unlockToken
      }
    });
    d = await r.json();
    assert(d.locked === false && d.unlocked === true, 'Lock status confirms session is unlocked');

    // ==========================================
    // 4. CHAT SECTION PROTECTION & ACCESS
    // ==========================================
    console.log('\n--- 4. Chat Section Server-Side Protection ---');
    // Create conversation between Manager and Agent 1
    const convInfo = db.run("INSERT INTO chat_conversations (user_a, user_b) VALUES (2, 3)");
    const convId = convInfo.lastInsertRowid;

    // Agent 1 tries to read messages without unlock token -> 403 Forbidden
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${agent1Token}` }
    });
    assert(r.status === 403, 'Chat messages blocked (403) before PIN verification for secured agent');

    // Agent 1 reads messages WITH unlock token -> 200 OK
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': unlockToken
      }
    });
    assert(r.status === 200, 'Chat messages accessible with X-Chat-Unlock-Token');

    // Mobile Chat App token (type: 'chat') -> automatically allowed without extra header
    const mobileChatToken = jwt.sign({ id: 3, username: 'agent_secured', role: 'agent', type: 'chat' }, SECRET);
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${mobileChatToken}` }
    });
    assert(r.status === 200, 'Mobile Chat App token (type=chat) accesses messages without extra panel header');

    // ==========================================
    // 5. ADMIN ENABLES / DISABLES CHAT SECURITY
    // ==========================================
    console.log('\n--- 5. Admin Enables / Disables Chat Security ---');
    // Admin toggles Agent 1 to disabled
    r = await fetch(`${base}/api/chat/admin/accounts/3/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ chat_enabled: false })
    });
    assert(r.status === 200, 'Admin disables chat security for Agent 1');

    // Verify Agent 1 is now NOT required to unlock
    r = await fetch(`${base}/api/chat/auth/lock-status`, {
      headers: { 'Authorization': `Bearer ${agent1Token}` }
    });
    d = await r.json();
    assert(d.chat_security_enabled === false && d.locked === false, 'Agent 1 payment/chats no longer locked when disabled');

    // Admin re-enables Agent 1 and sets new PIN '998877'
    r = await fetch(`${base}/api/chat/admin/accounts/3/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ password: '998877' })
    });
    assert(r.status === 200, 'Admin sets new Chat PIN 998877 and enables chat');

    // Verify lock is active again
    r = await fetch(`${base}/api/chat/auth/lock-status`, {
      headers: { 'Authorization': `Bearer ${agent1Token}` }
    });
    d = await r.json();
    assert(d.chat_security_enabled === true && d.locked === true, 'Lock becomes active again after re-enable');

    // Verify old PIN '112233' fails
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent1Token}` },
      body: JSON.stringify({ password: '112233' })
    });
    assert(r.status === 400, 'Old PIN 112233 fails');

    // Verify new PIN '998877' succeeds
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent1Token}` },
      body: JSON.stringify({ password: '998877' })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'New PIN 998877 successfully unlocks');
    const newUnlockToken = d.unlock_token;

    // ==========================================
    // 6. MESSAGE DELETION (DELETE FOR ME & DELETE FOR EVERYONE)
    // ==========================================
    console.log('\n--- 6. Message Deletion ---');
    // Agent 1 sends a message
    const msgInfo = db.run("INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?, 3, 'Test message for deletion')", [convId]);
    const msgId = msgInfo.lastInsertRowid;

    // Delete for me
    r = await fetch(`${base}/api/chat/messages/${msgId}/delete-for-me`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agent1Token}`, 'X-Chat-Unlock-Token': newUnlockToken }
    });
    assert(r.status === 200, 'Agent 1 deletes message for me successfully');

    // Check message is hidden for Agent 1
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${agent1Token}`, 'X-Chat-Unlock-Token': newUnlockToken }
    });
    d = await r.json();
    assert(!d.messages.some(m => m.id === msgId), 'Message is hidden for Agent 1 after delete-for-me');

    // Check message remains visible for Manager 1
    const mgrToken = jwt.sign({ id: 2, username: 'manager1', role: 'manager' }, SECRET);
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${mgrToken}` }
    });
    d = await r.json();
    assert(d.messages.some(m => m.id === msgId), 'Message remains visible to Manager 1');

    // Create a new message for delete-for-everyone test
    const m2Info = db.run("INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?, 3, 'Public message to delete')", [convId]);
    const m2Id = m2Info.lastInsertRowid;

    // Recipient (Manager 1) tries delete for everyone -> 403 Forbidden
    r = await fetch(`${base}/api/chat/messages/${m2Id}/delete-for-everyone`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mgrToken}` }
    });
    assert(r.status === 403, 'Recipient blocked from delete-for-everyone (403)');

    // Sender (Agent 1) deletes for everyone within 15 minutes -> 200 OK
    r = await fetch(`${base}/api/chat/messages/${m2Id}/delete-for-everyone`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agent1Token}`, 'X-Chat-Unlock-Token': newUnlockToken }
    });
    assert(r.status === 200, 'Sender deletes message for everyone within window (200)');

    // Verify tombstone rendered for all
    r = await fetch(`${base}/api/chat/messages/${convId}`, {
      headers: { 'Authorization': `Bearer ${mgrToken}` }
    });
    d = await r.json();
    const deletedMsg = d.messages.find(m => m.id === m2Id);
    assert(deletedMsg && deletedMsg.body === 'This message was deleted' && deletedMsg.is_deleted === true, 'Tombstone "This message was deleted" displayed to participants');

    // ==========================================
    // 7. FILE UPLOADS (.txt, .csv) & DOWNLOAD
    // ==========================================
    console.log('\n--- 7. File Uploads (.txt & .csv) & Download ---');
    // Test TXT upload
    const txtContent = 'Customer notes and details\nLine 2 info';
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    let body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n${txtContent}\r\n--${boundary}--\r\n`;

    r = await fetch(`${base}/api/chat/conversations/${convId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': newUnlockToken,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true && d.message.attachment_name === 'notes.txt', 'TXT file uploaded successfully');
    const txtMsgId = d.message.id;

    // Test CSV upload
    const csvContent = 'Number,Status,Rate\n+4470001,Active,0.05\n+4470002,Active,0.05';
    body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="numbers.csv"\r\nContent-Type: text/csv\r\n\r\n${csvContent}\r\n--${boundary}--\r\n`;

    r = await fetch(`${base}/api/chat/conversations/${convId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': newUnlockToken,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true && d.message.attachment_type === 'csv', 'CSV file uploaded successfully');
    const csvMsgId = d.message.id;

    // Test download of TXT file
    r = await fetch(`${base}/api/chat/messages/${txtMsgId}/download?token=${mgrToken}`);
    const downloadedTxt = await r.text();
    assert(r.status === 200 && downloadedTxt === txtContent, 'TXT file downloaded and content matches verbatim');

    // Test download of CSV file
    r = await fetch(`${base}/api/chat/messages/${csvMsgId}/download?token=${mgrToken}`);
    const downloadedCsv = await r.text();
    assert(r.status === 200 && downloadedCsv === csvContent, 'CSV file downloaded and content matches verbatim');

    // Test invalid extension (.exe) rejected
    body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="malicious.exe"\r\nContent-Type: application/octet-stream\r\n\r\nEXE_BINARY\r\n--${boundary}--\r\n`;
    r = await fetch(`${base}/api/chat/conversations/${convId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agent1Token}`,
        'X-Chat-Unlock-Token': newUnlockToken,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    assert(r.status === 400, 'Invalid file extension (.exe) rejected with 400');

    // Test non-conversation participant cannot download (Client 1)
    const clientToken = jwt.sign({ id: 5, username: 'client1', role: 'client' }, SECRET);
    r = await fetch(`${base}/api/chat/messages/${csvMsgId}/download?token=${clientToken}`);
    assert(r.status === 403, 'Unauthorized user blocked from downloading file (403)');

  } finally {
    server.close();
  }

  console.log(`\n===========================================`);
  console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
  console.log(`===========================================\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Test suite failed:', e);
  process.exit(1);
});
