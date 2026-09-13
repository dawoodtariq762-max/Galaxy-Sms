/* Phase-1 scale benchmark — 5M numbers direct bulk load + query timings */
const DB_FILE = process.env.BENCH_DB || '/tmp/powerx-bench.db';
process.env.DB_FILE = DB_FILE;
const db = require('../backend/db');
(async () => {
await db.init();
const { createTables } = require('../backend/schema');
createTables();

const TOTAL = parseInt(process.env.BENCH_N || '5000000', 10);
const existing = db.get('SELECT COUNT(*) c FROM numbers')?.c || 0;
console.log(`existing=${existing} target=${TOTAL}`);

// one range for all
let rid = db.get(`SELECT id FROM ranges WHERE name='BENCH-RANGE'`)?.id;
if (!rid) { db.run(`INSERT INTO ranges (name,prefix,test_number,currency) VALUES ('BENCH-RANGE','92300','','USD')`); rid = db.get(`SELECT id FROM ranges WHERE name='BENCH-RANGE'`).id; }

const t0 = Date.now();
const BATCH = 20000;
for (let i = existing; i < TOTAL; i += BATCH) {
  const end = Math.min(i + BATCH, TOTAL);
  const vals = [];
  for (let j = i; j < end; j++) vals.push(`(${rid},'92300${String(10000000000 + j).slice(1)}','92300','Weekly','0','bench')`);
  db.exec('BEGIN IMMEDIATE');
  db.execNoSave(`INSERT OR IGNORE INTO numbers (range_id,number,prefix,payterm,payout,import_source) VALUES ${vals.join(',')}`);
  db.exec('COMMIT');
  if ((i / BATCH) % 25 === 0) console.log(`  ${end}/${TOTAL} rows (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const count = db.get('SELECT COUNT(*) c FROM numbers').c;
console.log(`bulk load done: ${count} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s, db=${(require('fs').statSync(DB_FILE).size / 1e9).toFixed(2)}GB`);
db.exec(`ANALYZE`);
console.log('ANALYZE done');
process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
