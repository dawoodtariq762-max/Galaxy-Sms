'use strict';
/* Mode 5 — Combined matrix C1..C5 (inventory × users × ingest × alloc simultaneously) */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps, checkStop } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw, runWorkers } = require('../lib/api');
const { ensureInventory, Sampler, healthLag } = require('../lib/workload');
const { write, verdict } = require('../lib/report');
const { ensureUsers } = require('../lib/users');
const { Hist } = require('../lib/hist');
const audit = require('../lib/audit');
const http = require('http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function postIngest(port, msg) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(msg);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/incoming-sms', method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(30000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.write(data); req.end();
  });
}
const C = {
  C1: { N: 2e7, users: 150, sms: 70, alloc: 1000, conns: 8 },
  C2: { N: 2e7, users: 150, sms: 150, alloc: 1000, conns: 16 },
  C3: { N: 2e7, users: 150, sms: 200, alloc: 50000, conns: 16 },
  C4: { N: 5e7, users: 150, sms: 100, alloc: 50000, conns: 16 },
  C5: { N: 1e8, users: 150, sms: 100, alloc: 50000, conns: 16, representative: true },
};
module.exports = async function m5({ token, id = 'C1', minutes = 10 } = {}) {
  assertToken(cfg0, token);
  const c = C[id]; if (!c) { console.error('id C1..C5'); process.exit(1); }
  if (c.representative) { console.error('✗ C5 (100M) real-DB test refused — `node pwbench.js extreme` chalao (representative).'); process.exit(2); }
  assertCaps(cfg0, { durationMin: minutes + 5, workers: c.conns + 16 });
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 5 combined ${id}: ${c.N.toLocaleString()} numbers, ${c.users} users, ${c.sms} SMS/s, ${minutes}min ===`);
  await ensureInventory(cfg0, c.N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm5' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 15, agentsPer: 4, clientsPer: 3 });
  const tokens = Object.values(creds).map(x => x.token);
  const admin = creds.admin, mgr = creds.bm0;
  const results = []; const smp = new Sampler({ bench: srv.pid });
  const pool = audit.sampleNumbers(dbFile, 2000);
  let stopAll = false; const userLat = new Hist(); let sentMsgs = 0, accepted = 0;
  const userWorkers = runWorkers(Math.min(c.users, 64), async (i) => {
    const tk = tokens[i % tokens.length];
    const t = performance.now(); await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${1 + Math.floor(Math.random() * 800)}`, { token: tk }); userLat.add(performance.now() - t);
    await raw(cfg0.BENCH_PORT, 'GET', '/api/dashboard', { token: tk });
    await raw(cfg0.BENCH_PORT, 'GET', '/api/sms/paged?limit=25&_nocache=1', { token: tk });
    await sleep(1500);
  }, { deadlineMs: minutes * 60000 });
  const ingestWorker = runWorkers(c.conns, async () => {
    if (stopAll) return;
    const ref = `SYNTH-${process.pid}-C-${sentMsgs++}`;
    const st = await postIngest(cfg0.BENCH_PORT, { number: pool[sentMsgs % Math.max(1, pool.length)] || '923001234567', cli: 'SYNTH', message: ref });
    if (st === 200) accepted++; else sentMsgs--;
    await sleep(1000 / c.sms * c.conns);
  }, { deadlineMs: minutes * 60000 - 20000 });
  const allocWorker = (async () => { for (let k = 0; k < 10 && !stopAll; k++) { await sleep(minutes * 6000); const ids = []; let x = k + 999; while (ids.length < c.alloc) { x = (x * 31 + 7) % 99999991; ids.push(300 + (x % Math.floor(c.N * .5))); } await raw(cfg0.BENCH_PORT, 'POST', '/api/numbers/allocate', { token: admin.token, body: { ids, target_id: mgr.id } }); } })();
  const exWorker = (async () => { await sleep(minutes * 30000); const ex = await raw(cfg0.BENCH_PORT, 'POST', '/api/exports', { token: admin.token, body: { type: 'numbers' } }); console.log('   export job:', ex.j?.job_id); })();
  for (let m = minutes; m > 0; m--) { if (checkStop()) break; await sleep(60000); const lag = await healthLag(cfg0.BENCH_PORT); console.log(`   ...${m}min left | users p50=${userLat.out().p50}ms | sms sent=${sentMsgs} acc=${accepted} | lag99=${lag?.lag_p99_ms}ms`); }
  stopAll = true; await Promise.all([userWorkers, ingestWorker, allocWorker, exWorker]).catch(() => {});
  const sys = smp.stop(); const uo = userLat.out(); const lag = await healthLag(cfg0.BENCH_PORT);
  const ingestRate = (accepted / (minutes * 60)).toFixed(1);
  results.push(
    { name: 'user ops p50 (150 panels)', value: uo.p50 + 'ms', verdict: verdict(uo.p50), label: 'MEASURED' },
    { name: 'user ops p95/p99', value: `${uo.p95}/${uo.p99}ms`, label: 'MEASURED' },
    { name: `ingest`, value: `target ${c.sms}/s, achieved ${ingestRate}/s (sent=${sentMsgs}, accepted=${accepted})`, verdict: +ingestRate >= c.sms * 0.95 ? '🟢 EASY' : +ingestRate >= c.sms * 0.8 ? '🟡 WARNING' : '🟠 STRESSED', label: 'MEASURED' },
    { name: 'CPU% / RAM / IO', value: `${sys.bench?.cpuPct ?? '?'}% / ${sys.bench?.rssMB ?? '?'}MB / ${sys.bench?.ioMB ?? '?'}MB`, label: 'MEASURED' },
    { name: 'event-loop lag p50/p99', value: `${lag?.lag_p50_ms ?? '?'}/${lag?.lag_p99_ms ?? '?'}ms`, verdict: (lag?.lag_p99_ms || 0) <= 250 ? '🟢 EASY' : '🔴 BREAKING', label: 'MEASURED' },
  );
  srv.killNow(); await sleep(800);
  return write('m5', cfg0, { title: `Combined ${id}: ${c.N.toLocaleString()} × ${c.users}u × ${c.sms}sms/s`, config: { id, minutes }, results, bottleneck: +ingestRate < c.sms * 0.8 ? 'ingest target se kaam — WAL checkpoint / batch-ingest hypothesis (design §0)' : (uo.p95 > 1000 ? 'user p95 high — probe karo konsa op' : '') });
};
if (require.main === module) module.exports({ token: process.argv[2], id: process.env.ID || 'C1', minutes: +(process.env.MINUTES || 10) });
