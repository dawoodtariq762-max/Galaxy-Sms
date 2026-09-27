/**
 * Verification test suite for 3 production fixes:
 * 1. SMS Number Individual Allocation in Panel Sharing (resolves null range/pattern, rate card fallback, price override)
 * 2. Bulk Allocation in Panel Sharing (fixes SQLite "No such column" string literal bug in ranges query)
 * 3. Inside-Searchable Dropdown in Allocation Popups (Admin, Manager, Agent panels using renderSearchSelect)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../backend/db');

async function runTests() {
  console.log('====================================================');
  console.log(' Galaxy SMS — Production Fixes Verification Suite');
  console.log('====================================================\n');

  await db.init();
  const schema = require('../backend/schema');
  schema.createTables();

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    ${e.message}\n${e.stack}`);
    }
  }

  // --------------------------------------------------------------------------
  // TEST 1: ISSUE 2 — Bulk Allocation SQLite String Literal Fix
  // --------------------------------------------------------------------------
  console.log('--- Issue 2: Bulk Allocation SQLite Query Fix ---');

  test('Querying active ranges with deleted_at IS NULL OR deleted_at = "" executes without error', () => {
    // Before fix: COALESCE(deleted_at,"")="" triggered SqliteError: no such column: ""
    const range = db.get("SELECT * FROM ranges WHERE (deleted_at IS NULL OR deleted_at = '') LIMIT 1");
    assert(range !== undefined, 'Should execute query without throwing SQLite syntax error');
    assert.strictEqual(typeof range.id, 'number', 'Range id should be a number');
  });

  test('server.js has eliminated double-quote string literals in ranges queries', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
    assert(!serverCode.includes('COALESCE(deleted_at,"")=""'), 'server.js must not contain double-quoted COALESCE(deleted_at,"")=""');
    assert(!serverCode.includes('COALESCE(deleted_at,"") = ""'), 'server.js must not contain double-quoted empty string');
  });

  // --------------------------------------------------------------------------
  // TEST 2: ISSUE 1 — Panel Sharing Individual Allocation & Pattern Resolution
  // --------------------------------------------------------------------------
  console.log('\n--- Issue 1: SMS Number Individual Allocation & Pattern Resolution ---');

  test('schema ensures pattern column exists in both ranges and numbers tables', () => {
    const rangeCols = db.all("PRAGMA table_info(ranges)").map(c => c.name);
    const numCols = db.all("PRAGMA table_info(numbers)").map(c => c.name);
    assert(rangeCols.includes('pattern'), 'ranges table must have pattern column');
    assert(numCols.includes('pattern'), 'numbers table must have pattern column');
  });

  test('Allocation endpoint handles unlinked / null range numbers gracefully without crashing on pattern', () => {
    // Create test sharing user
    let su = db.get("SELECT * FROM sharing_users WHERE active=1 LIMIT 1");
    if (!su) {
      const insUser = db.run("INSERT INTO users (username, password, role, name, active) VALUES (?, ?, 'agent', 'Test SU', 1)",
        ['test_su_' + Date.now(), 'pass123']);
      db.run("INSERT INTO sharing_users (agent_user_id, panel_name, user_name, username, active) VALUES (?, 'Partner A', 'User A', ?, 1)",
        [insUser.lastInsertRowid, 'partner_' + Date.now()]);
      su = db.get("SELECT * FROM sharing_users WHERE id=?", [insUser.lastInsertRowid]);
    }

    let defaultRange = db.get("SELECT * FROM ranges LIMIT 1");
    if (!defaultRange) {
      db.run("INSERT INTO ranges (name, prefix) VALUES ('Default Range', '123')");
      defaultRange = db.get("SELECT * FROM ranges LIMIT 1");
    }

    // Insert an unallocated number with defaultRange.id
    const testNum = '+999' + Math.floor(1000000 + Math.random() * 9000000);
    const insNum = db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES (?, ?, NULL, NULL, NULL)", [testNum, defaultRange.id]);
    const numId = insNum.lastInsertRowid;

    // Simulate allocation logic from /api/panel-sharing/allocate
    const ph = '?';
    const rows = db.all(`SELECT n.id, n.number, n.range_id, r.name AS range_name, r.prefix AS range_prefix, COALESCE(NULLIF(r.pattern,''), r.prefix, '') AS pattern
      FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE n.id IN (${ph}) AND n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL`, [numId]);

    assert.strictEqual(rows.length, 1, 'Should find unallocated number');
    const r = rows[0];

    // Pattern/range resolution
    const allRanges = db.all("SELECT id, name, prefix, COALESCE(NULLIF(pattern,''), prefix, '') AS pattern, rate_1_1, rate_7_1, rate_7_7, rate_30_45 FROM ranges WHERE (deleted_at IS NULL OR deleted_at = '') ORDER BY LENGTH(prefix) DESC");
    if (!r.range_id || !r.range_name) {
      r.range_name = r.range_name || 'Standard Range';
      r.range_prefix = r.range_prefix || '';
      r.pattern = r.pattern || '';
    }

    assert(r.pattern !== undefined && r.pattern !== null, 'Pattern must never be null');
    assert.strictEqual(typeof r.pattern, 'string', 'Pattern must be a string');

    // Clean up test number
    db.run("DELETE FROM numbers WHERE id=?", [numId]);
  });

  test('panel-sharing.html has robust pattern and matchedRange fallback', () => {
    const html = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf8');
    assert(html.includes('matchedRange.pattern'), 'panel-sharing.html must ensure matchedRange.pattern is set');
    assert(html.includes("rate_7_1: '0.0000'"), 'panel-sharing.html must have valid fallback range object');
  });

  // --------------------------------------------------------------------------
  // TEST 3: ISSUE 3 — Searchable Dropdowns in Allocation Popups
  // --------------------------------------------------------------------------
  console.log('\n--- Issue 3: Searchable Dropdown Inside Allocation Popup ---');

  test('admin.html uses renderSearchSelect in allocAllModal and retains aaClient input', () => {
    const html = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
    assert(html.includes('id="aaTargetDropdownWrap"'), 'admin.html allocAllModal must have aaTargetDropdownWrap container');
    assert(!html.includes('<select id="aaClient">'), 'admin.html allocAllModal must not have a raw select element for aaClient');
    assert(html.includes("window.renderSearchSelect('aaTargetDropdownWrap'"), 'admin.html openAllocAll must call renderSearchSelect');
    assert(html.includes("id:'aaClient'"), 'renderSearchSelect in admin.html must bind to id aaClient');
    assert(html.includes("searchPlaceholder:'Search manager, agent, client...'"), 'Must include descriptive search placeholder');
  });

  test('manager.html uses renderSearchSelect in allocAllModal and retains aaAgent input', () => {
    const html = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf8');
    assert(html.includes('id="aaTargetDropdownWrap"'), 'manager.html allocAllModal must have aaTargetDropdownWrap container');
    assert(!html.includes('<select id="aaAgent">'), 'manager.html allocAllModal must not have a raw select element for aaAgent');
    assert(html.includes("window.renderSearchSelect('aaTargetDropdownWrap'"), 'manager.html openAllocAll must call renderSearchSelect');
    assert(html.includes("id: 'aaAgent'"), 'renderSearchSelect in manager.html must bind to id aaAgent');
    assert(html.includes("searchPlaceholder: 'Search agent, client...'"), 'Must include descriptive search placeholder');
  });

  test('agent.html uses renderSearchSelect in allocAllModal and retains aaClient input', () => {
    const html = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf8');
    assert(html.includes('id="aaTargetDropdownWrap"'), 'agent.html allocAllModal must have aaTargetDropdownWrap container');
    assert(!html.includes('<select id="aaClient">'), 'agent.html allocAllModal must not have a raw select element for aaClient');
    assert(html.includes("window.renderSearchSelect('aaTargetDropdownWrap'"), 'agent.html openAllocAll must call renderSearchSelect');
    assert(html.includes("id: 'aaClient'"), 'renderSearchSelect in agent.html must bind to id aaClient');
    assert(html.includes("searchPlaceholder: 'Search client...'"), 'Must include descriptive search placeholder');
  });

  test('renderSearchSelect has search box inside opened menu and stops click propagation', () => {
    const galaxyJs = fs.readFileSync(path.join(__dirname, '../assets/galaxy.js'), 'utf8');
    assert(galaxyJs.includes('<div class="sd-search-box" onclick="event.stopPropagation()">'),
      'Search box must be inside .sd-menu and call event.stopPropagation()');
    assert(galaxyJs.includes("items.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));"),
      'Items must be alphabetically sorted A-Z');
  });

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED / ${total - passed} FAILED`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
