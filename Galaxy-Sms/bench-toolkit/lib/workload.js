'use strict';
/* pwbench lib/workload.js — shared scenario helpers: inventory seed, op probes, sys sampling */
const { spawn } = require('child_process'), path = require('path'), fs = require('fs');
const { checkStop } = require('./guard');
const { raw } = require('./api');
const { Hist } = require('./hist');
const { sysSample, sysDelta } = require('./srv');

async function ensureInventory(cfg, N, benchDbFile) {
  fs.mkdirSync(path.dirname(benchDbFile), { recursive: true });
  let existing = 0;
  try { const D = require(path.join(cfg.APP_ROOT, 'node_modules/better-sqlite3')); const d = new D(benchDbFile, { readonly: true }); existing = d.prepare('SELECT COUNT(*) c FROM numbers').get().c; d.close(); } catch (_) {}
  if (existing >= N) { console.log(`   inventory: reusing ${existing.toLocaleString()} rows`); return existing; }
  console.log(`   bulkload ${N.toLocaleString()} numbers (existing ${existing})...`);
  await new Promise((res, rej) => { const c = spawn('node', [path.join(cfg.APP_ROOT, 'scripts/bench-bulkload.js')], { env: { ...process.env, BENCH_DB: benchDbFile, BENCH_N: String(N) }, stdio: ['ignore', 'ignore', 'inherit'] }); c.on('exit', x => x === 0 ? res() : rej(new Error('bulkload ' + x))); });
  return N;
}
/** measure the 4 standard user-facing ops with a role's token */
async function probeOps(port, token, { sample = 40 } = {}) {
  const hb = new Hist(), hs = new Hist(), hd = new Hist(), hh = new Hist();
  for (let i = 0; i < sample; i++) {
    if (checkStop()) break;
    let t = performance.now(); await raw(port, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${1 + Math.floor(Math.random() * 500)}`, { token }); hb.add(performance.now() - t);
    t = performance.now(); await raw(port, 'GET', `/api/numbers?paged=1&limit=25&_nocache=1&search=92300${1000000 + Math.floor(Math.random() * 8999999)}`, { token }); hs.add(performance.now() - t);
    t = performance.now(); await raw(port, 'GET', '/api/dashboard', { token }); hd.add(performance.now() - t);
    t = performance.now(); await raw(port, 'GET', '/api/sms/paged?limit=25&_nocache=1', { token }); hh.add(performance.now() - t);
  }
  return { browse: hb.out(), search: hs.out(), dashboard: hd.out(), smsHistory: hh.out() };
}
class Sampler {
  constructor(pids) { this.pids = pids; this.a = sysSample(pids); this.t = Date.now(); }
  stop() { const b = sysSample(this.pids); return sysDelta(this.a, b, Date.now() - this.t); }
}
async function healthLag(port) { try { const r = await raw(port, 'GET', '/api/health'); return r.j?.event_loop || null; } catch (_) { return null; } }
module.exports = { ensureInventory, probeOps, Sampler, healthLag };
