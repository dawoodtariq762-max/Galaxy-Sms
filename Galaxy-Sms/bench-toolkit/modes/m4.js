'use strict';
/* Mode 4 — Allocation benchmark + same-ID race proof */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw } = require('../lib/api');
const { ensureInventory, sleep } = require('../lib/workload');
const { write } = require('../lib/report');
const audit = require('../lib/audit');
const { ensureUsers } = require('../lib/users');

module.exports = async function m4({ token, scale = 'S2', batches = '1000,10000,50000', raceAllocators = 8 } = {}) {
  assertToken(cfg0, token);
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7 }; const N = sizes[scale];
  if (!N) { console.error('scale S1..S4'); process.exit(1); }
  assertCaps(cfg0, { durationMin: 40, allocBatch: Math.max(...batches.split(',').map(Number)) });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 4 allocation: ${scale}, batches ${batches}, race=${raceAllocators} allocators ===`);
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, label: 'm4' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 3, agentsPer: 1, clientsPer: 1 });
  const admin = creds.admin, mgr = creds.bm0, mgr2 = creds.bm1 || creds.bm0;
  const results = [];
  const pickIds = (n, salt) => { const ids = []; let x = salt; while (ids.length < n) { x = (x * 31 + 7) % 99999991; ids.push(1000 + (x % Math.floor(N * .6))); } return ids; };
  for (const B of batches.split(',').map(Number)) {
    const ids = pickIds(B, B + 13);
    const t = performance.now();
    const r = await client.call('POST', '/api/numbers/allocate', { ids, target_id: mgr.id }, admin.token);
    const ms = +(performance.now() - t).toFixed(0);
    results.push({ name: `allocate ${B}`, value: `${ms}ms (allocated=${r.j?.allocated}, skipped=${r.j?.skipped})`, label: 'MEASURED' });
    console.log('   ' + results[results.length - 1].value);
  }
  // RACE: same ids, K allocators ek sath
  const raceIds = pickIds(5000, 777);
  console.log(`   race: ${raceAllocators} allocators × same ${raceIds.length} ids...`);
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: raceAllocators }, (_, k) =>
    raw(cfg0.BENCH_PORT, 'POST', '/api/numbers/allocate', { token: admin.token, body: { ids: raceIds, target_id: k % 2 ? mgr2.id : mgr.id }, headers: { 'Idempotency-Key': `race-${k}-${Date.now()}` } })));
  const raceMs = +(performance.now() - t0).toFixed(0);
  const totAlloc = rs.reduce((a, r) => a + (r.j?.allocated || 0), 0);
  const own = audit.ownershipAudit(dbFile);
  results.push({ name: `race ${raceAllocators}× same 5k ids`, value: `${raceMs}ms totalAllocated=${totAlloc} (expected ≤5000, extras=skipped)`, verdict: totAlloc <= raceIds.length ? '🟢 EASY (no double-allocate)' : '🔴 BREAKING (double allocate!)', label: 'MEASURED' });
  results.push({ name: 'ownership audit', value: `orphanedAgent=${own.orphanedAgent} agentWithoutMgr=${own.agentWithoutManager} → ${own.pass ? 'PASS' : 'FAIL'}`, label: 'MEASURED' });
  srv.killNow(); await sleep(800);
  return write('m4', cfg0, { title: `Allocation benchmark ${scale}`, config: { batches, raceAllocators }, results, integrity: { ownership: own, pass: own.pass && totAlloc <= raceIds.length }, bottleneck: '' });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S2', batches: process.env.BATCHES || '1000,10000,50000', raceAllocators: +(process.env.RACE || 8) });
