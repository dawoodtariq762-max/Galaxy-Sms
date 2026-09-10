'use strict';
/* Mode 2 — Synthetic incoming SMS stress: paced ramp × connections + integrity audit */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw, runWorkers, sleep } = require('../lib/api');
const { ensureInventory, Sampler, healthLag } = require('../lib/workload');
const { write } = require('../lib/report');
const audit = require('../lib/audit');
const http = require('http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function postIngest(port, msg) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(msg);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/incoming-sms', method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(data); req.end();
  });
}
module.exports = async function m2({ token, dbFile, rates = '10,50,100', conns = '1,16', secondsPerRate = 30, carrierLock = true } = {}) {
  assertToken(cfg0, token);
  const rateList = rates.split(',').map(Number), connList = conns.split(',').map(Number);
  const totalMsgs = rateList.reduce((a, r) => a + r * secondsPerRate, 0);
  assertCaps(cfg0, { durationMin: Math.ceil(rateList.length * (secondsPerRate + 5) / 60) + 1, messages: totalMsgs, workers: Math.max(...connList) });
  console.log(`\n=== MODE 2 ingest: rates ${rates}/s × conns ${conns}, ${secondsPerRate}s per step ===`);
  await ensureInventory(cfg0, 200000, dbFile);
  const pool = audit.sampleNumbers(dbFile, 2000);
  const srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm2' });
  const client = new Client(cfg0.BENCH_PORT);
  const admin = await client.login('vibepk', 'vibepk123');
  if (carrierLock) {
    await client.call('PUT', '/api/carrier-settings?carrier_lock=Dawood', { carrier_lock: 'Dawood', integration_status: 'enabled', carrier_ip: '127.0.0.1', notes: 'pwbench' }, admin.token);
    console.log('   carrier integration enabled (bench server only)');
  }
  const results = [], integrityRuns = [], notes = [];
  const smp = new Sampler({ bench: srv.pid });
  for (const rate of rateList) {
    for (const connsN of connList) {
      const nMsgs = rate * secondsPerRate;
      const refs = Array.from({ length: nMsgs }, (_, i) => `SYNTH-${process.pid}-${rate}-${connsN}-${i}`);
      const intervalMs = 1000 * connsN / rate;   // pacing: per-worker spacing
      const t0 = Date.now(); let accepted = 0, rejected = 0;
      await runWorkers(connsN, async (i) => {
        if (i > connsN) await sleep(intervalMs); // pehla batch foran
        const st = await postIngest(cfg0.BENCH_PORT, { number: pool[i % pool.length] || '923001234567', cli: 'SYNTH', message: refs[i - 1] });
        if (st === 200) accepted++; else rejected++;
      }, { maxItems: nMsgs });
      const secs = (Date.now() - t0) / 1000;
      const lag = await healthLag(cfg0.BENCH_PORT);
      results.push({ name: `${rate}/s @ ${connsN}conn`, value: `${Math.round(accepted / secs)}/s processed (sent=${nMsgs}, acc=${accepted}, rej=${rejected}) avgLat=${client.h.out().avg}ms elLag99=${lag?.lag_p99_ms ?? '?'}ms`, verdict: accepted / secs >= rate * 0.98 ? '🟢 EASY' : accepted / secs >= rate * 0.8 ? '🟡 WARNING' : '🟠 STRESSED', label: 'MEASURED' });
      if (connsN === 1) {
        const a = audit.ingestAudit(dbFile, refs);
        integrityRuns.push({ step: `${rate}/s`, sent: a.sent, stored: a.stored, lost: a.lost, dup: a.duplicateSamples.length, pass: a.pass });
        console.log(`   integrity ${rate}/s: sent=${a.sent} stored=${a.stored} lost=${a.lost} dup=${a.duplicateSamples.length} → ${a.pass ? 'PASS' : 'FAIL'}`);
      }
    }
  }
  const sys = smp.stop();
  results.push({ name: 'CPU% / RAM / IO (whole run)', value: `${sys.bench?.cpuPct ?? '?'}% / ${sys.bench?.rssMB ?? '?'}MB / ${sys.bench?.ioMB ?? '?'}MB`, label: 'MEASURED' });
  srv.killNow();
  await new Promise(r => setTimeout(r, 800));
  const worst = integrityRuns.find(x => !x.pass);
  return write('m2', cfg0, {
    title: `Ingest stress: rates ${rates}/s, connections ${conns}`, config: { secondsPerRate, carrierLock },
    results, integrity: integrityRuns.length ? { runs: integrityRuns, pass: !worst } : {},
    bottleneck: results.some(r => /🔴|🟠/.test(r.verdict)) ? 'degraded rate par WAL-checkpoint stalls (elLag spikes) ya single-conn serialization — profiler comparison rows dekho' : '', notes,
  });
};
if (require.main === module) module.exports({ token: process.argv[2], rates: process.env.RATES || '10,50,100', conns: process.env.CONNS || '1,16', secondsPerRate: +(process.env.SECS || 30), dbFile: process.env.DBFILE || (cfg0.BENCH_DB_DIR + '/bench.db') });
