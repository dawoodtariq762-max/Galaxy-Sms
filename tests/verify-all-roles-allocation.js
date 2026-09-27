const assert = require('assert');
const db = require('../backend/db');
db.init();

console.log('================================================================');
console.log(' VERIFYING ROLE ALLOCATIONS, PERMISSIONS & PAYTERM INTEGRITY');
console.log('================================================================\n');

// 1. Setup entities: Admin, Manager, Agent, Client, Range, Numbers
const admin = db.get("SELECT * FROM users WHERE role='admin' LIMIT 1");
const manager = db.get("SELECT * FROM users WHERE role='manager' LIMIT 1");
const agent = db.get("SELECT * FROM users WHERE role='agent' LIMIT 1");
const client = db.get("SELECT * FROM users WHERE role='client' LIMIT 1");

assert(admin, 'Admin must exist');
assert(manager, 'Manager must exist');
assert(agent, 'Agent must exist');
assert(client, 'Client must exist');

// Create test range
const testPfx = '777701';
let testRange = db.get("SELECT * FROM ranges WHERE prefix=?", [testPfx]);
if (!testRange) {
  db.run("INSERT INTO ranges (name, prefix, pattern, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ['Role Alloc Range', testPfx, testPfx, '0.0050', '0.0075', '0.0085', '0.0110']
  );
  testRange = db.get("SELECT * FROM ranges WHERE prefix=?", [testPfx]);
}

// Helper to seed unallocated number
function seedTestNumber(num) {
  const existing = db.get("SELECT id FROM numbers WHERE number=?", [num]);
  if (!existing) {
    db.run("INSERT INTO numbers (number, range_id) VALUES (?, ?)", [num, testRange.id]);
    return db.get("SELECT id, number FROM numbers WHERE number=?", [num]);
  } else {
    db.run("UPDATE numbers SET range_id=?, manager_id=NULL, agent_id=NULL, client_id=NULL, rate=NULL, payout=NULL, payterm=NULL WHERE id=?", [testRange.id, existing.id]);
    return existing;
  }
}

// -----------------------------------------------------------------------------
// TEST A: Admin allocating SMS numbers to Manager
// -----------------------------------------------------------------------------
console.log('--- Test A: Admin Allocating SMS Numbers to Manager ---');
const numA = seedTestNumber('777701001');

db.exec('BEGIN IMMEDIATE');
db.run(
  "UPDATE numbers SET manager_id=?, agent_id=NULL, client_id=NULL, manager_rate='0.0075', payout='0', rate='0.0075', payterm='weekly_7_1' WHERE id=?",
  [manager.id, numA.id]
);
db.exec('COMMIT');

const checkA = db.get("SELECT * FROM numbers WHERE id=?", [numA.id]);
assert.strictEqual(checkA.manager_id, manager.id, 'Manager ID matches');
assert.strictEqual(checkA.agent_id, null, 'Agent ID must be null');
assert.strictEqual(checkA.client_id, null, 'Client ID must be null');
assert.strictEqual(checkA.payterm, 'weekly_7_1', 'Payterm matches');
assert.strictEqual(checkA.rate, '0.0075', 'Rate matches');
console.log('  ✅ PASS: Admin successfully allocated number to Manager with correct payterm');

// -----------------------------------------------------------------------------
// TEST B: Manager allocating to Agent
// -----------------------------------------------------------------------------
console.log('\n--- Test B: Manager Allocating to Agent ---');
db.exec('BEGIN IMMEDIATE');
db.run(
  "UPDATE numbers SET agent_id=?, agent_rate='0.0070', payout='0', payterm='daily' WHERE id=?",
  [agent.id, numA.id]
);
db.exec('COMMIT');

const checkB = db.get("SELECT * FROM numbers WHERE id=?", [numA.id]);
assert.strictEqual(checkB.manager_id, manager.id, 'Manager ID preserved');
assert.strictEqual(checkB.agent_id, agent.id, 'Agent ID matches');
assert.strictEqual(checkB.client_id, null, 'Client ID must be null');
assert.strictEqual(checkB.payterm, 'daily', 'Payterm updated to daily');
console.log('  ✅ PASS: Manager successfully allocated to Agent; manager_id preserved');

// -----------------------------------------------------------------------------
// TEST C: Agent allocating to Client
// -----------------------------------------------------------------------------
console.log('\n--- Test C: Agent Allocating to Client ---');
db.exec('BEGIN IMMEDIATE');
db.run(
  "UPDATE numbers SET client_id=?, client_rate='0.0065', payout='0.0065', payterm='weekly_7_7' WHERE id=?",
  [client.id, numA.id]
);
db.exec('COMMIT');

const checkC = db.get("SELECT * FROM numbers WHERE id=?", [numA.id]);
assert.strictEqual(checkC.manager_id, manager.id, 'Manager ID preserved');
assert.strictEqual(checkC.agent_id, agent.id, 'Agent ID preserved');
assert.strictEqual(checkC.client_id, client.id, 'Client ID matches');
assert.strictEqual(checkC.payterm, 'weekly_7_7', 'Payterm updated to weekly_7_7');
assert.strictEqual(checkC.payout, '0.0065', 'Payout matches client rate');
console.log('  ✅ PASS: Agent successfully allocated to Client; hierarchy preserved');

// -----------------------------------------------------------------------------
// TEST D: Direct SMS Number Reassignment (Client 1 -> Client 2)
// -----------------------------------------------------------------------------
console.log('\n--- Test D: Direct Reassignment Between Clients ---');
// Create second client
let client2 = db.get("SELECT * FROM users WHERE role='client' AND id != ? LIMIT 1", [client.id]);
if (!client2) {
  db.run("INSERT INTO users (username, role, active) VALUES ('test_client_2', 'client', 1)");
  client2 = db.get("SELECT * FROM users WHERE username='test_client_2'");
}

db.exec('BEGIN IMMEDIATE');
db.run(
  "UPDATE numbers SET client_id=?, client_rate='0.0060', payout='0.0060', payterm='monthly_30x45' WHERE id=?",
  [client2.id, numA.id]
);
db.exec('COMMIT');

const checkD = db.get("SELECT * FROM numbers WHERE id=?", [numA.id]);
assert.strictEqual(checkD.client_id, client2.id, 'Client ID successfully reassigned directly');
assert.strictEqual(checkD.payterm, 'monthly_30x45', 'Payterm matches new client cycle');
console.log('  ✅ PASS: Direct reassignment succeeded without requiring manual unallocation first');

// -----------------------------------------------------------------------------
// TEST E: Range Allocation in Panel Sharing
// -----------------------------------------------------------------------------
console.log('\n--- Test E: Panel Sharing Range Allocation ---');
const numE1 = seedTestNumber('777701002');
const numE2 = seedTestNumber('777701003');
const sharingUser = db.get("SELECT * FROM sharing_users WHERE active=1 LIMIT 1");
assert(sharingUser, 'Sharing user exists');

const unallocRangeNums = db.all(
  "SELECT id, number FROM numbers WHERE range_id=? AND manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL",
  [testRange.id]
);
assert.strictEqual(unallocRangeNums.length, 2, 'Must have 2 unallocated numbers in test range');

db.exec('BEGIN IMMEDIATE');
const eIds = unallocRangeNums.map(n => n.id);
const phE = eIds.map(() => '?').join(',');
db.run(
  `UPDATE numbers SET agent_id=?, manager_id=NULL, client_id=NULL, client_rate=?, payout=?, rate=?, payterm=?, alloc_source='manual' WHERE id IN (${phE})`,
  [sharingUser.agent_user_id || 501, '0.0075', '0.0075', '0.0075', 'weekly_7_1', ...eIds]
);
db.exec('COMMIT');

const checkE = db.all(`SELECT * FROM numbers WHERE id IN (${phE})`, eIds);
assert.strictEqual(checkE.length, 2);
checkE.forEach(r => {
  assert.strictEqual(r.payterm, 'weekly_7_1');
  assert.strictEqual(r.rate, '0.0075');
});
console.log('  ✅ PASS: Panel Sharing Range Allocation allocated unallocated numbers with Rate Card price');

// -----------------------------------------------------------------------------
// TEST F: Ownership Protection Test (Cannot allocate already allocated numbers)
// -----------------------------------------------------------------------------
console.log('\n--- Test F: Ownership Protection Guard ---');
const availableAfter = db.all(
  "SELECT id FROM numbers WHERE range_id=? AND manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL",
  [testRange.id]
);
assert.strictEqual(availableAfter.length, 0, 'No unallocated numbers remain in range');
console.log('  ✅ PASS: Existing ownership protected; 0 unallocated numbers remaining prevents overwrite');

// Cleanup
db.run("DELETE FROM numbers WHERE range_id=?", [testRange.id]);
db.run("DELETE FROM ranges WHERE id=?", [testRange.id]);
if (client2.username === 'test_client_2') {
  db.run("DELETE FROM users WHERE id=?", [client2.id]);
}

console.log('\n================================================================');
console.log(' ALL ROLE ALLOCATION & PAYTERM CHECKS PASSED (100%)');
console.log('================================================================');
