'use strict';
/* Mode 1 — Inventory scale benchmark (S1..S4 real; S5 = warning; S6+ refused -> m1x) */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw } = require('../lib/api');
const { ensureInventory, probeOps, Sampler, healthLag } = require('../lib/workload');
const { write, verdict } = require('../lib/report');
const { distribute } = require('../lib/users');

module.exports = async function m1({ token, scale = 'S2', sample = 40 } = {}) {
  assertToken(cfg0, token);
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7, S5: 5e7 };
  const N = sizes[scale]; if (!N) { console.error('scale S1..S5'); process.exit(1); }
  if (N >= 1e8) { console.error('✗ S6+ real-DB benchmark refused — `node pwbench.js extreme` (representative) use karo'); process.exit(2); }
  if (N >= 5e7) console.error('⚠ 50M = ~19GB DB, lambe op windows (design §1)');
  assertCaps(cfg0, { durationMin: 60 });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 1 inventory: ${scale} (${N.toLocaleString()}) ===`);
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, label: 'm1' });
  const client = new Client(cfg0.BENCH_PORT);
  const admin = await client.login('vibepk', 'vibepk123');
  const results = [], notes = [];
  try { await raw(cfg0.BENCH_PORT, 'POST', '/api/users', { token: admin.token, body: { username: 'm1mgr', password: 'pwbench123', role: 'manager', name: 'M1 Mgr' } }); } catch (_) {}
  const mgr = await client.login('m1mgr', 'pwbench123');
  const scopes = distribute(dbFile, { managers: 1, agentsPer: 2, clientsPer: 2, share: 0.5 });
  results.push({ name: `scope distribution (${scale})`, value: JSON.stringify(scopes), verdict: scopes.duplicates === 0 ? '🟢 EASY' : '🔴 BREAKING', label: 'MEASURED' });
  let t = performance.now(); await client.call('GET', '/api/numbers?paged=1&limit=25&_nocache=1', null, admin.token); const cold = +(performance.now() - t).toFixed(1);
  const smp = new Sampler({ bench: srv.pid });
  await probeOps(cfg0.BENCH_PORT, admin.token, { sample });
  t = performance.now();
  const ids = []; let x = 7; for (let i = 0; i < 1000; i++) { x = (x * 31 + 7) % 99999991; ids.push(100 + (x % Math.floor(N * .5))); }
  await client.call('POST', '/api/numbers/allocate', { ids, target_id: mgr.id }, admin.token);
  const allocMs = +(performance.now() - t).toFixed(0);
  const sys = smp.stop();
  const lag = await healthLag(cfg0.BENCH_PORT);
  const ops = client.h.out();
  results.push(
    { name: 'browse p1 COLD', value: cold + 'ms', verdict: verdict(cold), label: 'MEASURED' },
    { name: `all-ops p50 (${sample}×4)`, value: ops.p50 + 'ms', verdict: verdict(ops.p50), label: 'MEASURED' },
    { name: 'all-ops p95', value: ops.p95 + 'ms', label: 'MEASURED' },
    { name: 'all-ops p99', value: ops.p99 + 'ms', label: 'MEASURED' },
    { name: 'all-ops max', value: ops.max + 'ms', label: 'MEASURED' },
    { name: 'allocate 1k', value: allocMs + 'ms', verdict: verdict(allocMs, 'alloc'), label: 'MEASURED' },
    { name: 'CPU% / RAM / IO', value: `${sys.bench?.cpuPct ?? '?'}% / ${sys.bench?.rssMB ?? '?'}MB / ${sys.bench?.ioMB ?? '?'}MB`, label: 'MEASURED' },
    { name: 'event-loop lag p50/p99', value: `${lag?.lag_p50_ms ?? '?'}/${lag?.lag_p99_ms ?? '?'}ms`, label: 'MEASURED' },
  );
  if (ops.errors) notes.push(`errors during run: ${ops.errors}`);
  srv.killNow();
  await new Promise(r => setTimeout(r, 800));
  return write('m1', cfg0, { title: `Inventory benchmark ${scale} (${N.toLocaleString()} numbers)`, config: { scale, sample }, results, bottleneck: ops.p95 > 500 ? 'browse p95 > 500ms — WAL/disk I/O ya count() path dekho' : '', notes });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S2', sample: +(process.env.SAMPLE || 40) });
