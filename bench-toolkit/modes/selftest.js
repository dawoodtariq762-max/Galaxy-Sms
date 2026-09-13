'use strict';
/* Selftest — poori toolkit ka chhota end-to-end proof (~3-4 min, 100k inventory) */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken } = require('../lib/guard');
const { startBenchServer } = require('../lib/srv');
const { Client, raw, runWorkers } = require('../lib/api');
const { ensureInventory, probeOps } = require('../lib/workload');
const { write, verdict } = require('../lib/report');
const audit = require('../lib/audit');
const { ensureUsers, distribute } = require('../lib/users');

module.exports = async function selftest({ token } = {}) {
  assertToken(cfg0, token);
  const N = +(process.env.N || 100000);
  const dbFile = `${cfg0.BENCH_DB_DIR}/selftest.db`;
  console.log(`\n=== PW-BENCH SELFTEST (inventory ${N}, mini-ingest, mini-race) ===`);
  const results = []; const integrity = {};
  await ensureInventory(cfg0, N, dbFile);
  const srv = await startBenchServer(cfg0, { dbFile, env: { INCOMING_SMS_RATE_PER_MIN: '12000' }, label: 'selftest' });
  const client = new Client(cfg0.BENCH_PORT);
  const creds = await ensureUsers(client, cfg0, { managers: 2, agentsPer: 1, clientsPer: 1 });
  // 1) scoped distribution + duplicate audit
  const scopes = distribute(dbFile, { managers: 2, agentsPer: 1, clientsPer: 1, share: 0.6 });
  results.push({ name: 'scope distribution (no duplicates)', value: JSON.stringify(scopes), verdict: scopes.duplicates === 0 ? '🟢 EASY' : '🔴 BREAKING', label: 'MEASURED' });
  // 2) probes as a scoped agent
  const ag = Object.values(creds).find(c => c.role === 'agent') || creds.admin;
  const ops = await probeOps(cfg0.BENCH_PORT, ag.token, { sample: 15 });
  results.push({ name: 'scoped agent probes p50', value: ops.browse.p50 + 'ms', verdict: verdict(ops.browse.p50), label: 'MEASURED' });
  // 3) mini ingest with exact integrity
  const REFS = Array.from({ length: 300 }, (_, i) => `SYNTH-self-${process.pid}-${i}`);
  await client.call('PUT', '/api/carrier-settings?carrier_lock=Dawood', { carrier_lock: 'Dawood', integration_status: 'enabled', carrier_ip: '127.0.0.1', notes: 'st' }, creds.admin.token);
  const pool = audit.sampleNumbers(dbFile, 500);
  await runWorkers(4, async i => { await raw(cfg0.BENCH_PORT, 'POST', '/api/incoming-sms', { body: { number: pool[(i - 1) % pool.length] || '923001234567', cli: 'SYNTH', message: REFS[i - 1] } }); }, { maxItems: REFS.length });
  await new Promise(r => setTimeout(r, 1500));
  const ia = audit.ingestAudit(dbFile, REFS);
  integrity.ingest = ia; integrity.pass = ia.pass;
  results.push({ name: 'ingest 300 exact-audit', value: `sent=${ia.sent} stored=${ia.stored} lost=${ia.lost} dup=${ia.duplicateSamples.length}`, verdict: ia.pass ? '🟢 EASY' : '🔴 BREAKING', label: 'MEASURED' });
  // 4) mini race
  const mgr = creds.bm0, mgr2 = creds.bm1;
  const ids = []; let x = 55; while (ids.length < 200) { x = (x * 31 + 7) % 99999991; ids.push(50 + (x % Math.floor(N * .4))); }
  const rs = await Promise.all([1, 2].map(k => raw(cfg0.BENCH_PORT, 'POST', '/api/numbers/allocate', { token: creds.admin.token, body: { ids, target_id: k === 1 ? mgr.id : mgr2.id }, headers: { 'Idempotency-Key': `st-${k}` } })));
  const tot = rs.reduce((a, r) => a + (r.j?.allocated || 0), 0);
  const own = audit.ownershipAudit(dbFile);
  integrity.ownership = own; integrity.pass = integrity.pass && own.pass && tot <= ids.length;
  results.push({ name: 'race 2×200 same ids', value: `totalAllocated=${tot} (≤${ids.length}?) own-pass=${own.pass}`, verdict: tot <= ids.length && own.pass ? '🟢 EASY' : '🔴 BREAKING', label: 'MEASURED' });
  results.push({ name: 'labels/verdicts wired', value: 'report.md+json, 🟢🟡🟠🔴, MEASURED/PROJECTED/EXTRAPOLATED', label: 'MEASURED' });
  srv.killNow(); await new Promise(r => setTimeout(r, 800));
  const rep = write('selftest', cfg0, { title: 'Toolkit selftest (S0 mini)', config: { N }, results, integrity, bottleneck: '', notes: ['ye selftest hai — full capacity ke liye npm run bench:inventory/ingest/... chalao'] });
  console.log(`\nSELFTEST ${integrity.pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return rep;
};
if (require.main === module) module.exports({ token: process.argv[2] });
