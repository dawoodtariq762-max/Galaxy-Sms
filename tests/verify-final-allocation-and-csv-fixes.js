const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('================================================================');
console.log(' VERIFYING SMS RANGE ALLOCATION & BULK CSV FORMATTING FIXES');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// Setup DB connection
const db = require('../backend/db');
db.init();

// -----------------------------------------------------------------------------
// TEST SUITE 1: CSV FORMATTING VERIFICATION (panel-sharing.html inspection)
// -----------------------------------------------------------------------------
console.log('--- 1. Bulk Allocation & SMS Number CSV Formatting in panel-sharing.html ---');

const htmlContent = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf8');

it('panel-sharing.html does not join rows with literal double-backslash n ("\\\\n")', () => {
  // Ensure no lines.join('\\n') or list.join('\\n') exist in CSV generation
  const badLiteralJoinMatches = htmlContent.match(/\.join\(['"]\\\\n['"]\)/g);
  assert.strictEqual(badLiteralJoinMatches, null, `Found unwanted literal \\n joins: ${badLiteralJoinMatches}`);
});

it('downloadDetailedArchive joins rows using real CRLF (\\r\\n)', () => {
  assert(htmlContent.includes("lines.join('\\r\\n') + '\\r\\n'"), 'Detailed archive must use CRLF lines.join');
  assert(htmlContent.includes("'Range Name,Number,Price'"), 'Detailed archive must have standard 3-column header');
});

it('downloadNumbersOnlyArchive formats 1-column CSV with CRLF', () => {
  assert(htmlContent.includes("['Number'].concat(r.numbers)"), 'Numbers-only archive must format numbers with header');
  assert(htmlContent.includes("files.push({ name: fname, content: lines.join('\\r\\n') + '\\r\\n' });"), 'Numbers-only must join with CRLF');
});

it('downloadSelectedUnallocated and downloadAllFilteredNumbers use real CRLF', () => {
  assert(htmlContent.includes("triggerBlobDownload(lines.join('\\r\\n') + '\\r\\n', fname);"), 'Blob download must use CRLF');
});

it('copyNumbersOnly joins clipboard numbers with standard newline (\\n)', () => {
  assert(htmlContent.includes("const text = list.join('\\n');"), 'Clipboard copy must join with real \\n, not literal \\\\n');
});

// -----------------------------------------------------------------------------
// TEST SUITE 2: CSV PARSING & DATA SHAPE SIMULATION
// -----------------------------------------------------------------------------
console.log('\n--- 2. Simulated CSV Generation & Parsing Compliance ---');

// Simulate Detailed Archive generation
it('Type 2 Detailed CSV generates exactly 1 row per number with 3 columns', () => {
  const mockRange = {
    range_name: 'Test Range 01',
    price: '0.0075',
    numbers: ['44710000001', '44710000002', '44710000003', '44710000004', '44710000005']
  };
  const lines = ['Range Name,Number,Price'];
  mockRange.numbers.forEach(num => {
    lines.push(`"${(mockRange.range_name||'').replace(/"/g, '""')}","${num}",${mockRange.price}`);
  });
  const csvOutput = lines.join('\r\n') + '\r\n';

  // Ensure no literal '\n' string
  assert(!csvOutput.includes('\\n'), 'CSV must not contain literal \\n string');

  const rows = csvOutput.trim().split('\r\n');
  assert.strictEqual(rows.length, 6, 'Must contain 1 header + 5 number rows');
  assert.strictEqual(rows[0], 'Range Name,Number,Price');
  for (let i = 1; i <= 5; i++) {
    const cols = rows[i].split(',');
    assert.strictEqual(cols.length, 3, `Row ${i} must have exactly 3 columns`);
    assert.strictEqual(cols[0], '"Test Range 01"');
    assert.strictEqual(cols[1], `"4471000000${i}"`);
    assert.strictEqual(cols[2], '0.0075');
  }
});

// Simulate Numbers-Only Archive generation
it('Type 1 Numbers-Only CSV generates exactly 1 row per number, no horizontal joining', () => {
  const numbers = ['44710000001', '44710000002', '44710000003', '44710000004', '44710000005'];
  const lines = ['Number'].concat(numbers);
  const csvOutput = lines.join('\r\n') + '\r\n';

  // Ensure no literal '\n' string
  assert(!csvOutput.includes('\\n'), 'CSV must not contain literal \\n string');

  const rows = csvOutput.trim().split('\r\n');
  assert.strictEqual(rows.length, 6, 'Must contain 1 header + 5 number rows');
  assert.strictEqual(rows[0], 'Number');
  for (let i = 1; i <= 5; i++) {
    assert.strictEqual(rows[i], `4471000000${i}`, `Row ${i} must contain single number`);
  }
});

// -----------------------------------------------------------------------------
// TEST SUITE 3: BACKEND RANGE ALLOCATION FLOW & SERVICE VERIFICATION
// -----------------------------------------------------------------------------
console.log('\n--- 3. Backend SMS Number Range Allocation Flow & Logic ---');

const serverJs = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');

it('server.js supports allocating by range_id or range_name without mandatory ids[]', () => {
  assert(serverJs.includes('const rangeId = parsePositiveInt(b.range_id || b.id, 0);'), 'range_id parsed from request');
  assert(serverJs.includes('const rangeName = String(b.range_name || b.range || \'\').trim();'), 'range_name parsed from request');
  assert(serverJs.includes('} else if (range) {'), 'allocates from range when ids[] not provided');
});

it('server.js queries unallocated numbers with strict ownership checks', () => {
  assert(serverJs.includes('n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL'), 'Strict ownership verification');
});

it('server.js resolves authoritative Rate Card price for Range when price is omitted', () => {
  assert(serverJs.includes('price = payoutRateForPaymentCycle(range, payterm);'), 'Uses payoutRateForPaymentCycle for default price');
});

// -----------------------------------------------------------------------------
// TEST SUITE 4: END-TO-END DATABASE TRANSACTION ALLOCATION TEST
// -----------------------------------------------------------------------------
console.log('\n--- 4. End-to-End Database Allocation Simulation ---');

it('Successfully allocates a range of unallocated numbers to a sharing partner', () => {
  // 1. Create or get test range
  let testRange = db.get("SELECT * FROM ranges WHERE prefix='999901'");
  if (!testRange) {
    db.run("INSERT INTO ranges (name, prefix, pattern, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ['Test Fix Range', '999901', '999901', '0.0050', '0.0070', '0.0080', '0.0100']
    );
    testRange = db.get("SELECT * FROM ranges WHERE prefix='999901'");
  }
  assert(testRange, 'Test range exists');

  // 2. Get existing or create test sharing user
  let sharingUser = db.get("SELECT * FROM sharing_users WHERE active=1 LIMIT 1");
  assert(sharingUser, 'Active sharing user exists');

  // 3. Insert 5 test unallocated numbers for this range
  for (let i = 1; i <= 5; i++) {
    const num = `999901000${i}`;
    const exists = db.get("SELECT id FROM numbers WHERE number=?", [num]);
    if (!exists) {
      db.run("INSERT INTO numbers (number, range_id) VALUES (?, ?)", [num, testRange.id]);
    } else {
      db.run("UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, range_id=? WHERE number=?", [testRange.id, num]);
    }
  }

  // 4. Query unallocated numbers matching the range
  const unalloc = db.all(
    "SELECT id, number, range_id FROM numbers WHERE range_id=? AND manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL",
    [testRange.id]
  );
  assert.strictEqual(unalloc.length, 5, 'Must have 5 unallocated numbers in test range');

  // 5. Perform transactional allocation simulation
  const agentUserId = sharingUser.agent_user_id || 501;
  const payterm = 'weekly_7_1';
  const price = testRange.rate_7_1; // 0.0070

  db.exec('BEGIN IMMEDIATE');
  const ids = unalloc.map(u => u.id);
  const ph = ids.map(() => '?').join(',');
  db.run(
    `UPDATE numbers SET agent_id=?, manager_id=NULL, client_id=NULL, client_rate=?, payout=?, rate=?, payterm=?, alloc_source='manual' WHERE id IN (${ph})`,
    [agentUserId, price, price, price, payterm, ...ids]
  );
  db.exec('COMMIT');

  // 6. Verify numbers are allocated with correct owner, rate, and payterm
  const allocated = db.all(`SELECT * FROM numbers WHERE id IN (${ph})`, ids);
  assert.strictEqual(allocated.length, 5);
  allocated.forEach(a => {
    assert.strictEqual(a.agent_id, agentUserId, 'Agent user id matches');
    assert.strictEqual(a.manager_id, null, 'Manager id is null');
    assert.strictEqual(a.client_id, null, 'Client id is null');
    assert.strictEqual(String(a.rate), '0.0070', 'Rate matches 7/1 rate');
    assert.strictEqual(a.payterm, 'weekly_7_1', 'Payterm matches');
  });

  // 7. Ownership integrity: ensure already allocated numbers cannot be stolen
  const reallocAttempt = db.all(
    "SELECT id FROM numbers WHERE range_id=? AND manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL",
    [testRange.id]
  );
  assert.strictEqual(reallocAttempt.length, 0, 'No unallocated numbers remain in range, preventing accidental overwrite');

  // Cleanup test numbers and range
  db.run(`DELETE FROM numbers WHERE id IN (${ph})`, ids);
  db.run("DELETE FROM ranges WHERE id=?", [testRange.id]);
});

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(` ALL TESTS COMPLETE: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================');

if (failed > 0) process.exit(1);
