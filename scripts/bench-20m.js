#!/usr/bin/env node
/**
 * PowerX — 20M FULL BENCHMARK SUITE (Phase-3)
 * ============================================
 * Ek command, poora suite: 20M bulkload → server boot → browse/search/filter/
 * allocate-50k → SMS ingest burst → cursor walk → import-file → full 20M export
 * WITH isolation probe (panel latency DURING export) → MEASURED report.
 *
 * USAGE (VPS par, 8GB+ RAM, NVMe):
 *   node scripts/bench-20m.js                        # full 20M default
 *   BENCH_N=2000000 node scripts/bench-20m.js        # chhota dry-run
 *   SKIP_LOAD=1 node scripts/bench-20m.js            # pehle se loaded DB reuse
 *   BENCH_SKIP_EXPORT=1 node scripts/bench-20m.js    # export test chhodo
 *   BENCH_CLEANUP=1 node scripts/bench-20m.js        # end mein DB delete
 *
 * DB hamesha /var/tmp (disk) mein — /tmp tmpfs par kabhi nahi (OOM risk).
 * NOTE: jab tak ye suite apne VPS par 20M par PASS na ho, "20M/150-user"
 * claim PROJECTED hi rahega — MEASURED nahi.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const N = parseInt(process.env.BENCH_N || '20000000', 10);
const DB_DIR = process.env.BENCH_DIR || '/var/tmp/pw20';
const DB_FILE = process.env.BENCH_DB || path.join(DB_DIR, 'bench.db');
const PORT = parseInt(process.env.BENCH_PORT || '4888', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_LOAD = !!process.env.SKIP_LOAD;
const SKIP_EXPORT = !!process.env.BENCH_SKIP_EXPORT;
const CLEANUP = !!process.env.BENCH_CLEANUP;
const CACHE_MB = process.env.SQLITE_CACHE_MB || (N >= 10000000 ? '1024' : '512');
const ADMIN = { username: process.env.BENCH_ADMIN || 'vibepk', password: process.env.BENCH_PASS || 'vibepk123' };

const results = [];
function rec(name, value, pass, note = '') { results.push({ name, value, pass, note }); console.log(`${pass ? '✓' : '✗'} ${name}: ${value}${note ? '  (' + note + ')' : ''}`); }
const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];

let TOKEN = '';
async function api(method, url, body, extra = {}) {
  const t = performance.now();
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const ms = +(performance.now() - t).toFixed(1);
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j, ms };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function wait(pattern, timeoutS, label) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'backend/server.js')], { env: { ...process.env, DB_FILE, PORT: String(PORT), JWT_SECRET: 'bench20m', SQLITE_CACHE_MB: CACHE_MB }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => { buf += d; if (pattern.test(buf)) { child.stdout.off('data', onData); child.stderr.off('data', onData); done(); resolve(child); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const to = setTimeout(() => { console.error(`✗ server boot timeout (${label})\n` + buf.slice(-800)); process.exit(1); }, timeoutS * 1000);
    const done = () => { clearTimeout(to); };
    child.once('exit', (c) => { clearTimeout(to); console.error(`✗ server exited during boot (code=${c})\n` + buf.slice(-800)); process.exit(1); });
    child._bootDone = done;
  });
}

(async () => {
  console.log(`\n=== PowerX ${N / 1e6}M BENCHMARK — db=${DB_FILE} ===\n`);
  // port khali hai? (purana orphan bench server = contaminated results)
  const busy = await new Promise(res => { const s = require('net').connect({ port: PORT, host: '127.0.0.1' }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.setTimeout(1500, () => { s.destroy(); res(false); }); });
  if (busy) { console.error(`✗ port ${PORT} pehle se used hai — purana bench server zinda hai. Hal: ss -tlnp | grep ${PORT}  →  kill <pid>  (ya: pkill -f bench-20m)`); process.exit(1); }
  fs.mkdirSync(DB_DIR, { recursive: true });

  // ---- 1) BULKLOAD (existing proven loader, separate process) ----
  if (!SKIP_LOAD) {
    const existing = fs.existsSync(DB_FILE);
    console.log(`[1/8] bulkload ${N.toLocaleString()} numbers ${existing ? '(resume)' : ''}...`);
    await new Promise((resolve, reject) => {
      const c = spawn('node', [path.join(ROOT, 'scripts/bench-bulkload.js')], { env: { ...process.env, BENCH_DB: DB_FILE, BENCH_N: String(N) }, stdio: 'inherit' });
      c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('bulkload failed ' + code)));
    });
  } else console.log('[1/8] SKIP_LOAD — existing DB reuse');

  // ---- 2) BOOT ----
  console.log('[2/8] server boot...');
  const tBoot = Date.now();
  const server = await wait(/running:/, 120, 'bench');
  console.log(`      booted in ${((Date.now() - tBoot) / 1000).toFixed(1)}s`);
  // script kahin se bhi nikle — bench server orphan NA chhore
  process.on('exit', () => { try { server.kill('SIGKILL'); } catch (_) {} });
  process.on('SIGINT', () => { try { server.kill('SIGKILL'); } catch (_) {} process.exit(1); });

  // ---- 3) LOGIN ----
  let r = await api('POST', '/api/login', ADMIN);
  if (r.status !== 200) { console.error('✗ admin login failed — ' + JSON.stringify(r.j)); server.kill('SIGKILL'); process.exit(1); }
  TOKEN = r.j.token;

  // manager for allocation test
  await api('POST', '/api/users', { username: 'benchmgr', password: 'benchmgr123', role: 'manager', name: 'Bench Mgr' });
  const lm = await api('POST', '/api/login', { username: 'benchmgr', password: 'benchmgr123' });
  const mgrId = lm.j?.user?.id;

  // ---- 4) BROWSE / SEARCH / FILTER ----
  console.log('[3/8] browse + search + filters...');
  const cold = await api('GET', '/api/numbers?paged=1&limit=25&_nocache=1');
  rec('browse p1 COLD', cold.ms + 'ms', cold.ms < 2000, 'http ' + cold.status);
  const warmSamples = [];
  for (let i = 1; i <= 10; i++) warmSamples.push((await api('GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${i}`)).ms);
  const warmCap = N >= 10000000 ? 150 : 100;
  rec('browse p1 WARM p50', p(warmSamples.sort((a, b) => a - b), .5) + 'ms', p(warmSamples, .5) < warmCap, `cap ${warmCap}ms`);
  await api('GET', '/api/numbers?paged=1&limit=25');   // pehli call = miss (cache banta hai)
  const cache = await api('GET', '/api/numbers?paged=1&limit=25');   // DOOSRI call = asli hit
  rec('browse CACHE-HIT', cache.ms + 'ms', cache.ms < 25);
  const deep = await api('GET', '/api/numbers?paged=1&limit=25&page=5000&_nocache=1');
  rec('browse p5000 (deep)', deep.ms + 'ms', deep.ms < 300);
  const pre = await api('GET', '/api/numbers?paged=1&limit=25&search=92300100&_nocache=1');
  rec('prefix search 92300100', pre.ms + 'ms', pre.ms < 100, `rows=${pre.j.total}`);
  const exact = await api('GET', '/api/numbers?paged=1&limit=25&search=9230010000000&_nocache=1');
  rec('exact search', exact.ms + 'ms', exact.ms < 100);
  const alloc = await api('GET', '/api/numbers?paged=1&limit=25&allocation=allocated&_nocache=1');
  rec('allocated filter', alloc.ms + 'ms', alloc.ms < 100);
  const unalloc = await api('GET', '/api/numbers?paged=1&limit=25&allocation=unallocated&_nocache=1');
  rec('unallocated filter (count-heavy)', unalloc.ms + 'ms', unalloc.ms < 3000, 'known count O(n) path');
  const tSum = performance.now();
  await api('GET', '/api/numbers/summary');
  rec('summary', +(performance.now() - tSum).toFixed(0) + 'ms', true);

  // ---- 5) ALLOCATE 50k ----
  if (!process.env.SKIP_ALLOC) {
    console.log('[4/8] allocate 50,000...');
    const REQ = Math.min(50000, Math.max(1000, Math.floor(N / 4)));
    const base = Math.max(1, Math.floor(N / 2) - REQ - 1); // sequential unique ids (bulkload id = row order)
    const allocIds = Array.from({ length: REQ }, (_, i) => base + i);
    const tA = performance.now();
    const ares = await api('POST', '/api/numbers/allocate', { ids: allocIds, target_id: mgrId }, { 'Idempotency-Key': 'bench20m-' + Date.now() });
    rec(`allocate ${REQ} http200`, +(performance.now() - tA).toFixed(0) + 'ms', ares.status === 200 && ares.j?.allocated >= REQ * 0.98, `allocated=${ares.j?.allocated}`);
  } else console.log('[4/8] SKIP_ALLOC');

  // ---- 6) SMS INGEST BURST ----
  console.log('[5/8] SMS ingest burst...');
  await api('PUT', '/api/carrier-settings?carrier_lock=Dawood', { carrier_lock: 'Dawood', integration_status: 'enabled', carrier_ip: '127.0.0.1', notes: 'bench' });
  const nums = await api('GET', '/api/numbers?paged=1&limit=200&search=9230000');
  const pool = (nums.j.rows || []).map(r2 => r2.number);
  if (!pool.length) { console.error('✗ no numbers pool for ingest'); server.kill(); process.exit(1); }
  const BURST = Math.min(2000, parseInt(process.env.BENCH_SMS || '2000', 10));
  const tI = Date.now(); let okCount = 0;
  for (let i = 0; i < BURST; i++) {
    const rr = await fetch(BASE + '/api/incoming-sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: pool[i % pool.length], cli: 'BENCH', message: `bench otp ${i}` }) });
    if (rr.status === 200) okCount++;
  }
  const secs = (Date.now() - tI) / 1000;
  rec('SMS ingest (sequential HTTP)', (okCount / secs).toFixed(0) + '/s', okCount / secs > 100, `${okCount}/${BURST} ok, avg ${(secs * 1000 / okCount).toFixed(1)}ms`);
  const cur1 = await api('GET', '/api/sms/paged?limit=100');
  let walkOk = true, walkMs = [];
  let cursor = cur1.j.next_cursor;
  for (let i = 0; i < 4 && cursor; i++) { const t = performance.now(); const c = await api('GET', '/api/sms/paged?limit=100&cursor=' + cursor); walkMs.push(c.ms); cursor = c.j.next_cursor; if (c.status !== 200) walkOk = false; }
  rec('sms cursor walk (4x100)', walkMs.length ? walkMs.join('/') + 'ms' : 'n/a (<500 sms)', walkOk);

  // ---- 7) IMPORT-FILE ----
  console.log('[6/8] import-file 200k...');
  const IMP = 200000, csvPath = path.join(DB_DIR, 'bench-import.csv');
  const RUNID = Date.now() % 30000;   // har run ke numbers unique (resume par bhi fresh insert)
  if (!fs.existsSync(csvPath)) {
    const ws = fs.createWriteStream(csvPath);
    for (let i = 0; i < IMP; i++) { ws.write(`923${String(7000000000 + RUNID * 300000 + i)}\n`); if (i % 50000 === 0) await sleep(0); }
    await new Promise(res => ws.end(res));
  }
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(csvPath)], { type: 'text/csv' }), 'bench-import.csv');
  fd.append('range_name', 'BENCH-IMPORT');
  fd.append('file_name', 'bench-import.csv');
  const tImp = performance.now();
  const imp = await fetch(BASE + '/api/numbers/import-file', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  const impJ = await imp.json().catch(() => ({}));
  let impOk = imp.status === 200 && !!impJ?.job?.job_id, impIns = 0, impSkip = 0;
  if (impOk) for (let i = 0; i < 2400; i++) { await sleep(500); const jj = await api('GET', '/api/numbers/import-jobs/' + impJ.job.job_id); const job = jj.j?.job || jj.j; if (job?.status === 'done') { impIns = job.inserted; impSkip = job.skipped; break; } if (job?.status === 'failed') { impOk = false; break; } }
  rec('import-file 200k streaming', ((performance.now() - tImp) / 1000).toFixed(1) + 's', impOk && impIns >= IMP * 0.99, `inserted=${impIns} skipped=${impSkip}`);
  fs.unlinkSync(csvPath);

  // ---- 8) FULL EXPORT + ISOLATION PROBE ----
  if (!SKIP_EXPORT) {
    console.log(`[7/8] FULL ${N / 1e6}M export + panel isolation probe (ye ~${Math.ceil(N / 45000 / 60)} min lagenge)...`);
    const totRows = (await api('GET', '/api/numbers?paged=1&limit=1&_nocache=1')).j?.total || N;
    const ex = await api('POST', '/api/exports', { type: 'numbers' });
    if (ex.status === 429) { console.log('   (export slot busy — dubara koshish 30s baad)'); await sleep(30000); }
    const exOk = ex.status === 200 && !!ex.j?.job_id;
    const lat = []; let done = false, lastRows = 0;
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 3600 * 1000) {
      const b = await api('GET', `/api/numbers?paged=1&limit=25&_nocache=1&page=${1 + Math.floor(Math.random() * 100)}`);
      lat.push(b.ms);
      const jj = await api('GET', '/api/jobs/' + ex.j.job_id);
      done = jj.j?.status === 'done' || jj.j?.status === 'failed';
      lastRows = jj.j?.processed || lastRows;
      if (lat.length % 25 === 0) process.stdout.write(`   ...${(lastRows / 1e6).toFixed(1)}M rows, browse p50 ${p(lat.slice().sort((a, b) => a - b), .5)}ms\r\n`);
      await sleep(400);
    }
    lat.sort((a, b) => a - b);
    rec('browse DURING export p50', p(lat, .5) + 'ms', p(lat, .5) < 150, `p95=${p(lat, .95)}ms n=${lat.length}`);
    const jj = await api('GET', '/api/jobs/' + ex.j.job_id);
    const rows = jj.j?.result?.rows || 0;
    const dl = await fetch(BASE + `/api/exports/${ex.j.job_id}/download?token=${jj.j?.result?.token || ''}`);
    let lines = 0;
    if (dl.status === 200) {
      const reader = rl(dl.body); for await (const _ of reader) lines++;
      async function* rl(body) { const dec = new (require('util').TextDecoder)(); let buf = ''; for await (const ch of body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { yield 1; buf = buf.slice(i + 1); } } if (buf.trim()) yield 1; }
    }
    rec(`FULL export ${(totRows / 1e6).toFixed(1)}M rows`, ((Date.now() - t0) / 1000).toFixed(0) + 's', exOk && done && jj.j?.status === 'done' && lines === totRows + 1, `csv rows=${lines.toLocaleString()} size=${((jj.j?.result?.bytes || 0) / 1e9).toFixed(2)}GB (header+${(lines - 1).toLocaleString()})`);
  } else console.log('[7/8] SKIP_EXPORT');

  // ---- HEALTH + REPORT ----
  console.log('[8/8] health + report');
  const h = await api('GET', '/api/health');
  console.log(`\thealth: rss=${h.j.rss_mb}MB lag_p99=${h.j.event_loop.lag_p99_ms}ms db=${h.j.db_size_gb || h.j.db_size_mb} ver=${h.j.numbers_ver}`);
  const fails = results.filter(x => !x.pass);
  console.log('\n========== BENCH-20M REPORT (MEASURED) ==========');
  for (const x of results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}: ${x.value} ${x.note}`);
  console.log(`\nRESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? '  ← 20M claim MEASURED nahi hua jab tak ye FAIL hai' : '  ← 20M ab MEASURED hai is box par'}`);
  console.log(`DB: ${DB_FILE} (${(fs.statSync(DB_FILE).size / 1e9).toFixed(2)}GB)${CLEANUP ? ' [CLEANUP: deleting]' : ''}`);
  try { server.kill('SIGKILL'); } catch (_) {}
  if (CLEANUP) { fs.rmSync(DB_DIR, { recursive: true, force: true }); console.log('cleaned ' + DB_DIR); }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('BENCH ERROR:', e); process.exit(1); });
