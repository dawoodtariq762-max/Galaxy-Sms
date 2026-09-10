'use strict';
/* Mode 8 — Random realistic mix, config-limited */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw, runWorkers } = require('../lib/api');
const { ensureInventory, Sampler, healthLag } = require('../lib/workload');
const { write, verdict } = require('../lib/report');
const { ensureUsers } = require('../lib/users');
const audit = require('../lib/audit');

module.exports = async function m8({ token, scale = 'S3', users = 50, smsPerSec = 70, minutes = 10, allocBatch = 1000 } = {}) {
  assertToken(cfg0, token);
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7 }; const N = sizes[scale];
  assertCaps(cfg0, { durationMin: minutes + 2, messages: smsPerSec * 60 * minutes, workers: Math.min(users, 64) + 16, allocBatch });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 8 random: ${scale}, ${users}u, ${smsPerSec}/s, ${minutes}m, alloc=${allocBatch} ===`);
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm8' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 8, agentsPer: 3, clientsPer: 2 });
  const tokens = Object.values(creds).map(x => x.token);
  const admin = creds.admin, mgr = creds.bm0;
  const pool = audit.sampleNumbers(dbFile, 2000);
  const results = []; const smp = new Sampler({ bench: srv.pid });
  const ops = { search: 0, browse: 0, filter: 0, dash: 0, hist: 0, sms: 0, alloc: 0 };
  const deadline = Date.now() + minutes * 60000;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  await Promise.all([
    runWorkers(Math.min(users, 64), async () => {
      const tk = pick(tokens);
      const roll = Math.random();
      if (roll < .30) { await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&search=92300${1000000 + Math.floor(Math.random() * 8999999)}`, { token: tk }); ops.search++; }
      else if (roll < .55) { await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${1 + Math.floor(Math.random() * 900)}`, { token: tk }); ops.browse++; }
      else if (roll < .65) { await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=25&allocation=${pick(['allocated', 'unallocated'])}&_nocache=1`, { token: tk }); ops.filter++; }
      else if (roll < .80) { await raw(cfg0.BENCH_PORT, 'GET', '/api/dashboard', { token: tk }); ops.dash++; }
      else { await raw(cfg0.BENCH_PORT, 'GET', '/api/sms/paged?limit=25&_nocache=1', { token: tk }); ops.hist++; }
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 2000));
    }, { deadlineMs: minutes * 60000 }),
    (async () => { const interval = 1000 / smsPerSec; while (Date.now() < deadline) { await raw(cfg0.BENCH_PORT, 'POST', '/api/incoming-sms', { body: { number: pool[Math.floor(Math.random() * Math.max(1, pool.length))] || '923001234567', cli: 'SYNTH', message: 'SYNTH-' + process.pid + '-R' + Math.random().toString(36).slice(2) } }); ops.sms++; await new Promise(r => setTimeout(r, interval)); } })(),
    (async () => { while (Date.now() < deadline) { await new Promise(r => setTimeout(r, Math.max(60000, minutes * 6000))); const ids = []; let x = Date.now() % 9e6; while (ids.length < allocBatch) { x = (x * 31 + 7) % 99999991; ids.push(700 + (x % Math.floor(N * .5))); } await raw(cfg0.BENCH_PORT, 'POST', '/api/numbers/allocate', { token: admin.token, body: { ids, target_id: mgr.id } }); ops.alloc++; } })(),
  ]);
  const sys = smp.stop(); const o = client.h.out(); const lag = await healthLag(cfg0.BENCH_PORT);
  results.push(
    { name: 'mixed p50/p95/p99', value: `${o.p50}/${o.p95}/${o.p99}ms`, verdict: verdict(o.p50), label: 'MEASURED' },
    { name: 'errors/timeouts', value: `${o.errors}/${o.timeouts}`, label: 'MEASURED' },
    { name: 'op counts', value: JSON.stringify(ops), label: 'MEASURED' },
    { name: 'CPU/RAM/IO', value: `${sys.bench?.cpuPct ?? '?'}% / ${sys.bench?.rssMB ?? '?'}MB / ${sys.bench?.ioMB ?? '?'}MB`, label: 'MEASURED' },
    { name: 'el lag p99', value: (lag?.lag_p99_ms ?? '?') + 'ms', label: 'MEASURED' },
  );
  srv.killNow(); await new Promise(r => setTimeout(r, 800));
  return write('m8', cfg0, { title: `Random mix ${scale} ${users}u ${smsPerSec}/s ${minutes}m`, config: { scale, users, smsPerSec, minutes, allocBatch }, results, bottleneck: '' });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S3', users: +(process.env.USERS || 50), smsPerSec: +(process.env.SMS || 70), minutes: +(process.env.MINUTES || 10), allocBatch: +(process.env.ALLOC || 1000) });
