/**
 * backend/chat.js — P19e + P21 PHASE-1 & PHASE-2:
 * INTERNAL CHAT + SEPARATE CHAT AUTHENTICATION + MESSAGE DELETION + MOBILE APP API.
 * Mount: require('./chat')(app, { authRequired, chatAuthRequired, requireRole, logAction, signChat, SECRET })
 *
 * PERMISSION MATRIX (backend-enforced, users.parent_id se — koi doosra hierarchy nahi):
 *   client : apna agent (parent)                          | complaint -> admin
 *   agent  : apne clients (children) + apna manager       | complaint -> admin (admin se chat NAHI)
 *   manager: apne agents (children) + admin
 *   admin  : koi bhi active panel user; HAR conversation open/read/reply kar sakta hai
 *
 * SEPARATE CHAT AUTHENTICATION (P21 Phase-1):
 *   Non-admin users (manager, agent, client) have a dedicated chat password in chat_credentials.
 *   Panel password changes do NOT affect chat password; chat password changes do NOT affect panel password.
 *   Admin account uses the unified admin account password (verified with Admin Security Code).
 *
 * PHASE-2 ADVANCED FEATURES:
 *   - Message Deletion: "Delete for me" (per-user soft-delete) and "Delete for everyone" (sender <= 15m or admin anytime)
 *   - Tombstone semantics: revoked messages render as "This message was deleted" without breaking layout
 *   - Admin Spectator vs Participant separation (My Direct Chats vs Manager/Agent/Client inspection)
 *   - Hierarchy-aware conversation mapping (Manager ↔ Agent, Agent ↔ Client tags)
 *   - Server-side conversation search with zero full-table client dumping
 */
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');

const MSG_MAX = 2000, SUBJECT_MAX = 200, COMPLAINT_MAX = 4000;
const PAGE_DEFAULT = 30, PAGE_MAX = 50;
const CONV_LIST_LIMIT = 60;
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', agent: 'Agent', client: 'Client' };

/* ---------- tiny helpers ---------- */
function displayUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: (u.name && String(u.name).trim()) || u.username,
    role: u.role,
    role_label: ROLE_LABEL[u.role] || u.role
  };
}
function getUser(id) { return db.get('SELECT * FROM users WHERE id=?', [id]); }
function meUser(req) { return getUser(req.user.id) || req.user; }
function intId(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function cleanText(v, max) { const s = String(v == null ? '' : v).trim(); if (!s) return null; if (s.length > max) return null; return s; }

/* ---------- per-user send rate limit (60 msg/min, sliding) ---------- */
const _sendBuckets = new Map();
function sendRateOk(userId) {
  const now = Date.now();
  let b = _sendBuckets.get(userId);
  if (!b) { b = []; _sendBuckets.set(userId, b); }
  while (b.length && now - b[0] > 60000) b.shift();
  if (b.length >= 60) return false;
  b.push(now);
  if (_sendBuckets.size > 5000) for (const [k, v] of _sendBuckets) { if (!v.length) _sendBuckets.delete(k); }
  return true;
}

/* ---------- chat login rate limit (25 attempts / 5 min per IP) ---------- */
const _chatLoginBuckets = new Map();
function chatLoginLimit(req, res, next) {
  const now = Date.now();
  const key = `cl:${req.ip || 'unknown'}`;
  let b = _chatLoginBuckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 300000 }; _chatLoginBuckets.set(key, b); }
  b.count++;
  if (_chatLoginBuckets.size > 10000) for (const [k, v] of _chatLoginBuckets) if (now > v.resetAt) _chatLoginBuckets.delete(k);
  if (b.count > 25) {
    return res.status(429).json({ error: 'Too many chat login attempts. Please slow down.' });
  }
  next();
}

/* ---------- Super Manager helper (server-side check fresh from DB) ---------- */
function isSuperManager(userId) {
  if (!userId) return false;
  const u = getUser(userId);
  return !!(u && u.role === 'manager' && u.is_super_manager === 1);
}

/* ---------- permission core (server-side ONLY source of truth) ---------- */
function canStartChat(user, target) {
  if (!user || !target || user.id === target.id) return false;
  if (!target.active) return false;
  if (user.role === 'admin' || (user.role === 'manager' && isSuperManager(user.id))) return true;
  switch (user.role) {
    case 'manager': return (target.role === 'agent' && target.parent_id === user.id) || target.role === 'admin';
    case 'agent':   return (target.role === 'client' && target.parent_id === user.id) || (target.role === 'manager' && target.id === user.parent_id);
    case 'client':  return target.role === 'agent' && target.id === user.parent_id;
    default: return false;
  }
}

/* conversation read/reply access: participant, admin, or super manager */
function convAccess(user, conv) {
  if (!conv) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'manager' && isSuperManager(user.id)) return true;
  return conv.user_a === user.id || conv.user_b === user.id;
}
function pairOf(a, b) { return a < b ? [a, b] : [b, a]; }
function getConv(id) { return db.get('SELECT * FROM chat_conversations WHERE id=?', [id]); }

/* conversation list rows: participants' identity JOIN se */
const CONV_SELECT = `SELECT c.id, c.user_a, c.user_b, c.created_at, c.last_message_at, c.last_message_text,
    ua.id AS a_id, ua.username AS a_username, ua.name AS a_name, ua.role AS a_role, ua.active AS a_active, ua.parent_id AS a_parent_id,
    ub.id AS b_id, ub.username AS b_username, ub.name AS b_name, ub.role AS b_role, ub.active AS b_active, ub.parent_id AS b_parent_id
  FROM chat_conversations c JOIN users ua ON ua.id=c.user_a JOIN users ub ON ub.id=c.user_b`;

function mapConv(r, meId) {
  const a = { id: r.a_id, username: r.a_username, name: (r.a_name && String(r.a_name).trim()) || r.a_username, role: r.a_role, role_label: ROLE_LABEL[r.a_role] || r.a_role, parent_id: r.a_parent_id };
  const b = { id: r.b_id, username: r.b_username, name: (r.b_name && String(r.b_name).trim()) || r.b_username, role: r.b_role, role_label: ROLE_LABEL[r.b_role] || r.b_role, parent_id: r.b_parent_id };
  const other = meId === r.a_id ? b : (meId === r.b_id ? a : null);
  const isDirectAdmin = (r.a_role === 'admin' || r.b_role === 'admin');

  let relCategory = 'general';
  if ((r.a_role === 'manager' && r.b_role === 'agent') || (r.a_role === 'agent' && r.b_role === 'manager')) {
    relCategory = 'manager_agent';
  } else if ((r.a_role === 'agent' && r.b_role === 'client') || (r.a_role === 'client' && r.b_role === 'agent')) {
    relCategory = 'agent_client';
  } else if (isDirectAdmin) {
    relCategory = 'admin_direct';
  }

  return {
    id: r.id,
    user_a: a,
    user_b: b,
    other: other || undefined,
    is_direct_admin: isDirectAdmin,
    rel_category: relCategory,
    created_at: r.created_at,
    last_message_at: r.last_message_at,
    last_message_text: r.last_message_text
  };
}

function unreadCounts(meId, convIds) {
  const out = {};
  if (!convIds.length) return out;
  const ph = convIds.map(() => '?').join(',');
  db.all(`SELECT conversation_id cid, COUNT(*) c FROM chat_messages
      WHERE read_at IS NULL AND sender_id<>? AND conversation_id IN (${ph})
      GROUP BY conversation_id`, [meId, ...convIds]).forEach(r => out[r.cid] = r.c);
  return out;
}

/* ---------- SSE: one-time tickets + connections ---------- */
const sseTickets = new Map();   // ticket -> { userId, role, expires }
const sseClients = new Map();   // userId -> Set<res>
const HB_MS = 25000, MAX_SSE_TOTAL = 1000, MAX_SSE_PER_USER = 10;

const hbTimer = setInterval(() => {
  for (const set of sseClients.values()) for (const res of set) { try { sseSend(res, 'hb', { t: Date.now() }); } catch (e) {} }
}, HB_MS);
if (hbTimer.unref) hbTimer.unref();

const ticketSweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, v] of sseTickets) if (v.expires < now) sseTickets.delete(t);
}, 60000);
if (ticketSweeper.unref) ticketSweeper.unref();

function sseSend(res, event, obj) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (e) {} }

/* participants + saare connected admins ko push */
function broadcast(conv, event, obj) {
  const targets = new Set([conv.user_a, conv.user_b]);
  for (const [, set] of sseClients)
    for (const res of set)
      if (targets.has(res._gxUserId) || res._gxRole === 'admin' || isSuperManager(res._gxUserId)) sseSend(res, event, obj);
}

function broadcastSseAll(event, obj) {
  for (const [, set] of sseClients) {
    for (const res of set) {
      try { sseSend(res, event, obj); } catch (_) {}
    }
  }
}

function addClient(res, userId, role) {
  let set = sseClients.get(userId);
  if (!set) { set = new Set(); sseClients.set(userId, set); }
  set.add(res);
}

function dropClient(res, userId) {
  const set = sseClients.get(userId);
  if (set) { set.delete(res); if (!set.size) sseClients.delete(userId); }
}

function dropUserConnections(userId) {
  const set = sseClients.get(userId);
  if (set) {
    for (const res of set) {
      try {
        sseSend(res, 'revoked', { reason: 'Chat access disabled by admin' });
        res.end();
      } catch (e) {}
    }
    sseClients.delete(userId);
  }
}

/* Push notification dispatch hook */
function dispatchPushNotification(conv, senderId, msg) {
  try {
    const targetId = conv.user_a === senderId ? conv.user_b : conv.user_a;
    const activeStream = sseClients.get(targetId);
    if (!activeStream || activeStream.size === 0) {
      const tokens = db.all('SELECT token, platform FROM chat_device_tokens WHERE user_id=?', [targetId]);
      if (tokens && tokens.length > 0 && process.env.DEBUG_PUSH) {
        console.log(`[PUSH] Dispatching to user ${targetId} (${tokens.length} devices): "${msg.sender_name}: ${msg.body.slice(0, 40)}"`);
      }
    }
  } catch (e) {}
}

/* ================================================================ */
module.exports = function mountChat(app, deps) {
  const { authRequired, requireRole, logAction } = deps;
  const chatAuth = deps.chatAuthRequired || authRequired;
  const signChat = deps.signChat || (u => require('./auth').signChat(u));
  const SECRET = deps.SECRET || process.env.JWT_SECRET || 'ms-sms-dev-secret-change-in-production';
  app.broadcastSseAll = broadcastSseAll;

  /* ================================================================
   * CHAT AUTHENTICATION
   * ================================================================ */

  app.post('/api/chat/auth/login', chatLoginLimit, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.get('SELECT * FROM users WHERE username=? COLLATE NOCASE', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });

    // Admin uses master account password from users table
    if (user.role === 'admin') {
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      logAction({ user, ip: req.ip }, 'chat_login', 'chat', { username: user.username, role: 'admin' });
      return res.json({
        ok: true,
        token: signChat(user),
        user: { id: user.id, username: user.username, role: user.role, name: user.name || user.username, is_super_manager: 0, chat_display_name: '' }
      });
    }

    // Non-admin roles use dedicated chat_credentials
    const cred = db.get('SELECT * FROM chat_credentials WHERE user_id=?', [user.id]);
    if (!cred) {
      return res.status(403).json({ error: 'Chat access is not enabled for this account. Contact Admin.' });
    }
    if (!cred.chat_enabled) {
      return res.status(403).json({ error: 'Chat access has been disabled for this account. Contact Admin.' });
    }
    if (cred.locked_until && new Date(cred.locked_until).getTime() > Date.now()) {
      return res.status(429).json({ error: 'Account temporarily locked due to multiple failed login attempts. Please try again later.' });
    }

    const match = bcrypt.compareSync(password, cred.chat_password_hash);
    if (!match) {
      const attempts = (cred.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
      db.run('UPDATE chat_credentials SET failed_attempts=?, locked_until=? WHERE user_id=?', [attempts, lockUntil, user.id]);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    db.run(`UPDATE chat_credentials SET failed_attempts=0, locked_until=NULL, last_login_at=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [user.id]);
    logAction({ user, ip: req.ip }, 'chat_login', 'chat', { username: user.username, role: user.role });
    const freshUser = getUser(user.id) || user;
    return res.json({
      ok: true,
      token: signChat(user),
      user: {
        id: freshUser.id,
        username: freshUser.username,
        role: freshUser.role,
        name: freshUser.name || freshUser.username,
        is_super_manager: (freshUser.role === 'manager' && freshUser.is_super_manager === 1) ? 1 : 0,
        chat_display_name: freshUser.chat_display_name || ''
      }
    });
  });

  /* ================================================================
   * PANEL LOCK VERIFICATION (guarded sections: Chat & Payment)
   * Validates user's Chat App password / PIN against chat_credentials
   * ================================================================ */
  app.get('/api/chat/auth/lock-status', authRequired, (req, res) => {
    const user = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.role === 'admin') {
      return res.json({ chat_security_enabled: false, locked: false, unlocked: true });
    }

    const cred = db.get('SELECT chat_enabled, chat_password_hash FROM chat_credentials WHERE user_id=?', [user.id]);
    if (cred && (cred.chat_enabled === 0 || cred.chat_enabled === false)) {
      return res.json({ chat_security_enabled: false, locked: false, unlocked: true });
    }

    const unlockHeader = req.headers['x-chat-unlock-token'];
    let unlocked = false;
    if (unlockHeader) {
      try {
        const decoded = jwt.verify(unlockHeader, SECRET);
        if (decoded && decoded.type === 'chat_unlocked' && decoded.id === user.id) {
          unlocked = true;
        }
      } catch (_) {}
    }

    return res.json({
      chat_security_enabled: true,
      locked: !unlocked,
      unlocked: unlocked
    });
  });

  app.post('/api/chat/auth/verify-lock', authRequired, (req, res) => {
    const password = String((req.body && req.body.password) || '').trim();
    if (!password) return res.status(400).json({ error: 'Password or PIN is required' });

    const user = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });

    // Admin uses master account password
    if (user.role === 'admin') {
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ ok: false, error: 'Invalid password or PIN' });
      }
      const unlockToken = jwt.sign({ id: user.id, username: user.username, role: user.role, type: 'chat_unlocked' }, SECRET, { expiresIn: '12h' });
      return res.json({ ok: true, message: 'Unlocked successfully', unlock_token: unlockToken });
    }

    let cred = db.get('SELECT chat_enabled, chat_password_hash, failed_attempts, locked_until FROM chat_credentials WHERE user_id=?', [user.id]);
    if (!cred) {
      db.run('INSERT OR IGNORE INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime("now"))', [user.id, user.password]);
      cred = db.get('SELECT chat_enabled, chat_password_hash, failed_attempts, locked_until FROM chat_credentials WHERE user_id=?', [user.id]);
    }

    if (cred && cred.locked_until && new Date(cred.locked_until) > new Date()) {
      return res.status(429).json({ ok: false, error: 'Account temporarily locked due to multiple failed attempts. Please try again later.' });
    }

    let match = cred && cred.chat_password_hash ? bcrypt.compareSync(password, cred.chat_password_hash) : false;
    // Fallback: if separate PIN not yet set, match against user account password
    if (!match && user.password && (!cred || user.password !== cred.chat_password_hash)) {
      match = bcrypt.compareSync(password, user.password);
    }

    if (!match) {
      const attempts = ((cred && cred.failed_attempts) || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
      db.run('UPDATE chat_credentials SET failed_attempts=?, locked_until=? WHERE user_id=?', [attempts, lockUntil, user.id]);
      return res.status(400).json({ ok: false, error: 'Incorrect Chat Security PIN or Password' });
    }

    db.run(`UPDATE chat_credentials SET failed_attempts=0, locked_until=NULL, updated_at=datetime('now') WHERE user_id=?`, [user.id]);
    logAction(req, 'verify_chat_lock', 'chat', { user_id: user.id, username: user.username });
    const unlockToken = jwt.sign({ id: user.id, username: user.username, role: user.role, type: 'chat_unlocked' }, SECRET, { expiresIn: '12h' });
    return res.json({ ok: true, message: 'Unlocked successfully', unlock_token: unlockToken });
  });

  app.post('/api/chat/auth/change-password', chatAuth, (req, res) => {
    const currentPassword = String((req.body && req.body.current_password) || '');
    const newPassword = String((req.body && req.body.new_password) || '');
    const confirmPassword = String((req.body && req.body.confirm_password) || '');
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });

    if (req.user.role === 'admin') {
      const adminCode = String((req.body && req.body.admin_security_code) || '');
      const secRow = db.get('SELECT admin_security_code FROM system_security ORDER BY id ASC LIMIT 1');
      const expectedCode = (secRow && secRow.admin_security_code) || 'Dawood';
      if (adminCode !== expectedCode) return res.status(400).json({ error: 'Invalid admin security code' });

      const adminUser = db.get('SELECT password FROM users WHERE id=?', [req.user.id]);
      if (!adminUser || !bcrypt.compareSync(currentPassword, adminUser.password)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      db.run(`UPDATE users SET password=?, updated_at=datetime('now') WHERE id=?`, [bcrypt.hashSync(newPassword, 10), req.user.id]);
      logAction(req, 'admin_chat_password_changed', 'chat', { user_id: req.user.id });
      return res.json({ ok: true, message: 'Admin password updated successfully' });
    }

    const cred = db.get('SELECT * FROM chat_credentials WHERE user_id=?', [req.user.id]);
    if (!cred || !cred.chat_password_hash) {
      return res.status(400).json({ error: 'Chat credential not found. Contact Admin.' });
    }
    if (!bcrypt.compareSync(currentPassword, cred.chat_password_hash)) {
      return res.status(400).json({ error: 'Current chat password is incorrect' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.run(`UPDATE chat_credentials SET chat_password_hash=?, failed_attempts=0, locked_until=NULL, password_set_at=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [newHash, req.user.id]);
    logAction(req, 'user_chat_password_changed', 'chat', { user_id: req.user.id });
    res.json({ ok: true, message: 'Chat password updated successfully' });
  });

  /* ================================================================
   * ADMIN "CHAT ACCOUNTS" MANAGEMENT
   * ================================================================ */

  app.get('/api/chat/admin/accounts', chatAuth, requireRole('admin'), (req, res) => {
    const rows = db.all(`
      SELECT u.id, u.username, u.name, u.role, u.active AS user_active, u.email, u.contact, u.parent_id,
             u.is_super_manager, u.chat_display_name,
             p.username AS parent_username,
             c.chat_enabled, c.failed_attempts, c.locked_until, c.last_login_at, c.password_set_at,
             CASE WHEN c.chat_password_hash IS NOT NULL AND c.chat_password_hash != '' THEN 1 ELSE 0 END AS has_chat_password
      FROM users u
      LEFT JOIN users p ON p.id = u.parent_id
      LEFT JOIN chat_credentials c ON c.user_id = u.id
      ORDER BY CASE u.role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'agent' THEN 3 ELSE 4 END, u.username COLLATE NOCASE
    `);
    res.json({ accounts: rows });
  });

  app.post('/api/chat/admin/accounts/:userId/password', chatAuth, requireRole('admin'), (req, res) => {
    const targetId = intId(req.params.userId);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID' });
    const target = getUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Admin chat password follows admin panel password' });

    const password = String((req.body && req.body.password) || '');
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = bcrypt.hashSync(password, 10);
    const existing = db.get('SELECT user_id FROM chat_credentials WHERE user_id=?', [targetId]);
    if (existing) {
      db.run(`UPDATE chat_credentials SET chat_password_hash=?, chat_enabled=1, failed_attempts=0, locked_until=NULL, password_set_at=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [hash, targetId]);
    } else {
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [targetId, hash]);
    }
    logAction(req, 'admin_set_chat_password', 'chat', { target_id: targetId, username: target.username });
    res.json({ ok: true, user_id: targetId, message: `Chat password updated for ${target.username}` });
  });

  /* ---------- Assign / Revoke Super Manager & Set Custom Chat Display Name ---------- */
  app.post('/api/chat/admin/super-manager/:userId', chatAuth, requireRole('admin'), (req, res) => {
    const targetId = intId(req.params.userId);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID' });
    const target = getUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role !== 'manager') {
      return res.status(400).json({ error: 'Super Manager role can only be assigned to Manager accounts' });
    }

    const isSuper = (req.body.is_super_manager === 1 || req.body.is_super_manager === true) ? 1 : 0;
    const displayName = String(req.body.chat_display_name || '').trim();

    if (isSuper && !displayName) {
      return res.status(400).json({ error: 'A custom Chat display name is required for Super Manager' });
    }

    db.run("UPDATE users SET is_super_manager=?, chat_display_name=? WHERE id=?",
      [isSuper, isSuper ? displayName : '', target.id]);

    logAction(req, isSuper ? 'assign_super_manager' : 'revoke_super_manager', 'users', {
      target_id: target.id,
      username: target.username,
      chat_display_name: isSuper ? displayName : ''
    });

    res.json({
      ok: true,
      user_id: target.id,
      username: target.username,
      is_super_manager: isSuper,
      chat_display_name: isSuper ? displayName : ''
    });
  });

  app.post('/api/chat/admin/accounts/:userId/toggle', chatAuth, requireRole('admin'), (req, res) => {
    const targetId = intId(req.params.userId);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID' });
    const target = getUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot disable admin chat access' });

    const existing = db.get('SELECT * FROM chat_credentials WHERE user_id=?', [targetId]);
    const currentStatus = existing ? existing.chat_enabled : 1;
    const newStatus = (req.body && typeof req.body.chat_enabled !== 'undefined') ? (req.body.chat_enabled ? 1 : 0) : (currentStatus ? 0 : 1);

    if (existing) {
      db.run(`UPDATE chat_credentials SET chat_enabled=?, updated_at=datetime('now') WHERE user_id=?`, [newStatus, targetId]);
    } else {
      const dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (?,?,?)`, [targetId, dummyHash, newStatus]);
    }

    if (newStatus === 0) {
      dropUserConnections(targetId);
    }

    logAction(req, 'admin_toggle_chat_enabled', 'chat', { target_id: targetId, username: target.username, chat_enabled: newStatus });
    res.json({ ok: true, user_id: targetId, chat_enabled: newStatus });
  });

  app.post('/api/chat/admin/accounts/:userId/send-setup', chatAuth, requireRole('admin'), (req, res) => {
    const targetId = intId(req.params.userId);
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID' });
    const target = getUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!target.email) return res.status(400).json({ error: 'User does not have an email address configured' });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHmac('sha256', SECRET).update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    db.run(`INSERT INTO password_setup_tokens (user_id, token_hash, expires_at, token_purpose) VALUES (?,?,?,?)`,
      [targetId, tokenHash, expiresAt, 'chat_password']);

    const host = req.get('host') || '127.0.0.1';
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const setupUrl = `${proto}://${host}/set-password?token=${token}&type=chat`;

    logAction(req, 'admin_send_chat_setup_token', 'chat', { target_id: targetId, email: target.email });
    res.json({ ok: true, setup_url: setupUrl, email: target.email, message: `Setup link generated for ${target.username}` });
  });

  app.post('/api/chat/admin/accounts/init-all', chatAuth, requireRole('admin'), (req, res) => {
    const uninit = db.all(`SELECT id, username FROM users WHERE role != 'admin' AND id NOT IN (SELECT user_id FROM chat_credentials)`);
    let count = 0;
    for (const u of uninit) {
      const tempHash = bcrypt.hashSync(crypto.randomBytes(18).toString('base64url'), 10);
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [u.id, tempHash]);
      count++;
    }
    logAction(req, 'admin_init_all_chat_credentials', 'chat', { count });
    res.json({ ok: true, initialized: count });
  });

  /* ================================================================
   * MOBILE DEVICE PUSH TOKENS
   * ================================================================ */

  app.post('/api/chat/device-token', chatAuth, (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const platform = String((req.body && req.body.platform) || 'android').trim();
    const appVersion = String((req.body && req.body.app_version) || '').trim();
    if (!token) return res.status(400).json({ error: 'Device token required' });

    db.run(`
      INSERT INTO chat_device_tokens (user_id, token, platform, app_version, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, token) DO UPDATE SET updated_at=datetime('now'), app_version=excluded.app_version
    `, [req.user.id, token, platform, appVersion]);

    res.json({ ok: true });
  });

  app.delete('/api/chat/device-token', chatAuth, (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) {
      db.run('DELETE FROM chat_device_tokens WHERE user_id=?', [req.user.id]);
    } else {
      db.run('DELETE FROM chat_device_tokens WHERE user_id=? AND token=?', [req.user.id, token]);
    }
    res.json({ ok: true });
  });

  /* ================================================================
   * CHAT CONTACTS & CONVERSATIONS
   * ================================================================ */

  app.get('/api/chat/contacts', chatAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = `%${q}%`;
    const me = meUser(req);
    let rows = [];
    if (req.user.role === 'admin') {
      rows = db.all(`SELECT * FROM users WHERE active=1 AND id<>? AND (username LIKE ? OR name LIKE ?) ORDER BY username LIMIT 50`, [req.user.id, like, like]);
    } else if (req.user.role === 'manager') {
      rows = db.all(`SELECT * FROM users WHERE active=1 AND ((role='agent' AND parent_id=?) OR role='admin')
        AND (username LIKE ? OR name LIKE ?) ORDER BY role, username LIMIT 50`, [req.user.id, like, like]);
    } else if (req.user.role === 'agent') {
      rows = db.all(`SELECT * FROM users WHERE active=1 AND ((role='client' AND parent_id=?) OR (role='manager' AND id=?))
        AND (username LIKE ? OR name LIKE ?) ORDER BY role, username LIMIT 50`, [req.user.id, me.parent_id, like, like]);
    } else if (req.user.role === 'client') {
      rows = db.all(`SELECT * FROM users WHERE active=1 AND role='agent' AND id=? AND (username LIKE ? OR name LIKE ?) LIMIT 50`, [me.parent_id, like, like]);
    }
    res.json(rows.map(displayUser));
  });

  /* ---------- GET /api/chat/conversations ---------- */
  app.get('/api/chat/conversations', chatAuth, (req, res) => {
    const scope = String(req.query.scope || 'mine');
    const filter = String(req.query.filter || 'all').toLowerCase();
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = `%${q}%`;

    if (scope === 'all') {
      const isSuper = (req.user.role === 'manager' && isSuperManager(req.user.id));
      if (req.user.role !== 'admin' && !isSuper) return res.status(403).json({ error: 'Forbidden — All Chats is admin and super manager only' });

      let whereClauses = [];
      let params = [];

      if (filter === 'direct') {
        whereClauses.push(`(c.user_a = ? OR c.user_b = ?)`);
        params.push(req.user.id, req.user.id);
      } else if (filter === 'manager_chats' || filter === 'managers') {
        whereClauses.push(`((ua.role='manager' AND ub.role='agent') OR (ua.role='agent' AND ub.role='manager'))`);
      } else if (filter === 'agent_chats' || filter === 'agents') {
        whereClauses.push(`(ua.role='agent' OR ub.role='agent')`);
      } else if (filter === 'client_chats' || filter === 'clients') {
        whereClauses.push(`(ua.role='client' OR ub.role='client')`);
      }

      if (q) {
        whereClauses.push(`(ua.username LIKE ? OR ua.name LIKE ? OR ub.username LIKE ? OR ub.name LIKE ? OR c.last_message_text LIKE ?)`);
        params.push(like, like, like, like, like);
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = db.all(`${CONV_SELECT} ${whereSql}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ${CONV_LIST_LIMIT}`, params);
      return res.json(rows.map(r => ({ ...mapConv(r, req.user.id), unread: 0 })));
    }

    // scope === 'mine'
    const rows = db.all(`SELECT t.id, t.created_at, t.last_message_at, t.last_message_text,
        t.user_a, t.user_b,
        ua.id AS a_id, ua.username AS a_username, ua.name AS a_name, ua.role AS a_role, ua.active AS a_active, ua.parent_id AS a_parent_id,
        ub.id AS b_id, ub.username AS b_username, ub.name AS b_name, ub.role AS b_role, ub.active AS b_active, ub.parent_id AS b_parent_id
      FROM (
        SELECT c.id, c.user_a, c.user_b, c.created_at, c.last_message_at, c.last_message_text
        FROM chat_conversations c WHERE c.user_a=?
        UNION ALL
        SELECT c.id, c.user_a, c.user_b, c.created_at, c.last_message_at, c.last_message_text
        FROM chat_conversations c WHERE c.user_b=?
      ) t
      JOIN users ua ON ua.id=t.user_a
      JOIN users ub ON ub.id=t.user_b
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT ${CONV_LIST_LIMIT}`, [req.user.id, req.user.id]);

    const convIds = rows.map(r => r.id);
    const unread = unreadCounts(req.user.id, convIds);
    let mapped = rows.map(r => ({ ...mapConv(r, req.user.id), unread: unread[r.id] || 0 }));

    if (filter === 'manager') {
      mapped = mapped.filter(c => c.other && (c.other.role === 'manager' || (req.user.role === 'manager' && c.other.role === 'admin')));
    } else if (filter === 'clients' || filter === 'client') {
      mapped = mapped.filter(c => c.other && c.other.role === 'client');
    } else if (filter === 'agents' || filter === 'agent') {
      mapped = mapped.filter(c => c.other && c.other.role === 'agent');
    } else if (filter === 'admin' || filter === 'support') {
      mapped = mapped.filter(c => c.other && c.other.role === 'admin');
    }

    if (q) {
      mapped = mapped.filter(c => (c.other && (c.other.name.toLowerCase().includes(q) || c.other.username.toLowerCase().includes(q))) || (c.last_message_text || '').toLowerCase().includes(q));
    }
    res.json(mapped);
  });

  /* ---------- start (ya existing) conversation ---------- */
  app.post('/api/chat/conversations', chatAuth, (req, res) => {
    const targetId = intId(req.body && req.body.user_id);
    if (!targetId) return res.status(400).json({ error: 'user_id required' });
    const target = getUser(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!canStartChat(meUser(req), target)) return res.status(403).json({ error: 'You are not allowed to chat with this user' });
    const [a, b] = pairOf(req.user.id, target.id);
    let conv = db.get('SELECT id FROM chat_conversations WHERE user_a=? AND user_b=?', [a, b]);
    if (!conv) {
      const info = db.run('INSERT INTO chat_conversations (user_a, user_b) VALUES (?,?)', [a, b]);
      conv = { id: info.lastInsertRowid };
      logAction(req, 'chat_conversation_started', 'chat', { with_user: target.username, with_role: target.role });
    }
    res.json({ ok: true, conversation_id: conv.id });
  });

  /* ---------- messages: paginated history (respecting delete-for-me & delete-for-everyone) ---------- */
  app.get('/api/chat/messages/:id', chatAuth, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const beforeId = parseInt(req.query.before_id || '0', 10) || null;
    const afterId = parseInt(req.query.after_id || '0', 10) || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit || String(PAGE_DEFAULT), 10) || PAGE_DEFAULT, 1), PAGE_MAX);

    // Filter out messages deleted for me by the calling user
    const delFilter = `AND m.id NOT IN (SELECT message_id FROM chat_message_deletions WHERE user_id=${req.user.id})`;

    if (afterId) {
      const rows = db.all(`SELECT m.*, u.username, u.name, u.role, u.is_super_manager, u.chat_display_name FROM chat_messages m JOIN users u ON u.id=m.sender_id
        WHERE m.conversation_id=? AND m.id>? ${delFilter} ORDER BY m.id ASC LIMIT ${PAGE_MAX}`, [conv.id, afterId]);
      return res.json({ messages: rows.map(mapMsg), has_older: false });
    }
    const rows = db.all(`SELECT m.*, u.username, u.name, u.role, u.is_super_manager, u.chat_display_name FROM chat_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.conversation_id=? ${beforeId ? 'AND m.id<?' : ''} ${delFilter} ORDER BY m.id DESC LIMIT ${limit + 1}`,
      beforeId ? [conv.id, beforeId] : [conv.id]);
    const hasOlder = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    res.json({ messages: page.map(mapMsg), has_older: hasOlder });
  });

  function mapMsg(m) {
    const isDeleted = (m.deleted_for_everyone === 1);
    const isSuper = (m.is_super_manager === 1);
    const displayName = (isSuper && m.chat_display_name && String(m.chat_display_name).trim())
      ? String(m.chat_display_name).trim()
      : ((m.name && String(m.name).trim()) || m.username);
    const displayRole = isSuper ? 'Super Manager' : (ROLE_LABEL[m.role] || m.role);
    return {
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      sender_name: displayName,
      sender_role: displayRole,
      sender_username: isSuper ? displayName : m.username,
      body: isDeleted ? 'This message was deleted' : m.body,
      attachment_path: isDeleted ? null : (m.attachment_path || null),
      attachment_type: isDeleted ? null : (m.attachment_type || null),
      attachment_name: isDeleted ? null : (m.attachment_name || null),
      attachment_size: isDeleted ? null : (m.attachment_size || null),
      is_deleted: isDeleted,
      deleted_at: m.deleted_at || null,
      created_at: m.created_at,
      read_at: m.read_at || null
    };
  }

  /* ================================================================
   * FILE ATTACHMENTS (.txt, .csv)
   * ================================================================ */
  const uploadDir = path.join(__dirname, '..', 'data', 'chat_uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = (ext === '.csv') ? '.csv' : '.txt';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    }
  });

  const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.txt' && ext !== '.csv') {
      return cb(new Error('Only .txt and .csv files are supported'));
    }
    const allowedMimes = [
      'text/plain', 'text/csv', 'application/csv', 'text/x-csv',
      'application/x-csv', 'application/vnd.ms-excel', 'text/comma-separated-values'
    ];
    const mime = (file.mimetype || '').toLowerCase();
    if (!allowedMimes.includes(mime) && !mime.startsWith('text/')) {
      return cb(new Error('Invalid MIME type for file'));
    }
    cb(null, true);
  };

  const chatUpload = multer({
    storage: uploadStorage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
  });

  function handleChatUpload(req, res, next) {
    chatUpload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds maximum limit of 10MB' });
        }
        return res.status(400).json({ error: err.message || 'File upload failed' });
      }
      next();
    });
  }

  /* ---------- upload attachment to conversation ---------- */
  app.post('/api/chat/conversations/:id/upload', chatAuth, handleChatUpload, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!convAccess(req.user, conv)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    // Security content inspection: check head bytes
    try {
      const fd = fs.openSync(req.file.path, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, bytesRead).toString('latin1');
      if (head.startsWith('\x7fELF') || head.startsWith('MZ') || /<script|<\?php/i.test(head)) {
        try { fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(400).json({ error: 'File rejected by security validation.' });
      }
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(500).json({ error: 'File validation failed.' });
    }

    const safeOriginalName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safeOriginalName).toLowerCase();
    const fileType = (ext === '.csv') ? 'csv' : 'txt';
    const fileSize = req.file.size;
    const relPath = path.basename(req.file.path);
    const bodyText = String(req.body.body || '').trim() || safeOriginalName;

    const info = db.run(`
      INSERT INTO chat_messages (conversation_id, sender_id, body, attachment_path, attachment_type, attachment_name, attachment_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [conv.id, req.user.id, bodyText, relPath, fileType, safeOriginalName, fileSize]);

    db.run(`UPDATE chat_conversations SET last_message_at=datetime('now'), last_message_text=? WHERE id=?`,
      [`📎 ${safeOriginalName}`, conv.id]);

    const sender = getUser(req.user.id) || req.user;
    const isSuper = (sender.role === 'manager' && sender.is_super_manager === 1);
    const senderDisplayName = (isSuper && sender.chat_display_name && String(sender.chat_display_name).trim())
      ? String(sender.chat_display_name).trim()
      : ((sender.name && String(sender.name).trim()) || sender.username);
    const senderRoleLabel = isSuper ? 'Super Manager' : (ROLE_LABEL[req.user.role] || req.user.role);
    const msg = {
      id: Number(info.lastInsertRowid),
      conversation_id: conv.id,
      sender_id: req.user.id,
      sender_name: senderDisplayName,
      sender_role: senderRoleLabel,
      sender_username: isSuper ? senderDisplayName : sender.username,
      body: bodyText,
      attachment_path: relPath,
      attachment_type: fileType,
      attachment_name: safeOriginalName,
      attachment_size: fileSize,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      read_at: null,
      is_deleted: false
    };

    broadcast(conv, 'msg', { c: conv.id, m: msg });
    dispatchPushNotification(conv, req.user.id, msg);
    res.json({ ok: true, message: msg });
  });

  /* ---------- download attachment ---------- */
  app.get('/api/chat/messages/:id/download', chatAuth, (req, res) => {
    const msgId = intId(req.params.id);
    if (!msgId) return res.status(400).json({ error: 'Invalid message ID' });
    const msg = db.get('SELECT * FROM chat_messages WHERE id=?', [msgId]);
    if (!msg || !msg.attachment_path) return res.status(404).json({ error: 'Attachment not found' });
    if (msg.deleted_for_everyone === 1) return res.status(410).json({ error: 'Attachment has been deleted' });

    const conv = getConv(msg.conversation_id);
    if (!conv || !convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden' });

    const safeName = path.basename(msg.attachment_path);
    const filePath = path.resolve(uploadDir, safeName);
    if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on storage' });
    }

    const dlName = msg.attachment_name || safeName;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dlName)}"`);
    res.setHeader('Content-Type', msg.attachment_type === 'csv' ? 'text/csv' : 'text/plain');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  });

  /* ---------- send message ---------- */
  app.post('/api/chat/messages/:id', chatAuth, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const body = cleanText(req.body && (req.body.body || req.body.message), MSG_MAX);
    if (!body) return res.status(400).json({ error: 'Message is empty' });
    if (!sendRateOk(req.user.id)) return res.status(429).json({ error: 'Too many messages — slow down' });

    // Safeguard against rapid duplicate submission (e.g. accidental double-click within 2s)
    const recent = db.get(
      `SELECT * FROM chat_messages 
       WHERE conversation_id = ? AND sender_id = ? AND body = ? 
       AND datetime(created_at) >= datetime('now', '-2 seconds')
       ORDER BY id DESC LIMIT 1`,
      [conv.id, req.user.id, body]
    );
    if (recent) {
      const sender = getUser(req.user.id) || req.user;
      const isSuper = (sender.role === 'manager' && sender.is_super_manager === 1);
      const senderDisplayName = (isSuper && sender.chat_display_name && String(sender.chat_display_name).trim())
        ? String(sender.chat_display_name).trim()
        : ((sender.name && String(sender.name).trim()) || sender.username);
      const senderRoleLabel = isSuper ? 'Super Manager' : (ROLE_LABEL[req.user.role] || req.user.role);
      const msg = {
        id: recent.id,
        conversation_id: recent.conversation_id,
        sender_id: recent.sender_id,
        sender_name: senderDisplayName,
        sender_role: senderRoleLabel,
        sender_username: isSuper ? senderDisplayName : sender.username,
        body: recent.body,
        created_at: recent.created_at,
        read_at: recent.read_at,
        is_deleted: false
      };
      return res.json({ ok: true, message: msg, deduplicated: true });
    }

    const info = db.run('INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?,?,?)', [conv.id, req.user.id, body]);
    const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
    db.run(`UPDATE chat_conversations SET last_message_at=datetime('now'), last_message_text=? WHERE id=?`, [preview, conv.id]);
    const sender = getUser(req.user.id) || req.user;
    const isSuper = (sender.role === 'manager' && sender.is_super_manager === 1);
    const senderDisplayName = (isSuper && sender.chat_display_name && String(sender.chat_display_name).trim())
      ? String(sender.chat_display_name).trim()
      : ((sender.name && String(sender.name).trim()) || sender.username);
    const senderRoleLabel = isSuper ? 'Super Manager' : (ROLE_LABEL[req.user.role] || req.user.role);
    const msg = {
      id: Number(info.lastInsertRowid),
      conversation_id: conv.id,
      sender_id: req.user.id,
      sender_name: senderDisplayName,
      sender_role: senderRoleLabel,
      sender_username: isSuper ? senderDisplayName : sender.username,
      body,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      read_at: null,
      is_deleted: false
    };
    broadcast(conv, 'msg', { c: conv.id, m: msg });
    dispatchPushNotification(conv, req.user.id, msg);
    res.json({ ok: true, message: msg });
  });

  /* ---------- upload attachment alias (:id = convId) ---------- */
  app.post('/api/chat/messages/:id/upload', chatAuth, handleChatUpload, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!convAccess(req.user, conv)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    try {
      const fd = fs.openSync(req.file.path, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, bytesRead).toString('latin1');
      if (head.startsWith('\x7fELF') || head.startsWith('MZ') || /<script|<\?php/i.test(head)) {
        try { fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(400).json({ error: 'File rejected by security validation.' });
      }
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch(_) {}
      return res.status(500).json({ error: 'File validation failed.' });
    }

    const safeOriginalName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safeOriginalName).toLowerCase();
    const fileType = (ext === '.csv') ? 'csv' : 'txt';
    const fileSize = req.file.size;
    const relPath = path.basename(req.file.path);
    const bodyText = String(req.body.body || '').trim() || safeOriginalName;

    const info = db.run(`
      INSERT INTO chat_messages (conversation_id, sender_id, body, attachment_path, attachment_type, attachment_name, attachment_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [conv.id, req.user.id, bodyText, relPath, fileType, safeOriginalName, fileSize]);

    db.run(`UPDATE chat_conversations SET last_message_at=datetime('now'), last_message_text=? WHERE id=?`,
      [`📎 ${safeOriginalName}`, conv.id]);

    const sender = getUser(req.user.id) || req.user;
    const isSuper = (sender.role === 'manager' && sender.is_super_manager === 1);
    const senderDisplayName = (isSuper && sender.chat_display_name && String(sender.chat_display_name).trim())
      ? String(sender.chat_display_name).trim()
      : ((sender.name && String(sender.name).trim()) || sender.username);
    const senderRoleLabel = isSuper ? 'Super Manager' : (ROLE_LABEL[req.user.role] || req.user.role);
    const msg = {
      id: Number(info.lastInsertRowid),
      conversation_id: conv.id,
      sender_id: req.user.id,
      sender_name: senderDisplayName,
      sender_role: senderRoleLabel,
      sender_username: isSuper ? senderDisplayName : sender.username,
      body: bodyText,
      attachment_path: relPath,
      attachment_type: fileType,
      attachment_name: safeOriginalName,
      attachment_size: fileSize,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      read_at: null,
      is_deleted: false
    };

    broadcast(conv, 'msg', { c: conv.id, m: msg });
    dispatchPushNotification(conv, req.user.id, msg);
    res.json({ ok: true, message: msg });
  });

  /* ---------- Delete for Me (Caller view only) ---------- */
  app.post('/api/chat/messages/:id/delete-for-me', chatAuth, (req, res) => {
    const msgId = intId(req.params.id);
    if (!msgId) return res.status(400).json({ error: 'Invalid message ID' });
    const msg = db.get('SELECT * FROM chat_messages WHERE id=?', [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const conv = getConv(msg.conversation_id);
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden' });

    db.run(`INSERT OR IGNORE INTO chat_message_deletions (message_id, user_id, deleted_at) VALUES (?, ?, datetime('now'))`,
      [msgId, req.user.id]);
    res.json({ ok: true, message_id: msgId, mode: 'delete_for_me' });
  });

  /* ---------- Delete for Everyone (Sender <= 15m OR Admin anytime) ---------- */
  app.post('/api/chat/messages/:id/delete-for-everyone', chatAuth, (req, res) => {
    const msgId = intId(req.params.id);
    if (!msgId) return res.status(400).json({ error: 'Invalid message ID' });
    const msg = db.get('SELECT * FROM chat_messages WHERE id=?', [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const conv = getConv(msg.conversation_id);
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden' });

    const isAdmin = req.user.role === 'admin';
    const isSender = req.user.id === msg.sender_id;

    if (!isAdmin && !isSender) {
      return res.status(403).json({ error: 'You can only delete your own messages.' });
    }

    if (!isAdmin && isSender) {
      const msgTime = new Date(msg.created_at).getTime();
      const ageMs = Date.now() - msgTime;
      if (ageMs > 15 * 60 * 1000) {
        return res.status(403).json({ error: 'Messages can only be deleted for everyone within 15 minutes of sending.' });
      }
    }

    db.run(`UPDATE chat_messages SET deleted_for_everyone=1, deleted_at=datetime('now'), deleted_by=?, body='This message was deleted' WHERE id=?`,
      [req.user.id, msgId]);

    logAction(req, 'chat_message_revoked', 'chat', { message_id: msgId, conversation_id: conv.id, deleted_by_role: req.user.role });
    broadcast(conv, 'msg_deleted', { c: conv.id, m_id: msgId });

    res.json({ ok: true, message_id: msgId, mode: 'delete_for_everyone' });
  });

  /* ---------- mark read ---------- */
  app.post('/api/chat/messages/:id/read', chatAuth, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const info = db.run(`UPDATE chat_messages SET read_at=datetime('now') WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL`, [conv.id, req.user.id]);
    broadcast(conv, 'read', { c: conv.id, by: req.user.id, by_name: (req.user.name && String(req.user.name).trim()) || req.user.username });
    res.json({ ok: true, marked: info.changes || 0 });
  });

  /* ================================================================
   * FEATURE 2: GALAXY SMS OFFICIAL CHANNEL
   * ================================================================ */
  const channelUploadDir = path.join(__dirname, '..', 'data', 'channel_media');
  if (!fs.existsSync(channelUploadDir)) {
    fs.mkdirSync(channelUploadDir, { recursive: true });
  }

  const channelStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, channelUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `chan-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  });

  const channelFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedImgExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const allowedVidExts = ['.mp4', '.webm', '.mov', '.m4v'];
    if (!allowedImgExts.includes(ext) && !allowedVidExts.includes(ext)) {
      return cb(new Error('Only images (.jpg, .png, .webp, .gif) and videos (.mp4, .webm, .mov) are allowed'));
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/') && !mime.startsWith('video/') && mime !== 'application/octet-stream') {
      return cb(new Error('Invalid media MIME type'));
    }
    cb(null, true);
  };

  const channelUpload = multer({
    storage: channelStorage,
    fileFilter: channelFileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
  });

  function handleChannelUpload(req, res, next) {
    channelUpload.single('media')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds maximum limit of 50MB' });
        }
        return res.status(400).json({ error: err.message || 'Media upload failed' });
      }
      next();
    });
  }

  function validateMediaFile(filePath, ext) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const headStr = buf.subarray(0, bytesRead).toString('latin1');
      if (headStr.startsWith('\x7fELF') || headStr.startsWith('MZ') || /<script|<\?php|#!\/bin/i.test(headStr)) {
        return false;
      }
      if (['.jpg', '.jpeg'].includes(ext)) {
        return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      }
      if (ext === '.png') {
        return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      }
      if (ext === '.gif') {
        return headStr.startsWith('GIF87a') || headStr.startsWith('GIF89a');
      }
      if (ext === '.webp') {
        return headStr.startsWith('RIFF') && headStr.includes('WEBP');
      }
      if (['.mp4', '.m4v'].includes(ext)) {
        return buf.subarray(4, 8).toString('latin1') === 'ftyp' || headStr.includes('isom') || headStr.includes('mp42');
      }
      if (ext === '.webm') {
        return buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
      }
      if (ext === '.mov') {
        return buf.subarray(4, 8).toString('latin1') === 'ftyp' || buf.subarray(4, 8).toString('latin1') === 'moov';
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function mapChannelPost(p) {
    const hasMedia = !!p.media_path;
    const mediaUrl = hasMedia ? `/api/chat/channel/media/${encodeURIComponent(p.media_path)}` : null;
    return {
      id: p.id,
      admin_id: p.admin_id,
      admin_name: p.admin_name || p.admin_username || 'Galaxy SMS Official',
      admin_username: p.admin_username || 'admin',
      title: p.title || '',
      body: p.body,
      media_url: mediaUrl,
      media_path: p.media_path || null,
      media_type: p.media_type || null,
      media_name: p.media_name || null,
      media_size: p.media_size || 0,
      is_pinned: !!p.is_pinned,
      created_at: p.created_at,
      updated_at: p.updated_at
    };
  }

  /* GET /api/chat/channel/posts — all authorized chat roles can view (paginated) */
  app.get('/api/chat/channel/posts', chatAuth, (req, res) => {
    const beforeId = parseInt(req.query.before_id || '0', 10) || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 50);

    let sql = `SELECT p.*, u.username AS admin_username, u.name AS admin_name
               FROM channel_posts p JOIN users u ON u.id=p.admin_id`;
    const params = [];
    if (beforeId) {
      sql += ' WHERE p.id < ?';
      params.push(beforeId);
    }
    sql += ` ORDER BY p.id DESC LIMIT ${limit + 1}`;

    const rows = db.all(sql, params);
    const hasOlder = rows.length > limit;
    const items = (hasOlder ? rows.slice(0, limit) : rows).map(mapChannelPost);

    const readRow = db.get('SELECT last_read_post_id FROM channel_reads WHERE user_id=?', [req.user.id]);
    const lastRead = readRow ? (readRow.last_read_post_id || 0) : 0;
    const unreadCount = db.get('SELECT COUNT(*) AS c FROM channel_posts WHERE id > ?', [lastRead])?.c || 0;

    res.json({ posts: items, has_older: hasOlder, unread_count: unreadCount });
  });

  /* POST /api/chat/channel/posts — ADMIN ONLY publishing */
  app.post('/api/chat/channel/posts', chatAuth, requireRole('admin'), handleChannelUpload, (req, res) => {
    const body = String(req.body && (req.body.body || req.body.caption || req.body.text || '')).trim();
    const title = String((req.body && req.body.title) || '').trim();

    let mediaPath = '', mediaType = '', mediaName = '', mediaSize = 0;
    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (!validateMediaFile(req.file.path, ext)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ error: 'File rejected by security validation.' });
      }
      mediaPath = path.basename(req.file.path);
      mediaName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      mediaSize = req.file.size;
      mediaType = ['.mp4', '.webm', '.mov', '.m4v'].includes(ext) ? 'video' : 'image';
    }

    if (!body && !mediaPath) {
      return res.status(400).json({ error: 'Post must contain text, an image, or a video.' });
    }

    const info = db.run(
      `INSERT INTO channel_posts (admin_id, title, body, media_path, media_type, media_name, media_size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, title, body, mediaPath, mediaType, mediaName, mediaSize]
    );
    const postId = Number(info.lastInsertRowid);
    const post = mapChannelPost({
      id: postId,
      admin_id: req.user.id,
      admin_username: req.user.username,
      admin_name: (req.user.name && String(req.user.name).trim()) || req.user.username,
      title,
      body,
      media_path: mediaPath,
      media_type: mediaType,
      media_name: mediaName,
      media_size: mediaSize,
      is_pinned: 0,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });

    broadcastSseAll('channel_post', { post });
    logAction(req, 'create_channel_post', 'channel', { post_id: postId, has_media: !!mediaPath });
    res.json({ ok: true, post });
  });

  /* PUT /api/chat/channel/posts/:id — ADMIN ONLY editing */
  app.put('/api/chat/channel/posts/:id', chatAuth, requireRole('admin'), (req, res) => {
    const postId = intId(req.params.id);
    if (!postId) return res.status(400).json({ error: 'Invalid post ID' });
    const existing = db.get('SELECT * FROM channel_posts WHERE id=?', [postId]);
    if (!existing) return res.status(404).json({ error: 'Channel post not found' });

    const body = String(req.body && (req.body.body || req.body.caption || req.body.text || '')).trim();
    const title = String((req.body && req.body.title) || '').trim();
    if (!body && !existing.media_path) {
      return res.status(400).json({ error: 'Post body cannot be empty' });
    }

    db.run("UPDATE channel_posts SET title=?, body=?, updated_at=datetime('now') WHERE id=?",
      [title, body, postId]);

    const updated = db.get(`SELECT p.*, u.username AS admin_username, u.name AS admin_name FROM channel_posts p JOIN users u ON u.id=p.admin_id WHERE p.id=?`, [postId]);
    const post = mapChannelPost(updated);
    broadcastSseAll('channel_post_updated', { post });
    logAction(req, 'update_channel_post', 'channel', { post_id: postId });
    res.json({ ok: true, post });
  });

  /* DELETE /api/chat/channel/posts/:id — ADMIN ONLY deleting */
  app.delete('/api/chat/channel/posts/:id', chatAuth, requireRole('admin'), (req, res) => {
    const postId = intId(req.params.id);
    if (!postId) return res.status(400).json({ error: 'Invalid post ID' });
    const post = db.get('SELECT * FROM channel_posts WHERE id=?', [postId]);
    if (!post) return res.status(404).json({ error: 'Channel post not found' });

    if (post.media_path) {
      try {
        const filePath = path.resolve(channelUploadDir, post.media_path);
        if (filePath.startsWith(channelUploadDir) && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {}
    }

    db.run('DELETE FROM channel_posts WHERE id=?', [postId]);
    broadcastSseAll('channel_post_deleted', { id: postId });
    logAction(req, 'delete_channel_post', 'channel', { post_id: postId });
    res.json({ ok: true, id: postId });
  });

  /* GET /api/chat/channel/media/:filename — secure media streaming */
  app.get('/api/chat/channel/media/:filename', chatAuth, (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename) return res.status(400).json({ error: 'Filename required' });

    const filePath = path.resolve(channelUploadDir, filename);
    if (!filePath.startsWith(channelUploadDir) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v'
    };

    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  });

  /* POST /api/chat/channel/read — update read state for current user */
  app.post('/api/chat/channel/read', chatAuth, (req, res) => {
    const lastId = intId(req.body && req.body.last_post_id) || 0;
    db.run(`
      INSERT INTO channel_reads (user_id, last_read_post_id, read_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET last_read_post_id=MAX(last_read_post_id, excluded.last_read_post_id), read_at=datetime('now')
    `, [req.user.id, lastId]);
    res.json({ ok: true });
  });

  /* GET /api/chat/profile — current user identity & Super Manager flags */
  app.get('/api/chat/profile', chatAuth, (req, res) => {
    const u = getUser(req.user.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const isSuper = (u.role === 'manager' && u.is_super_manager === 1);
    res.json({
      id: u.id,
      username: u.username,
      name: u.name || u.username,
      role: u.role,
      is_super_manager: isSuper,
      chat_display_name: u.chat_display_name || ''
    });
  });

  /* ---------- unread badge (chat + complaints + channel) ---------- */
  app.get('/api/chat/unread-count', chatAuth, (req, res) => {
    const chat = db.get(`SELECT COUNT(*) c FROM chat_messages m JOIN chat_conversations c2 ON c2.id=m.conversation_id
      WHERE (c2.user_a=? OR c2.user_b=?) AND m.sender_id<>? AND m.read_at IS NULL`, [req.user.id, req.user.id, req.user.id]).c;
    let complaints = 0;
    if (req.user.role === 'admin') complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE status<>'Resolved'`).c;
    else complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE sender_id=? AND status<>'Resolved'`, [req.user.id]).c;

    const readRow = db.get('SELECT last_read_post_id FROM channel_reads WHERE user_id=?', [req.user.id]);
    const lastRead = readRow ? (readRow.last_read_post_id || 0) : 0;
    const channel = db.get('SELECT COUNT(*) AS c FROM channel_posts WHERE id > ?', [lastRead])?.c || 0;

    const u = getUser(req.user.id);
    const isSuper = (u && u.role === 'manager' && u.is_super_manager === 1);

    res.json({
      chat,
      complaints,
      channel,
      is_super_manager: isSuper,
      chat_display_name: u?.chat_display_name || ''
    });
  });

  /* ---------- Admin Global Search Endpoint ---------- */
  app.get('/api/chat/admin/search', chatAuth, requireRole('admin'), (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const like = `%${q}%`;
    const rows = db.all(`
      SELECT m.id AS message_id, m.conversation_id, m.sender_id, m.body, m.created_at, m.deleted_for_everyone,
             u.username AS sender_username, u.name AS sender_name, u.role AS sender_role,
             ua.username AS a_username, ua.role AS a_role,
             ub.username AS b_username, ub.role AS b_role
      FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      JOIN users u ON u.id = m.sender_id
      JOIN users ua ON ua.id = c.user_a
      JOIN users ub ON ub.id = c.user_b
      WHERE m.body LIKE ? OR u.username LIKE ? OR ua.username LIKE ? OR ub.username LIKE ?
      ORDER BY m.id DESC LIMIT 50
    `, [like, like, like, like]);
    res.json({ results: rows });
  });

  /* ---------- SSE: one-time ticket + stream ---------- */
  app.post('/api/chat/ticket', chatAuth, (req, res) => {
    const t = crypto.randomBytes(24).toString('hex');
    sseTickets.set(t, { userId: req.user.id, role: req.user.role, expires: Date.now() + 60000 });
    res.json({ ticket: t });
  });

  app.get('/api/chat/stream', (req, res) => {
    const t = String(req.query.ticket || '');
    const v = sseTickets.get(t);
    if (!v || v.expires < Date.now()) return res.status(401).json({ error: 'Invalid or expired ticket' });
    sseTickets.delete(t); // one-time
    let total = 0; for (const set of sseClients.values()) total += set.size;
    if (total >= MAX_SSE_TOTAL) return res.status(503).json({ error: 'Too many stream connections' });
    let mine = sseClients.get(v.userId); if (mine && mine.size >= MAX_SSE_PER_USER) return res.status(503).json({ error: 'Too many stream connections for this user' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res._gxRole = v.role; res._gxUserId = v.userId;
    res.write('event: ready\ndata: {"ok":true}\n\n');
    addClient(res, v.userId, v.role);
    req.on('close', () => dropClient(res, v.userId));
  });

  /* ================================================================
   * COMPLAINTS
   * ================================================================ */
  const COMPLAINT_SELECT = `SELECT cm.*, u.username, u.name, u.role FROM complaints cm JOIN users u ON u.id=cm.sender_id`;

  app.post('/api/complaints', chatAuth, (req, res) => {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Complaints are submitted to Admin' });
    const subject = cleanText(req.body && req.body.subject, SUBJECT_MAX);
    const body = cleanText(req.body && req.body.body, COMPLAINT_MAX);
    if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required' });
    const info = db.run('INSERT INTO complaints (sender_id, subject, body) VALUES (?,?,?)', [req.user.id, subject, body]);
    logAction(req, 'complaint_created', 'complaints', { id: Number(info.lastInsertRowid), subject });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  app.get('/api/complaints', chatAuth, (req, res) => {
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = `%${q}%`;
    const validStatus = ['Open', 'In Progress', 'Resolved'];
    if (req.user.role === 'admin') {
      const conds = [], params = [];
      if (validStatus.includes(status)) { conds.push('cm.status=?'); params.push(status); }
      if (q) { conds.push('(cm.subject LIKE ? OR cm.body LIKE ? OR u.username LIKE ? OR u.name LIKE ?)'); params.push(like, like, like, like); }
      const rows = db.all(`${COMPLAINT_SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY cm.created_at DESC LIMIT 100`, params);
      return res.json(rows.map(mapComplaint));
    }
    const rows = db.all(`${COMPLAINT_SELECT} WHERE cm.sender_id=? ORDER BY cm.created_at DESC LIMIT 100`, [req.user.id]);
    return res.json(rows.filter(r => !validStatus.includes(status) || r.status === status).map(mapComplaint));
  });

  function mapComplaint(r) {
    return {
      id: r.id,
      subject: r.subject,
      body: r.body,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      status_updated_at: r.status_updated_at || null,
      status_updated_by: r.status_updated_by || '',
      sender: {
        id: r.sender_id,
        username: r.username,
        name: (r.name && String(r.name).trim()) || r.username,
        role: r.role,
        role_label: ROLE_LABEL[r.role] || r.role
      }
    };
  }

  function complaintAccess(user, cm) { return user.role === 'admin' || cm.sender_id === user.id; }

  app.get('/api/complaints/:id', chatAuth, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const replies = db.all(`SELECT cr.*, u.username, u.name, u.role FROM complaint_replies cr JOIN users u ON u.id=cr.sender_id
      WHERE cr.complaint_id=? ORDER BY cr.id ASC`, [cm.id]);
    const sender = getUser(cm.sender_id);
    res.json({
      ...mapComplaint({ ...cm, username: sender.username, name: sender.name, role: sender.role }),
      replies: replies.map(r => ({
        id: r.id,
        sender_id: r.sender_id,
        sender_name: (r.name && String(r.name).trim()) || r.username,
        sender_role: ROLE_LABEL[r.role] || r.role,
        body: r.body,
        created_at: r.created_at
      }))
    });
  });


  /* ================================================================
   * MOBILE APP VERSION & IN-APP UPDATE SYSTEM
   * ================================================================ */
  app.get('/api/chat/app/version', (req, res) => {
    const v2ApkPath = path.join(__dirname, '..', 'galaxy-chat-v2.apk');
    const v1ApkPath = path.join(__dirname, '..', 'galaxy-chat-v1.apk');
    let apkSize = 0;
    if (fs.existsSync(v2ApkPath)) {
      apkSize = fs.statSync(v2ApkPath).size;
    } else if (fs.existsSync(v1ApkPath)) {
      apkSize = fs.statSync(v1ApkPath).size;
    }

    res.json({
      latestVersion: '2.0.0',
      versionCode: 2,
      minSupportedVersion: '1.0.0',
      downloadUrl: '/api/chat/app/download',
      apkSize: apkSize,
      releaseNotes: 'Galaxy SMS Chat v2.0.0:\n• Official Galaxy SMS Channel for instant announcements\n• Super Manager role with All-Chats access & display alias\n• Media & file sharing enhancements\n• In-app update notifications & 1-tap upgrades',
      releaseDate: '2026-09-23',
      mandatory: false
    });
  });

  app.get('/api/chat/app/download', (req, res) => {
    const v2ApkPath = path.join(__dirname, '..', 'galaxy-chat-v2.apk');
    const v1ApkPath = path.join(__dirname, '..', 'galaxy-chat-v1.apk');
    const apkFile = fs.existsSync(v2ApkPath) ? v2ApkPath : (fs.existsSync(v1ApkPath) ? v1ApkPath : null);

    if (!apkFile) {
      return res.status(404).json({ error: 'Chat APK file not found on server.' });
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="galaxy-chat-v2.apk"');
    res.sendFile(apkFile);
  });

  app.post('/api/complaints/:id/replies', chatAuth, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const body = cleanText(req.body && req.body.body, COMPLAINT_MAX);
    if (!body) return res.status(400).json({ error: 'Reply is empty' });
    db.run(`UPDATE complaints SET updated_at=datetime('now') WHERE id=?`, [cm.id]);
    const info = db.run('INSERT INTO complaint_replies (complaint_id, sender_id, body) VALUES (?,?,?)', [cm.id, req.user.id, body]);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
};
