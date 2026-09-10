'use strict';
/* Mode 6 — Extreme bursts: accepted messages kabhi silently lose nahi hone chahiye */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client } = require('../lib/api');
const { ensureInventory, healthLag } = require('../lib/workload');
const { write } = require('../lib/report');
const audit = require('../lib/audit');
const http = require('http');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function postIngest(port, msg) {
  return new Promise(resolve => {
    const data = JSON.stringify(msg);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/incoming-sms', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(30000, () => req.destroy(new Error('t'))); req.on('error', () => resolve(0)); req.end(data);
  });
}
module.exports = async function m6({ token, dbFile, profiles = '2000x1s,10000x5s,50000x30s' } = {}) {
  assertToken(cfg0, token);
  const total = profiles.split(',').reduce((a, p) => a + parseInt(p.split('x')[0], 10), 0);
  assertCaps(cfg0, { durationMin: 30, messages: total, workers: 48 });
  console.log(`\n=== MODE 6 burst: ${profiles} ===`);
  await ensureInventory(cfg0, 200000, dbFile);
  const pool = audit.sampleNumbers(dbFile, 2000);
  const srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm6' });
  const client = new Client(cfg0.BENCH_PORT);
  const admin = await client.login('vibepk', 'vibepk123');
  await client.call('PUT', '/api/carrier-settings?carrier_lock=Dawood', { carrier_lock: 'Dawood', integration_status: 'enabled', carrier_ip: '127.0.0.1', notes: 'pwbench' }, admin.token);
  const results = [];
  for (const prof of profiles.split(',')) {
    const [count, win] = prof.split('x'); const n = parseInt(count, 10);
    const ms = win.endsWith('m') ? parseInt(win, 10) * 60000 : parseInt(win, 10) * 1000;
    const deadline = Date.now() + ms;
    let accepted = 0, rejected = 0; const refs = []; const W = 48; let stop = false;
    await Promise.all(Array.from({ length: W }, async (_, w) => {
      while (!stop && Date.now() < deadline) {
        const ref = `SYNTH-${process.pid}-B${n}-${w}-${refs.length}`;
        refs.push(ref);
        const st = await postIngest(cfg0.BENCH_PORT, { number: pool[refs.length % pool.length] || '923001234567', cli: 'SYNTH', message: ref });
        if (st === 200) accepted++; else rejected++;
      }
    }));
    stop = true;
    await sleep(3000); // drain
    const sample = refs.slice(0, Math.min(refs.length, 50000));
    const a = audit.ingestAudit(dbFile, sample);
    const lag = await healthLag(cfg0.BENCH_PORT);
    results.push({ name: `burst ${prof}`, value: `sent≈${refs.length} acc=${accepted} rej=${rejected} (429=graceful) | sampled stored=${a.stored}/${a.sent} lost=${a.lost} lag99=${lag?.lag_p99_ms}ms`, verdict: a.lost === 0 ? '🟢 EASY (accepted=stored)' : '🔴 BREAKING (SILENT LOSS!)', label: 'MEASURED' });
    console.log('   ' + results[results.length - 1].value);
    if (a.lost > 0) break;
  }
  const recoveryStart = Date.now(); let recMs = 0;
  for (let i = 0; i < 30; i++) { await sleep(1000); const l = await healthLag(cfg0.BENCH_PORT); if ((l?.lag_p99_ms ?? 9999) < 100) { recMs = Date.now() - recoveryStart; break; } }
  results.push({ name: 'recovery to lag99<100ms', value: recMs ? recMs + 'ms' : '>30s', verdict: recMs && recMs < 60000 ? '🟢 EASY' : '🟡 WARNING', label: 'MEASURED' });
  srv.killNow(); await sleep(800);
  return write('m6', cfg0, { title: `Burst profiles: ${profiles}`, results, integrity: { pass: !results.some(r => /SILENT LOSS/.test(r.value)) }, bottleneck: results.some(r => /SILENT LOSS/.test(r.value)) ? 'SILENT LOSS detected — ingest path audit foran' : '' });
};
if (require.main === module) module.exports({ token: process.argv[2], profiles: process.env.PROFILES || '2000x1s,10000x5s,50000x30s', dbFile: process.env.DBFILE || (cfg0.BENCH_DB_DIR + '/bench.db') });
