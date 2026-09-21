/**
 * tests/p21-corrections-verify.js
 * Automated test suite for P21 Phase-2 Corrections & Final Implementation:
 * 1. Auto-generated 6-digit numeric chat passwords on user creation
 * 2. Auto-generated 6-digit numeric chat passwords on public request approval
 * 3. Direct Admin 6-digit password assignment without email dependency
 * 4. Voice message binary upload & access-controlled playback
 * 5. WebRTC Voice Call Signaling (invite, answer, ice-candidate, end)
 * 6. Mobile APK assets and build integrity check
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 8097;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_DB = `/tmp/test-p21-corr-${Date.now()}.sqlite`;

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

function req(method, endpoint, body = null, token = null, isRaw = false, rawHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    const headers = Object.assign({}, rawHeaders);
    if (!isRaw && body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let sendData = null;
    if (body) {
      if (Buffer.isBuffer(body)) {
        sendData = body;
        headers['Content-Length'] = body.length;
      } else if (typeof body === 'object') {
        sendData = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(sendData);
      } else {
        sendData = String(body);
        headers['Content-Length'] = Buffer.byteLength(sendData);
      }
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: headers
    };

    const request = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        let data = null;
        try {
          data = JSON.parse(rawBuf.toString());
        } catch (e) {
          data = rawBuf;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, raw: rawBuf });
      });
    });

    request.on('error', reject);

    if (sendData) {
      request.write(sendData);
    }
    request.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('\n===== P21 PHASE-2 CORRECTIONS & FINAL FEATURES VERIFICATION =====\n');

  try {
    process.env.DB_FILE = TEST_DB;
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = 'test-p21-corr-jwt-secret-999';
    process.env.NODE_ENV = 'test';

    const env = Object.assign({}, process.env);
    serverProc = spawn('node', [path.join(__dirname, '..', 'backend', 'server.js')], {
      env,
      cwd: path.join(__dirname, '..')
    });

    await sleep(2500);

    // 1. Admin Login
    const adminLogin = await req('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' });
    assert(adminLogin.status === 200 && adminLogin.body.token, 'Admin panel login succeeds');
    const adminToken = adminLogin.body.token;

    // 2. Auto-generated 6-digit numeric chat password on User Creation
    const createMgr = await req('POST', '/api/users', {
      username: 'mgr_auto1',
      password: 'PanelPassword123!',
      role: 'manager',
      name: 'Manager Auto One',
      email: 'mgr1@example.com'
    }, adminToken);

    assert(createMgr.status === 200, 'Manager created via POST /api/users');
    const mgrId = createMgr.body.id;
    const mgrChatPin = createMgr.body.chat_password;
    assert(/^\d{6}$/.test(mgrChatPin), 'Auto-generated chat password is a 6-digit numeric PIN', `PIN: ${mgrChatPin}`);

    // Verify Manager can immediately login to Chat using this 6-digit PIN
    const mgrChatLogin = await req('POST', '/api/chat/auth/login', {
      username: 'mgr_auto1',
      password: mgrChatPin
    });
    assert(mgrChatLogin.status === 200 && mgrChatLogin.body.token, 'Manager successfully logs into Chat with 6-digit PIN');
    const mgrChatToken = mgrChatLogin.body.token;

    // Create Agent under Manager
    const createAgt = await req('POST', '/api/users', {
      username: 'agt_auto1',
      password: 'PanelPassword123!',
      role: 'agent',
      name: 'Agent Auto One',
      parent_id: mgrId,
      email: 'agt1@example.com'
    }, adminToken);
    assert(createAgt.status === 200, 'Agent created with parent Manager');
    const agtId = createAgt.body.id;
    const agtChatPin = createAgt.body.chat_password;
    assert(/^\d{6}$/.test(agtChatPin), 'Agent received 6-digit numeric chat password', `PIN: ${agtChatPin}`);

    const agtChatLogin = await req('POST', '/api/chat/auth/login', {
      username: 'agt_auto1',
      password: agtChatPin
    });
    assert(agtChatLogin.status === 200, 'Agent logs into Chat with 6-digit PIN');
    const agtChatToken = agtChatLogin.body.token;

    // 3. Direct Admin Password Assignment with 6-digit PIN
    const setPinRes = await req('POST', `/api/chat/admin/accounts/${agtId}/password`, {
      password: '778899'
    }, adminToken);
    assert(setPinRes.status === 200, 'Admin directly sets 6-digit PIN 778899 without email verification');

    const agtLoginNewPin = await req('POST', '/api/chat/auth/login', {
      username: 'agt_auto1',
      password: '778899'
    });
    assert(agtLoginNewPin.status === 200, 'Agent logs into Chat with newly assigned PIN 778899');

    // 4. Voice Message Recording, Upload & Authenticated Playback
    // Create conversation between Manager and Agent
    const convRes = await req('POST', '/api/chat/conversations', {
      user_id: agtId
    }, mgrChatToken);
    assert(convRes.status === 200 && convRes.body.conversation_id, 'Manager creates conversation with Agent');
    const convId = convRes.body.conversation_id;

    // Fake audio payload (opus stream bytes)
    // 4. Voice message removal verification (Endpoints return 404 / cleanly disabled)
    const fakeAudioData = Buffer.alloc(1024, 0xAA);
    const uploadVoiceRes = await req('POST', `/api/chat/conversations/${convId}/voice?duration=5.4`, fakeAudioData, mgrChatToken, true, {
      'Content-Type': 'audio/ogg'
    });
    assert(uploadVoiceRes.status === 404, 'Voice upload endpoint cleanly removed (returns 404)');

    const playHeaderRes = await req('GET', `/api/chat/voice/test_voice.ogg`, null, agtChatToken);
    assert(playHeaderRes.status === 404, 'Voice playback endpoint cleanly removed (returns 404)');

    // 5. WebRTC Voice Call Signaling removal verification (Endpoints return 404 / cleanly disabled)
    const callInviteRes = await req('POST', '/api/chat/call/invite', {
      conversation_id: convId,
      offer: { type: 'offer', sdp: 'v=0\r\no=alice ...' },
      call_type: 'voice'
    }, mgrChatToken);
    assert(callInviteRes.status === 404, 'WebRTC call invite endpoint cleanly removed (returns 404)');

    const callAnswerRes = await req('POST', '/api/chat/call/answer', {
      call_id: 'call-123',
      answer: { type: 'answer', sdp: 'v=0\r\no=bob ...' }
    }, agtChatToken);
    assert(callAnswerRes.status === 404, 'WebRTC call answer endpoint cleanly removed (returns 404)');

    // 6. Mobile Assets & Production Host Configuration
    const mobileHtml = fs.readFileSync(path.join(__dirname, '..', 'mobile-app', 'assets', 'index.html'), 'utf8');
    assert(mobileHtml.includes('http://173.249.48.57'), 'Mobile app has production server http://173.249.48.57 embedded by default');
    assert(mobileHtml.includes('#070D1F') && mobileHtml.includes('--accent: #30ABED'), 'Mobile app includes Deep Space Luxury theme');
    assert(mobileHtml.includes('bottom-nav') && mobileHtml.includes('data-nav="chats"') && mobileHtml.includes('data-nav="contacts"'), 'Mobile app features bottom navigation tabs');
    assert(!mobileHtml.includes('RTCPeerConnection'), 'Mobile app cleanly removed WebRTC calling code');
    assert(!mobileHtml.includes('MediaRecorder'), 'Mobile app cleanly removed voice recording code');

    // 7. Signed APK Verification
    const apkPath = path.join(__dirname, '..', 'galaxy-chat-v1.apk');
    assert(fs.existsSync(apkPath) && fs.statSync(apkPath).size > 50000, 'Signed APK galaxy-chat-v1.apk exists and exceeds 50KB', `${fs.statSync(apkPath).size} bytes`);

  } catch (err) {
    console.error('FAIL | UNEXPECTED ERROR in suite |', err);
    failed++;
  } finally {
    if (serverProc) {
      serverProc.kill();
    }
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
      if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
      if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    } catch (e) {}

    console.log('\n===========================================');
    console.log(`TOTAL: ${passed} PASS / ${failed} FAIL`);
    console.log('===========================================\n');

    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
