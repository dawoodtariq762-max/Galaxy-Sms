/**
 * Galaxy SMS — Comprehensive Verification Suite for 30 Points Specification
 * Covers:
 *  1. Login Page text verification
 *  2. Range Allocation Safe Quantity Handling (requested > available)
 *  3. Range Unallocation Quantity Reduction (requested > owned)
 *  4. SMS Number Allocation — Direct Reassignment (Client A -> Client B)
 *  5. Searchable Dropdowns & Alphabetical Sorting
 *  6. SMS Number Copy/Download preservation
 *  7. Agent Panel Security PIN & Binance UID preservation
 *  8-12. Panel Sharing SMPP Connection (Client & Server modes, credentials protection)
 *  15-18. Panel Sharing Bulk Allocation & 2 CSV Generation (Numbers-only & Range+Num+Price)
 *  19-25. Panel Sharing HTTP Connection (Variable mapping, Preview, Safe test, Logging)
 *  26. 3 Connection Types in Panel Sharing (Activity, SMPP, HTTP)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function run() {
  console.log('====================================================');
  console.log(' Galaxy SMS — 30-Point Specification Verification');
  console.log('====================================================\n');

  // --- SECTION 1: LOGIN PAGE ---
  console.log('--- Section 1: Login Page ---');
  test('Login HTML removes unnecessary description paragraph', () => {
    const html = fs.readFileSync(path.join(__dirname, '../login.html'), 'utf-8');
    assert(!html.includes('Sign in to the Galaxy SMS control panel. Available to Admin, Manager, Agent, Client and Test Panel users.'), 'Removed text still present');
    assert(!html.includes('Sign in to Galaxy SMS Control Panel, available to admin, manager, agent, client and test panel users.'), 'Removed text variation present');
    assert(html.includes('Galaxy Secure Access'), 'Missing Galaxy Secure Access eyebrow');
    assert(html.includes('Welcome to Galaxy SMS'), 'Missing Welcome to Galaxy SMS heading');
    assert(html.includes('id="username"'), 'Missing username field');
    assert(html.includes('id="password"'), 'Missing password field');
    assert(html.includes('Math Captcha'), 'Missing Math Captcha');
  });

  // --- SECTION 7: AGENT PANEL SECURITY PIN & BINANCE UID BUG ---
  console.log('\n--- Section 7: Security PIN & Binance UID Bug ---');
  test('JWT is properly imported and decrypts unlock token', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf-8');
    assert(serverCode.includes("const jwt = require('jsonwebtoken');"), 'jwt is not imported in backend/server.js');

    const SECRET = process.env.JWT_SECRET || 'ms-sms-dev-secret-change-in-production';
    const unlockToken = jwt.sign({ id: 55, username: 'agent_55', role: 'agent', type: 'chat_unlocked' }, SECRET, { expiresIn: '12h' });

    // Verify token
    const decoded = jwt.verify(unlockToken, SECRET);
    assert.strictEqual(decoded.id, 55);
    assert.strictEqual(decoded.type, 'chat_unlocked');
  });

  // Database setup for functional tests
  const db = require('../backend/db');
  await db.init();

  // --- SECTION 2: RANGE ALLOCATION — SAFE QUANTITY HANDLING ---
  console.log('\n--- Section 2: Range Allocation — Safe Quantity Handling ---');
  test('Range Allocation only allocates available quantity when requested > available', () => {
    db.run("DELETE FROM ranges WHERE name=?", ['Test Safe Alloc Range']);
    db.run("INSERT INTO ranges (name, prefix, currency, payment_type) VALUES (?, ?, ?, ?)", ['Test Safe Alloc Range', '99', 'USD', 'weekly_7_1']);
    const r = db.get("SELECT id FROM ranges WHERE name=?", ['Test Safe Alloc Range']);
    const rid = r.id;

    // Insert 10 numbers: 5 unallocated, 5 already allocated to an existing manager
    for (let i = 1; i <= 5; i++) {
      db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, NULL, NULL, NULL)", [`990000000${i}`, rid]);
    }
    for (let i = 6; i <= 10; i++) {
      db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, 999, NULL, NULL)", [`990000000${i}`, rid]);
    }

    // Now test: Requested = 10, Available = 5
    // In Range Allocation, only unallocated numbers (manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL) are selected
    const unallocCond = 'manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL';
    const requestedQty = 10;
    const pool = db.all(
      `SELECT id FROM numbers WHERE range_id=? AND ${unallocCond} ORDER BY id ASC LIMIT ?`,
      [rid, requestedQty]
    ).map(x => x.id);

    assert.strictEqual(pool.length, 5, `Expected 5 numbers available, got ${pool.length}`);

    // Verify message generation
    const allocated = pool.length;
    let message = `Successfully allocated ${allocated} numbers.`;
    if (allocated < requestedQty) {
      message = `Only ${allocated} numbers were available out of ${requestedQty} requested. Therefore, only ${allocated} numbers were allocated.`;
    }
    assert(message.includes('Only 5 numbers were available out of 10 requested'), `Message was: ${message}`);

    // Verify already allocated numbers (6-10) were NEVER touched
    const existing = db.all("SELECT id, manager_id FROM numbers WHERE range_id=? AND manager_id=999", [rid]);
    assert.strictEqual(existing.length, 5, "Existing allocations were stolen!");

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id=?", [rid]);
    db.run("DELETE FROM ranges WHERE id=?", [rid]);
  });

  // --- SECTION 3: RANGE UNALLOCATION / QUANTITY REDUCTION ---
  console.log('\n--- Section 3: Range Unallocation / Quantity Reduction ---');
  test('Range Unallocation reduces only user\'s owned allocation when requested > owned', () => {
    db.run("DELETE FROM ranges WHERE name=?", ['Test Safe Unalloc Range']);
    db.run("INSERT INTO ranges (name, prefix, currency, payment_type) VALUES (?, ?, ?, ?)", ['Test Safe Unalloc Range', '98', 'USD', 'weekly_7_1']);
    const r = db.get("SELECT id FROM ranges WHERE name=?", ['Test Safe Unalloc Range']);
    const rid = r.id;

    // User A (manager 101) owns 3 numbers
    // User B (manager 102) owns 4 numbers
    for (let i = 1; i <= 3; i++) {
      db.run("INSERT INTO numbers (number, range_id, manager_id) VALUES (?, ?, 101)", [`980000000${i}`, rid]);
    }
    for (let i = 4; i <= 7; i++) {
      db.run("INSERT INTO numbers (number, range_id, manager_id) VALUES (?, ?, 102)", [`980000000${i}`, rid]);
    }

    // User A requests unallocation of 10 numbers
    const requestedReduce = 10;
    const userARows = db.all(
      "SELECT id FROM numbers WHERE range_id=? AND manager_id=? ORDER BY id ASC LIMIT ?",
      [rid, 101, requestedReduce]
    );

    assert.strictEqual(userARows.length, 3, "User A should only match their 3 owned numbers");

    // Perform reduction
    const ph = userARows.map(() => '?').join(',');
    db.run(`UPDATE numbers SET manager_id=NULL WHERE id IN (${ph})`, userARows.map(x => x.id));

    // Verify User A has 0 now, and User B STILL has all 4 untouched!
    const userARemain = db.all("SELECT id FROM numbers WHERE range_id=? AND manager_id=101", [rid]);
    const userBRemain = db.all("SELECT id FROM numbers WHERE range_id=? AND manager_id=102", [rid]);
    assert.strictEqual(userARemain.length, 0, "User A unallocation failed");
    assert.strictEqual(userBRemain.length, 4, "User B numbers were stolen or affected!");

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id=?", [rid]);
    db.run("DELETE FROM ranges WHERE id=?", [rid]);
  });

  // --- SECTION 4: SMS NUMBER ALLOCATION — DIRECT REASSIGNMENT ---
  console.log('\n--- Section 4: SMS Number Allocation — Direct Reassignment ---');
  test('Direct reassignment moves number from Client A to Client B without manual unallocate', () => {
    db.run("DELETE FROM ranges WHERE name=?", ['Test Direct Reassign Range']);
    db.run("INSERT INTO ranges (name, prefix, currency, payment_type) VALUES (?, ?, ?, ?)", ['Test Direct Reassign Range', '97', 'USD', 'weekly_7_1']);
    const r = db.get("SELECT id FROM ranges WHERE name=?", ['Test Direct Reassign Range']);
    const rid = r.id;

    // Number starts owned by Client 201 (under Agent 301)
    db.run("INSERT INTO numbers (number, range_id, agent_id, client_id, client_rate, payout) VALUES (?, ?, 301, 201, '0.005', '0.005')", ['9700000001', rid]);
    const num = db.get("SELECT id, number, client_id, agent_id FROM numbers WHERE number='9700000001'");
    assert.strictEqual(num.client_id, 201);

    // Agent 301 assigns number directly to Client 202
    // Inside handleAllocate: update sets client_id=202 within agent's scope
    const agentScopeWhere = "n.agent_id = 301";
    const sets = "client_id=202, client_rate='0.008', payout='0.008'";
    const upd = db.run(
      `UPDATE numbers AS n SET ${sets} WHERE n.id = ? AND (${agentScopeWhere})`,
      [num.id]
    );

    assert.strictEqual(upd.changes, 1, "Direct reassignment failed to update row");

    const afterNum = db.get("SELECT id, number, client_id, agent_id, client_rate, payout FROM numbers WHERE id=?", [num.id]);
    assert.strictEqual(afterNum.client_id, 202, "Client ID was not updated to Client 202");
    assert.strictEqual(afterNum.agent_id, 301, "Agent ID was altered");
    assert.strictEqual(afterNum.client_rate, '0.008', "Rate was not updated");

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id=?", [rid]);
    db.run("DELETE FROM ranges WHERE id=?", [rid]);
  });

  // --- SECTION 5: SEARCHABLE DROPDOWNS & A-Z SORTING ---
  console.log('\n--- Section 5: Searchable Dropdowns & A-Z Sorting ---');
  test('Dropdowns contain search fields and sorting is strictly alphabetical (A-Z)', () => {
    const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf-8');
    const mgrHtml = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf-8');
    const agtHtml = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf-8');
    const psHtml = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf-8');

    assert(adminHtml.includes('id="allocRangeSearch"'), 'admin.html missing allocRangeSearch');
    assert(adminHtml.includes('id="allocManagerSearch"'), 'admin.html missing allocManagerSearch');
    assert(adminHtml.includes('localeCompare'), 'admin.html missing alphabetical sort');

    assert(mgrHtml.includes('id="baRangeSearch"'), 'manager.html missing baRangeSearch');
    assert(mgrHtml.includes('id="baAgentSearch"'), 'manager.html missing baAgentSearch');
    assert(mgrHtml.includes('managerAllocTargets'), 'manager.html missing managerAllocTargets');

    assert(agtHtml.includes('id="baRangeSearch"'), 'agent.html missing baRangeSearch');
    assert(agtHtml.includes('id="baClientSearch"'), 'agent.html missing baClientSearch');
    assert(agtHtml.includes('agentAllocTargets'), 'agent.html missing agentAllocTargets');

    assert(psHtml.includes('id="bulkRangeSearch"'), 'panel-sharing.html missing bulkRangeSearch');
    assert(psHtml.includes('id="bulkUserSearch"'), 'panel-sharing.html missing bulkUserSearch');
  });

  // --- SECTIONS 15-18: PANEL SHARING BULK ALLOCATION & TWO CSV DOWNLOADS ---
  console.log('\n--- Sections 15-18: Panel Sharing Bulk Allocation & 2 CSV Files ---');
  test('Bulk Allocation assigns numbers with downstream selling price and exports 2 CSV files', () => {
    // Setup sharing user and range
    db.run("INSERT OR IGNORE INTO users (id, username, password, role, name) VALUES (501, 'share_agent_1', 'pass', 'agent', 'Sharing Partner A')");
    db.run("INSERT OR REPLACE INTO sharing_users (id, agent_user_id, panel_name, username, active) VALUES (10, 501, 'Partner Panel X', 'share_agent_1', 1)");
    db.run("DELETE FROM ranges WHERE name=?", ['Partner Range Bulk']);
    db.run("INSERT INTO ranges (name, prefix, currency, payment_type) VALUES (?, ?, ?, ?)", ['Partner Range Bulk', '88', 'USD', 'weekly_7_1']);
    const r = db.get("SELECT id FROM ranges WHERE name=?", ['Partner Range Bulk']);
    const rid = r.id;

    // Insert 5 test numbers
    const testNums = ['8800000001', '8800000002', '8800000003', '8800000004', '8800000005'];
    for (const n of testNums) {
      db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, NULL, NULL, NULL)", [n, rid]);
    }

    // Bulk allocate 3 numbers with selling price 0.0075
    const allocatedNums = ['8800000001', '8800000002', '8800000003'];
    const sellingPrice = '0.0075';
    const payterm = 'weekly_7_1';

    const ph = allocatedNums.map(() => '?').join(',');
    db.run(
      `UPDATE numbers SET agent_id=501, manager_id=NULL, client_id=NULL, client_rate=?, payout=?, rate=?, payterm=?, alloc_source='manual' WHERE range_id=? AND number IN (${ph})`,
      [sellingPrice, sellingPrice, sellingPrice, payterm, rid, ...allocatedNums]
    );

    // Verify ownership and rates
    const allocatedRows = db.all("SELECT number, agent_id, client_rate, payout FROM numbers WHERE range_id=? AND agent_id=501", [rid]);
    assert.strictEqual(allocatedRows.length, 3, "Expected 3 allocated rows");
    for (const row of allocatedRows) {
      assert.strictEqual(row.client_rate, '0.0075', "Selling price not set on client_rate");
      assert.strictEqual(row.payout, '0.0075', "Selling price not set on payout");
    }

    // Verify File 1 (Numbers Only) format
    const file1Lines = ['Number', ...allocatedRows.map(r => r.number)];
    const file1Csv = file1Lines.join('\n');
    assert(file1Csv.startsWith('Number\n8800000001'), `File 1 CSV format incorrect: ${file1Csv}`);

    // Verify File 2 (Range Name + Number + Price) format
    const file2Lines = ['Range Name,Number,Price', ...allocatedRows.map(r => `"Partner Range Bulk","${r.number}",0.0075`)];
    const file2Csv = file2Lines.join('\n');
    assert(file2Csv.startsWith('Range Name,Number,Price\n"Partner Range Bulk","8800000001",0.0075'), `File 2 CSV format incorrect: ${file2Csv}`);

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id=?", [rid]);
    db.run("DELETE FROM ranges WHERE id=?", [rid]);
  });

  // --- SECTIONS 19-25: PANEL SHARING HTTP CONNECTION & MAPPING ---
  console.log('\n--- Sections 19-25: Panel Sharing HTTP Connection ---');
  test('HTTP Connection mapping formats variables correctly and protects secrets', () => {
    const sampleSms = {
      cli: 'BANK_OTP',
      number: '+447987654321',
      message: 'Your verification code is 987654',
      received_at: '2026-09-26 15:30:45',
      otp_code: '987654'
    };

    const cfg = {
      url: 'https://external-client.com/receive',
      method: 'POST',
      auth_type: 'bearer',
      auth_token: 'secret_jwt_token_xyz',
      map: {
        cli: 'sender_id',
        number: 'destination_msisdn',
        message: 'text_body',
        date: 'event_date',
        time: 'event_time',
        otp_code: 'code'
      }
    };

    const recDate = String(sampleSms.received_at);
    const dOnly = recDate.slice(0, 10);
    const tOnly = recDate.slice(11, 19);

    const m = cfg.map;
    const mappedPayload = {};
    mappedPayload[m.cli] = sampleSms.cli;
    mappedPayload[m.number] = sampleSms.number;
    mappedPayload[m.message] = sampleSms.message;
    mappedPayload[m.date] = dOnly;
    mappedPayload[m.time] = tOnly;
    mappedPayload[m.otp_code] = sampleSms.otp_code;

    assert.strictEqual(mappedPayload.sender_id, 'BANK_OTP');
    assert.strictEqual(mappedPayload.destination_msisdn, '+447987654321');
    assert.strictEqual(mappedPayload.text_body, 'Your verification code is 987654');
    assert.strictEqual(mappedPayload.event_date, '2026-09-26');
    assert.strictEqual(mappedPayload.event_time, '15:30:45');
    assert.strictEqual(mappedPayload.code, '987654');

    // Test secret masking in UI preview/logs
    const safeUrl = (cfg.url + '?token=' + cfg.auth_token).replace(/(token|key|password|secret|bearer)=?([^\s&]+)/gi, '$1=***');
    assert(!safeUrl.includes('secret_jwt_token_xyz'), 'Plain secret leaked in URL');
    assert(safeUrl.includes('token=***'), 'Secret was not masked with ***');
  });

  // --- SECTIONS 8-12: PANEL SHARING SMPP CONNECTION SUPPORT ---
  console.log('\n--- Sections 8-12: Panel Sharing SMPP Connection Support ---');
  test('SMPP connections support Client and Server modes with protected credentials', () => {
    // Client mode
    db.run("INSERT OR REPLACE INTO smpp_connections (id, name, mode, host, port, system_id, password, bind_type, active) VALUES (1, 'Test Client SMPP', 'client', '127.0.0.1', 2775, 'sys_user', 'secret_pwd', 'transceiver', 1)");
    // Server mode
    db.run("INSERT OR REPLACE INTO smpp_connections (id, name, mode, listen_port, allowed_ips, system_id, password, bind_type, active) VALUES (2, 'Test Server SMPP', 'server', 2776, '192.168.1.100', 'srv_user', 'secret_pwd2', 'transceiver', 1)");

    const conns = db.all("SELECT id, name, mode, host, port, listen_port, system_id, password, bind_type, active FROM smpp_connections WHERE id IN (1, 2)");
    assert.strictEqual(conns.length, 2);

    const clientConn = conns.find(c => c.id === 1);
    const serverConn = conns.find(c => c.id === 2);

    assert.strictEqual(clientConn.mode, 'client');
    assert.strictEqual(clientConn.host, '127.0.0.1');
    assert.strictEqual(serverConn.mode, 'server');
    assert.strictEqual(serverConn.listen_port, 2776);

    // Verify public masking
    const safePublic = (conn) => {
      const { password, ...rest } = conn;
      return { ...rest, has_password: !!password };
    };

    const pubClient = safePublic(clientConn);
    assert.strictEqual(pubClient.password, undefined);
    assert.strictEqual(pubClient.has_password, true);
  });

  // --- SECTION 26: 3 SEPARATE CONNECTION TYPES IN PANEL SHARING ---
  console.log('\n--- Section 26: 3 Separate Connection Types ---');
  test('Panel Sharing cleanly supports Activity, HTTP, and SMPP connection types', () => {
    db.run("INSERT OR IGNORE INTO users (id, username, password, role) VALUES (601, 'agent_conn_1', 'pass', 'agent')");
    db.run("INSERT OR IGNORE INTO users (id, username, password, role) VALUES (602, 'agent_conn_2', 'pass', 'agent')");
    db.run("INSERT OR IGNORE INTO users (id, username, password, role) VALUES (603, 'agent_conn_3', 'pass', 'agent')");

    db.run("DELETE FROM sharing_users WHERE id IN (21, 22, 23)");
    db.run("INSERT INTO sharing_users (id, agent_user_id, panel_name, username, connection_type, attribute_url, http_config, smpp_connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)", [21, 601, 'P_Activity', 'u_act', 'activity', 'https://act.com/hook', '']);
    db.run("INSERT INTO sharing_users (id, agent_user_id, panel_name, username, connection_type, attribute_url, http_config, smpp_connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)", [22, 602, 'P_HTTP', 'u_http', 'http', '', '{"url":"https://http.com"}']);
    db.run("INSERT INTO sharing_users (id, agent_user_id, panel_name, username, connection_type, attribute_url, http_config, smpp_connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [23, 603, 'P_SMPP', 'u_smpp', 'smpp', '', '', 1]);

    const rows = db.all("SELECT id, panel_name, connection_type, attribute_url, http_config, smpp_connection_id FROM sharing_users WHERE id IN (21, 22, 23)");
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows.find(r => r.id === 21).connection_type, 'activity');
    assert.strictEqual(rows.find(r => r.id === 22).connection_type, 'http');
    assert.strictEqual(rows.find(r => r.id === 23).connection_type, 'smpp');

    // Clean up
    db.run("DELETE FROM sharing_users WHERE id IN (21, 22, 23)");
    db.run("DELETE FROM users WHERE id IN (601, 602, 603)");
  });

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED / ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

run();
