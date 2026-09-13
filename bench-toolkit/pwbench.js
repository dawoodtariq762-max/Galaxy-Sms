#!/usr/bin/env node
'use strict';
/* pwbench.js — PowerX temporary benchmark laboratory (STANDALONE, /opt/powerx-bench)
   Safety: token + loopback-only target + caps + STOP kill-switch + isolated bench DB. */
const path = require('path');
const guard = require('./lib/guard');
const cfg = guard.loadConfig();

const HELP = `
pwbench — PowerX temporary stress lab (production panel se bilkul alag)

USAGE: node pwbench.js <command> --token "<TOKEN>" [options]

Commands:
  selftest                     chhota end-to-end proof (~3 min)
  inventory [--SCALE S1..S5] [--SAMPLE 40]      Mode 1
  ingest    [--RATES 10,50,100] [--CONNS 1,16] [--SECS 30]   Mode 2 (integrity audit)
  users     [--SCALE S3] [--USERS 25,100,150] [--SAMPLE 25]  Mode 3
  allocation[--SCALE S2] [--BATCHES 1000,10000,50000] [--RACE 8] Mode 4
  combined  [--ID C1..C5] [--MINUTES 10]        Mode 5 (C5 refused -> extreme)
  burst     [--PROFILES 2000x1s,10000x5s,50000x30s]           Mode 6
  isolation [--SCALE S2] [--HEAVY export,alloc,search]        Mode 7
  random    [--SCALE S3] [--USERS 50] [--SMS 70] [--MINUTES 10] [--ALLOC 1000]  Mode 8
  soak      [--SCALE S2] [--HOURS 24] [--COMPRESS 5]          Mode 9 (120min!)
  extreme   [--SCALE 600M] [--SOAK_GB 10]       Mode 1X (representative, no giant DB)
  stop                        emergency STOP (sab runs band)
  report                      FINAL CAPACITY-ANSWER generate
  cleanup                     bench DBs + exports remove (production DB ko touch NAHI karta)

Env: SCALE, SAMPLE, RATES, CONNS, SECS, USERS, BATCHES, RACE, ID, MINUTES, HEAVY, SMS, ALLOC, HOURS, COMPRESS, SOAK_GB, DBFILE
`;
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : (process.env[name] || dflt); };
const cmd = process.argv[2];
const token = process.argv[process.argv.indexOf('--token') + 1] || process.env.PW_TOKEN;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'stop') { require('fs').writeFileSync(path.join(guard.ROOT, 'STOP'), String(Date.now())); console.log('✓ STOP file likh diya — chalte runs agle second band. 3s baad: fuser -k ' + cfg.BENCH_PORT + '/tcp'); setTimeout(() => process.exit(0), 500); return; }
  if (cmd === 'report') { guard.assertToken(cfg, token); require('./lib/report').capacity(cfg); return; }
  if (cmd === 'cleanup') {
    guard.assertToken(cfg, token);
    const fs = require('fs');
    for (const f of (fs.existsSync(cfg.BENCH_DB_DIR) ? fs.readdirSync(cfg.BENCH_DB_DIR) : [])) { try { fs.unlinkSync(path.join(cfg.BENCH_DB_DIR, f)); } catch (_) {} }
    try { fs.rmSync(path.join(cfg.APP_ROOT, 'powerx-exports'), { recursive: true, force: true }); } catch (_) {}
    console.log('✓ bench DBs + bench exports cleaned. Production DB (' + cfg.APP_ROOT + '/data) SAFE — touch hi nahi hua.');
    return;
  }
  const modeMap = {
    selftest: () => require('./modes/selftest')({ token }),
    inventory: () => require('./modes/m1')({ token, scale: arg('SCALE', 'S2'), sample: +arg('SAMPLE', 40) }),
    ingest: () => require('./modes/m2')({ token, rates: arg('RATES', '10,50,100'), conns: arg('CONNS', '1,16'), secondsPerRate: +arg('SECS', 30), dbFile: arg('DBFILE', cfg.BENCH_DB_DIR + '/bench.db') }),
    users: () => require('./modes/m3')({ token, scale: arg('SCALE', 'S3'), userCounts: arg('USERS', '25,100,150'), sample: +arg('SAMPLE', 25) }),
    allocation: () => require('./modes/m4')({ token, scale: arg('SCALE', 'S2'), batches: arg('BATCHES', '1000,10000,50000'), raceAllocators: +arg('RACE', 8) }),
    combined: () => require('./modes/m5')({ token, id: arg('ID', 'C1'), minutes: +arg('MINUTES', 10) }),
    burst: () => require('./modes/m6')({ token, profiles: arg('PROFILES', '2000x1s,10000x5s,50000x30s'), dbFile: arg('DBFILE', cfg.BENCH_DB_DIR + '/bench.db') }),
    isolation: () => require('./modes/m7')({ token, scale: arg('SCALE', 'S2'), heavy: arg('HEAVY', 'export,alloc,search') }),
    random: () => require('./modes/m8')({ token, scale: arg('SCALE', 'S3'), users: +arg('USERS', 50), smsPerSec: +arg('SMS', 70), minutes: +arg('MINUTES', 10), allocBatch: +arg('ALLOC', 1000) }),
    soak: () => require('./modes/m9')({ token, scale: arg('SCALE', 'S2'), simHours: +arg('HOURS', 24), compress: +arg('COMPRESS', 5) }),
    extreme: () => require('./modes/m1x')({ token, scale: arg('SCALE', '600M'), soakGB: +arg('SOAK_GB', 10) }),
    full: async () => {
      guard.assertToken(cfg, token);
      console.log('=== FULL suite: selftest → inventory S2 → ingest ramp → isolation → combined C1 (10m) ===');
      await require('./modes/selftest')({ token });
      await require('./modes/m1')({ token, scale: 'S2', sample: 40 });
      await require('./modes/m2')({ token, rates: '10,50,100', conns: '1,16', secondsPerRate: 30, dbFile: cfg.BENCH_DB_DIR + '/bench.db' });
      await require('./modes/m7')({ token, scale: 'S2', heavy: 'export,alloc,search' });
      await require('./modes/m5')({ token, id: 'C1', minutes: 10 });
      require('./lib/report').capacity(cfg);
    },
  };
  const fn = modeMap[cmd];
  if (!fn) { console.log(HELP); process.exit(1); }
  guard.clearStop();
  await fn();
  process.exit(0);
}
main().catch(e => { console.error('PW-BENCH ERROR:', e.message); process.exit(1); });
