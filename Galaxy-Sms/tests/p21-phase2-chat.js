/**
 * tests/p21-phase2-chat.js
 * Comprehensive automated test suite for Phase-2 Chat features:
 * - Message Deletion: "Delete for Me" (caller-only soft delete)
 * - Message Deletion: "Delete for Everyone" (sender within 15 min or Admin anytime, tombstone semantics)
 * - Exceeded 15-minute deletion window enforcement
 * - IDOR security on deletions
 * - Admin Conversation Categorization (direct, manager_chats, agent_chats, client_chats)
 * - Non-admin conversation split filtering (My Agents vs Admin Support, My Manager vs My Clients)
 * - Spectator metadata validation (sender names, roles, usernames in 3rd party viewing)
 * - Admin global search endpoint authorization and indexed query
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 8094;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_DB = `/tmp/test-p21-phase2-${Date.now()}.sqlite`;

let serverProc = null;
let passed = 0;
let failed = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`PASS | ${testName}${details ? ' | ' + details : ''}`);
    passed++;
  } else {
    console.error(`FAIL | ${testName}${details ? ' | ' + details : ''}`);
    failed++;
  }
}

function req(method, endpoint, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: headers
    };

    const request = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    request.on('error', reject);
    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('\n===== P21 PHASE-2 ADVANCED CHAT FEATURES VERIFICATION =====\n');

  try {
    process.env.DB_FILE = TEST_DB;
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = 'test-p21-phase2-jwt-secret-xyz987';
    process.env.NODE_ENV = 'test';

    const env = Object.assign({}, process.env);

    serverProc = spawn('node', [path.join(__dirname, '..', 'backend', 'server.js')], {
      env,
      cwd: path.join(__dirname, '..')
    });

    await sleep(2500);

    // 1. Admin login
    const adminLoginRes = await req('POST', '/api/login', {
      username: 'vibepk',
      password: 'vibepk123'
    });
    assert(adminLoginRes.status === 200, 'Admin panel login succeeds');
    const adminPanelToken = adminLoginRes.body.token;

    const adminChatLogin = await req('POST', '/api/chat/auth/login', {
      username: 'vibepk',
      password: 'vibepk123'
    });
    assert(adminChatLogin.status === 200, 'Admin chat login succeeds');
    const adminChatToken = adminChatLogin.body.token;
    const adminUser = adminChatLogin.body.user;

    // 2. Create Hierarchy: Manager -> Agent -> Client
    const mgrRes = await req('POST', '/api/users', {
      username: 'mgr_faisal',
      name: 'Manager Faisal',
      role: 'manager',
      email: 'faisal@example.com',
      password: 'PanelPass1@',
      chat_password: 'ChatPass1@'
    }, adminPanelToken);
    assert(mgrRes.status === 200, 'Manager created');
    const mgrList = await req('GET', '/api/users/manager', null, adminPanelToken);
    const mgrUser = mgrList.body.find(u => u.username === 'mgr_faisal');
    const mgrId = mgrUser.id;

    const agtRes = await req('POST', '/api/users', {
      username: 'agt_salman',
      name: 'Agent Salman',
      role: 'agent',
      email: 'salman@example.com',
      parent_id: mgrId,
      password: 'PanelPass2@',
      chat_password: 'ChatPass2@'
    }, adminPanelToken);
    assert(agtRes.status === 200, 'Agent created with parent Manager');
    const agtList = await req('GET', '/api/users/agent', null, adminPanelToken);
    const agtUser = agtList.body.find(u => u.username === 'agt_salman');
    const agtId = agtUser.id;

    const cliRes = await req('POST', '/api/users', {
      username: 'cli_kamran',
      name: 'Client Kamran',
      role: 'client',
      email: 'kamran@example.com',
      parent_id: agtId,
      password: 'PanelPass3@',
      chat_password: 'ChatPass3@'
    }, adminPanelToken);
    assert(cliRes.status === 200, 'Client created with parent Agent');
    const cliList = await req('GET', '/api/users/client', null, adminPanelToken);
    const cliUser = cliList.body.find(u => u.username === 'cli_kamran');
    const cliId = cliUser.id;

    // 3. Login to chat as Manager, Agent, Client
    const mgrChat = await req('POST', '/api/chat/auth/login', { username: 'mgr_faisal', password: 'ChatPass1@' });
    const agtChat = await req('POST', '/api/chat/auth/login', { username: 'agt_salman', password: 'ChatPass2@' });
    const cliChat = await req('POST', '/api/chat/auth/login', { username: 'cli_kamran', password: 'ChatPass3@' });

    assert(mgrChat.status === 200 && agtChat.status === 200 && cliChat.status === 200, 'All role accounts logged into chat');
    const mgrToken = mgrChat.body.token;
    const agtToken = agtChat.body.token;
    const cliToken = cliChat.body.token;

    console.log('\n--- Section 1: Hierarchy Messaging & Spectator Metadata ---');
    // Agent starts conversation with Manager
    const agtToMgrConv = await req('POST', '/api/chat/conversations', { user_id: mgrId }, agtToken);
    assert(agtToMgrConv.status === 200 && agtToMgrConv.body.conversation_id, 'Agent creates conv with Manager');
    const convAgtMgrId = agtToMgrConv.body.conversation_id;

    // Agent sends a message to Manager
    const m1Res = await req('POST', `/api/chat/messages/${convAgtMgrId}`, {
      body: 'Hello Manager Faisal, need approval on batch 401'
    }, agtToken);
    assert(m1Res.status === 200 && m1Res.body.ok, 'Agent sends M1 to Manager');
    const msg1Id = m1Res.body.message.id;

    // Manager replies to Agent
    const m2Res = await req('POST', `/api/chat/messages/${convAgtMgrId}`, {
      body: 'Approved Salman, proceed with batch 401.'
    }, mgrToken);
    assert(m2Res.status === 200 && m2Res.body.ok, 'Manager sends M2 reply to Agent');
    const msg2Id = m2Res.body.message.id;

    // Client starts conversation with Agent
    const cliToAgtConv = await req('POST', '/api/chat/conversations', { user_id: agtId }, cliToken);
    assert(cliToAgtConv.status === 200 && cliToAgtConv.body.conversation_id, 'Client creates conv with Agent');
    const convCliAgtId = cliToAgtConv.body.conversation_id;

    const m3Res = await req('POST', `/api/chat/messages/${convCliAgtId}`, {
      body: 'Dear Agent, my campaign 99 has completed successfully.'
    }, cliToken);
    assert(m3Res.status === 200 && m3Res.body.ok, 'Client sends M3 to Agent');
    const msg3Id = m3Res.body.message.id;

    // Admin starts direct conversation with Manager
    const adminToMgrConv = await req('POST', '/api/chat/conversations', { user_id: mgrId }, adminChatToken);
    assert(adminToMgrConv.status === 200 && adminToMgrConv.body.conversation_id, 'Admin creates direct conv with Manager');
    const convAdminMgrId = adminToMgrConv.body.conversation_id;

    const mAdminRes = await req('POST', `/api/chat/messages/${convAdminMgrId}`, {
      body: 'Directive from HQ: review quota allocations.'
    }, adminChatToken);
    assert(mAdminRes.status === 200 && mAdminRes.body.ok, 'Admin sends direct message to Manager');

    console.log('\n--- Section 2: Conversation Filtering & Splitting ---');
    // Admin filtering:
    // 2.1 filter=direct -> should ONLY return conv with Admin as direct participant
    const adminDirect = await req('GET', '/api/chat/conversations?scope=all&filter=direct', null, adminChatToken);
    assert(adminDirect.status === 200, 'Admin get filter=direct returns 200');
    assert(Array.isArray(adminDirect.body) && adminDirect.body.length === 1 && adminDirect.body[0].id === convAdminMgrId,
      'Admin filter=direct returns exactly direct admin conversations');

    // 2.2 filter=manager_chats -> convAgtMgrId or convAdminMgrId (both involve manager)
    const adminMgrChats = await req('GET', '/api/chat/conversations?scope=all&filter=manager_chats', null, adminChatToken);
    assert(adminMgrChats.status === 200, 'Admin get filter=manager_chats returns 200');
    const hasAgtMgr = adminMgrChats.body.some(c => c.id === convAgtMgrId);
    assert(hasAgtMgr, 'Admin filter=manager_chats includes Manager-Agent conversation');

    // 2.3 filter=client_chats -> convCliAgtId
    const adminCliChats = await req('GET', '/api/chat/conversations?scope=all&filter=client_chats', null, adminChatToken);
    assert(adminCliChats.status === 200, 'Admin get filter=client_chats returns 200');
    const hasCliAgt = adminCliChats.body.some(c => c.id === convCliAgtId);
    assert(hasCliAgt, 'Admin filter=client_chats includes Client-Agent conversation');

    // Manager filtering:
    // Manager has 2 chats: Admin (filter=manager/admin) and Agent (filter=agents)
    const mgrAgentsList = await req('GET', '/api/chat/conversations?filter=agents', null, mgrToken);
    assert(mgrAgentsList.body.some(c => c.id === convAgtMgrId),
      'Manager filter=agents shows Agent chat');
    const mgrAdminList = await req('GET', '/api/chat/conversations?filter=manager', null, mgrToken);
    assert(mgrAdminList.body.some(c => c.id === convAdminMgrId),
      'Manager filter=manager shows Admin Support chat');

    // Agent filtering:
    // Agent has 2 chats: Manager (filter=manager) and Client (filter=clients)
    const agtMgrList = await req('GET', '/api/chat/conversations?filter=manager', null, agtToken);
    assert(agtMgrList.body.some(c => c.id === convAgtMgrId),
      'Agent filter=manager shows Manager chat');
    const agtCliList = await req('GET', '/api/chat/conversations?filter=clients', null, agtToken);
    assert(agtCliList.body.some(c => c.id === convCliAgtId),
      'Agent filter=clients shows Client chat');

    console.log('\n--- Section 3: Spectator Mode Identification ---');
    // Admin reads convCliAgtId messages (Admin is a spectator, neither sender nor recipient)
    const adminViewCliConv = await req('GET', `/api/chat/messages/${convCliAgtId}`, null, adminChatToken);
    assert(adminViewCliConv.status === 200, 'Admin spectator reads 3rd-party conversation messages');
    const specMsg = adminViewCliConv.body.messages.find(m => m.id === msg3Id);
    assert(specMsg && specMsg.sender_name === 'Client Kamran' && specMsg.sender_role === 'Client',
      'Spectator message carries sender_name and sender_role for visual differentiation');

    console.log('\n--- Section 4: "Delete for Me" Soft-Deletion ---');
    // Agent sends message M4 to Manager
    const m4Res = await req('POST', `/api/chat/messages/${convAgtMgrId}`, {
      body: 'M4: Confidential draft note for my eyes only later.'
    }, agtToken);
    const msg4Id = m4Res.body.message.id;

    // Agent calls delete-for-me on msg4Id
    const delForMeRes = await req('POST', `/api/chat/messages/${msg4Id}/delete-for-me`, {}, agtToken);
    assert(delForMeRes.status === 200 && delForMeRes.body && delForMeRes.body.ok === true && delForMeRes.body.mode === 'delete_for_me',
      'Agent calls delete-for-me successfully');

    // Agent fetches messages: msg4Id MUST NOT appear in Agent list
    const agtMessages = await req('GET', `/api/chat/messages/${convAgtMgrId}`, null, agtToken);
    const foundByAgt = agtMessages.body.messages.some(m => m.id === msg4Id);
    assert(!foundByAgt, 'Message is completely hidden for Agent after delete-for-me');

    // Manager fetches messages: msg4Id MUST still appear for Manager!
    const mgrMessages = await req('GET', `/api/chat/messages/${convAgtMgrId}`, null, mgrToken);
    const foundByMgr = mgrMessages.body.messages.some(m => m.id === msg4Id);
    assert(foundByMgr, 'Message remains fully visible to Manager counterparty');

    // Idempotent delete-for-me
    const delForMeAgain = await req('POST', `/api/chat/messages/${msg4Id}/delete-for-me`, {}, agtToken);
    assert(delForMeAgain.status === 200 && delForMeAgain.body && delForMeAgain.body.ok === true,
      'Second delete-for-me call is idempotent and safe');

    // IDOR test: Client attempts delete-for-me on msg4Id (which is between Agent and Manager)
    const idorDelMe = await req('POST', `/api/chat/messages/${msg4Id}/delete-for-me`, {}, cliToken);
    assert(idorDelMe.status === 403 || idorDelMe.status === 404,
      'Non-participant cannot delete-for-me another user message (403/404)');

    console.log('\n--- Section 5: "Delete for Everyone" Tombstone Semantics ---');
    // Agent sends message M5 to Manager
    const m5Res = await req('POST', `/api/chat/messages/${convAgtMgrId}`, {
      body: 'M5: Typo in this message that sender wants to retract!'
    }, agtToken);
    const msg5Id = m5Res.body.message.id;

    // Recipient (Manager) tries to delete for everyone -> forbidden
    const mgrDelEveryoneFail = await req('POST', `/api/chat/messages/${msg5Id}/delete-for-everyone`, {}, mgrToken);
    assert(mgrDelEveryoneFail.status === 403, 'Recipient cannot delete message for everyone (403)');

    // Sender (Agent) deletes for everyone within 15 minutes -> success
    const agtDelEveryone = await req('POST', `/api/chat/messages/${msg5Id}/delete-for-everyone`, {}, agtToken);
    assert(agtDelEveryone.status === 200 && agtDelEveryone.body && agtDelEveryone.body.ok === true && agtDelEveryone.body.mode === 'delete_for_everyone',
      'Sender successfully deletes for everyone within window');

    // Agent checks messages: msg5Id has tombstone "This message was deleted"
    const agtMsgAfterDel = await req('GET', `/api/chat/messages/${convAgtMgrId}`, null, agtToken);
    const tombstoneAgt = agtMsgAfterDel.body.messages.find(m => m.id === msg5Id);
    assert(tombstoneAgt && tombstoneAgt.is_deleted === true && tombstoneAgt.body === 'This message was deleted',
      'Agent sees tombstone "This message was deleted"');

    // Manager checks messages: also sees tombstone
    const mgrMsgAfterDel = await req('GET', `/api/chat/messages/${convAgtMgrId}`, null, mgrToken);
    const tombstoneMgr = mgrMsgAfterDel.body.messages.find(m => m.id === msg5Id);
    assert(tombstoneMgr && tombstoneMgr.is_deleted === true && tombstoneMgr.body === 'This message was deleted',
      'Manager sees tombstone "This message was deleted"');

    console.log('\n--- Section 6: Exceeded 15-Minute Window & Admin Override ---');
    // Send M6
    const oldMsgRes = await req('POST', `/api/chat/messages/${convAgtMgrId}`, {
      body: 'M6: Message from half an hour ago.'
    }, agtToken);
    const msg6Id = oldMsgRes.body.message.id;

    // Direct DB update to set created_at = 30 minutes ago
    const Database = require('better-sqlite3');
    const oldTime = new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const directDb = new Database(TEST_DB);
    directDb.prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(oldTime, msg6Id);
    directDb.close();

    // Agent tries to delete-for-everyone on expired message -> 403
    const agtExpiredDel = await req('POST', `/api/chat/messages/${msg6Id}/delete-for-everyone`, {}, agtToken);
    assert(agtExpiredDel.status === 403 && agtExpiredDel.body.error.includes('15 minutes'),
      'Sender cannot delete for everyone after 15 minutes window has expired (403)');

    // Admin CAN delete-for-everyone anytime (Admin bypass)
    const adminDelOverride = await req('POST', `/api/chat/messages/${msg6Id}/delete-for-everyone`, {}, adminChatToken);
    if (!adminDelOverride.body || !adminDelOverride.body.ok) console.log('DEBUG adminDelOverride:', adminDelOverride);
    assert(adminDelOverride.status === 200 && adminDelOverride.body && adminDelOverride.body.ok === true && adminDelOverride.body.mode === 'delete_for_everyone',
      'Admin can delete for everyone after 15 minutes window (Admin privilege)');

    console.log('\n--- Section 7: Admin Global Search Endpoint ---');
    // Non-admin search attempt -> 403
    const nonAdminSearch = await req('GET', '/api/chat/admin/search?q=quota', null, mgrToken);
    assert(nonAdminSearch.status === 403, 'Non-admin forbidden from Admin search endpoint (403)');

    // Admin search for keyword "quota"
    const adminSearchRes = await req('GET', '/api/chat/admin/search?q=quota', null, adminChatToken);
    assert(adminSearchRes.status === 200, 'Admin search returns 200');
    assert(Array.isArray(adminSearchRes.body.results) && adminSearchRes.body.results.length >= 1,
      'Admin search finds matching message by text');
    assert(adminSearchRes.body.results[0].body.includes('quota'),
      'Admin search result contains expected message content');

    // Admin search for user
    const adminSearchUser = await req('GET', '/api/chat/admin/search?q=kamran', null, adminChatToken);
    assert(adminSearchUser.status === 200, 'Admin search by user returns 200');
    assert(adminSearchUser.body.results.some(r => r.sender_username === 'cli_kamran' || r.a_username === 'cli_kamran' || r.b_username === 'cli_kamran'),
      'Admin search finds messages involving specified user');

  } catch (err) {
    console.error('FAIL | UNEXPECTED ERROR in suite |', err);
    failed++;
  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (e) {}
    }
  }

  console.log('\n===========================================');
  console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
  console.log('===========================================\n');
  if (failed > 0) process.exit(1);
}

run();
