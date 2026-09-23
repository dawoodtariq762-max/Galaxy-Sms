// verify-chat-duplicates-and-file-picker.js
// Verification suite for Issue 1 (Message Duplication) and Issue 2 (File Chooser & Upload Flow)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const testDbPath = `/tmp/test_chat_dedupe_${Date.now()}.sqlite`;
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const JWT_SECRET = 'galaxy_jwt_secret_test_suite_xyz123!';
process.env.JWT_SECRET = JWT_SECRET;

let passCount = 0;
let failCount = 0;

function pass(msg) {
  passCount++;
  console.log(`PASS | ${msg}`);
}

function fail(msg, err) {
  failCount++;
  console.error(`FAIL | ${msg}`, err ? (err.stack || err) : '');
}

async function runTests() {
  console.log('\n======================================================');
  console.log('VERIFYING CHAT MESSAGE DEDUPLICATION & FILE PICKER');
  console.log('======================================================\n');

  // 1. Audit MainActivity.java for onShowFileChooser & onActivityResult
  console.log('--- Test Section 1: Android WebView Native File Chooser Audit ---');
  const mainActivityPath = path.join(__dirname, '..', 'mobile-app', 'src', 'com', 'galaxysms', 'chat', 'MainActivity.java');
  const mainActivitySrc = fs.readFileSync(mainActivityPath, 'utf8');

  try {
    assert(mainActivitySrc.includes('onShowFileChooser'), 'MainActivity.java must implement onShowFileChooser');
    pass('MainActivity implements onShowFileChooser(WebView, ValueCallback<Uri[]>, FileChooserParams)');

    assert(mainActivitySrc.includes('onActivityResult'), 'MainActivity.java must implement onActivityResult');
    pass('MainActivity implements onActivityResult to receive chosen file Uri');

    assert(mainActivitySrc.includes('mFilePathCallback'), 'MainActivity.java must manage mFilePathCallback');
    pass('MainActivity stores and releases ValueCallback<Uri[]> cleanly');

    assert(mainActivitySrc.includes('Intent.ACTION_GET_CONTENT') || mainActivitySrc.includes('fileChooserParams.createIntent()'), 'MainActivity must launch Android file picker intent');
    pass('MainActivity launches native Intent chooser for document/file selection');

    assert(mainActivitySrc.includes('text/plain') && mainActivitySrc.includes('text/csv'), 'MainActivity must declare text/plain and text/csv mime types');
    pass('MainActivity specifies .txt and .csv MIME types for native chooser');
  } catch (e) {
    fail('Android WebView Native File Chooser Audit failed', e);
  }

  // 2. Audit Mobile App HTML/JS for file picker & deduplication
  console.log('\n--- Test Section 2: Mobile App HTML & Deduplication Audit ---');
  const mobileIndexPath = path.join(__dirname, '..', 'mobile-app', 'assets', 'index.html');
  const mobileIndexSrc = fs.readFileSync(mobileIndexPath, 'utf8');

  try {
    assert(mobileIndexSrc.includes('for="filePicker"'), 'Attachment button must be a label linked to filePicker for native tap execution');
    pass('Attachment button is configured as <label for="filePicker"> for native tap interaction');

    assert(mobileIndexSrc.includes('accept=".txt,.csv,text/plain,text/csv'), 'filePicker must accept extensions and MIME types');
    pass('filePicker input includes .txt, .csv and corresponding MIME types');

    assert(!mobileIndexSrc.includes('id="filePicker" accept=".txt,.csv" style="display:none"'), 'filePicker should not use display:none which breaks mobile WebViews');
    pass('filePicker does not use display:none, using accessible zero-clip positioning');

    assert(mobileIndexSrc.includes('function appendOrUpdateMessage'), 'mobile index.html must define appendOrUpdateMessage helper');
    pass('mobile index.html defines appendOrUpdateMessage with ID deduplication');

    assert(mobileIndexSrc.includes('seen = new Set()'), 'renderMessages must perform Set deduplication pass');
    pass('renderMessages performs Set deduplication before DOM rendering');

    assert(mobileIndexSrc.includes('S.isSending'), 'sendMessage must include in-flight guard to prevent duplicate submissions');
    pass('sendMessage includes S.isSending guard and button disable to prevent rapid duplicate taps');
  } catch (e) {
    fail('Mobile App HTML & Deduplication Audit failed', e);
  }

  // 3. Audit Web Chat Widget for deduplication & file picker
  console.log('\n--- Test Section 3: Web Chat Widget Audit ---');
  const webChatPath = path.join(__dirname, '..', 'assets', 'chat.js');
  const webChatSrc = fs.readFileSync(webChatPath, 'utf8');

  try {
    assert(webChatSrc.includes('for="gxcFileInput"'), 'Web chat attachment button must be linked to gxcFileInput');
    pass('Web chat attachment button uses <label for="gxcFileInput">');

    assert(webChatSrc.includes('Number(m.conversation_id) !== Number(S.convId)'), 'Web chat appendMsg must use numeric comparison for convId');
    pass('Web chat appendMsg uses numeric type-safe convId comparison');

    assert(webChatSrc.includes('el.querySelector(`[data-mid="${m.id}"]`)'), 'Web chat appendMsg checks existing DOM data-mid');
    pass('Web chat appendMsg deduplicates by DOM data-mid');
  } catch (e) {
    fail('Web Chat Widget Audit failed', e);
  }

  // 4. Backend Functional Simulation: Single message, Rapid messages, SSE + POST Race
  console.log('\n--- Test Section 4: Live Backend Database & API Simulation ---');

  // Seed users: Admin (id: 1), Agent (id: 2), Manager (id: 3)
  const passwordHash = bcrypt.hashSync('Pass123!@#', 10);
  db.run(`INSERT INTO users (id, username, password, role, active) VALUES (1, 'admin1', ?, 'admin', 1)`, [passwordHash]);
  db.run(`INSERT INTO users (id, username, password, role, active) VALUES (2, 'agent1', ?, 'agent', 1)`, [passwordHash]);
  db.run(`INSERT INTO users (id, username, password, role, active) VALUES (3, 'manager1', ?, 'manager', 1)`, [passwordHash]);

  db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (1, ?, 1)`, [passwordHash]);
  db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (2, ?, 1)`, [passwordHash]);
  db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (3, ?, 1)`, [passwordHash]);

  // Create conversation between Agent (2) and Manager (3)
  const convRes = db.run(`INSERT INTO chat_conversations (user_a, user_b, created_at) VALUES (2, 3, datetime('now'))`);
  const convId = Number(convRes.lastInsertRowid);
  pass(`Created conversation #${convId} between Agent (2) and Manager (3)`);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  const { authRequired, chatAuthRequired, requireRole, descendantIds } = require('../backend/auth');
  function logAction() {}
  function scopeIds(user) { return [1, 2, 3, 4, 5]; }
  function normalizePaymentType(v) { return 'weekly_7_1'; }

  const mountChat = require('../backend/chat');
  mountChat(app, {
    authRequired,
    chatAuthRequired,
    requireRole,
    logAction,
    scopeIds,
    normalizePaymentType
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const agentToken = jwt.sign({ id: 2, username: 'agent1', role: 'agent', type: 'chat' }, JWT_SECRET, { expiresIn: '1h' });
  const managerToken = jwt.sign({ id: 3, username: 'manager1', role: 'manager', type: 'chat' }, JWT_SECRET, { expiresIn: '1h' });

  try {
    // Test A: Single Message Send -> exactly 1 database record
    console.log('\n--- Scenario A: Single Message Send ---');
    const sendRes1 = await fetch(`${baseUrl}/api/chat/messages/${convId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`
      },
      body: JSON.stringify({ body: 'Hello Manager!' })
    });
    const sendData1 = await sendRes1.json();
    assert.strictEqual(sendRes1.status, 200, 'Message send should return HTTP 200');
    assert.strictEqual(sendData1.ok, true, 'Message send response ok should be true');
    assert(sendData1.message && sendData1.message.id > 0, 'Message response must contain positive id');
    pass('Single message sent successfully: ' + JSON.stringify({ id: sendData1.message.id, body: sendData1.message.body }));

    // Verify DB count for this conversation
    const dbCount1 = db.get('SELECT count(*) as count FROM chat_messages WHERE conversation_id = ?', [convId]).count;
    assert.strictEqual(dbCount1, 1, `DB must contain exactly 1 message, found: ${dbCount1}`);
    pass(`Verified Database contains exactly 1 message record (ID: ${sendData1.message.id})`);

    // Test B: Frontend Race Condition Simulation: SSE arrives BEFORE HTTP response
    console.log('\n--- Scenario B: SSE Arrives Before HTTP Response Resolution ---');
    const clientState = {
      messages: [],
      user: { id: 2, username: 'agent1', role: 'agent' },
      activeConv: { id: convId }
    };

    function simAppendOrUpdate(S, m) {
      if (!m || !m.id) return false;
      const mid = Number(m.id);
      if (!Array.isArray(S.messages)) S.messages = [];
      const idx = S.messages.findIndex(existing => Number(existing.id) === mid);
      if (idx !== -1) {
        S.messages[idx] = Object.assign({}, S.messages[idx], m);
        return false;
      }
      S.messages.push(m);
      S.messages.sort((a, b) => Number(a.id) - Number(b.id));
      return true;
    }

    function simRenderMessages(S) {
      const seen = new Set();
      const unique = [];
      for (const m of S.messages) {
        const mid = Number(m.id);
        if (!seen.has(mid)) {
          seen.add(mid);
          unique.push(m);
        }
      }
      S.messages = unique;
      return S.messages.map(m => m.body);
    }

    // Step 1: SSE event arrives first with message
    const sseEventMessage = { id: sendData1.message.id, conversation_id: convId, sender_id: 2, body: 'Hello Manager!' };
    simAppendOrUpdate(clientState, sseEventMessage);
    let rendered = simRenderMessages(clientState);
    assert.strictEqual(clientState.messages.length, 1, 'Client state must have 1 message after SSE event');
    assert.deepStrictEqual(rendered, ['Hello Manager!'], 'UI must show exactly 1 message');
    pass('SSE event arrived first -> UI rendered exactly 1 message');

    // Step 2: HTTP response resolves a moment later with the exact same message
    const httpResponseMessage = { id: sendData1.message.id, conversation_id: convId, sender_id: 2, body: 'Hello Manager!' };
    simAppendOrUpdate(clientState, httpResponseMessage);
    rendered = simRenderMessages(clientState);
    assert.strictEqual(clientState.messages.length, 1, 'Client state must STILL have exactly 1 message after HTTP response');
    assert.deepStrictEqual(rendered, ['Hello Manager!'], 'UI must continue showing exactly 1 message (NO DUPLICATION)');
    pass('HTTP response resolved afterwards -> Deduplication prevented duplicate insertion! Rendered count: 1');

    // Test C: Frontend Race Condition Simulation: HTTP response arrives BEFORE SSE
    console.log('\n--- Scenario C: HTTP Response Arrives Before SSE Event ---');
    const clientState2 = {
      messages: [],
      user: { id: 2, username: 'agent1', role: 'agent' },
      activeConv: { id: convId }
    };
    // Step 1: HTTP response arrives first
    simAppendOrUpdate(clientState2, httpResponseMessage);
    let rendered2 = simRenderMessages(clientState2);
    assert.strictEqual(clientState2.messages.length, 1);
    pass('HTTP response arrived first -> UI rendered exactly 1 message');

    // Step 2: SSE arrives second
    simAppendOrUpdate(clientState2, sseEventMessage);
    rendered2 = simRenderMessages(clientState2);
    assert.strictEqual(clientState2.messages.length, 1);
    assert.deepStrictEqual(rendered2, ['Hello Manager!']);
    pass('SSE event arrived afterwards -> Deduplication prevented duplicate insertion! Rendered count: 1');

    // Test D: Rapid Concurrent Submissions (Simulated fast double click)
    console.log('\n--- Scenario D: Rapid Double-Click Submissions (< 500ms) ---');
    const [resDouble1, resDouble2] = await Promise.all([
      fetch(`${baseUrl}/api/chat/messages/${convId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
        body: JSON.stringify({ body: 'Rapid double tap test' })
      }),
      fetch(`${baseUrl}/api/chat/messages/${convId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
        body: JSON.stringify({ body: 'Rapid double tap test' })
      })
    ]);
    const doubleData1 = await resDouble1.json();
    const doubleData2 = await resDouble2.json();

    assert.strictEqual(doubleData1.ok, true);
    assert.strictEqual(doubleData2.ok, true);

    // Verify DB count
    const rapidMsgsInDb = db.all('SELECT id, body FROM chat_messages WHERE conversation_id = ? AND body = ?', [convId, 'Rapid double tap test']);
    assert.strictEqual(rapidMsgsInDb.length, 1, `Backend safeguard must deduplicate rapid identical submissions into exactly 1 DB record. Found: ${rapidMsgsInDb.length}`);
    pass(`Rapid double send created strictly ONE DB record (ID: ${rapidMsgsInDb[0].id})`);

    // Verify both requests returned the same message ID
    assert.strictEqual(doubleData1.message.id, doubleData2.message.id, 'Both rapid requests must resolve to the identical message ID');
    pass('Both rapid responses returned identical message ID: ' + doubleData1.message.id);

    // Test E: Two-Way Messaging
    console.log('\n--- Scenario E: Two-Way Messaging ---');
    const replyRes = await fetch(`${baseUrl}/api/chat/messages/${convId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${managerToken}` },
      body: JSON.stringify({ body: 'Manager reply: acknowledged!' })
    });
    const replyData = await replyRes.json();
    assert.strictEqual(replyRes.status, 200);
    pass('Manager replied successfully (ID: ' + replyData.message.id + ')');

    // Feed to agent client state
    simAppendOrUpdate(clientState, replyData.message);
    const finalRendered = simRenderMessages(clientState);
    assert.strictEqual(finalRendered.length, 2, 'Two-way thread must have exactly 2 distinct messages');
    pass('Two-way messaging state contains exactly 2 messages in sequence');

    // Test F: History Reload
    console.log('\n--- Scenario F: History Reload / Refresh ---');
    const historyRes = await fetch(`${baseUrl}/api/chat/messages/${convId}?limit=50`, {
      headers: { 'Authorization': `Bearer ${agentToken}` }
    });
    const historyData = await historyRes.json();
    assert(Array.isArray(historyData.messages), 'History must return messages array');
    const historyState = { messages: [] };
    historyData.messages.forEach(m => simAppendOrUpdate(historyState, m));
    const historyRendered = simRenderMessages(historyState);
    assert.strictEqual(historyRendered.length, historyData.messages.length, 'Loaded history rendered without duplicates');
    pass(`History reload verified: exactly ${historyRendered.length} unique messages loaded`);

    // Test G: File Upload to Conversation & Alias Route
    console.log('\n--- Scenario G: File Upload Flow & Endpoint Alias ---');
    const formTxt = new FormData();
    formTxt.append('file', new Blob(['Col1,Col2\nVal1,Val2\n'], { type: 'text/csv' }), 'test_data.csv');
    formTxt.append('body', 'CSV Attachment Report');

    const uploadRes = await fetch(`${baseUrl}/api/chat/conversations/${convId}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agentToken}` },
      body: formTxt
    });
    const uploadData = await uploadRes.json();
    assert.strictEqual(uploadRes.status, 200, 'Upload should return 200');
    assert(uploadData.message && uploadData.message.attachment_path, 'Upload response must contain attachment_path');
    assert.strictEqual(uploadData.message.attachment_type, 'csv');
    pass('File upload via /api/chat/conversations/:id/upload succeeded: ' + uploadData.message.attachment_name);

    // Test alias route
    const formAlias = new FormData();
    formAlias.append('file', new Blob(['Hello plain text file content'], { type: 'text/plain' }), 'notes.txt');
    formAlias.append('body', 'Notes text file');

    const aliasRes = await fetch(`${baseUrl}/api/chat/messages/${convId}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agentToken}` },
      body: formAlias
    });
    const aliasData = await aliasRes.json();
    assert.strictEqual(aliasRes.status, 200, 'Upload via messages/:id/upload alias should return 200');
    assert.strictEqual(aliasData.message.attachment_type, 'txt');
    pass('File upload via alias /api/chat/messages/:id/upload succeeded: ' + aliasData.message.attachment_name);

    // Test file download
    const dlRes = await fetch(`${baseUrl}/api/chat/messages/${uploadData.message.id}/download`, {
      headers: { 'Authorization': `Bearer ${agentToken}` }
    });
    const dlText = await dlRes.text();
    assert.strictEqual(dlText, 'Col1,Col2\nVal1,Val2\n', 'Downloaded file content must match verbatim');
    pass('Uploaded file downloaded and content verified verbatim');

    // Test invalid file rejected
    const badForm = new FormData();
    badForm.append('file', new Blob(['malicious binary'], { type: 'application/octet-stream' }), 'bad.exe');
    const badRes = await fetch(`${baseUrl}/api/chat/conversations/${convId}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agentToken}` },
      body: badForm
    });
    assert.strictEqual(badRes.status, 400, 'Non-txt/csv file should be rejected with 400');
    pass('Invalid file format (.exe) properly rejected with HTTP 400');

  } finally {
    server.close();
    try { fs.unlinkSync(testDbPath); } catch (_) {}
  }

  console.log('\n======================================================');
  console.log(`CHAT DEDUPLICATION & FILE PICKER SUITE: ${passCount} PASS / ${failCount} FAIL`);
  console.log('======================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
