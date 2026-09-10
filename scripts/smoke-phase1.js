/* Power X SMS — Phase-1 smoke + correctness test suite (self-contained) */
const BASE = 'http://localhost:' + (process.env.TEST_PORT || '4777');
let TOKEN = '';
const results = [];
function log(name, pass, extra = '') { results.push({ name, pass, extra }); console.log(`${pass ? '✅ PASS' : '❌ FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`); }
async function api(method, path, body, headers = {}) {
  const t0 = performance.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = +(performance.now() - t0).toFixed(1);
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j, ms };
}
const rng = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 1e12));

(async () => {
  // 1) login
  let r = await api('POST', '/api/login', { username: 'vibepk', password: 'vibepk123' });
  log('login', r.status === 200 && r.j?.token, `${r.ms}ms`);
  TOKEN = r.j.token;

  // 2) health (new fields)
  r = await api('GET', '/api/health');
  log('health enriched', r.status === 200 && r.j?.event_loop && r.j?.slow_queries && r.j?.rss_mb !== undefined,
    `rss=${r.j?.rss_mb}MB lag_p99=${r.j?.event_loop?.lag_p99_ms}ms slowq=${r.j?.slow_queries?.count}`);

  // 3) create range + managers
  r = await api('POST', '/api/ranges', { name: 'SMOKE-RANGE', prefix: '92300', currency: 'USD', rate_7_1: '0.01' });
  const rangeOk = r.status === 200 || r.status === 201;
  log('range create', rangeOk, `${r.ms}ms ${JSON.stringify(r.j).slice(0, 80)}`);
  r = await api('POST', '/api/users', { username: 'mgr1', password: 'mgr1pass', role: 'manager', name: 'Mgr One' });
  log('manager1 create', r.status === 200 || r.status === 201, JSON.stringify(r.j).slice(0, 60));
  r = await api('POST', '/api/users', { username: 'mgr2', password: 'mgr2pass', role: 'manager', name: 'Mgr Two' });
  log('manager2 create', r.status === 200 || r.status === 201, JSON.stringify(r.j).slice(0, 60));
  // login as each manager to resolve their user ids (login response includes user.id)
  const l1 = await api('POST', '/api/login', { username: 'mgr1', password: 'mgr1pass' });
  const l2 = await api('POST', '/api/login', { username: 'mgr2', password: 'mgr2pass' });
  const mgr1Id = l1.j?.user?.id, mgr2Id = l2.j?.user?.id;
  console.log(`   user ids: mgr1=${mgr1Id} mgr2=${mgr2Id}`);

  // 4) import 60,000 numbers (background job)
  const N = 60000;
  const numbers = Array.from({ length: N }, (_, i) => '92300' + String(1000000 + i));
  r = await api('POST', '/api/numbers/import', { range_name: 'SMOKE-RANGE', numbers, file_name: 'smoke.csv' });
  const jobId = r.j?.job_id || r.j?.job?.job_id;
  log('import job accepted', r.status === 200 && !!jobId, `${r.ms}ms job=${jobId}`);
  let job = null, t0 = Date.now();
  do {
    await new Promise(res => setTimeout(res, 400));
    const jr = await api('GET', '/api/numbers/import-jobs/' + jobId);
    job = jr.j?.job || jr.j;
  } while (job && (job.status === 'processing' || job.status === 'queued') && Date.now() - t0 < 120000);
  log('import 60k completed', job?.status === 'done' && job?.inserted === N,
    `status=${job?.status} inserted=${job?.inserted} skipped=${job?.skipped} took=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 5) browse + count + search timings (cache-cold: _nocache=1)
  r = await api('GET', '/api/numbers?paged=1&page=1&limit=25&_nocache=1');
  log('browse p1 (60k, cold)', r.status === 200 && r.j?.total === N, `${r.ms}ms total=${r.j?.total}`);
  r = await api('GET', '/api/numbers?paged=1&page=200&limit=25&_nocache=1');
  log('browse p200 (deep offset)', r.status === 200, `${r.ms}ms`);
  r = await api('GET', '/api/numbers?paged=1&page=1&limit=25&search=923001234567&_nocache=1');
  log('exact digit search', r.status === 200, `${r.ms}ms found=${r.j?.rows?.length}`);
  r = await api('GET', '/api/numbers?paged=1&page=1&limit=25&search=9230012&_nocache=1');
  log('prefix digit search', r.status === 200, `${r.ms}ms total=${r.j?.total}`);
  r = await api('GET', '/api/numbers?paged=1&page=1&limit=25&allocation=unallocated&_nocache=1');
  log('unallocated filter', r.status === 200 && r.j?.total === N, `${r.ms}ms total=${r.j?.total}`);
  r = await api('GET', '/api/numbers/summary?_nocache=1');
  log('ranges summary', r.status === 200 && r.j?.[0]?.total === N, `${r.ms}ms total=${r.j?.[0]?.total}`);

  // 6) allocate 5,000 → mgr1
  const allocIds = rng(5000).map((_, i) => i + 1); // ids 1..5000
  r = await api('POST', '/api/numbers/allocate', { ids: allocIds, target_id: mgr1Id });
  log('allocate 5k', r.status === 200 && r.j?.allocated === 5000, `${r.ms}ms req=${r.j?.requested} alloc=${r.j?.allocated} skip=${r.j?.skipped}`);

  // 7) RACE: same ids → mgr2 while mgr1 re-alloc (concurrent)
  const sameIds = Array.from({ length: 3000 }, (_, i) => i + 1); // already mgr1's
  const [ra, rb] = await Promise.all([
    api('POST', '/api/numbers/allocate', { ids: sameIds, target_id: mgr1Id }),           // same owner re-alloc → allowed
    api('POST', '/api/numbers/allocate', { ids: sameIds, target_id: mgr2Id }),           // cross-manager steal → blocked
  ]);
  const stealBlocked = rb.j?.allocated === 0 || rb.status === 403 || (rb.j?.skipped > 0);
  log('race/steal guard (mgr2 steal blocked)', stealBlocked,
    `A: alloc=${ra.j?.allocated}/${ra.status} B: alloc=${rb.j?.allocated} skip=${rb.j?.skipped} http=${rb.status}`);

  // 8) ownership check in DB — who owns id 1..3000 now?
  r = await api('GET', '/api/numbers?paged=1&limit=5&search=923001000000&_nocache=1');
  const ownerName = r.j?.rows?.[0]?.manager_name;
  log('ownership stays mgr1', ownerName === 'mgr1', `owner=${ownerName}`);

  // 10) 50,000 allocation
  const big = Array.from({ length: 50000 }, (_, i) => 5001 + i); // ids 5001..55000 unallocated
  const t50 = performance.now();
  r = await api('POST', '/api/numbers/allocate', { ids: big, target_id: mgr2Id });
  log('allocate 50,000 (was HTTP 500 before)', r.status === 200 && r.j?.allocated === 50000,
    `${(performance.now() - t50).toFixed(0)}ms alloc=${r.j?.allocated} skip=${r.j?.skipped}`);

  // 9b) idempotency — same key twice (fresh unallocated ids)
  const key = 'smoke-' + Date.now();
  const id1 = await api('POST', '/api/numbers/allocate', { ids: [55501, 55502, 55503], target_id: mgr1Id }, { 'Idempotency-Key': key });
  const id2 = await api('POST', '/api/numbers/allocate', { ids: [55501, 55502, 55503], target_id: mgr1Id }, { 'Idempotency-Key': key });
  log('idempotency replay', id1.status === 200 && id2.status === 200 && JSON.stringify(id1.j) === JSON.stringify(id2.j),
    `1st=[${id1.status}]${id1.j?.allocated} 2nd=[${id2.status}]${id2.j?.allocated} ${JSON.stringify(id1.j).slice(0,90)}`);



  // 11) import dedup re-run (same 60k again → all skipped)
  r = await api('POST', '/api/numbers/import', { range_name: 'SMOKE-RANGE', numbers: numbers.slice(0, 1000), file_name: 'smoke-dup.csv' });
  const dupJob = r.j?.job_id || r.j?.job?.job_id;
  t0 = Date.now();
  do { await new Promise(res => setTimeout(res, 300)); const jr = await api('GET', '/api/numbers/import-jobs/' + dupJob); job = jr.j?.job || jr.j; }
  while (job && (job.status === 'processing' || job.status === 'queued') && Date.now() - t0 < 30000);
  log('import dedup (re-import all skipped)', job?.inserted === 0 && job?.skipped === 1000, `ins=${job?.inserted} skip=${job?.skipped}`);

  // 12) SMS ingest -> dashboard/stats pre-aggregation (Step 4)
  await api('PUT', '/api/carrier-settings?carrier_lock=Dawood', { carrier_lock: 'Dawood', integration_status: 'enabled', carrier_ip: '127.0.0.1', notes: 'smoke' });
  const own = await api('GET', '/api/numbers?paged=1&limit=1&search=923001000000&_nocache=1');
  r = await api('POST', '/api/incoming-sms', { number: '923001000000', cli: 'SmokeCLI', message: 'Your code is 424242' });
  const ingestOk = r.status === 200;
  log('SMS ingest (carrier webhook)', ingestOk, `http=${r.status} ${JSON.stringify(r.j).slice(0, 80)}`);
  await new Promise(res => setTimeout(res, 200));
  const dashKeys = ['sms_today','otp_today','successful_otp_today','failed_otp_today','failed_sms_today','total_sms','failed_total','sms_yesterday','sms_7d','sms_month','payout_7d','payout_month','managers','agents','clients','numbers','daily7','recent'];
  const tDash = performance.now();
  r = await api('GET', '/api/dashboard');
  const keys = Object.keys(r.j || {}).sort();
  const keysOk = dashKeys.every(k => keys.includes(k)) && r.j.sms_today >= 1 && r.j.total_sms >= 1;
  log('dashboard: same keys + counters from stats table', keysOk,
    `${(performance.now() - tDash).toFixed(0)}ms sms_today=${r.j?.sms_today} total_sms=${r.j?.total_sms} keys=${keys.length}`);
  r = await api('GET', '/api/stats/manager');
  const mgrRow = (r.j?.rows || []).find(x => x.key === 'mgr1');
  log('stats/manager (SQL agg, correct totals)', r.status === 200 && !!mgrRow && mgrRow.sms >= 1 && r.j.totalSms >= 1,
    `rows=${r.j?.rows?.length} mgr1_sms=${mgrRow?.sms} totalSms=${r.j?.totalSms}`);
  r = await api('GET', '/api/stats/number');
  log('stats/number (SQL GROUP BY)', r.status === 200 && (r.j?.rows || []).length >= 1, `rows=${r.j?.rows?.length}`);
  r = await api('GET', '/api/admin/backfill-stats');
  log('backfill status', r.status === 200, JSON.stringify(r.j).slice(0, 80));
  // rate limit sanity: health exempt path & 429 structure (not flooding)
  r = await api('GET', '/api/health');
  log('health still open + enriched', r.status === 200 && r.j.event_loop, '');

  /* ================= PHASE-2 TESTS ================= */
  // P2-1) background numbers export (worker thread) + token download
  const ex = await api('POST', '/api/exports', { type: 'numbers' });
  let expOk = ex.status === 200 && !!ex.j?.job_id, dlOk = false, lines = 0;
  if (expOk) {
    for (let i = 0; i < 120; i++) {
      await new Promise(res => setTimeout(res, 500));
      const jj = await api('GET', '/api/jobs/' + ex.j.job_id);
      if (jj.j?.status === 'done') { expOk = true; break; }
      if (jj.j?.status === 'failed') { expOk = false; break; }
    }
    const jobFull = await api('GET', '/api/jobs/' + ex.j.job_id);
    const dl = await fetch(BASE + '/api/exports/' + ex.j.job_id + '/download?token=' + (jobFull.j?.result?.token || 'MISSING'));
    dlOk = dl.status === 200;
    if (dlOk) { const txt = await dl.text(); lines = txt.trim().split('\n').length - 1; }
    else { console.log('   debug: jobStatus=' + jobFull.j?.status + ' hasResult=' + !!jobFull.j?.result + ' dlStatus=' + dl.status); }
  }
  log('P2 export numbers (worker) + download', expOk && dlOk && lines >= 60000, `rows=${lines}`);

  // P2-2) multipart file import (1.1MB CSV, 110k fresh numbers)
  const bigCsv = Array.from({ length: 110000 }, (_, i) => '92377' + String(10000000 + i)).join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([bigCsv], { type: 'text/csv' }), 'big-smoke.csv');
  fd.append('range_name', 'SMOKE-RANGE-FILE');
  fd.append('file_name', 'big-smoke.csv');
  const tImp = performance.now();
  const imp = await fetch(BASE + '/api/numbers/import-file', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  const impJ = await imp.json().catch(() => ({}));
  let fileImpOk = imp.status === 200 && !!impJ?.job?.job_id;
  if (fileImpOk) {
    for (let i = 0; i < 200; i++) {
      await new Promise(res => setTimeout(res, 500));
      const jj = await api('GET', '/api/numbers/import-jobs/' + impJ.job.job_id);
      const st = jj.j?.job?.status || jj.j?.status;
      if (st === 'done') { fileImpOk = (jj.j.job?.inserted ?? jj.j.inserted) === 110000; break; }
      if (st === 'failed') { fileImpOk = false; break; }
    }
  }
  log('P2 import-file (multipart 110k, streaming)', fileImpOk, `${(performance.now() - tImp).toFixed(0)}ms`);

  // P2-3) SMS cursor keyset (additive mode)
  const c1 = await api('GET', '/api/sms/paged?limit=1');
  const c2 = await api('GET', '/api/sms/paged?limit=1&cursor=' + c1.j.rows[0].id);
  const c3 = await api('GET', '/api/sms/paged?limit=5');
  log('P2 sms cursor keyset', c1.status === 200 && c2.status === 200 && 'next_cursor' in c2.j && 'cursor_mode' in c2.j && Array.isArray(c3.j.rows),
    `page1=${c1.j.rows.length} cursorPage=${c2.j.rows.length} c2.next=${c2.j.next_cursor} normal=${c3.j.rows.length}`);

  // P2-4) jobs list
  const jl = await api('GET', '/api/jobs');
  log('P2 jobs list', jl.status === 200 && (jl.j?.rows || []).length >= 1, `jobs=${jl.j?.rows?.length}`);

  const fails = results.filter(x => !x.pass).length;
  console.log(`\n===== SMOKE RESULT: ${results.length - fails}/${results.length} PASS, ${fails} FAIL =====`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); process.exit(2); });
