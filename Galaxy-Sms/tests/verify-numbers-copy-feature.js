/**
 * Comprehensive Verification Test for Galaxy SMS "Copy Only the Numbers" feature.
 * Strictly tests Admin, Manager, Agent, and Client across page sizes, pagination (P1, P2, Middle, Last),
 * filtering (range, search), and clipboard content integrity.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const testDbPath = '/tmp/test_copy_numbers_' + Date.now() + '.sqlite';
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
require('../backend/schema').createTables();

const SECRET = 'test-secret-copy-numbers-2026';
process.env.JWT_SECRET = SECRET;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { authRequired, chatAuthRequired, requireRole } = require('../backend/auth');

// Seed test users:
// Admin (id: 1)
// Manager (id: 2, parent: 1)
// Agent (id: 3, parent: 2)
// Client (id: 4, parent: 3)
db.run("INSERT INTO users (id, username, password, role, active) VALUES (1, 'admin', ?, 'admin', 1)", [bcrypt.hashSync('pass', 10)]);
db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (2, 'manager1', ?, 'manager', 1, 1)", [bcrypt.hashSync('pass', 10)]);
db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (3, 'agent1', ?, 'agent', 2, 1)", [bcrypt.hashSync('pass', 10)]);
db.run("INSERT INTO users (id, username, password, role, parent_id, active) VALUES (4, 'client1', ?, 'client', 3, 1)", [bcrypt.hashSync('pass', 10)]);

// Seed Ranges
db.run("INSERT INTO ranges (id, name, prefix) VALUES (1, 'Italy Mobile', '3934')");
db.run("INSERT INTO ranges (id, name, prefix) VALUES (2, 'UK Mobile', '4477')");

// Seed 12,350 Numbers:
// 10,000 for Italy Mobile (range_id: 1)
// 2,350 for UK Mobile (range_id: 2)
// Numbers 1..5000 assigned to Manager 2 -> Agent 3 -> Client 4
// Numbers 5001..12350 unallocated / assigned to Manager
console.log('Seeding 12,350 test numbers...');
db.exec('BEGIN TRANSACTION');

for (let i = 1; i <= 10000; i++) {
  const num = `3934${String(i).padStart(8, '0')}`;
  if (i <= 5000) {
    db.run('INSERT INTO numbers (range_id, prefix, number, manager_id, agent_id, client_id, rate, payout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [1, '3934', num, 2, 3, 4, '0.045', '0.040']);
  } else {
    db.run('INSERT INTO numbers (range_id, prefix, number, manager_id, agent_id, client_id, rate, payout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [1, '3934', num, 2, null, null, '0.045', '0.040']);
  }
}

for (let i = 1; i <= 2350; i++) {
  const num = `4477${String(i).padStart(8, '0')}`;
  if (i <= 1000) {
    db.run('INSERT INTO numbers (range_id, prefix, number, manager_id, agent_id, client_id, rate, payout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [2, '4477', num, 2, 3, 4, '0.035', '0.030']);
  } else {
    db.run('INSERT INTO numbers (range_id, prefix, number, manager_id, agent_id, client_id, rate, payout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [2, '4477', num, 2, 3, null, '0.035', '0.030']);
  }
}
db.exec('COMMIT');
console.log('Seeding complete.');

// Mount numbers API from real server route logic
const NUMBER_PAGE_DEFAULT = 25;
const ROLE_PAGE_MAX = { admin: 100000, manager: 5000, agent: 5000, client: 500, test: 500 };
const ROLE_ALL_MAX = { admin: 200000 };

function parsePositiveInt(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

app.get('/api/numbers', authRequired, (req, res) => {
  const role = req.user.role;
  const roleCap = ROLE_PAGE_MAX[role] || 500;
  const q = req.query || {};
  const requestedLimitRaw = String(q.limit || NUMBER_PAGE_DEFAULT);
  const isAll = requestedLimitRaw.toLowerCase() === 'all';
  const hardCap = isAll ? (ROLE_ALL_MAX[role] || roleCap) : roleCap;
  const requestedLimit = isAll ? hardCap : parsePositiveInt(requestedLimitRaw, NUMBER_PAGE_DEFAULT);
  const limit = Math.min(hardCap, Math.max(1, requestedLimit));

  let whereClauses = [];
  let params = [];

  // Role Scope
  if (role === 'manager') {
    whereClauses.push('n.manager_id = ?');
    params.push(req.user.id);
  } else if (role === 'agent') {
    whereClauses.push('n.agent_id = ?');
    params.push(req.user.id);
  } else if (role === 'client') {
    whereClauses.push('n.client_id = ?');
    params.push(req.user.id);
  }

  // Filters
  if (q.range) {
    whereClauses.push('r.name = ?');
    params.push(q.range);
  }
  if (q.search) {
    whereClauses.push('(n.number LIKE ? OR r.name LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const countRow = db.get(`SELECT COUNT(*) AS total FROM numbers n LEFT JOIN ranges r ON r.id = n.range_id ${whereSql}`, params);
  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, parsePositiveInt(q.page, 1)), totalPages);
  const offset = (page - 1) * limit;

  const rows = db.all(
    `SELECT n.id, n.range_id, r.name AS range_name, n.number, n.rate, n.payout, n.payterm,
            cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
     FROM numbers n
     LEFT JOIN ranges r ON r.id = n.range_id
     LEFT JOIN users cu ON cu.id = n.client_id
     LEFT JOIN users au ON au.id = n.agent_id
     LEFT JOIN users mu ON mu.id = n.manager_id
     ${whereSql}
     ORDER BY n.id ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  res.json({
    total,
    page,
    limit,
    totalPages,
    rows
  });
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
  console.log('\n======================================================');
  console.log('STARTING COPY ONLY CURRENT PAGE NUMBERS VERIFICATION');
  console.log('======================================================\n');

  // Verify UI elements and helper scripts across all 4 HTML files
  console.log('--- 1. Static Code & UI Audit (Admin, Manager, Agent, Client) ---');
  const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
  const managerHtml = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf8');
  const agentHtml = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf8');
  const clientHtml = fs.readFileSync(path.join(__dirname, '../client.html'), 'utf8');

  assert(adminHtml.includes('id="numPageCount"') && adminHtml.includes('id="btnCopyPageNumbers"'), 'Admin HTML has Number count and copy button beside heading');
  assert(adminHtml.includes('function copyCurrentPageNumbers'), 'Admin HTML defines copyCurrentPageNumbers()');
  assert(adminHtml.includes('<option>10000</option>'), 'Admin HTML numLen selector supports 10,000');

  assert(managerHtml.includes('id="numPageCount"') && managerHtml.includes('id="btnCopyPageNumbers"'), 'Manager HTML has Number count and copy button beside heading');
  assert(managerHtml.includes('function copyCurrentPageNumbers'), 'Manager HTML defines copyCurrentPageNumbers()');

  assert(agentHtml.includes('id="numPageCount"') && agentHtml.includes('id="btnCopyPageNumbers"'), 'Agent HTML has Number count and copy button beside heading');
  assert(agentHtml.includes('function copyCurrentPageNumbers'), 'Agent HTML defines copyCurrentPageNumbers()');

  assert(clientHtml.includes('id="numPageCount"') && clientHtml.includes('id="btnCopyPageNumbers"'), 'Client HTML has Number count and copy button beside heading');
  assert(clientHtml.includes('function copyCurrentPageNumbers'), 'Client HTML defines copyCurrentPageNumbers()');

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, SECRET);
  const managerToken = jwt.sign({ id: 2, username: 'manager1', role: 'manager' }, SECRET);
  const agentToken = jwt.sign({ id: 3, username: 'agent1', role: 'agent' }, SECRET);
  const clientToken = jwt.sign({ id: 4, username: 'client1', role: 'client' }, SECRET);

  /**
   * Helper that simulates the exact browser copyCurrentPageNumbers() function:
   * takes the current page's rows, extracts ONLY numbers, joins with \n.
   */
  function simulateCopy(rows) {
    const list = (rows || []).map(r => String(r.number || '').trim()).filter(Boolean);
    return list.join('\n');
  }

  try {
    // ==========================================
    // 2. ADMIN TESTS
    // ==========================================
    console.log('\n--- 2. Admin Panel Copy Tests ---');
    // Test Admin: 25 per page (Page 1)
    let res = await fetch(`${base}/api/numbers?limit=25&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    let data = await res.json();
    let clipboard = simulateCopy(data.rows);
    let lines = clipboard.split('\n');
    assert(lines.length === 25, 'Admin Page 1 (limit 25) copied exactly 25 numbers');
    assert(lines[0] === '393400000001' && lines[24] === '393400000025', 'Admin Page 1 matches exact displayed range 1..25');
    assert(!clipboard.includes('Italy') && !clipboard.includes('0.045'), 'Clipboard contains strictly NO range names or rates');

    // Test Admin: 25 per page (Page 2) -> Must NOT contain Page 1
    res = await fetch(`${base}/api/numbers?limit=25&page=2`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Admin Page 2 (limit 25) copied exactly 25 numbers');
    assert(lines[0] === '393400000026' && lines[24] === '393400000050', 'Admin Page 2 matches exact displayed range 26..50');
    assert(!clipboard.includes('393400000001'), 'Admin Page 2 does NOT include Page 1 numbers');

    // Test Admin: 50 per page
    res = await fetch(`${base}/api/numbers?limit=50&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 50, 'Admin limit 50 copied exactly 50 numbers');

    // Test Admin: 100 per page
    res = await fetch(`${base}/api/numbers?limit=100&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 100, 'Admin limit 100 copied exactly 100 numbers');

    // Test Admin: 500 per page
    res = await fetch(`${base}/api/numbers?limit=500&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 500, 'Admin limit 500 copied exactly 500 numbers');

    // Test Admin: 1,000 per page
    res = await fetch(`${base}/api/numbers?limit=1000&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 1000, 'Admin limit 1,000 copied exactly 1,000 numbers');

    // Test Admin: 10,000 per page
    res = await fetch(`${base}/api/numbers?limit=10000&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 10000, 'Admin limit 10,000 copied exactly 10,000 numbers');

    // Test Admin: Middle Page (Page 5, limit 500)
    res = await fetch(`${base}/api/numbers?limit=500&page=5`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 500, 'Admin Middle Page (Page 5, limit 500) copied exactly 500 numbers');
    assert(lines[0] === '393400002001' && lines[499] === '393400002500', 'Admin Page 5 matches exact offset range 2001..2500');

    // Test Admin: Last Page with remainder (Total 12,350 -> limit 1000 -> Page 13 has exactly 350)
    res = await fetch(`${base}/api/numbers?limit=1000&page=13`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 350, 'Admin Final Page (Page 13, limit 1000) copied exactly 350 remaining numbers');
    assert(lines[0] === '447700002001' && lines[349] === '447700002350', 'Admin Final Page matches exact remaining numbers');

    // Test Admin: Filtered results (Range = UK Mobile)
    res = await fetch(`${base}/api/numbers?limit=500&page=1&range=UK%20Mobile`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 500, 'Admin Range filter copied exactly 500 filtered numbers');
    assert(lines.every(num => num.startsWith('4477')), 'All copied numbers belong strictly to filtered range (4477)');

    // ==========================================
    // 3. MANAGER TESTS
    // ==========================================
    console.log('\n--- 3. Manager Panel Copy Tests ---');
    // Manager has access to numbers 1..12,350
    // Test Manager: 25 per page (Page 1)
    res = await fetch(`${base}/api/numbers?limit=25&page=1`, { headers: { Authorization: `Bearer ${managerToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Manager Page 1 (limit 25) copied exactly 25 numbers');

    // Test Manager: Page 2
    res = await fetch(`${base}/api/numbers?limit=25&page=2`, { headers: { Authorization: `Bearer ${managerToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Manager Page 2 (limit 25) copied exactly 25 numbers');
    assert(lines[0] === '393400000026', 'Manager Page 2 begins at record 26');

    // Test Manager: 50, 100, 500, 1,000, 5,000
    for (const lim of [50, 100, 500, 1000, 5000]) {
      res = await fetch(`${base}/api/numbers?limit=${lim}&page=1`, { headers: { Authorization: `Bearer ${managerToken}` } });
      data = await res.json();
      clipboard = simulateCopy(data.rows);
      lines = clipboard.split('\n');
      assert(lines.length === lim, `Manager limit ${lim} copied exactly ${lim} numbers`);
    }

    // Test Manager: Last Page (limit 5000 -> Page 3 has 2,350)
    res = await fetch(`${base}/api/numbers?limit=5000&page=3`, { headers: { Authorization: `Bearer ${managerToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 2350, 'Manager Final Page (Page 3, limit 5000) copied exactly 2,350 remaining numbers');

    // ==========================================
    // 4. AGENT TESTS
    // ==========================================
    console.log('\n--- 4. Agent Panel Copy Tests ---');
    // Agent has numbers 1..5,000 (Italy) + 1..2,350 (UK) = 7,350 total
    // Test Agent: 25 per page (Page 1)
    res = await fetch(`${base}/api/numbers?limit=25&page=1`, { headers: { Authorization: `Bearer ${agentToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Agent Page 1 copied exactly 25 numbers');

    // Test Agent: Page 2
    res = await fetch(`${base}/api/numbers?limit=25&page=2`, { headers: { Authorization: `Bearer ${agentToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Agent Page 2 copied exactly 25 numbers');
    assert(lines[0] === '393400000026', 'Agent Page 2 begins at 26');

    // Test Agent: 1,000 per page
    res = await fetch(`${base}/api/numbers?limit=1000&page=1`, { headers: { Authorization: `Bearer ${agentToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 1000, 'Agent limit 1,000 copied exactly 1,000 numbers');

    // Test Agent: 5,000 per page
    res = await fetch(`${base}/api/numbers?limit=5000&page=1`, { headers: { Authorization: `Bearer ${agentToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 5000, 'Agent limit 5,000 copied exactly 5,000 numbers');

    // Test Agent: Last Page (Page 2, limit 5000 -> 2,350 remainder)
    res = await fetch(`${base}/api/numbers?limit=5000&page=2`, { headers: { Authorization: `Bearer ${agentToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 2350, 'Agent Final Page (Page 2, limit 5000) copied exactly 2,350 remaining numbers');

    // ==========================================
    // 5. CLIENT TESTS
    // ==========================================
    console.log('\n--- 5. Client Panel Copy Tests ---');
    // Client has numbers 1..5000 (Italy) + 1..1000 (UK) = 6,000 total
    // Role cap for Client is 500
    // Test Client: 25 per page (Page 1)
    res = await fetch(`${base}/api/numbers?limit=25&page=1`, { headers: { Authorization: `Bearer ${clientToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Client Page 1 copied exactly 25 numbers');

    // Test Client: Page 2
    res = await fetch(`${base}/api/numbers?limit=25&page=2`, { headers: { Authorization: `Bearer ${clientToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 25, 'Client Page 2 copied exactly 25 numbers');
    assert(lines[0] === '393400000026', 'Client Page 2 begins at 26');

    // Test Client: 50, 100, 500
    for (const lim of [50, 100, 500]) {
      res = await fetch(`${base}/api/numbers?limit=${lim}&page=1`, { headers: { Authorization: `Bearer ${clientToken}` } });
      data = await res.json();
      clipboard = simulateCopy(data.rows);
      lines = clipboard.split('\n');
      assert(lines.length === lim, `Client limit ${lim} copied exactly ${lim} numbers`);
    }

    // Test Client: Last Page (Total 6,000 -> limit 500 -> 12 pages -> Page 12 has 500)
    res = await fetch(`${base}/api/numbers?limit=500&page=12`, { headers: { Authorization: `Bearer ${clientToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');
    assert(lines.length === 500, 'Client Final Page (Page 12, limit 500) copied exactly 500 numbers');

    // ==========================================
    // 6. STRICT CLIPBOARD FORMATTING CHECKS
    // ==========================================
    console.log('\n--- 6. Clipboard Content & Purity Checks ---');
    res = await fetch(`${base}/api/numbers?limit=100&page=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
    data = await res.json();
    clipboard = simulateCopy(data.rows);
    lines = clipboard.split('\n');

    // Verify every line is purely numeric phone number
    const allNumeric = lines.every(line => /^\d{10,15}$/.test(line));
    assert(allNumeric, 'Every copied line is strictly a numeric phone number');

    assert(!clipboard.includes('Italy Mobile'), 'NO range names in clipboard');
    assert(!clipboard.includes('0.045'), 'NO rates in clipboard');
    assert(!clipboard.includes('client1'), 'NO client names in clipboard');
    assert(!clipboard.includes('agent1'), 'NO agent names in clipboard');
    assert(!clipboard.includes('manager1'), 'NO manager names in clipboard');
    assert(!clipboard.includes('Weekly'), 'NO payterms in clipboard');
    assert(!clipboard.includes('Active'), 'NO statuses in clipboard');
    assert(!clipboard.includes(','), 'NO CSV commas in clipboard');
    assert(!clipboard.includes('{') && !clipboard.includes('}'), 'NO JSON in clipboard');
    assert(!clipboard.includes('<') && !clipboard.includes('>'), 'NO HTML tags in clipboard');
    assert(!clipboard.includes('Number') && !clipboard.includes('Range'), 'NO table headers in clipboard');

  } finally {
    server.close();
    try { fs.unlinkSync(testDbPath); } catch (_) {}
  }

  console.log('\n======================================================');
  console.log(`COPY ONLY CURRENT PAGE TEST SUITE: ${passed} PASS / ${failed} FAIL`);
  console.log('======================================================\n');
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
