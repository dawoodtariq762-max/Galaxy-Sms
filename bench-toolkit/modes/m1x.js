'use strict';
/* Mode 1X — Extreme scales (100M-600M) WITHOUT giant DB inserts:
   (a) extrapolate per-op cost from latest m1 report, (b) disk I/O soak sample. */
const cfg0 = require('../lib/guard').loadConfig();
const { assertToken } = require('../lib/guard');
const { write } = require('../lib/report');
const fs = require('fs'), path = require('path');

module.exports = async function m1x({ token, scale = '600M', soakGB = 10 } = {}) {
  assertToken(cfg0, token);
  const target = { '100M': 1e8, '200M': 2e8, '500M': 5e8, '600M': 6e8 }[scale];
  if (!target) { console.error('scale 100M|200M|500M|600M'); process.exit(1); }
  console.log(`\n=== MODE 1X extreme: ${scale} (representative + disk soak) ===`);
  const files = fs.existsSync(cfg0.REPORT_DIR) ? fs.readdirSync(cfg0.REPORT_DIR).filter(f => f.startsWith('m1-') && f.endsWith('.json')) : [];
  const results = [];
  if (!files.length) { console.error('✗ pehle `node pwbench.js inventory` chalao (S1..S4) — extrapolation ko base chahiye'); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(path.join(cfg0.REPORT_DIR, files.sort().pop()), 'utf8'));
  const baseScale = /(\d+M)/.exec(base.title)?.[1]; const baseN = parseInt(baseScale, 10) * 1e6;
  const ratio = target / baseN;
  const lin = name => { const r = base.results.find(x => x.name === name); if (!r) return null; const ms = parseFloat(r.value); return +(ms * Math.min(ratio, 25)).toFixed(0); };
  results.push({ name: `${scale} browse (linear-model, capped 25×)`, value: (lin('all-ops p50') || '?') + 'ms', verdict: '🟠 STRESSED', label: `EXTRAPOLATED (from ${baseScale} MEASURED)` });
  results.push({ name: `${scale} DB size (375B/row + WAL/backup overhead)`, value: (target / 1e6 * 0.375).toFixed(0) + 'GB (×2 backups ≈ ' + (target / 1e6 * 1.125).toFixed(0) + 'GB)', label: 'PROJECTED' });
  const soakFile = path.join(cfg0.BENCH_DB_DIR, `soak-${Date.now()}.bin`);
  console.log(`   disk soak: ${soakGB}GB sequential write...`);
  const t0 = Date.now(); let written = 0;
  const fd = fs.openSync(soakFile, 'w'); const buf = Buffer.alloc(8 * 1024 * 1024, 7);
  const targetBytes = soakGB * 1e9;
  while (written < targetBytes) { fs.writeSync(fd, buf); written += buf.length; }
  fs.fsyncSync(fd); fs.closeSync(fd);
  const writeSec = (Date.now() - t0) / 1000; const mbps = +(soakGB * 1024 / writeSec).toFixed(0);
  fs.unlinkSync(soakFile);
  const dbGB = target / 1e6 * 0.375;
  results.push(
    { name: 'disk sequential write', value: `${mbps} MB/s (${soakGB}GB sample)`, label: 'DISK-MEASURED (sample)' },
    { name: `${scale} full-DB scan/backup est. @${mbps}MB/s`, value: Math.round(dbGB * 1024 / Math.max(1, mbps) / 60) + ' min', verdict: dbGB * 1024 / mbps / 60 > 60 ? '🔴 BREAKING (1h+ ops window)' : '🟡 WARNING', label: 'EXTRAPOLATED' },
  );
  results.push({ name: `${scale} architecture verdict`, value: 'single-file SQLite: backup/scan/ANALYZE windows infeasible at this size — PG migration (roadmap E) ya range-sharding required', verdict: '🔴 NOT FEASIBLE', label: 'PROJECTED (model)' });
  return write('m1x', cfg0, { title: `Extreme representative ${scale}`, config: { scale, soakGB }, results, notes: [`base report: ${base.title}`, 'linear-model capped 25× — indexed lookups is se BEHTAR honge (B-tree log); scans/count ye upper-bound hai'] });
};
if (require.main === module) module.exports({ token: process.argv[2], scale: process.env.SCALE || '600M', soakGB: +(process.env.SOAK_GB || 10) });
