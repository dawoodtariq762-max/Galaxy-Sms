'use strict';
/* Mode 3 — Concurrent users scaling (same inventory, N users) */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, runWorkers } = require('../lib/api');
const { ensureInventory, probeOps, Sampler, healthLag } = require('../lib/workload');
const { write, verdict } = require('../lib/report');
const { ensureUsers } = require('../lib/users');
const { Hist } = require('../lib/hist');

module.exports = async function m3({ token, scale = 'S3', userCounts = '25,100,150', sample = 25 } = {}) {
  assertToken(cfg0, token);
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7 };
  const N = sizes[scale]; if (!N) { console.error('scale S1..S4'); process.exit(1); }
  const counts = userCounts.split(',').map(Number);
  const maxW = Math.max(...counts); assertCaps(cfg0, { durationMin: 45, workers: maxW });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 3 users: ${scale} inventory, users ${userCounts} ===`);
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, label: 'm3' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 5, agentsPer: 4, clientsPer: 4 });
  const tokens = Object.values(creds).map(c => c.token);
  const results = [];
  for (const U of counts) {
    const smp = new Sampler({ bench: srv.pid });
    const perUser = new Hist();
    const chunk = Math.ceil(U / Math.min(U, 64));
    await runWorkers(Math.min(U, 64), async (i) => {
      const tk = tokens[i % tokens.length];
      const ops = await probeOps(cfg0.BENCH_PORT, tk, { sample: Math.max(3, Math.ceil(sample / Math.min(U, 64))) });
      perUser.add(ops.browse.p50);
    }, { deadlineMs: 120000 });
    const sys = smp.stop();
    const o = client.h.out(), lag = await healthLag(cfg0.BENCH_PORT);
    results.push({ name: `${U} users`, value: `all-ops p50=${o.p50}ms p95=${o.p95} p99=${o.p99} max=${o.max} err=${o.errors} cpu=${sys.bench?.cpuPct}% ram=${sys.bench?.rssMB}MB lag99=${lag?.lag_p99_ms}ms`, verdict: verdict(o.p50), label: 'MEASURED' });
    console.log(`   ${U} users → ${results[results.length - 1].value}`);
  }
  srv.killNow(); await new Promise(r => setTimeout(r, 800));
  return write('m3', cfg0, { title: `Users scaling on ${scale} inventory`, config: { userCounts, sample }, results, bottleneck: '' });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S3', userCounts: process.env.USERS || '25,100,150', sample: +(process.env.SAMPLE || 25) });
