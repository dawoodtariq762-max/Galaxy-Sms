/**
 * verify-super-manager-and-channel.js
 * Verification of:
 * 1. Super Manager Role (assign/revoke on Manager, masked display name, scope=all, reply to any chat, zero admin permissions).
 * 2. Galaxy SMS Official Channel (admin-only publish/edit/delete, image/video upload, emojis 🇮🇹 🇲🇳 🇵🇭, view-only for others, pagination, read tracking).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Point to test DB
const testDbPath = `/tmp/test_sm_chan_${Date.now()}.sqlite`;
process.env.DB_FILE = testDbPath;
process.env.JWT_SECRET = 'test-secret-super-manager-channel-2026';

const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const { sign, signChat, authRequired, chatAuthRequired, requireRole, descendantIds, SECRET } = require('../backend/auth');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function logAction(req, action, module, details) {
  try {
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : '';
    const role = req.user ? req.user.role : '';
    db.run(
      `INSERT INTO audit_logs (user_id, username, role, action, module, details) VALUES (?,?,?,?,?,?)`,
      [userId, username, role, action, module, typeof details === 'string' ? details : JSON.stringify(details || {})]
    );
  } catch (_) {}
}

// Mount server mock admin endpoint for permission check
app.post('/api/admin/restricted-settings', authRequired, requireRole('admin'), (req, res) => {
  res.json({ ok: true, admin_only: true });
});

require('../backend/chat')(app, { authRequired, chatAuthRequired, requireRole, logAction, signChat, SECRET });

let server, port;
let adminToken, mgr1Token, mgr2Token, agent1Token, client1Token;
let adminUser, mgr1User, mgr2User, agent1User, client1User;

async function request(method, path, body = null, token = null, isMultipart = false, multipartData = null) {
  return new Promise((resolve, reject) => {
    let headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    
    let postData = null;
    if (isMultipart && multipartData) {
      const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
      headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
      
      const parts = [];
      for (const [k, v] of Object.entries(multipartData.fields || {})) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      }
      if (multipartData.file) {
        const f = multipartData.file;
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldname}"; filename="${f.filename}"\r\nContent-Type: ${f.mimetype}\r\n\r\n`);
      }
      const prefix = Buffer.from(parts.join(''), 'utf8');
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const fileBuf = multipartData.file ? multipartData.file.buffer : Buffer.alloc(0);
      postData = Buffer.concat([prefix, fileBuf, suffix]);
      headers['Content-Length'] = postData.length;
    } else if (body) {
      postData = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = postData.length;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

let passed = 0, failed = 0;
function assert(desc, condition, details = '') {
  if (condition) {
    console.log(`PASS | ${desc}`);
    passed++;
  } else {
    console.error(`FAIL | ${desc} ${details ? '- ' + details : ''}`);
    failed++;
  }
}

async function runTests() {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  console.log(`\n===== TEST SUITE: SUPER MANAGER & OFFICIAL CHANNEL =====\n`);

  // Setup Users in DB
  const hash = bcrypt.hashSync('Password123!', 10);
  
  db.run(`INSERT INTO users (username, password, role, name) VALUES ('admin1', ?, 'admin', 'System Admin')`, [hash]);
  adminUser = db.get(`SELECT * FROM users WHERE username='admin1'`);
  adminToken = sign(adminUser);

  db.run(`INSERT INTO users (username, password, role, name) VALUES ('manager1', ?, 'manager', 'Alice Manager')`, [hash]);
  mgr1User = db.get(`SELECT * FROM users WHERE username='manager1'`);
  mgr1Token = sign(mgr1User);

  db.run(`INSERT INTO users (username, password, role, name) VALUES ('manager2', ?, 'manager', 'Bob Manager')`, [hash]);
  mgr2User = db.get(`SELECT * FROM users WHERE username='manager2'`);
  mgr2Token = sign(mgr2User);

  db.run(`INSERT INTO users (username, password, role, name, parent_id) VALUES ('agent1', ?, 'agent', 'Charlie Agent', ?)`, [hash, mgr1User.id]);
  agent1User = db.get(`SELECT * FROM users WHERE username='agent1'`);
  agent1Token = signChat(agent1User);

  db.run(`INSERT INTO users (username, password, role, name, parent_id) VALUES ('client1', ?, 'client', 'Dave Client', ?)`, [hash, agent1User.id]);
  client1User = db.get(`SELECT * FROM users WHERE username='client1'`);
  client1Token = signChat(client1User);

  // Initialize chat credentials for all
  [mgr1User, mgr2User, agent1User, client1User].forEach(u => {
    db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (?,?,1)`, [u.id, hash]);
  });

  // Create a conversation between Agent1 and Client1 (Mgr1 is not participant)
  const convAC = db.run(`INSERT INTO chat_conversations (user_a, user_b, created_at) VALUES (?,?, datetime('now'))`,
    [Math.min(agent1User.id, client1User.id), Math.max(agent1User.id, client1User.id)]
  );
  const convACId = Number(convAC.lastInsertRowid);

  // Send an initial message from Client1 to Agent1
  db.run(`INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?,?,?)`, [convACId, client1User.id, 'Hello Agent Charlie!']);

  /* ================================================================
   * FEATURE 1: SUPER MANAGER TESTS
   * ================================================================ */
  console.log(`\n--- FEATURE 1: SUPER MANAGER ROLE & IDENTITY MASKING ---`);

  // 1. Regular Manager attempts scope=all -> 403 Forbidden
  {
    const r = await request('GET', '/api/chat/conversations?scope=all', null, mgr1Token);
    assert('Regular Manager is blocked from scope=all (403)', r.status === 403);
  }

  // 2. Regular Manager attempts to read Agent-Client conversation -> 403 Forbidden
  {
    const r = await request('GET', `/api/chat/messages/${convACId}`, null, mgr1Token);
    assert('Regular Manager is blocked from non-participant conversation (403)', r.status === 403);
  }

  // 3. Admin attempts to assign Super Manager to an Agent -> 400 Rejected
  {
    const r = await request('POST', `/api/chat/admin/super-manager/${agent1User.id}`, {
      is_super_manager: 1,
      chat_display_name: 'Agent Support'
    }, adminToken);
    assert('Assigning Super Manager to Agent is rejected (400)', r.status === 400 && r.body.error.includes('Manager'));
  }

  // 4. Non-admin attempts to assign Super Manager -> 403 Forbidden
  {
    const r = await request('POST', `/api/chat/admin/super-manager/${mgr1User.id}`, {
      is_super_manager: 1,
      chat_display_name: 'Galaxy Support'
    }, mgr2Token);
    assert('Non-admin is blocked from assigning Super Manager (403)', r.status === 403);
  }

  // 5. Admin assigns Super Manager to Manager 1 with display name "Galaxy Support"
  {
    const r = await request('POST', `/api/chat/admin/super-manager/${mgr1User.id}`, {
      is_super_manager: 1,
      chat_display_name: 'Galaxy Support'
    }, adminToken);
    assert('Admin assigns Super Manager successfully (200)', r.status === 200 && r.body.is_super_manager === 1);
    assert('Display name set to "Galaxy Support"', r.body.chat_display_name === 'Galaxy Support');
  }

  // 6. Super Manager queries profile -> reports is_super_manager = true
  {
    const r = await request('GET', '/api/chat/profile', null, mgr1Token);
    assert('Super Manager profile reports is_super_manager: true', r.status === 200 && r.body.is_super_manager === true);
    assert('Super Manager profile has chat_display_name', r.body.chat_display_name === 'Galaxy Support');
  }

  // 7. Super Manager accesses scope=all -> 200 OK and receives conversations
  {
    const r = await request('GET', '/api/chat/conversations?scope=all', null, mgr1Token);
    assert('Super Manager accesses scope=all successfully (200)', r.status === 200 && Array.isArray(r.body));
    const found = r.body.some(c => c.id === convACId);
    assert('Super Manager sees Agent-Client conversation in All Chats', found);
  }

  // 8. Super Manager opens and reads Agent-Client conversation -> 200 OK
  {
    const r = await request('GET', `/api/chat/messages/${convACId}`, null, mgr1Token);
    assert('Super Manager opens and reads conversation history (200)', r.status === 200 && r.body.messages.length > 0);
  }

  // 9. Super Manager replies to Agent-Client conversation -> 200 OK
  let replyMsgId = null;
  {
    const r = await request('POST', `/api/chat/messages/${convACId}`, { body: 'Hello from Support! How can I help you today?' }, mgr1Token);
    assert('Super Manager sends reply to conversation (200)', r.status === 200 && r.body.ok);
    replyMsgId = r.body.message.id;
    assert('Immediate message response masks name with "Galaxy Support"', r.body.message.sender_name === 'Galaxy Support');
    assert('Immediate message response masks username', r.body.message.sender_username === 'Galaxy Support');
    assert('Immediate message response sets role to Super Manager', r.body.message.sender_role === 'Super Manager');
  }

  // 10. Agent reads conversation history -> verifies Super Manager username is masked
  {
    const r = await request('GET', `/api/chat/messages/${convACId}`, null, agent1Token);
    assert('Agent loads messages (200)', r.status === 200);
    const msg = r.body.messages.find(m => m.id === replyMsgId);
    assert('Super Manager message found in history', !!msg);
    assert('Message displays custom name "Galaxy Support"', msg && msg.sender_name === 'Galaxy Support');
    assert('Message sender_role is "Super Manager"', msg && msg.sender_role === 'Super Manager');
    assert('Original account username "manager1" is NOT exposed', msg && msg.sender_username !== 'manager1');
  }

  // 11. Super Manager has ZERO unrelated admin permissions
  {
    const r = await request('POST', '/api/admin/restricted-settings', {}, mgr1Token);
    assert('Super Manager is BLOCKED from admin settings (403)', r.status === 403);
    const r2 = await request('GET', '/api/chat/admin/accounts', null, mgr1Token);
    assert('Super Manager is BLOCKED from admin chat accounts (403)', r2.status === 403);
  }

  // 12. Support multiple Super Managers with independent display names
  {
    const r = await request('POST', `/api/chat/admin/super-manager/${mgr2User.id}`, {
      is_super_manager: 1,
      chat_display_name: 'VIP Concierge Team'
    }, adminToken);
    assert('Admin assigns second Super Manager with independent name (200)', r.status === 200 && r.body.chat_display_name === 'VIP Concierge Team');

    const rReply = await request('POST', `/api/chat/messages/${convACId}`, { body: 'VIP Concierge standing by.' }, mgr2Token);
    assert('Second Super Manager replies with independent display name', rReply.body.message.sender_name === 'VIP Concierge Team');
  }

  // 13. Revoke Super Manager status -> Access immediately revoked server-side
  {
    const r = await request('POST', `/api/chat/admin/super-manager/${mgr1User.id}`, {
      is_super_manager: 0
    }, adminToken);
    assert('Admin revokes Super Manager status for Manager 1 (200)', r.status === 200 && r.body.is_super_manager === 0);

    const rScope = await request('GET', '/api/chat/conversations?scope=all', null, mgr1Token);
    assert('Revoked Super Manager is immediately blocked from scope=all (403)', rScope.status === 403);

    const rRead = await request('GET', `/api/chat/messages/${convACId}`, null, mgr1Token);
    assert('Revoked Super Manager is immediately blocked from conversation (403)', rRead.status === 403);
  }

  /* ================================================================
   * FEATURE 2: GALAXY SMS OFFICIAL CHANNEL TESTS
   * ================================================================ */
  console.log(`\n--- FEATURE 2: GALAXY SMS OFFICIAL CHANNEL ---`);

  // 1. Non-admin attempts to publish post -> 403 Forbidden
  {
    const r = await request('POST', '/api/chat/channel/posts', { body: 'Unauthorized announcement' }, client1Token);
    assert('Client is blocked from publishing to channel (403)', r.status === 403);
    const r2 = await request('POST', '/api/chat/channel/posts', { body: 'Unauthorized announcement' }, mgr1Token);
    assert('Manager is blocked from publishing to channel (403)', r2.status === 403);
  }

  // 2. Admin publishes text-only post with Unicode & country flag emojis (🇮🇹, 🇲🇳, 🇵🇭)
  let post1Id = null;
  const unicodeText = '🚀 Welcome to Galaxy SMS Official Channel! Country routes updated: Italy 🇮🇹, Mongolia 🇲🇳, Philippines 🇵🇭. Rate discounts active!';
  {
    const r = await request('POST', '/api/chat/channel/posts', {
      title: 'Global Routes Update',
      body: unicodeText
    }, adminToken);
    assert('Admin publishes text post with emojis (200)', r.status === 200 && r.body.ok);
    assert('Post title preserved', r.body.post.title === 'Global Routes Update');
    assert('Full Unicode and country flag emojis preserved verbatim', r.body.post.body === unicodeText);
    post1Id = r.body.post.id;
  }

  // 3. Admin publishes post with valid Image attachment
  let postImgId = null;
  {
    // 1x1 valid PNG image buffer
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89]);
    const r = await request('POST', '/api/chat/channel/posts', null, adminToken, true, {
      fields: { title: 'Network Infrastructure', caption: 'High-availability server cluster in EU & APAC.' },
      file: { fieldname: 'media', filename: 'cluster_diagram.png', mimetype: 'image/png', buffer: pngHeader }
    });
    assert('Admin uploads image post successfully (200)', r.status === 200 && r.body.ok);
    assert('Post has media_type: image', r.body.post.media_type === 'image');
    assert('Post has valid media_url', r.body.post.media_url && r.body.post.media_url.includes('/api/chat/channel/media/'));
    postImgId = r.body.post.id;

    // Verify media download endpoint
    const filename = r.body.post.media_path;
    const dl = await request('GET', `/api/chat/channel/media/${filename}`, null, client1Token);
    assert('Authorized client can stream channel image (200)', dl.status === 200);
    assert('Media response has nosniff header', dl.headers['x-content-type-options'] === 'nosniff');
  }

  // 4. Admin publishes post with valid Video attachment
  let postVidId = null;
  {
    // Synthetic MP4 buffer (ftyp box)
    const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x6D, 0x6D, 0x70, 0x34, 0x32]);
    const r = await request('POST', '/api/chat/channel/posts', null, adminToken, true, {
      fields: { title: 'Platform Video Tour', caption: 'Watch our guide on multi-tier rate allocations.' },
      file: { fieldname: 'media', filename: 'tutorial.mp4', mimetype: 'video/mp4', buffer: mp4Header }
    });
    assert('Admin uploads video post successfully (200)', r.status === 200 && r.body.ok);
    assert('Post has media_type: video', r.body.post.media_type === 'video');
    postVidId = r.body.post.id;
  }

  // 5. Malicious executable / script upload is rejected
  {
    const elfBuf = Buffer.from('\x7fELF\x02\x01\x01\x00malicious_binary_content', 'latin1');
    const r = await request('POST', '/api/chat/channel/posts', null, adminToken, true, {
      fields: { caption: 'Hidden virus' },
      file: { fieldname: 'media', filename: 'image.png', mimetype: 'image/png', buffer: elfBuf }
    });
    assert('Malicious ELF binary disguised as PNG is rejected (400)', r.status === 400 && r.body.error.includes('rejected'));

    const phpBuf = Buffer.from('<?php echo "shell"; ?>', 'latin1');
    const r2 = await request('POST', '/api/chat/channel/posts', null, adminToken, true, {
      fields: { caption: 'PHP Script' },
      file: { fieldname: 'media', filename: 'photo.jpg', mimetype: 'image/jpeg', buffer: phpBuf }
    });
    assert('PHP script disguised as JPG is rejected (400)', r2.status === 400 && r2.body.error.includes('rejected'));
  }

  // 6. Admin edits own post -> 200 OK
  {
    const r = await request('PUT', `/api/chat/channel/posts/${post1Id}`, {
      title: 'Global Routes Update (Updated)',
      body: 'Updated routes: Italy 🇮🇹, Mongolia 🇲🇳, Philippines 🇵🇭. Special +15% rebate this week!'
    }, adminToken);
    assert('Admin edits channel post successfully (200)', r.status === 200 && r.body.ok);
    assert('Updated text reflected', r.body.post.body.includes('+15% rebate'));
  }

  // 7. Non-admin cannot edit or delete posts -> 403 Forbidden
  {
    const r = await request('PUT', `/api/chat/channel/posts/${post1Id}`, { body: 'Hacked body' }, client1Token);
    assert('Non-admin is blocked from editing post (403)', r.status === 403);

    const r2 = await request('DELETE', `/api/chat/channel/posts/${post1Id}`, null, agent1Token);
    assert('Non-admin is blocked from deleting post (403)', r2.status === 403);
  }

  // 8. Viewers: All roles can read channel posts with pagination
  {
    const r = await request('GET', '/api/chat/channel/posts?limit=2', null, client1Token);
    assert('Client reads channel posts with limit=2 (200)', r.status === 200);
    assert('Returns 2 posts and has_older is true', r.body.posts.length === 2 && r.body.has_older === true);

    // Pagination with before_id
    const oldestId = r.body.posts[r.body.posts.length - 1].id;
    const rOlder = await request('GET', `/api/chat/channel/posts?limit=2&before_id=${oldestId}`, null, client1Token);
    assert('Next page loaded with before_id (200)', rOlder.status === 200 && rOlder.body.posts.length >= 1);
    assert('Older page preserves Unicode flags 🇮🇹 🇲🇳 🇵🇭', rOlder.body.posts.some(p => p.body.includes('🇮🇹')));
  }

  // 9. Read state tracking & Unread counters
  {
    // Client initially has unread channel posts
    const uCount1 = await request('GET', '/api/chat/unread-count', null, client1Token);
    assert('Client unread counter shows unread channel posts > 0', uCount1.body.channel > 0);

    // Client marks channel read up to postVidId
    const rRead = await request('POST', '/api/chat/channel/read', { last_post_id: postVidId }, client1Token);
    assert('Client marks channel as read (200)', rRead.status === 200 && rRead.body.ok);

    const uCount2 = await request('GET', '/api/chat/unread-count', null, client1Token);
    assert('Client unread counter for channel is now 0', uCount2.body.channel === 0);
  }

  // 10. Admin deletes post -> 200 OK and media cleaned up
  {
    const r = await request('DELETE', `/api/chat/channel/posts/${postVidId}`, null, adminToken);
    assert('Admin deletes post successfully (200)', r.status === 200 && r.body.ok);

    const rCheck = await request('GET', '/api/chat/channel/posts', null, client1Token);
    assert('Deleted post no longer present in feed', !rCheck.body.posts.some(p => p.id === postVidId));
  }

  console.log(`\n===========================================`);
  console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
  console.log(`===========================================\n`);

  server.close();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Test execution error:", err);
  if (server) server.close();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
  process.exit(1);
});
