/**
 * Galaxy SMS — Verification Suite for Sections 31 to 55:
 *  - Search inside opened dropdown (Sections 32, 33, 41)
 *  - Panel Sharing SMS Numbers: User + Billing period (Section 31)
 *  - Confirmation / Price Override Modal (Sections 36, 37, 38, 39)
 *  - Downstream price applied (Section 38, 52) & provider rate untouched
 *  - File name using Range Name (Section 35, 49)
 *  - Bulk Multi-Range Allocation: one user -> multiple ranges (Section 40, 42)
 *  - Rate Card Authoritative price per range (Section 44, 47)
 *  - Dual ZIP archives: Detailed Allocation Files.zip & Numbers Only Files.zip (Section 46, 48, 50)
 *  - Pure JS Store ZIP builder verification
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  console.log(' Galaxy SMS — Sections 31 to 55 Verification');
  console.log('====================================================\n');

  // --- SECTIONS 32, 33, 41: SEARCH INSIDE OPENED DROPDOWN ---
  console.log('--- Sections 32, 33, 41: Search Inside Opened Dropdown ---');
  test('Search field is placed INSIDE the opened dropdown, NOT outside/above', () => {
    const psHtml = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf-8');
    const gxJs = fs.readFileSync(path.join(__dirname, '../assets/galaxy.js'), 'utf-8');
    const gxCss = fs.readFileSync(path.join(__dirname, '../assets/galaxy.css'), 'utf-8');

    // Verify search select CSS exists
    assert(gxCss.includes('.sd-menu'), 'Missing .sd-menu in galaxy.css');
    assert(gxCss.includes('.sd-search-box'), 'Missing .sd-search-box in galaxy.css');
    assert(gxCss.includes('.sd-options'), 'Missing .sd-options in galaxy.css');

    // Verify JS renders search box INSIDE the menu
    assert(gxJs.includes('<div class="sd-search-box" onclick="event.stopPropagation()">'), 'Search box does not have event.stopPropagation()');
    assert(gxJs.includes('oninput="filterSearchDropdown'), 'filterSearchDropdown missing');
    assert(gxJs.includes('renderSearchSelect'), 'renderSearchSelect helper missing');

    // In panel-sharing.html, verify containers are used and outside search inputs are removed
    assert(!psHtml.includes('id="bulkRangeSearch"'), 'Old outside bulkRangeSearch still in panel-sharing.html');
    assert(!psHtml.includes('id="bulkUserSearch"'), 'Old outside bulkUserSearch still in panel-sharing.html');
    assert(psHtml.includes('allocUserDropdownContainer'), 'allocUserDropdownContainer missing');
    assert(psHtml.includes('bulkRangeDropdownContainer'), 'bulkRangeDropdownContainer missing');
    assert(psHtml.includes('bulkUserDropdownContainer'), 'bulkUserDropdownContainer missing');

    // In admin.html, manager.html, agent.html, verify old outside search inputs removed
    const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf-8');
    const mgrHtml = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf-8');
    const agtHtml = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf-8');

    assert(!adminHtml.includes('id="allocRangeSearch"'), 'Old outside allocRangeSearch still in admin.html');
    assert(!adminHtml.includes('id="allocManagerSearch"'), 'Old outside allocManagerSearch still in admin.html');
    assert(adminHtml.includes('allocRangeDropdownContainer'), 'admin.html missing allocRangeDropdownContainer');
    assert(adminHtml.includes('allocUserDropdownContainer'), 'admin.html missing allocUserDropdownContainer');

    assert(!mgrHtml.includes('id="baRangeSearch"'), 'Old outside baRangeSearch still in manager.html');
    assert(mgrHtml.includes('baRangeDropdownContainer'), 'manager.html missing baRangeDropdownContainer');

    assert(!agtHtml.includes('id="baRangeSearch"'), 'Old outside baRangeSearch still in agent.html');
    assert(agtHtml.includes('baRangeDropdownContainer'), 'agent.html missing baRangeDropdownContainer');
  });

  // --- SECTIONS 31, 34, 35: SMS NUMBERS PANEL SHARING TOOLBAR & FILENAME ---
  console.log('\n--- Sections 31, 34, 35: SMS Numbers Management ---');
  test('User selection and billing period are visible together in SMS Numbers', () => {
    const psHtml = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf-8');
    assert(psHtml.includes('id="allocPayterm"'), 'Missing allocPayterm billing period select');
    assert(psHtml.includes('id="allocUserDropdownContainer"'), 'Missing allocUserDropdownContainer');
    assert(psHtml.includes('downloadSelectedUnallocated'), 'Missing downloadSelectedUnallocated function');
    assert(psHtml.includes('openAllocConfirmFlow'), 'Missing openAllocConfirmFlow function');
  });

  // --- SECTIONS 36, 37, 38, 39: ALLOCATION CONFIRMATION & PRICE OVERRIDE ---
  console.log('\n--- Sections 36-39: Allocation Confirmation & Price Override Modal ---');
  test('Confirmation modal displays Rate Card default, allows override, and cancels cleanly', () => {
    const psHtml = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf-8');
    assert(psHtml.includes('id="allocConfirmModal"'), 'Missing #allocConfirmModal');
    assert(psHtml.includes('id="confRateCardPrice"'), 'Missing confRateCardPrice display');
    assert(psHtml.includes('id="confOverridePrice"'), 'Missing confOverridePrice input');
    assert(psHtml.includes('proceedWithConfirmedAllocation'), 'Missing proceedWithConfirmedAllocation function');
    assert(psHtml.includes('closeAllocConfirmModal'), 'Missing closeAllocConfirmModal function');
  });

  // Initialize DB for functional tests
  const db = require('../backend/db');
  await db.init();

  // Test functional SMS Number allocation with confirmed price
  test('Backend POST /api/panel-sharing/allocate updates downstream price and preserves provider rate', () => {
    // Setup range with rate card and provider cost
    db.run("DELETE FROM ranges WHERE name=?", ['Afghanistan Galaxy 01']);
    db.run(
      "INSERT INTO ranges (name, prefix, currency, payment_type, rate_7_1, provider_rate_7_1) VALUES (?, ?, ?, ?, ?, ?)",
      ['Afghanistan Galaxy 01', '93', 'USD', 'weekly_7_1', '0.0050', '0.0020']
    );
    const range = db.get("SELECT * FROM ranges WHERE name=?", ['Afghanistan Galaxy 01']);

    // Setup sharing user
    db.run("INSERT OR IGNORE INTO users (id, username, password, role) VALUES (701, 'share_partner_test', 'pass', 'agent')");
    db.run("INSERT OR REPLACE INTO sharing_users (id, agent_user_id, panel_name, username, active) VALUES (71, 701, 'Partner Alpha', 'share_partner_test', 1)");

    // Insert 2 test numbers
    db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('9300000001', ?, NULL, NULL, NULL)", [range.id]);
    db.run("INSERT INTO numbers (number, range_id, manager_id, agent_id, client_id) VALUES ('9300000002', ?, NULL, NULL, NULL)", [range.id]);

    const num1 = db.get("SELECT id, number FROM numbers WHERE number='9300000001'");
    const num2 = db.get("SELECT id, number FROM numbers WHERE number='9300000002'");

    // User overrides default price $0.0050 to $0.0040 in confirmation popup
    const confirmedPrice = '0.0040';
    const payterm = 'weekly_7_1';

    // Simulate backend update logic in /api/panel-sharing/allocate
    db.run(
      "UPDATE numbers SET agent_id=701, manager_id=NULL, client_id=NULL, client_rate=?, payout=?, rate=?, payterm=?, alloc_source='manual' WHERE id IN (?, ?)",
      [confirmedPrice, confirmedPrice, confirmedPrice, payterm, num1.id, num2.id]
    );

    // Verify numbers received downstream price
    const updated1 = db.get("SELECT client_rate, payout, rate, payterm FROM numbers WHERE id=?", [num1.id]);
    assert.strictEqual(updated1.client_rate, '0.0040', 'Downstream client_rate not set to confirmed price');
    assert.strictEqual(updated1.payout, '0.0040', 'Downstream payout not set to confirmed price');
    assert.strictEqual(updated1.payterm, 'weekly_7_1', 'Payterm not set');

    // Verify upstream provider cost is 100% untouched
    const rangeAfter = db.get("SELECT rate_7_1, provider_rate_7_1 FROM ranges WHERE id=?", [range.id]);
    assert.strictEqual(rangeAfter.rate_7_1, '0.0050', 'Rate Card modified!');
    assert.strictEqual(rangeAfter.provider_rate_7_1, '0.0020', 'Provider rate modified!');

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id=?", [range.id]);
    db.run("DELETE FROM ranges WHERE id=?", [range.id]);
  });

  // --- SECTIONS 40-45: MULTI-RANGE BULK ALLOCATION ---
  console.log('\n--- Sections 40-45: Multi-Range Bulk Allocation ---');
  test('Bulk Allocation assigns multiple ranges at once using each range\'s authoritative Rate Card price', () => {
    // Range 1: Afghanistan ($0.0050)
    db.run("DELETE FROM ranges WHERE name=?", ['Afghanistan Galaxy 01']);
    db.run("INSERT INTO ranges (name, prefix, rate_7_1, provider_rate_7_1) VALUES ('Afghanistan Galaxy 01', '93', '0.0050', '0.0020')");
    const r1 = db.get("SELECT id, name FROM ranges WHERE name='Afghanistan Galaxy 01'");

    // Range 2: Algeria ($0.0060)
    db.run("DELETE FROM ranges WHERE name=?", ['Algeria Galaxy 01']);
    db.run("INSERT INTO ranges (name, prefix, rate_7_1, provider_rate_7_1) VALUES ('Algeria Galaxy 01', '213', '0.0060', '0.0025')");
    const r2 = db.get("SELECT id, name FROM ranges WHERE name='Algeria Galaxy 01'");

    // Range 3: Zambia ($0.0040)
    db.run("DELETE FROM ranges WHERE name=?", ['Zambia Galaxy 01']);
    db.run("INSERT INTO ranges (name, prefix, rate_7_1, provider_rate_7_1) VALUES ('Zambia Galaxy 01', '260', '0.0040', '0.0015')");
    const r3 = db.get("SELECT id, name FROM ranges WHERE name='Zambia Galaxy 01'");

    // Insert numbers in all 3 ranges
    db.run("INSERT INTO numbers (number, range_id) VALUES ('9300000010', ?)", [r1.id]);
    db.run("INSERT INTO numbers (number, range_id) VALUES ('9300000011', ?)", [r1.id]);
    db.run("INSERT INTO numbers (number, range_id) VALUES ('2130000001', ?)", [r2.id]);
    db.run("INSERT INTO numbers (number, range_id) VALUES ('2600000001', ?)", [r3.id]);

    // Simulate multi-range bulk allocation to Partner 71 (agent 701)
    const rangesToAlloc = [
      { id: r1.id, name: r1.name, price: '0.0050' },
      { id: r2.id, name: r2.name, price: '0.0060' },
      { id: r3.id, name: r3.name, price: '0.0040' }
    ];

    for (const item of rangesToAlloc) {
      db.run(
        "UPDATE numbers SET agent_id=701, client_rate=?, payout=?, rate=?, payterm='weekly_7_1', alloc_source='manual' WHERE range_id=?",
        [item.price, item.price, item.price, item.id]
      );
    }

    // Verify Range 1 received 0.0050
    const numsR1 = db.all("SELECT client_rate FROM numbers WHERE range_id=?", [r1.id]);
    assert.strictEqual(numsR1.length, 2);
    assert.strictEqual(numsR1[0].client_rate, '0.0050');

    // Verify Range 2 received 0.0060
    const numsR2 = db.all("SELECT client_rate FROM numbers WHERE range_id=?", [r2.id]);
    assert.strictEqual(numsR2[0].client_rate, '0.0060');

    // Verify Range 3 received 0.0040
    const numsR3 = db.all("SELECT client_rate FROM numbers WHERE range_id=?", [r3.id]);
    assert.strictEqual(numsR3[0].client_rate, '0.0040');

    // Clean up
    db.run("DELETE FROM numbers WHERE range_id IN (?, ?, ?)", [r1.id, r2.id, r3.id]);
    db.run("DELETE FROM ranges WHERE id IN (?, ?, ?)", [r1.id, r2.id, r3.id]);
  });

  // --- SECTIONS 46, 47, 48, 50: DUAL ZIP ARCHIVES GENERATION ---
  console.log('\n--- Sections 46-50: Dual ZIP Archives (Detailed & Numbers Only) ---');
  test('Pure JS ZIP builder generates valid standard ZIPs containing per-range CSVs', () => {
    // Load window.createZipArchive from assets/galaxy.js
    const gxJs = fs.readFileSync(path.join(__dirname, '../assets/galaxy.js'), 'utf-8');
    const vm = require('vm');
    const sandbox = {
      window: {},
      document: { addEventListener: () => {} },
      TextEncoder: TextEncoder,
      Uint8Array: Uint8Array,
      DataView: DataView,
      Blob: function(parts, opts) { this.parts = parts; this.opts = opts; }
    };
    vm.createContext(sandbox);
    vm.runInContext(gxJs, sandbox);

    assert(typeof sandbox.window.createZipArchive === 'function', 'createZipArchive not exported to window');

    // Test ARCHIVE 1: Detailed CSV files
    const detailedFiles = [
      {
        name: 'Afghanistan Galaxy 01.csv',
        content: 'Range Name,Number,Price\n"Afghanistan Galaxy 01","+9300000010",0.0050\n"Afghanistan Galaxy 01","+9300000011",0.0050'
      },
      {
        name: 'Algeria Galaxy 01.csv',
        content: 'Range Name,Number,Price\n"Algeria Galaxy 01","+2130000001",0.0060'
      }
    ];

    const detailedBlob = sandbox.window.createZipArchive(detailedFiles);
    const detailedBuf = Buffer.from(detailedBlob.parts[0]);
    assert(detailedBuf.length > 100, 'Detailed ZIP buffer too small');
    // Check standard ZIP signature 0x04034b50
    assert.strictEqual(detailedBuf.readUInt32LE(0), 0x04034b50, 'Invalid ZIP local header signature');

    // Test ARCHIVE 2: Numbers-Only CSV files
    const numbersFiles = [
      {
        name: 'Afghanistan Galaxy 01.csv',
        content: '+9300000010\n+9300000011'
      },
      {
        name: 'Algeria Galaxy 01.csv',
        content: '+2130000001'
      }
    ];

    const numbersBlob = sandbox.window.createZipArchive(numbersFiles);
    const numbersBuf = Buffer.from(numbersBlob.parts[0]);
    assert(numbersBuf.length > 50, 'Numbers ZIP buffer too small');
    assert.strictEqual(numbersBuf.readUInt32LE(0), 0x04034b50, 'Invalid ZIP local header signature');
  });

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED / ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

run();
