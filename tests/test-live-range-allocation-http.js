const http = require('http');
const assert = require('assert');
const db = require('../backend/db');
db.init();

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('Testing Live HTTP Range Allocation...');

  // 1. Generate Admin Token using auth.sign
  const { sign } = require('../backend/auth');
  const adminUser = db.get("SELECT id, username, role FROM users WHERE role='admin' LIMIT 1");
  assert(adminUser, 'Admin user must exist in database');
  const token = sign(adminUser);
  console.log('Admin token generated successfully for', adminUser.username);

  // 2. Setup test Range and Numbers in DB
  const rangePrefix = '888801';
  let testRange = db.get('SELECT * FROM ranges WHERE prefix=?', [rangePrefix]);
  if (!testRange) {
    db.run(
      'INSERT INTO ranges (name, prefix, pattern, rate_1_1, rate_7_1, rate_7_7, rate_30_45) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['Live Range Test', rangePrefix, rangePrefix, '0.0060', '0.0085', '0.0095', '0.0120']
    );
    testRange = db.get('SELECT * FROM ranges WHERE prefix=?', [rangePrefix]);
  }

  const sharingUser = db.get('SELECT * FROM sharing_users WHERE active=1 LIMIT 1');
  assert(sharingUser, 'Must have active sharing user');

  // Insert 3 unallocated numbers in this range
  const testNums = ['888801001', '888801002', '888801003'];
  for (const num of testNums) {
    const exists = db.get('SELECT id FROM numbers WHERE number=?', [num]);
    if (!exists) {
      db.run('INSERT INTO numbers (number, range_id) VALUES (?, ?)', [num, testRange.id]);
    } else {
      db.run('UPDATE numbers SET range_id=?, manager_id=NULL, agent_id=NULL, client_id=NULL WHERE number=?', [testRange.id, num]);
    }
  }

  // 3. Test HTTP POST /api/panel-sharing/allocate by range_id
  console.log('Allocating range via POST /api/panel-sharing/allocate...');
  const allocRes = await apiRequest({
    hostname: '127.0.0.1',
    port: 4000,
    path: '/api/panel-sharing/allocate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, {
    sharing_user_id: sharingUser.id,
    range_id: testRange.id,
    payterm: 'weekly_7_1'
  });

  console.log('Response Status:', allocRes.status);
  console.log('Response Body:', allocRes.body);

  assert.strictEqual(allocRes.status, 200, 'Allocation HTTP status must be 200');
  assert.strictEqual(allocRes.body.ok, true, 'ok must be true');
  assert.strictEqual(allocRes.body.count, 3, 'Allocated count must be 3');
  assert.strictEqual(allocRes.body.price, '0.0085', 'Rate card price for 7/1 must match 0.0085');
  assert.strictEqual(allocRes.body.payterm, 'weekly_7_1', 'Payterm must match');
  assert(allocRes.body.ranges && allocRes.body.ranges.length > 0, 'Must return ranges group');
  assert.strictEqual(allocRes.body.ranges[0].numbers.length, 3, 'Must contain all 3 numbers');

  // 4. Test re-allocation attempt on same range returns 404 (ownership protection: no unallocated left)
  const allocEmptyRes = await apiRequest({
    hostname: '127.0.0.1',
    port: 4000,
    path: '/api/panel-sharing/allocate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, {
    sharing_user_id: sharingUser.id,
    range_id: testRange.id,
    payterm: 'weekly_7_1'
  });

  console.log('Second Allocation on exhausted range status:', allocEmptyRes.status);
  assert.strictEqual(allocEmptyRes.status, 404, 'Must return 404 when no unallocated numbers left');

  // 5. Test Role Authorization: Manager/Agent cannot call panel-sharing allocate
  const agentUser = db.get("SELECT id, username, role FROM users WHERE role='agent' LIMIT 1");
  if (agentUser) {
    const agentToken = sign(agentUser);
    const forbiddenRes = await apiRequest({
      hostname: '127.0.0.1',
      port: 4000,
      path: '/api/panel-sharing/allocate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`
      }
    }, {
      sharing_user_id: sharingUser.id,
      range_id: testRange.id
    });
    console.log('Non-admin access status:', forbiddenRes.status);
    assert.strictEqual(forbiddenRes.status, 403, 'Must return 403 for non-admin role');
  }

  // 6. Cleanup
  db.run('DELETE FROM numbers WHERE range_id=?', [testRange.id]);
  db.run('DELETE FROM ranges WHERE id=?', [testRange.id]);

  console.log('\n✅ ALL LIVE HTTP RANGE ALLOCATION TESTS PASSED!');
}

run().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
