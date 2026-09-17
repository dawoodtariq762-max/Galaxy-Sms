/**
 * backend/chat.js — P19e INTERNAL CHAT + COMPLAINTS (isolated module).
 * Mount: require('./chat')(app, { authRequired, requireRole, logAction })  (server.js me ek line)
 * Disable/revert: woh mount line hata do — baaki system par zero asar.
 *
 * PERMISSION MATRIX (backend-enforced, users.parent_id se — koi doosra hierarchy nahi):
 *   client : apna agent (parent)                          | complaint -> admin
 *   agent  : apne clients (children) + apna manager       | complaint -> admin (admin se chat NAHI)
 *   manager: apne agents (children) + admin
 *   admin  : koi bhi active panel user; HAR conversation open/read/reply kar sakta hai
 *
 * REAL-TIME: SSE (GET /api/chat/stream?ticket=...) — same Node process, zero naya dependency.
 *   JWT URL me na jaye is liye one-time 60s ticket (POST /api/chat/ticket) use hota hai.
 *   jsdom/old browsers ke liye client polling fallback rakhta hai (chat.js).
 *   Heartbeat 25s (no DB). Broadcast sirf chat POST se — SMS/numbers paths untouched.
 */
'use strict';
const crypto = require('crypto');
const db = require('./db');

const MSG_MAX = 2000, SUBJECT_MAX = 200, COMPLAINT_MAX = 4000;
const PAGE_DEFAULT = 30, PAGE_MAX = 50;
const CONV_LIST_LIMIT = 60;
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', agent: 'Agent', client: 'Client' };

/* ---------- tiny helpers ---------- */
function displayUser(u) { return { id: u.id, username: u.username, name: (u.name && String(u.name).trim()) || u.username, role: u.role, role_label: ROLE_LABEL[u.role] || u.role }; }
function getUser(id) { return db.get('SELECT * FROM users WHERE id=?', [id]); }
/* P19e FIX: JWT payload me sirf {id,username,role} hota hai — parent_id DB row se aata hai.
   (Bug: req.user.parent_id undefined tha => client->agent / agent->manager conv 403 ho rahi thi.) */
function meUser(req) { return getUser(req.user.id) || req.user; }
function intId(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function cleanText(v, max) { const s = String(v == null ? '' : v).trim(); if (!s) return null; if (s.length > max) return null; return s; }
/* XSS-safe render ke liye body ko kabhi raw HTML me insert nahi karte (client textContent use karta hai) */

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

/* ---------- permission core (server-side ONLY source of truth) ---------- */
function canStartChat(user, target) {
  if (!user || !target || user.id === target.id) return false;
  if (!target.active) return false;
  switch (user.role) {
    case 'admin': return true;                                        // admin <-> koi bhi active user
    case 'manager': return (target.role === 'agent' && target.parent_id === user.id) || target.role === 'admin';
    case 'agent':   return (target.role === 'client' && target.parent_id === user.id) || (target.role === 'manager' && target.id === user.parent_id);
    case 'client':  return target.role === 'agent' && target.id === user.parent_id;
    default: return false;
  }
}
/* conversation read/reply access: participant ya admin (admin-only global visibility) */
function convAccess(user, conv) {
  if (!conv) return false;
  if (user.role === 'admin') return true;
  return conv.user_a === user.id || conv.user_b === user.id;
}
function pairOf(a, b) { return a < b ? [a, b] : [b, a]; }
function getConv(id) { return db.get('SELECT * FROM chat_conversations WHERE id=?', [id]); }

/* conversation list rows: participants' identity JOIN se (messages me duplication nahi) */
const CONV_SELECT = `SELECT c.id, c.user_a, c.user_b, c.created_at, c.last_message_at, c.last_message_text,
    ua.id AS a_id, ua.username AS a_username, ua.name AS a_name, ua.role AS a_role, ua.active AS a_active,
    ub.id AS b_id, ub.username AS b_username, ub.name AS b_name, ub.role AS b_role, ub.active AS b_active
  FROM chat_conversations c JOIN users ua ON ua.id=c.user_a JOIN users ub ON ub.id=c.user_b`;

function mapConv(r, meId) {
  const a = { id: r.a_id, username: r.a_username, name: (r.a_name && String(r.a_name).trim()) || r.a_username, role: r.a_role, role_label: ROLE_LABEL[r.a_role] || r.a_role };
  const b = { id: r.b_id, username: r.b_username, name: (r.b_name && String(r.b_name).trim()) || r.b_username, role: r.b_role, role_label: ROLE_LABEL[r.b_role] || r.b_role };
  const other = meId === r.a_id ? b : (meId === r.b_id ? a : null);
  return { id: r.id, user_a: a, user_b: b, other: other || undefined, created_at: r.created_at, last_message_at: r.last_message_at, last_message_text: r.last_message_text };
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
const HB_MS = 25000, MAX_SSE_TOTAL = 300, MAX_SSE_PER_USER = 5;
const hbTimer = setInterval(() => {
  for (const set of sseClients.values()) for (const res of set) { try { res.write(': hb\n\n'); } catch (e) {} }
}, HB_MS);
if (hbTimer.unref) hbTimer.unref();
const ticketSweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, v] of sseTickets) if (v.expires < now) sseTickets.delete(t);
}, 60000);
if (ticketSweeper.unref) ticketSweeper.unref();

function sseSend(res, event, obj) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (e) {} }
/* participants + saare connected admins ko push (admin All-Chats live update) */
function broadcast(conv, event, obj) {
  const targets = new Set([conv.user_a, conv.user_b]);
  for (const [, set] of sseClients)
    for (const res of set)
      if (targets.has(res._gxUserId) || res._gxRole === 'admin') sseSend(res, event, obj);
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

/* ================================================================ */
module.exports = function mountChat(app, deps) {
  const { authRequired, requireRole, logAction } = deps;

  /* ---------- contacts: jisse chat START karne ki permission hai ---------- */
  app.get('/api/chat/contacts', authRequired, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = `%${q}%`;
    const me = meUser(req); /* DB row — parent_id sahi */
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

  /* ---------- conversation list (mine | admin all) ---------- */
  app.get('/api/chat/conversations', authRequired, (req, res) => {
    const scope = String(req.query.scope || 'mine');
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = `%${q}%`;
    if (scope === 'all') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden — All Chats is admin-only' });
      const rows = db.all(`${CONV_SELECT}
        ${q ? `WHERE (ua.username LIKE ? OR ua.name LIKE ? OR ub.username LIKE ? OR ub.name LIKE ?)` : ''}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ${CONV_LIST_LIMIT}`,
        q ? [like, like, like, like] : []);
      return res.json(rows.map(r => ({ ...mapConv(r, req.user.id), unread: 0 })));
    }
    /* P19e FIX: participants ki identity JOIN se aati hai (pehle plain UNION rows thi —
       mapConv ko "a_" aur "b_" prefixed fields chahiye, warna naam undefined dikhta). Do indexed scans + JOIN. */
    const rows = db.all(`SELECT t.id, t.created_at, t.last_message_at, t.last_message_text,
        t.user_a, t.user_b,
        ua.id AS a_id, ua.username AS a_username, ua.name AS a_name, ua.role AS a_role,
        ub.id AS b_id, ub.username AS b_username, ub.name AS b_name, ub.role AS b_role
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
    const byId = new Map(rows.map(r => [r.id, r]));
    let out = rows.map(r => ({ ...mapConv(r, req.user.id), unread: unread[r.id] || 0 }));
    if (q) out = out.filter(c => (c.other && (c.other.name.toLowerCase().includes(q) || c.other.username.toLowerCase().includes(q))) || (c.last_message_text || '').toLowerCase().includes(q));
    void byId;
    res.json(out);
  });

  /* ---------- start (ya existing) conversation — permission matrix se ---------- */
  app.post('/api/chat/conversations', authRequired, (req, res) => {
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

  /* ---------- messages: paginated history (recent window + older on demand) ---------- */
  app.get('/api/chat/messages/:id', authRequired, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const beforeId = parseInt(req.query.before_id || '0', 10) || null;
    const afterId = parseInt(req.query.after_id || '0', 10) || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit || String(PAGE_DEFAULT), 10) || PAGE_DEFAULT, 1), PAGE_MAX);
    if (afterId) {
      const rows = db.all(`SELECT m.*, u.username, u.name, u.role FROM chat_messages m JOIN users u ON u.id=m.sender_id
        WHERE m.conversation_id=? AND m.id>? ORDER BY m.id ASC LIMIT ${PAGE_MAX}`, [conv.id, afterId]);
      return res.json({ messages: rows.map(mapMsg), has_older: false });
    }
    const rows = db.all(`SELECT m.*, u.username, u.name, u.role FROM chat_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.conversation_id=? ${beforeId ? 'AND m.id<?' : ''} ORDER BY m.id DESC LIMIT ${limit + 1}`,
      beforeId ? [conv.id, beforeId] : [conv.id]);
    const hasOlder = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    res.json({ messages: page.map(mapMsg), has_older: hasOlder });
  });

  function mapMsg(m) { return { id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, sender_name: (m.name && String(m.name).trim()) || m.username, sender_role: ROLE_LABEL[m.role] || m.role, body: m.body, created_at: m.created_at, read_at: m.read_at || null }; }

  /* ---------- send message ---------- */
  app.post('/api/chat/messages/:id', authRequired, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const body = cleanText(req.body && req.body.body, MSG_MAX);
    if (!body) return res.status(400).json({ error: 'Message is empty' });
    if (!sendRateOk(req.user.id)) return res.status(429).json({ error: 'Too many messages — slow down' });
    const info = db.run('INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?,?,?)', [conv.id, req.user.id, body]);
    const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
    db.run(`UPDATE chat_conversations SET last_message_at=datetime('now'), last_message_text=? WHERE id=?`, [preview, conv.id]);
    const sender = getUser(req.user.id) || req.user;
    const msg = { id: Number(info.lastInsertRowid), conversation_id: conv.id, sender_id: req.user.id, sender_name: (sender.name && String(sender.name).trim()) || sender.username, sender_role: ROLE_LABEL[req.user.role] || req.user.role, body, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), read_at: null };
    broadcast(conv, 'msg', { c: conv.id, m: msg });
    res.json({ ok: true, message: msg });
  });

  /* ---------- mark read ---------- */
  app.post('/api/chat/messages/:id/read', authRequired, (req, res) => {
    const conv = getConv(intId(req.params.id));
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!convAccess(req.user, conv)) return res.status(403).json({ error: 'Forbidden — not your conversation' });
    const info = db.run(`UPDATE chat_messages SET read_at=datetime('now') WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL`, [conv.id, req.user.id]);
    broadcast(conv, 'read', { c: conv.id, by: req.user.id, by_name: (req.user.name && String(req.user.name).trim()) || req.user.username });
    res.json({ ok: true, marked: info.changes || 0 });
  });

  /* ---------- unread badge (chat) + open complaints badge ---------- */
  app.get('/api/chat/unread-count', authRequired, (req, res) => {
    const chat = db.get(`SELECT COUNT(*) c FROM chat_messages m JOIN chat_conversations c2 ON c2.id=m.conversation_id
      WHERE (c2.user_a=? OR c2.user_b=?) AND m.sender_id<>? AND m.read_at IS NULL`, [req.user.id, req.user.id, req.user.id]).c;
    let complaints = 0;
    if (req.user.role === 'admin') complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE status<>'Resolved'`).c;
    else complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE sender_id=? AND status<>'Resolved'`, [req.user.id]).c;
    res.json({ chat, complaints });
  });

  /* ---------- SSE: one-time ticket + stream ---------- */
  app.post('/api/chat/ticket', authRequired, (req, res) => {
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
   * COMPLAINTS (separate system — normal chat se alag)
   * ================================================================ */
  const COMPLAINT_SELECT = `SELECT cm.*, u.username, u.name, u.role FROM complaints cm JOIN users u ON u.id=cm.sender_id`;

  app.post('/api/complaints', authRequired, (req, res) => {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Complaints are submitted to Admin' });
    const subject = cleanText(req.body && req.body.subject, SUBJECT_MAX);
    const body = cleanText(req.body && req.body.body, COMPLAINT_MAX);
    if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required' });
    const info = db.run('INSERT INTO complaints (sender_id, subject, body) VALUES (?,?,?)', [req.user.id, subject, body]);
    logAction(req, 'complaint_created', 'complaints', { id: Number(info.lastInsertRowid), subject });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  app.get('/api/complaints', authRequired, (req, res) => {
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
    return { id: r.id, subject: r.subject, body: r.body, status: r.status, created_at: r.created_at, updated_at: r.updated_at,
      status_updated_at: r.status_updated_at || null, status_updated_by: r.status_updated_by || '',
      sender: { id: r.sender_id, username: r.username, name: (r.name && String(r.name).trim()) || r.username, role: r.role, role_label: ROLE_LABEL[r.role] || r.role } };
  }

  function complaintAccess(user, cm) { return user.role === 'admin' || cm.sender_id === user.id; }

  app.get('/api/complaints/:id', authRequired, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const replies = db.all(`SELECT cr.*, u.username, u.name, u.role FROM complaint_replies cr JOIN users u ON u.id=cr.sender_id
      WHERE cr.complaint_id=? ORDER BY cr.id ASC`, [cm.id]);
    const sender = getUser(cm.sender_id);
    res.json({ ...mapComplaint({ ...cm, username: sender.username, name: sender.name, role: sender.role }),
      replies: replies.map(r => ({ id: r.id, sender_id: r.sender_id, sender_name: (r.name && String(r.name).trim()) || r.username, sender_role: ROLE_LABEL[r.role] || r.role, body: r.body, created_at: r.created_at })) });
  });

  app.post('/api/complaints/:id/replies', authRequired, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const body = cleanText(req.body && req.body.body, COMPLAINT_MAX);
    if (!body) return res.status(400).json({ error: 'Reply is empty' });
    db.run(`UPDATE complaints SET updated_at=datetime('now') WHERE id=?`, [cm.id]);
    const info = db.run('INSERT INTO complaint_replies (complaint_id, sender_id, body) VALUES (?,?,?)', [cm.id, req.user.id, body]);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  app.post('/api/complaints/:id/status', authRequired, requireRole('admin'), (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    const status = String((req.body && req.body.status) || '').trim();
    if (!['Open', 'In Progress', 'Resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.run(`UPDATE complaints SET status=?, updated_at=datetime('now'), status_updated_at=datetime('now'), status_updated_by=? WHERE id=?`,
      [status, req.user.username, cm.id]);
    logAction(req, 'complaint_status_changed', 'complaints', { id: cm.id, from: cm.status, to: status });
    res.json({ ok: true, status });
  });
};
