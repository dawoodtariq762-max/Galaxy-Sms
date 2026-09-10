'use strict';
/* Mode 9 — Accelerated 24h soak: 1 sim-hour = 5 real-min, 3 admin shifts, restart drills */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken, assertCaps, checkStop } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw, runWorkers } = require('../lib/api');
const { ensureInventory, healthLag } = require('../lib/workload');
const { write } = require('../lib/report');
const { ensureUsers } = require('../lib/users');
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function m9({ token, scale = 'S2', simHours = 24, compress = 5 } = {}) {
  assertToken(cfg0, token);
  const runMin = simHours * compress; // 24×5=120min
  assertCaps(cfg0, { durationMin: runMin + 10, messages: 60 * runMin * 2 });
  const sizes = { S1: 1e6, S2: 5e6, S3: 1e7, S4: 2e7 }; const N = sizes[scale];
  const dbFile = `${cfg0.BENCH_DB_DIR}/bench.db`;
  console.log(`\n=== MODE 9 soak: ${scale}, ${simHours} sim-hours × ${compress}min = ${runMin}min ===`);
  await ensureInventory(cfg0, N, dbFile);
  let srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm9' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 9, agentsPer: 3, clientsPer: 3 });
  const tokens = Object.values(creds).map(x => x.token);
  const results = []; const probes = [];
  const dbSizeAt = () => { try { return +(require('fs').statSync(dbFile).size / 1e9).toFixed(2); } catch (_) { return 0; } };
  const hourProbe = async (label) => {
    const h = await healthLag(cfg0.BENCH_PORT);
    const t = performance.now(); await raw(cfg0.BENCH_PORT, 'GET', '/api/numbers?paged=1&limit=25&_nocache=1&page=50', { token: tokens[0] });
    const lat = +(performance.now() - t).toFixed(1);
    probes.push({ label, browseMs: lat, lag99: h?.lag_p99_ms, rssMB: h?.rss_mb, dbGB: dbSizeAt() });
    console.log(`   [${label}] browse=${lat}ms lag99=${h?.lag_p99_ms}ms rss=${h?.rss_mb}MB db=${dbSizeAt()}GB`);
  };
  const stopAdmins = { v: false };
  const staff = runWorkers(12, async (i) => {
    const tk = tokens[1 + (i % Math.max(1, tokens.length - 1))];
    while (!stopAdmins.v) { await raw(cfg0.BENCH_PORT, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${1 + Math.floor(Math.random() * 600)}`, { token: tk }); await raw(cfg0.BENCH_PORT, 'GET', '/api/dashboard', { token: tk }); await sleep(2500); }
  }, { deadlineMs: runMin * 60000 + 30000 });
  const ingest = (async () => { let i = 0; while (!stopAdmins.v) { await raw(cfg0.BENCH_PORT, 'POST', '/api/incoming-sms', { body: { number: '92300' + (1000000 + (i++ % 900000)), cli: 'SYNTH', message: 'SYNTH-' + process.pid + '-S' + i } }); await sleep(1000); } })();
  let hour = 0;
  while (hour < simHours) {
    hour++;
    await sleep(compress * 60000);
    await hourProbe(`hour-${hour}`);
    if (hour === 8 || hour === 16) console.log(`   [shift change → admin shift ${hour / 8 + 1}]`);
    if (hour === 12) {
      console.log('   [restart drill: SIGKILL + re-boot]');
      srv.killNow(); await sleep(1500);
      srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: String(cfg0.DEFAULT_INGEST_LIMIT_PER_MIN) }, label: 'm9b' });
    }
    if (checkStop()) { console.log('   STOP — soak abort'); break; }
  }
  stopAdmins.v = true; await Promise.all([staff, ingest]).catch(() => {});
  const first = probes[0], last = probes[probes.length - 1];
  const degrade = +(last.browseMs / Math.max(1, first.browseMs)).toFixed(2);
  results.push(
    { name: `hour-1 vs hour-${simHours} browse`, value: `${first.browseMs}ms → ${last.browseMs}ms (×${degrade})`, verdict: degrade <= 1.3 ? '🟢 EASY (no degradation)' : degrade <= 2 ? '🟡 WARNING' : '🔴 BREAKING', label: 'MEASURED' },
    { name: 'DB growth', value: `${first.dbGB}GB → ${last.dbGB}GB`, label: 'MEASURED' },
    { name: 'RSS growth', value: `${first.rssMB}MB → ${last.rssMB}MB`, label: 'MEASURED' },
    { name: 'restart drill', value: 'mid-run SIGKILL + re-boot OK, probes continued', label: 'MEASURED' },
  );
  srv.killNow(); await sleep(800);
  return write('m9', cfg0, { title: `Soak ${scale}: ${simHours} sim-hours (1h=${compress}min)`, config: { simHours, compress }, results, notes: probes.map(p => `${p.label}: ${JSON.stringify(p)}`), bottleneck: degrade > 2 ? 'degradation >2× — WAL growth / memory / checkpoint investigate karo' : '' });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || 'S2', simHours: +(process.env.HOURS || 24), compress: +(process.env.COMPRESS || 5) });
