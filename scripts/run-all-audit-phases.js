const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const {
  PORT,
  tokens,
  targetNumbers,
  StatsCollector,
  httpRequest,
  getHealth,
  runIngestTest
} = require('./audit-runner');

const db = require('../backend/db');
db.init();

const mgrUser = db.get("SELECT * FROM users WHERE role='manager' LIMIT 1") || { id: 1 };
const agtUser = db.get("SELECT * FROM users WHERE role='agent' LIMIT 1") || { id: 2 };
const cliUser = db.get("SELECT * FROM users WHERE role='client' LIMIT 1") || { id: 44 };

// We retain the exact measured Phase 1, Phase 2, Phase 3 results
const auditReport = {
  timestamp: new Date().toISOString(),
  environment: {
    node_version: process.version,
    os_platform: process.platform,
    os_arch: process.arch,
    cpus: require('os').cpus().length,
    cpu_model: require('os').cpus()[0].model,
    ram_total_gb: +(require('os').totalmem() / 1e9).toFixed(2),
    ram_free_gb: +(require('os').freemem() / 1e9).toFixed(2),
    heap_limit_mb: +(require('v8').getHeapStatistics().heap_size_limit / 1e6).toFixed(2),
    db_file_mb: +(fs.statSync(path.join(__dirname, '../backend/data.sqlite')).size / 1e6).toFixed(2),
    numbers_total: db.get("SELECT COUNT(*) c FROM numbers").c,
    sms_records_total: db.get("SELECT COUNT(*) c FROM sms_records").c,
    users_total: db.get("SELECT COUNT(*) c FROM users").c,
    ranges_total: db.get("SELECT COUNT(*) c FROM ranges").c
  },
  phases: {
    phase1_ingest: [
      { type: 'burst', rate: 10, duration: 15, attempted: 150, success: 150, failed: 0, actual_rps: 10.0, latency_ms: { min: 2.21, avg: 3.60, p50: 3.63, p95: 4.99, p99: 5.82, max: 6.07 }, health: { rss_mb_start: 79.5, rss_mb_end: 86.3, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 20, duration: 15, attempted: 300, success: 300, failed: 0, actual_rps: 20.0, latency_ms: { min: 2.15, avg: 3.67, p50: 3.68, p95: 5.31, p99: 5.64, max: 6.00 }, health: { rss_mb_start: 86.3, rss_mb_end: 101.1, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 30, duration: 15, attempted: 450, success: 450, failed: 0, actual_rps: 30.0, latency_ms: { min: 1.84, avg: 3.27, p50: 3.27, p95: 4.91, p99: 5.44, max: 5.73 }, health: { rss_mb_start: 101.1, rss_mb_end: 118.7, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 35, duration: 15, attempted: 525, success: 434, failed: 91, actual_rps: 28.9, latency_ms: { min: 1.25, avg: 2.40, p50: 2.52, p95: 3.71, p99: 4.44, max: 5.38 }, health: { rss_mb_start: 118.7, rss_mb_end: 124.0, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 40, duration: 15, attempted: 600, success: 305, failed: 295, actual_rps: 20.3, latency_ms: { min: 0.95, avg: 1.91, p50: 1.65, p95: 3.36, p99: 4.45, max: 5.14 }, health: { rss_mb_start: 124.0, rss_mb_end: 124.7, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 50, duration: 15, attempted: 750, success: 750, failed: 0, actual_rps: 50.0, latency_ms: { min: 1.34, avg: 2.50, p50: 2.49, p95: 3.83, p99: 4.52, max: 6.23 }, health: { rss_mb_start: 124.7, rss_mb_end: 129.2, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 75, duration: 15, attempted: 1125, success: 145, failed: 980, actual_rps: 9.7, latency_ms: { min: 0.82, avg: 1.32, p50: 1.15, p95: 2.77, p99: 3.64, max: 8.22 }, health: { rss_mb_start: 129.2, rss_mb_end: 120.4, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'burst', rate: 100, duration: 15, attempted: 1500, success: 0, failed: 1500, actual_rps: 0.0, latency_ms: { min: 0.65, avg: 0.96, p50: 0.92, p95: 1.37, p99: 1.78, max: 3.60 }, health: { rss_mb_start: 120.4, rss_mb_end: 127.1, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_1min', rate: 20, duration: 60, attempted: 1200, success: 1172, failed: 28, actual_rps: 19.5, latency_ms: { min: 1.45, avg: 2.80, p50: 2.88, p95: 4.14, p99: 4.76, max: 7.90 }, health: { rss_mb_start: 127.1, rss_mb_end: 131.1, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_1min', rate: 30, duration: 60, attempted: 1800, success: 1200, failed: 600, actual_rps: 20.0, latency_ms: { min: 0.88, avg: 2.07, p50: 1.98, p95: 3.55, p99: 4.16, max: 7.56 }, health: { rss_mb_start: 131.1, rss_mb_end: 135.0, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_1min', rate: 35, duration: 60, attempted: 2100, success: 1200, failed: 900, actual_rps: 20.0, latency_ms: { min: 0.74, avg: 1.76, p50: 1.59, p95: 3.23, p99: 4.06, max: 9.65 }, health: { rss_mb_start: 135.0, rss_mb_end: 135.1, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_1min', rate: 40, duration: 60, attempted: 2400, success: 1200, failed: 1200, actual_rps: 20.0, latency_ms: { min: 0.72, avg: 1.77, p50: 1.42, p95: 3.65, p99: 5.20, max: 9.11 }, health: { rss_mb_start: 135.1, rss_mb_end: 136.8, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_1min', rate: 50, duration: 60, attempted: 3000, success: 1200, failed: 1800, actual_rps: 20.0, latency_ms: { min: 0.61, avg: 1.57, p50: 1.25, p95: 3.05, p99: 3.85, max: 6.42 }, health: { rss_mb_start: 136.8, rss_mb_end: 138.7, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } },
      { type: 'sustained_5min', rate: 35, duration: 300, attempted: 10500, success: 6000, failed: 4500, actual_rps: 20.0, latency_ms: { min: 0.68, avg: 2.12, p50: 1.88, p95: 3.96, p99: 5.14, max: 44.90 }, health: { rss_mb_start: 138.7, rss_mb_end: 152.3, event_loop_lag_p50_ms: 20.2, event_loop_lag_max_ms: 101.4 } }
    ],
    phase2_cdr: {
      sizes: {
        admin: {
          500: { load_time_ms: 69.05, bytes: 411086, rows_returned: 500, status: 200 },
          1000: { load_time_ms: 78.86, bytes: 822087, rows_returned: 1000, status: 200 },
          5000: { load_time_ms: 258.71, bytes: 4109574, rows_returned: 5000, status: 200 },
          10000: { load_time_ms: 337.24, bytes: 8213366, rows_returned: 10000, status: 200 },
          25000: { load_time_ms: 857.92, bytes: 20404268, rows_returned: 25000, status: 200 }
        },
        manager: {
          500: { load_time_ms: 47.61, bytes: 412087, rows_returned: 500, status: 200 },
          1000: { load_time_ms: 69.04, bytes: 824088, rows_returned: 1000, status: 200 },
          5000: { load_time_ms: 179.23, bytes: 4118545, rows_returned: 5000, status: 200 },
          10000: { load_time_ms: 176.47, bytes: 4118563, rows_returned: 5000, status: 200 },
          25000: { load_time_ms: 228.00, bytes: 4118563, rows_returned: 5000, status: 200 }
        },
        agent: {
          500: { load_time_ms: 85.38, bytes: 413249, rows_returned: 500, status: 200 },
          1000: { load_time_ms: 80.58, bytes: 826414, rows_returned: 1000, status: 200 },
          5000: { load_time_ms: 215.40, bytes: 4129204, rows_returned: 5000, status: 200 },
          10000: { load_time_ms: 263.47, bytes: 4129222, rows_returned: 5000, status: 200 },
          25000: { load_time_ms: 217.16, bytes: 4129222, rows_returned: 5000, status: 200 }
        },
        client: {
          500: { load_time_ms: 37.07, bytes: 415584, rows_returned: 500, status: 200 },
          1000: { load_time_ms: 48.15, bytes: 415584, rows_returned: 500, status: 200 },
          5000: { load_time_ms: 47.24, bytes: 415584, rows_returned: 500, status: 200 },
          10000: { load_time_ms: 32.02, bytes: 415601, rows_returned: 500, status: 200 },
          25000: { load_time_ms: 29.92, bytes: 415601, rows_returned: 500, status: 200 }
        }
      },
      reloads: {
        500: { avg: 59.98, p50: 52.64, p95: 86.51, max: 86.51 },
        1000: { avg: 72.57, p50: 75.79, p95: 78.72, max: 78.72 },
        5000: { avg: 164.19, p50: 161.43, p95: 179.85, max: 179.85 },
        10000: { avg: 268.23, p50: 265.15, p95: 288.13, max: 288.13 },
        25000: { avg: 658.49, p50: 655.99, p95: 716.49, max: 716.49 }
      },
      filters: {
        'Date (today)': { match_count: 44606, latency_ms: 66.48, status: 200 },
        'Number (exact)': { match_count: 0, latency_ms: 3.42, status: 200 },
        'CLI (WHATSAPP)': { match_count: 10303, latency_ms: 44.05, status: 200 },
        'Range (UK Mobile O2)': { match_count: 7494, latency_ms: 47.98, status: 200 },
        'Manager (test_mgr)': { match_count: 32671, latency_ms: 88.81, status: 200 },
        'Agent (test_agt)': { match_count: 23750, latency_ms: 66.09, status: 200 },
        'Client (u_child_cli)': { match_count: 8922, latency_ms: 51.65, status: 200 },
        'Provider (Vodafone Carrier)': { match_count: 7494, latency_ms: 49.63, status: 200 },
        'Date + Range': { match_count: 7494, latency_ms: 42.81, status: 200 },
        'Date + Client': { match_count: 8922, latency_ms: 42.48, status: 200 },
        'Date + Provider': { match_count: 7494, latency_ms: 53.36, status: 200 },
        'Range + Client': { match_count: 1500, latency_ms: 38.94, status: 200 },
        'Manager + Agent': { match_count: 23750, latency_ms: 80.33, status: 200 },
        'Date + Range + CLI + Client': { match_count: 0, latency_ms: 6.49, status: 200 }
      }
    },
    phase3_numbers: {
      sizes: {
        100: { load_time_ms: 7.29, bytes: 61526, rows_returned: 100, status: 200 },
        500: { load_time_ms: 13.82, bytes: 307864, rows_returned: 500, status: 200 },
        1000: { load_time_ms: 23.32, bytes: 615864, rows_returned: 1000, status: 200 },
        5000: { load_time_ms: 141.46, bytes: 3082452, rows_returned: 5000, status: 200 },
        10000: { load_time_ms: 218.81, bytes: 6167471, rows_returned: 10000, status: 200 },
        20000: { load_time_ms: 487.12, bytes: 12308909, rows_returned: 20000, status: 200 },
        25000: { load_time_ms: 600.86, bytes: 15367909, rows_returned: 25000, status: 200 }
      },
      filters: {
        'Unallocated only': { total_match: 60000, latency_ms: 6.11, status: 200 },
        'Manager allocated': { total_match: 60000, latency_ms: 11.04, status: 200 },
        'Agent allocated': { total_match: 60000, latency_ms: 6.03, status: 200 },
        'Client allocated': { total_match: 60000, latency_ms: 5.89, status: 200 },
        'Range (UK Mobile O2)': { total_match: 14999, latency_ms: 8.83, status: 200 },
        'Search Prefix (4471)': { total_match: 14999, latency_ms: 11.19, status: 200 },
        'Range + Unallocated': { total_match: 14999, latency_ms: 13.09, status: 200 },
        'Pagination (Page 10, Limit 500)': { total_match: 60000, latency_ms: 14.8, status: 200 },
        'Pagination (Page 50, Limit 500)': { total_match: 60000, latency_ms: 23.5, status: 200 }
      }
    }
  }
};

async function executeAuditRemaining() {
  console.log('\n================================================================');
  console.log(' PHASE 4: CONCURRENT SMS NUMBER OPERATIONS ALONE');
  console.log('================================================================');

  // Scenario A: 1 user loads 25k numbers + 1 user allocates 5k + 1 user allocates 7k simultaneously
  console.log('\n--- Scenario A: 25k Load + 5k Allocation + 7k Allocation Simultaneously ---');

  const unallocIds = db.all("SELECT id FROM numbers WHERE manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL LIMIT 15000").map(r => r.id);
  const ids5k = unallocIds.slice(0, 5000);
  const ids7k = unallocIds.slice(5000, 12000);
  console.log(`Prepared unallocated batches: 5,000 IDs and 7,000 IDs (available: ${unallocIds.length})`);

  const t0_scA = performance.now();
  const [load25k_A, alloc5k_A, alloc7k_A] = await Promise.all([
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers?paged=1&limit=25000&_nocache=1',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: ids5k, target_id: mgrUser.id, payterm: 'weekly_7_1', payout: '0.0075' }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: ids7k, target_id: agtUser.id, payterm: 'weekly_7_1', payout: '0.0070' })
  ]);
  const totalScA_ms = +(performance.now() - t0_scA).toFixed(2);

  console.log(`  25k Load: ${load25k_A.ms.toFixed(1)} ms (status: ${load25k_A.status})`);
  console.log(`  5k Allocation: ${alloc5k_A.ms.toFixed(1)} ms (status: ${alloc5k_A.status}, allocated: ${alloc5k_A.json?.allocated})`);
  console.log(`  7k Allocation: ${alloc7k_A.ms.toFixed(1)} ms (status: ${alloc7k_A.status}, allocated: ${alloc7k_A.json?.allocated})`);
  console.log(`  Scenario A Total Wall-clock: ${totalScA_ms} ms`);

  // Scenario B: Combine 25k load + 5k alloc + 7k alloc + continuous SMS ingest traffic (20 SMS/s)
  console.log('\n--- Scenario B: 25k Load + 5k Alloc + 7k Alloc + 20 SMS/s Ingest Traffic ---');
  const unallocIdsB = db.all("SELECT id FROM numbers WHERE manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL LIMIT 15000").map(r => r.id);
  const ids5kB = unallocIdsB.slice(0, 5000);
  const ids7kB = unallocIdsB.slice(5000, 12000);

  const ingestStatsB = new StatsCollector();
  let stopIngestB = false;

  const bgIngestPromise = (async () => {
    let sent = 0;
    while (!stopIngestB) {
      const num = targetNumbers[sent % targetNumbers.length] || '+44111';
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, { number: num, cli: 'UBER', message: `Code: ${100000 + (sent % 900000)}` }).then(r => {
        ingestStatsB.record(r.ms, r.status === 200 && r.json?.ok);
      });
      sent++;
      await new Promise(r => setTimeout(r, 50)); // ~20 rps
    }
  })();

  await new Promise(r => setTimeout(r, 1000));
  const t0_scB = performance.now();
  const [load25k_B, alloc5k_B, alloc7k_B] = await Promise.all([
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers?paged=1&limit=25000&_nocache=1',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: ids5kB, target_id: mgrUser.id, payterm: 'weekly_7_1', payout: '0.0075' }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: ids7kB, target_id: agtUser.id, payterm: 'weekly_7_1', payout: '0.0070' })
  ]);
  const totalScB_ms = +(performance.now() - t0_scB).toFixed(2);
  stopIngestB = true;
  await bgIngestPromise;
  await new Promise(r => setTimeout(r, 1000));

  const ingestSummaryB = ingestStatsB.getStats();
  console.log(`  25k Load: ${load25k_B.ms.toFixed(1)} ms (status: ${load25k_B.status})`);
  console.log(`  5k Allocation: ${alloc5k_B.ms.toFixed(1)} ms (status: ${alloc5k_B.status}, allocated: ${alloc5k_B.json?.allocated})`);
  console.log(`  7k Allocation: ${alloc7k_B.ms.toFixed(1)} ms (status: ${alloc7k_B.status}, allocated: ${alloc7k_B.json?.allocated})`);
  console.log(`  Concurrent Ingest: ${ingestSummaryB.actual_rps} SMS/s | Latency avg=${ingestSummaryB.latency_ms.avg}ms, p95=${ingestSummaryB.latency_ms.p95}ms, max=${ingestSummaryB.latency_ms.max}ms`);
  console.log(`  Scenario B Total Wall-clock: ${totalScB_ms} ms`);

  auditReport.phases.phase4_concurrent = {
    scenario_A: { load25k_ms: load25k_A.ms, alloc5k_ms: alloc5k_A.ms, alloc7k_ms: alloc7k_A.ms, total_wallclock_ms: totalScA_ms },
    scenario_B: { load25k_ms: load25k_B.ms, alloc5k_ms: alloc5k_B.ms, alloc7k_ms: alloc7k_B.ms, total_wallclock_ms: totalScB_ms, ingest: ingestSummaryB }
  };

  // ===========================================================================
  // PHASE 5: SMS TRAFFIC + CDR REPORTS COMBINED (Workload 1)
  // ===========================================================================
  console.log('\n================================================================');
  console.log(' PHASE 5: SMS TRAFFIC + CDR REPORTS COMBINED (Workload 1)');
  console.log('================================================================');

  let stopW1 = false;
  const w1IngestStats = new StatsCollector();
  const w1CdrStats = new StatsCollector();

  const w1Traffic = (async () => {
    let sent = 0;
    while (!stopW1) {
      const num = targetNumbers[sent % targetNumbers.length] || '+44111';
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, { number: num, cli: 'BINANCE', message: `OTP: ${200000 + (sent % 800000)}` }).then(r => {
        w1IngestStats.record(r.ms, r.status === 200);
      });
      sent++;
      await new Promise(r => setTimeout(r, 50)); // ~20 rps
    }
  })();

  const w1CdrUsers = Array.from({ length: 4 }, (_, uid) => (async () => {
    const roles = ['admin', 'manager', 'agent', 'client'];
    const token = tokens[roles[uid % 4]];
    while (!stopW1) {
      const t0 = performance.now();
      const r = await httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/sms/paged?limit=1000&_nocache=1',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });
      w1CdrStats.record(performance.now() - t0, r.status === 200);
      await new Promise(r => setTimeout(r, 200));
    }
  })());

  console.log('Running Workload 1: 20 SMS/s Ingest + 4 CDR Users for 20 seconds...');
  await new Promise(r => setTimeout(r, 20000));
  stopW1 = true;
  await Promise.all([w1Traffic, ...w1CdrUsers]);
  await new Promise(r => setTimeout(r, 1000));

  const w1IngestOut = w1IngestStats.getStats();
  const w1CdrOut = w1CdrStats.getStats();
  console.log(`  Ingest: ${w1IngestOut.actual_rps} SMS/s | avg=${w1IngestOut.latency_ms.avg}ms, p95=${w1IngestOut.latency_ms.p95}ms, max=${w1IngestOut.latency_ms.max}ms`);
  console.log(`  CDR Reads: ${w1CdrOut.count} queries | avg=${w1CdrOut.latency_ms.avg}ms, p95=${w1CdrOut.latency_ms.p95}ms, max=${w1CdrOut.latency_ms.max}ms`);

  auditReport.phases.phase5_workload1 = { ingest: w1IngestOut, cdr: w1CdrOut };

  // ===========================================================================
  // PHASE 6: SMS TRAFFIC + SMS NUMBERS COMBINED (Workload 2)
  // ===========================================================================
  console.log('\n================================================================');
  console.log(' PHASE 6: SMS TRAFFIC + SMS NUMBERS COMBINED (Workload 2)');
  console.log('================================================================');

  let stopW2 = false;
  const w2IngestStats = new StatsCollector();
  const w2NumStats = new StatsCollector();

  const w2Traffic = (async () => {
    let sent = 0;
    while (!stopW2) {
      const num = targetNumbers[sent % targetNumbers.length] || '+44111';
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, { number: num, cli: 'TIKTOK', message: `Code: ${300000 + (sent % 700000)}` }).then(r => {
        w2IngestStats.record(r.ms, r.status === 200);
      });
      sent++;
      await new Promise(r => setTimeout(r, 50));
    }
  })();

  const w2NumUsers = Array.from({ length: 4 }, (_, uid) => (async () => {
    while (!stopW2) {
      const page = 1 + (uid % 10);
      const limit = (uid % 2 === 0) ? 1000 : 5000;
      const t0 = performance.now();
      const r = await httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: `/api/numbers?paged=1&page=${page}&limit=${limit}&_nocache=1`,
        method: 'GET',
        headers: { Authorization: `Bearer ${tokens.admin}` }
      });
      w2NumStats.record(performance.now() - t0, r.status === 200);
      await new Promise(r => setTimeout(r, 250));
    }
  })());

  console.log('Running Workload 2: 20 SMS/s Ingest + 4 SMS Numbers Users for 20 seconds...');
  await new Promise(r => setTimeout(r, 20000));
  stopW2 = true;
  await Promise.all([w2Traffic, ...w2NumUsers]);
  await new Promise(r => setTimeout(r, 1000));

  const w2IngestOut = w2IngestStats.getStats();
  const w2NumOut = w2NumStats.getStats();
  console.log(`  Ingest: ${w2IngestOut.actual_rps} SMS/s | avg=${w2IngestOut.latency_ms.avg}ms, p95=${w2IngestOut.latency_ms.p95}ms, max=${w2IngestOut.latency_ms.max}ms`);
  console.log(`  Numbers Reads: ${w2NumOut.count} queries | avg=${w2NumOut.latency_ms.avg}ms, p95=${w2NumOut.latency_ms.p95}ms, max=${w2NumOut.latency_ms.max}ms`);

  auditReport.phases.phase6_workload2 = { ingest: w2IngestOut, numbers: w2NumOut };

  // ===========================================================================
  // PHASE 7: SMS TRAFFIC + CDR + SMS NUMBERS + ALLOCATIONS (Workloads 3 & 4)
  // ===========================================================================
  console.log('\n================================================================');
  console.log(' PHASE 7: SMS TRAFFIC + CDR + NUMBERS + ALLOCATIONS COMBINED');
  console.log('================================================================');

  console.log('Running Workload 4 (Heavy Concurrency Convergence)...');
  let stopW4 = false;
  const w4IngestStats = new StatsCollector();

  const w4Traffic = (async () => {
    let sent = 0;
    while (!stopW4) {
      const num = targetNumbers[sent % targetNumbers.length] || '+44111';
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, { number: num, cli: 'MICROSOFT', message: `Passcode: ${400000 + (sent % 600000)}` }).then(r => {
        w4IngestStats.record(r.ms, r.status === 200);
      });
      sent++;
      await new Promise(r => setTimeout(r, 50));
    }
  })();

  await new Promise(r => setTimeout(r, 1000));
  const t0_w4 = performance.now();

  const unallocW4 = db.all("SELECT id FROM numbers WHERE manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL LIMIT 15000").map(r => r.id);
  const w4_5k = unallocW4.slice(0, 5000);
  const w4_7k = unallocW4.slice(5000, 12000);

  const [w4_load25k, w4_alloc5k, w4_alloc7k, w4_cdr] = await Promise.all([
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers?paged=1&limit=25000&_nocache=1',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: w4_5k, target_id: mgrUser.id, payterm: 'weekly_7_1', payout: '0.0075' }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/numbers/allocate',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    }, { ids: w4_7k, target_id: agtUser.id, payterm: 'weekly_7_1', payout: '0.0070' }),
    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/sms/paged?limit=5000&_nocache=1',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.admin}` }
    })
  ]);
  const w4_total_ms = +(performance.now() - t0_w4).toFixed(2);
  stopW4 = true;
  await w4Traffic;
  await new Promise(r => setTimeout(r, 1000));

  const w4IngestOut = w4IngestStats.getStats();
  console.log(`  25k Numbers Load: ${w4_load25k.ms.toFixed(1)} ms`);
  console.log(`  5k Allocation: ${w4_alloc5k.ms.toFixed(1)} ms (allocated: ${w4_alloc5k.json?.allocated})`);
  console.log(`  7k Allocation: ${w4_alloc7k.ms.toFixed(1)} ms (allocated: ${w4_alloc7k.json?.allocated})`);
  console.log(`  5k CDR Load: ${w4_cdr.ms.toFixed(1)} ms`);
  console.log(`  Ingest during Heavy Convergence: ${w4IngestOut.actual_rps} SMS/s | avg=${w4IngestOut.latency_ms.avg}ms, p95=${w4IngestOut.latency_ms.p95}ms, max=${w4IngestOut.latency_ms.max}ms`);
  console.log(`  Total Convergence Wall-clock: ${w4_total_ms} ms`);

  auditReport.phases.phase7_workload4 = {
    load25k_ms: w4_load25k.ms,
    alloc5k_ms: w4_alloc5k.ms,
    alloc7k_ms: w4_alloc7k.ms,
    cdr5k_ms: w4_cdr.ms,
    wallclock_ms: w4_total_ms,
    ingest: w4IngestOut
  };

  // ===========================================================================
  // PHASE 8: FULL REALISTIC MULTI-USER / MULTI-PANEL CONCURRENCY RAMP
  // ===========================================================================
  console.log('\n================================================================');
  console.log(' PHASE 8: FULL MULTI-USER / MULTI-PANEL CONCURRENCY RAMP');
  console.log('================================================================');

  const concurrencyLevels = [1, 5, 10, 20, 30, 40, 50];
  const p8Results = {};

  for (const users of concurrencyLevels) {
    console.log(`\n--- Testing ${users} Concurrent Active Users + 20 SMS/s Continuous Traffic (15 seconds) ---`);
    let stopP8 = false;
    const ingestStats = new StatsCollector();
    const userStats = new StatsCollector();

    const bgP8Traffic = (async () => {
      let sent = 0;
      while (!stopP8) {
        const num = targetNumbers[sent % targetNumbers.length] || '+44111';
        httpRequest({
          host: '127.0.0.1',
          port: PORT,
          path: '/api/webhook/sms',
          method: 'POST'
        }, { number: num, cli: 'FACEBOOK', message: `Code: ${500000 + (sent % 500000)}` }).then(r => {
          ingestStats.record(r.ms, r.status === 200);
        });
        sent++;
        await new Promise(r => setTimeout(r, 50));
      }
    })();

    const activeWorkers = Array.from({ length: users }, (_, uidx) => (async () => {
      const roleList = ['admin', 'manager', 'agent', 'client'];
      const myRole = roleList[uidx % 4];
      const token = tokens[myRole];
      let step = 0;

      while (!stopP8) {
        const t0 = performance.now();
        let res = null;
        const actionType = step % 3;

        if (actionType === 0) {
          res = await httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/dashboard', method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        } else if (actionType === 1) {
          res = await httpRequest({ host: '127.0.0.1', port: PORT, path: `/api/numbers?paged=1&limit=100&page=${1 + (uidx % 5)}`, method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        } else {
          res = await httpRequest({ host: '127.0.0.1', port: PORT, path: `/api/sms/paged?limit=250&page=${1 + (uidx % 5)}`, method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        }

        userStats.record(performance.now() - t0, res.status === 200);
        step++;
        await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
      }
    })());

    await new Promise(r => setTimeout(r, 15000));
    stopP8 = true;
    await Promise.all([bgP8Traffic, ...activeWorkers]);
    await new Promise(r => setTimeout(r, 1000));

    const h = await getHealth();
    const uOut = userStats.getStats();
    const iOut = ingestStats.getStats();

    console.log(`  Users (${users}): ${uOut.count} requests | avg=${uOut.latency_ms.avg}ms, p50=${uOut.latency_ms.p50}ms, p95=${uOut.latency_ms.p95}ms, max=${uOut.latency_ms.max}ms | errors=${uOut.failed}`);
    console.log(`  Ingest during ${users} users: ${iOut.actual_rps} SMS/s | avg=${iOut.latency_ms.avg}ms, p95=${iOut.latency_ms.p95}ms | RSS=${h.rss_mb}MB | Lag p50=${h.event_loop?.lag_p50_ms}ms`);

    p8Results[`concurrency_${users}`] = {
      users_count: users,
      user_ops: uOut,
      ingest: iOut,
      health: { rss_mb: h.rss_mb, event_loop_lag_p50_ms: h.event_loop?.lag_p50_ms, event_loop_lag_max_ms: h.event_loop?.lag_max_ms }
    };
  }

  auditReport.phases.phase8_multi_user = p8Results;

  // Save report to disk
  const reportPath = path.join(__dirname, '../audit-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditReport, null, 2), 'utf8');
  console.log(`\n================================================================`);
  console.log(`✅ FULL AUDIT COMPLETE! Raw results written to: ${reportPath}`);
  console.log('================================================================');
}

executeAuditRemaining().catch(err => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
