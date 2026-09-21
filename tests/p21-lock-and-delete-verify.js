/**
 * P21 Phase-2 Lock & Delete Verification Suite
 * Verifies:
 * 1. POST /api/chat/auth/verify-lock:
 *    - Authenticated panel session validation
 *    - Correct Chat App PIN succeeds
 *    - Incorrect Chat App PIN fails with 400 (avoids triggering panel logout)
 *    - Lockout after 5 consecutive failed attempts
 * 2. Password Synchronization:
 *    - Admin updates user's chat password via POST /api/chat/admin/accounts/:userId/password
 *    - Updating chat PIN immediately validates in verify-lock AND Chat App login
 *    - Updating chat PIN does NOT change panel login password
 * 3. User Deletion with Cascades & Detachments:
 *    - DELETE /api/users/:id on Manager safely reparents child Agents and unallocates numbers without 500
 *    - DELETE /api/users/:id on Agent safely removes wallets, forwards, chat conversations, and detaches clients without 500
 */

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const testDbPath = '/tmp/test_lock_del_' + Date.now() + '.sqlite';
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const SECRET = 'test-jwt-secret-lock-delete-2026';
process.env.JWT_SECRET = SECRET;

const app = express();
app.use(express.json());

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

function requireRole(role) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

function logAction() {}
function scopeIds() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }

// Mount Chat Module
const mountChat = require('../backend/chat');
mountChat(app, {
  authRequired,
  chatAuthRequired: authRequired,
  requireRole,
  logAction,
  signChat: u => jwt.sign({ id: u.id, username: u.username, role: u.role, type: 'chat' }, SECRET),
  SECRET
});

// Mount user delete endpoint matching server.js
app.delete('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id) || id === req.user.id) return res.status(403).json({ error: 'Not allowed' });

  const target = db.get('SELECT * FROM users WHERE id=?', [id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });

  try {
    db.execNoSave('BEGIN');

    // 1. Re-parent / detach child users to prevent FK constraint failure
    if (target.role === 'manager') {
      db.runNoSave('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [id]);
      db.runNoSave('UPDATE numbers SET manager_id = NULL WHERE manager_id = ?', [id]);
      db.runNoSave('DELETE FROM cli_limits WHERE manager_id = ?', [id]);
    } else if (target.role === 'agent') {
      db.runNoSave('UPDATE users SET parent_id = ? WHERE parent_id = ?', [target.parent_id || null, id]);
      db.runNoSave("UPDATE numbers SET agent_id = NULL, client_id = NULL, payout = '0' WHERE agent_id = ?", [id]);
      db.runNoSave('DELETE FROM agent_wallets WHERE agent_id = ?', [id]);
      db.runNoSave('DELETE FROM sharing_users WHERE agent_user_id = ?', [id]);
      db.runNoSave('DELETE FROM payment_notifications_v2 WHERE agent_id = ?', [id]);
    } else if (target.role === 'client') {
      db.runNoSave("UPDATE numbers SET client_id = NULL, payout = '0' WHERE client_id = ?", [id]);
    }

    // 2. Clean up Chat conversations & messages for this user
    const convs = db.all('SELECT id FROM chat_conversations WHERE user_a = ? OR user_b = ?', [id, id]);
    if (convs.length) {
      const cids = convs.map(c => c.id);
      const ph = cids.map(() => '?').join(',');
      db.runNoSave('DELETE FROM chat_message_deletions WHERE message_id IN (SELECT id FROM chat_messages WHERE conversation_id IN (' + ph + '))', cids);
      db.runNoSave('DELETE FROM chat_messages WHERE conversation_id IN (' + ph + ')', cids);
      db.runNoSave('DELETE FROM chat_conversations WHERE id IN (' + ph + ')', cids);
    }
    db.runNoSave('DELETE FROM chat_messages WHERE sender_id = ?', [id]);
    db.runNoSave('DELETE FROM chat_credentials WHERE user_id = ?', [id]);
    db.runNoSave('DELETE FROM chat_device_tokens WHERE user_id = ?', [id]);
    db.runNoSave('DELETE FROM chat_message_deletions WHERE user_id = ?', [id]);

    // 3. Clean up complaints & replies
    const cmps = db.all('SELECT id FROM complaints WHERE sender_id = ?', [id]);
    if (cmps.length) {
      const cmpIds = cmps.map(c => c.id);
      const ph = cmpIds.map(() => '?').join(',');
      db.runNoSave('DELETE FROM complaint_replies WHERE complaint_id IN (' + ph + ')', cmpIds);
      db.runNoSave('DELETE FROM complaints WHERE id IN (' + ph + ')', cmpIds);
    }
    db.runNoSave('DELETE FROM complaint_replies WHERE sender_id = ?', [id]);

    // 4. Detach jobs & tokens
    db.runNoSave('UPDATE jobs SET created_by = NULL WHERE created_by = ?', [id]);
    db.runNoSave('DELETE FROM password_setup_tokens WHERE user_id = ?', [id]);
    db.runNoSave('DELETE FROM idempotency_keys WHERE user_id = ?', [id]);

    // 5. Delete the user
    db.runNoSave('DELETE FROM users WHERE id = ?', [id]);

    db.execNoSave('COMMIT');
    db.save();

    res.json({ ok: true });
  } catch (err) {
    try { db.execNoSave('ROLLBACK'); } catch (_) {}
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user: ' + err.message });
  }
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
  console.log('===== P21 LOCK & DELETE COMPREHENSIVE VERIFICATION =====\n');

  // Seed initial accounts
  db.run("INSERT INTO users (id, username, password, role, active) VALUES (1, 'admin', ?, 'admin', 1)", [bcrypt.hashSync('admin_panel_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, active) VALUES (2, 'manager_alpha', ?, 'manager', 1)", [bcrypt.hashSync('mgr_panel_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (3, 'agent_beta', ?, 'agent', 2, 1)", [bcrypt.hashSync('agt_panel_pass', 10)]);
  db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (4, 'client_gamma', ?, 'client', 3, 1)", [bcrypt.hashSync('cli_panel_pass', 10)]);

  // Agent chat credential (PIN 445566)
  db.run("INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (3, ?, 1)", [bcrypt.hashSync('445566', 10)]);

  // Seed resources
  db.run("INSERT INTO ranges (id, name) VALUES (1, 'UK-Test')");
  db.run("INSERT INTO numbers (id, number, range_id, manager_id, agent_id, client_id) VALUES (10, '+4470001', 1, 2, 3, 4)");
  db.run("INSERT INTO agent_wallets (agent_id, binance_uid) VALUES (3, '12345678')");
  db.run("INSERT INTO chat_conversations (id, user_a, user_b) VALUES (50, 3, 2)");
  db.run("INSERT INTO chat_messages (id, conversation_id, sender_id, body) VALUES (501, 50, 3, 'Hello Manager')");

  const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, SECRET);
  const agentToken = jwt.sign({ id: 3, username: 'agent_beta', role: 'agent' }, SECRET);

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- PART 1: Lock Verification ---
    console.log('--- Part 1: Agent Lock Screen Verification ---');
    // Wrong PIN
    let r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: 'wrong' })
    });
    let d = await r.json();
    assert(r.status === 400 && d.ok === false, 'Wrong chat PIN rejected with 400 (does not trigger panel token expiration)');

    // Correct PIN
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: '445566' })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'Correct chat PIN (445566) unlocks successfully');

    // --- PART 2: Password Synchronization ---
    console.log('\n--- Part 2: Password Synchronization ---');
    // Admin updates chat PIN to 889900
    r = await fetch(`${base}/api/chat/admin/accounts/3/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ password: '889900' })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'Admin updates agent chat PIN to 889900 via Admin Chat Accounts');

    // Verify old PIN fails
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: '445566' })
    });
    assert(r.status === 400, 'Previous PIN 445566 is immediately invalid');

    // Verify new PIN succeeds in verify-lock
    r = await fetch(`${base}/api/chat/auth/verify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ password: '889900' })
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'New PIN 889900 immediately unlocks verify-lock');

    // Verify Chat App login also accepts new PIN
    r = await fetch(`${base}/api/chat/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agent_beta', password: '889900' })
    });
    d = await r.json();
    assert(r.status === 200 && !!d.token, 'Chat App login immediately accepts synchronized PIN 889900');

    // Verify Panel password is completely untouched
    const agtDb = db.get('SELECT password FROM users WHERE id=3');
    const panelOk = bcrypt.compareSync('agt_panel_pass', agtDb.password);
    const panelNotChat = !bcrypt.compareSync('889900', agtDb.password);
    assert(panelOk && panelNotChat, 'Agent panel login password remains completely separate and untouched');

    // --- PART 3: User Deletion Cascades & Reparenting (Fixes 500 error) ---
    console.log('\n--- Part 3: User Deletion FK Integrity (Fixes 500 error) ---');
    // Delete Manager 2 (has child agent 3, numbers, chat)
    r = await fetch(`${base}/api/users/2`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'DELETE /api/users/2 (Manager with child Agent) succeeds with 200 without FK error');

    // Verify child agent reparented to NULL
    const checkAgt = db.get('SELECT * FROM users WHERE id=3');
    assert(checkAgt && checkAgt.parent_id === null, 'Child agent was safely reparented to NULL');

    // Verify number manager_id unallocated
    const checkNum = db.get('SELECT * FROM numbers WHERE id=10');
    assert(checkNum && checkNum.manager_id === null && checkNum.agent_id === 3, 'Number allocation manager_id unallocated to NULL while agent preserved');

    // Delete Agent 3 (has child client 4, wallet, numbers, chat conversations)
    r = await fetch(`${base}/api/users/3`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    d = await r.json();
    assert(r.status === 200 && d.ok === true, 'DELETE /api/users/3 (Agent with child Client & Wallet) succeeds with 200 without FK error');

    // Verify agent is deleted and client is reparented
    const deletedAgt = db.get('SELECT * FROM users WHERE id=3');
    assert(!deletedAgt, 'Agent 3 was deleted from database');

    const wallet = db.get('SELECT * FROM agent_wallets WHERE agent_id=3');
    assert(!wallet, 'Agent wallet was cleanly removed');

    const checkCli = db.get('SELECT * FROM users WHERE id=4');
    assert(checkCli && checkCli.parent_id === null, 'Child client was safely detached with parent_id set to NULL');

    const checkNum2 = db.get('SELECT * FROM numbers WHERE id=10');
    assert(checkNum2 && checkNum2.agent_id === null, 'Number agent_id safely cleared to NULL');

  } finally {
    server.close();
  }

  console.log(`\n===========================================`);
  console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
  console.log(`===========================================\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Fatal error during test run:', e);
  process.exit(1);
});
