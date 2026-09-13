'use strict';
/* Mode 7 — Isolation: admin-heavy vs manager/agent/client (slowdown multiplier ≤2× PASS) */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw } = require('../lib/api');
const { ensureInventory, sleep } = require('../lib/workload');
const { write } = require('../lib/report');
const { ensureUsers } = require('../lib/users');
const { Hist } = require('../lib/hist');

module.exports = async function m7({ token, scale = 'S2', heavy = 'export,alloc,search' } = {}) {
  assertToken(cfg0, token);
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7 }; const N = sizes[scale]; if (!N) { console.error('scale S1..S4'); process.exit(1); }
  assertCaps(cfg0, { durationMin: 45, allocBatch: 50000 });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 7 isolation: ${scale}, admin-heavy=[${heavy}] ===`);
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, label: 'm7' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 2, agentsPer: 2, clientsPer: 2 });
  const A = creds.admin, M = creds.bm0, G = creds['bm0a0'] || creds.bm0, C = creds['bm0a0c0'] || creds.bm0;
  const results = [];
  const lat = async (tk, n = 60) => { const h = new Hist(); for (let i = 0; i < n; i++) { const t = performance.now(); await raw(cfg0.BENCH_PORT, 'GET', '/api/numbers?paged=1&limit=25&_nocache=1&page=' + (1 + i % 300), { token: tk }); h.add(performance.now() - t); } return h.out(); };
  const idle = { admin: await lat(A.token), manager: await lat(M.token), agent: await lat(G.token), client: await lat(C.token) };
  console.log('   idle:', Object.entries(idle).map(([k, v]) => `${k}=${v.p50}ms`).join(' '));
  const heavyOps = {
    export: async () => { const ex = await raw(cfg0.BENCH_PORT, 'POST', '/api/exports', { token: A.token, body: { type: 'numbers' } }); if (ex.status === 200) { for (let i = 0; i < 240; i++) { await sleep(1000); const j = await raw(cfg0.BENCH_PORT, 'GET', '/api/jobs/' + ex.j.job_id, { token: A.token }); if (j.j?.status === 'done' || j.j?.status === 'failed') break; } } },
    alloc: async () => { const ids = []; let x = 424242; while (ids.length < 50000) { x = (x * 31 + 7) % 99999991; ids.push(500 + (x % Math.floor(N * .5))); } await raw(cfg0.BENCH_PORT, 'POST', '/api/numbers/allocate', { token: A.token, body: { ids, target_id: M.id } }); },
    search: async () => { for (let i = 0; i < 30; i++) await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=1000&_nocache=1&search=9230${i % 10}`, { token: A.token }); },
  };
  const mult = {};
  for (const op of heavy.split(',')) {
    if (!heavyOps[op]) continue;
    const during = { manager: new Hist(), agent: new Hist(), client: new Hist() };
    let stopProbes = false;
    const probeLoop = async (name, tk) => { while (!stopProbes) { const t = performance.now(); await raw(cfg0.BENCH_PORT, 'GET', '/api/numbers?paged=1&limit=25&_nocache=1&page=' + (1 + Math.floor(Math.random() * 400)), { token: tk }); during[name].add(performance.now() - t); await sleep(200); } };
    const loops = [probeLoop('manager', M.token), probeLoop('agent', G.token), probeLoop('client', C.token)];
    await heavyOps[op]();
    stopProbes = true; await Promise.all(loops);
    for (const role of ['manager', 'agent', 'client']) {
      const m = +(during[role].out().p50 / Math.max(1, idle[role].p50)).toFixed(2);
      mult[`${op}:${role}`] = m;
      results.push({ name: `during admin ${op} → ${role} p50`, value: `${during[role].out().p50}ms (idle ${idle[role].p50}ms) ×${m}`, verdict: m <= 2 ? '🟢 EASY (isolated)' : m <= 4 ? '🟡 WARNING' : '🔴 FREEZE', label: 'MEASURED' });
    }
  }
  srv.killNow(); await sleep(800);
  const worst = Math.max(...Object.values(mult));
  return write('m7', cfg0, { title: `Isolation matrix ${scale} (admin heavy: ${heavy})`, config: { heavy }, results, integrity: { isolationMultiplier: mult, pass: worst <= 2, worst }, bottleneck: worst > 2 ? 'non-admin slowdown >2× — heavy op ka execution path (sync SQL vs worker) check karo' : '' });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S2', heavy: process.env.HEAVY || 'export,alloc,search' });
