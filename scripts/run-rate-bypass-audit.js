/**
 * scripts/run-rate-bypass-audit.js
 * Controlled temporary capacity audit testing HTTP-only, SMPP-only, and HTTP+SMPP simultaneous.
 * Tests real engine throughput with rate limiter bypassed at runtime via environment variables.
 */

const http = require('http');
const smpp = require('smpp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');

const db = require('../backend/db');
db.init();

const PORT = 4000;
const SMPP_PORT = 2776;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200 });

// Target numbers pool from seeded DB
const targetNumbers = db.all("SELECT number FROM numbers LIMIT 10000").map(r => r.number);
console.log(`Loaded ${targetNumbers.length} valid destination numbers.`);

// Helper: HTTP request
function httpRequest(options, postData) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const dataStr = postData ? JSON.stringify(postData) : null;
    const req = http.request({
      ...options,
      agent: httpAgent,
      headers: {
        ...(options.headers || {}),
        ...(dataStr ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr)
        } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const ms = performance.now() - t0;
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json, ms });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, error: err.message, ms: performance.now() - t0 });
    });

    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function getHealth() {
  const r = await httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET' });
  return r.json || {};
}

// Latency & stats tracker
class PerfTracker {
  constructor(name) {
    this.name = name;
    this.latencies = [];
    this.statusCodes = {};
    this.success = 0;
    this.failed = 0;
    this.t0 = performance.now();
  }

  record(latencyMs, statusCode, isSuccess) {
    this.latencies.push(latencyMs);
    this.statusCodes[statusCode] = (this.statusCodes[statusCode] || 0) + 1;
    if (isSuccess) this.success++;
    else this.failed++;
  }

  summary(durationSec) {
    const totalTime = durationSec || ((performance.now() - this.t0) / 1000);
    const n = this.latencies.length;
    if (!n) return { count: 0, actual_rps: 0, success: 0, failed: 0 };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      attempted: n,
      success: this.success,
      failed: this.failed,
      status_codes: this.statusCodes,
      actual_rps: +(this.success / totalTime).toFixed(2),
      avg_latency_ms: +(sum / n).toFixed(2),
      p50_latency_ms: +sorted[Math.floor(n * 0.50)].toFixed(2),
      p95_latency_ms: +sorted[Math.floor(n * 0.95)].toFixed(2),
      p99_latency_ms: +sorted[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2),
      max_latency_ms: +sorted[n - 1].toFixed(2),
      duration_s: +totalTime.toFixed(2)
    };
  }
}

// ============================================================================
// 1. HTTP ONLY TEST RUNNER
// ============================================================================
async function runHttpTest(targetRps, durationSec, testTag) {
  console.log(`\n>>> [HTTP TEST] Target: ${targetRps} SMS/s for ${durationSec}s [Tag: ${testTag}]`);
  const tracker = new PerfTracker(testTag);
  const healthStart = await getHealth();

  const startTime = Date.now();
  const endTime = startTime + (durationSec * 1000);
  const intervalMs = 1000 / targetRps;
  let sent = 0;

  const preDbCount = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag]).c;

  while (Date.now() < endTime) {
    const num = targetNumbers[sent % targetNumbers.length];
    const seq = sent++;

    httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/webhook/sms',
      method: 'POST'
    }, {
      number: num,
      cli: testTag,
      message: `HTTP Code: ${100000 + seq}`
    }).then(r => {
      const ok = r.status === 200 && r.json?.ok === true;
      tracker.record(r.ms, r.status, ok);
    });

    const expectedTime = startTime + (sent * intervalMs);
    const waitMs = expectedTime - Date.now();
    if (waitMs > 1) {
      await new Promise(res => setTimeout(res, waitMs));
    }
  }

  const sendDuration = (Date.now() - startTime) / 1000;
  // Drain
  await new Promise(res => setTimeout(res, 1200));
  const healthEnd = await getHealth();

  const stats = tracker.summary(sendDuration);
  const postDbCount = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag]).c;
  const dbInserted = postDbCount - preDbCount;

  // Check duplicate messages
  const duplicates = db.get(`
    SELECT COUNT(*) c FROM (
      SELECT message, COUNT(*) cnt FROM sms_records WHERE cli=? GROUP BY message HAVING cnt > 1
    )
  `, [testTag]).c;

  console.log(`    Result: ${stats.actual_rps} SMS/s | Attempted: ${stats.attempted} | Success: ${stats.success} | Failed: ${stats.failed}`);
  console.log(`    Statuses:`, stats.status_codes);
  console.log(`    Latency: avg=${stats.avg_latency_ms}ms, p50=${stats.p50_latency_ms}ms, p95=${stats.p95_latency_ms}ms, p99=${stats.p99_latency_ms}ms, max=${stats.max_latency_ms}ms`);
  console.log(`    DB Verification: Written to DB = ${dbInserted} | Duplicates = ${duplicates}`);
  console.log(`    Health: RSS=${healthEnd.rss_mb}MB | Event Loop Lag p50=${healthEnd.event_loop?.lag_p50_ms}ms, max=${healthEnd.event_loop?.lag_max_ms}ms`);

  return {
    rate_target: targetRps,
    duration_s: durationSec,
    stats,
    db_inserted: dbInserted,
    duplicates,
    health: {
      rss_mb: healthEnd.rss_mb,
      event_loop_lag_p50_ms: healthEnd.event_loop?.lag_p50_ms,
      event_loop_lag_max_ms: healthEnd.event_loop?.lag_max_ms
    }
  };
}

// ============================================================================
// 2. SMPP ONLY TEST RUNNER
// ============================================================================
function createSmppClientSession() {
  return new Promise((resolve, reject) => {
    const session = smpp.connect({
      url: `smpp://127.0.0.1:${SMPP_PORT}`,
      auto_enquire_link_period: 15000
    }, () => {
      session.bind_transceiver({
        system_id: 'srv_user',
        password: 'secret_pwd2'
      }, (pdu) => {
        if (pdu.command_status === 0) {
          resolve(session);
        } else {
          reject(new Error('SMPP Bind failed with status: ' + pdu.command_status));
        }
      });
    });
    session.on('error', (err) => reject(err));
  });
}

async function runSmppTest(targetRps, durationSec, testTag) {
  console.log(`\n>>> [SMPP TEST] Target: ${targetRps} SMS/s for ${durationSec}s [Tag: ${testTag}]`);
  const session = await createSmppClientSession();
  const tracker = new PerfTracker(testTag);
  const healthStart = await getHealth();

  const startTime = Date.now();
  const endTime = startTime + (durationSec * 1000);
  const intervalMs = 1000 / targetRps;
  let sent = 0;

  const preDbCount = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag]).c;

  while (Date.now() < endTime) {
    const num = targetNumbers[sent % targetNumbers.length];
    const seq = sent++;
    const t0 = performance.now();

    session.submit_sm({
      destination_addr: num,
      source_addr: testTag,
      short_message: `SMPP Code: ${200000 + seq}`
    }, (pdu) => {
      const ms = performance.now() - t0;
      const ok = pdu && pdu.command_status === 0;
      tracker.record(ms, pdu ? pdu.command_status : -1, ok);
    });

    const expectedTime = startTime + (sent * intervalMs);
    const waitMs = expectedTime - Date.now();
    if (waitMs > 1) {
      await new Promise(res => setTimeout(res, waitMs));
    }
  }

  const sendDuration = (Date.now() - startTime) / 1000;
  // Drain
  await new Promise(res => setTimeout(res, 1200));
  await new Promise(res => session.unbind(() => { session.close(); res(); }));
  const healthEnd = await getHealth();

  const stats = tracker.summary(sendDuration);
  const postDbCount = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag]).c;
  const dbInserted = postDbCount - preDbCount;

  // Check duplicate messages
  const duplicates = db.get(`
    SELECT COUNT(*) c FROM (
      SELECT message, COUNT(*) cnt FROM sms_records WHERE cli=? GROUP BY message HAVING cnt > 1
    )
  `, [testTag]).c;

  console.log(`    Result: ${stats.actual_rps} SMS/s | Attempted: ${stats.attempted} | Success: ${stats.success} | Failed: ${stats.failed}`);
  console.log(`    Command Statuses:`, stats.status_codes);
  console.log(`    Latency: avg=${stats.avg_latency_ms}ms, p50=${stats.p50_latency_ms}ms, p95=${stats.p95_latency_ms}ms, p99=${stats.p99_latency_ms}ms, max=${stats.max_latency_ms}ms`);
  console.log(`    DB Verification: Written to DB = ${dbInserted} | Duplicates = ${duplicates}`);
  console.log(`    Health: RSS=${healthEnd.rss_mb}MB | Event Loop Lag p50=${healthEnd.event_loop?.lag_p50_ms}ms, max=${healthEnd.event_loop?.lag_max_ms}ms`);

  return {
    rate_target: targetRps,
    duration_s: durationSec,
    stats,
    db_inserted: dbInserted,
    duplicates,
    health: {
      rss_mb: healthEnd.rss_mb,
      event_loop_lag_p50_ms: healthEnd.event_loop?.lag_p50_ms,
      event_loop_lag_max_ms: healthEnd.event_loop?.lag_max_ms
    }
  };
}

// ============================================================================
// 3. HTTP + SMPP SIMULTANEOUS TEST RUNNER
// ============================================================================
async function runSimultaneousTest(httpTargetRps, smppTargetRps, durationSec, testTag) {
  const combinedTarget = httpTargetRps + smppTargetRps;
  console.log(`\n>>> [HTTP + SMPP SIMULTANEOUS] Target: HTTP ${httpTargetRps} + SMPP ${smppTargetRps} = Total ${combinedTarget} SMS/s for ${durationSec}s`);

  const httpTracker = new PerfTracker(testTag + '_HTTP');
  const smppTracker = new PerfTracker(testTag + '_SMPP');
  const session = await createSmppClientSession();

  const healthStart = await getHealth();
  const startTime = Date.now();
  const endTime = startTime + (durationSec * 1000);

  const preHttpDb = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag + '_HTTP']).c;
  const preSmppDb = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag + '_SMPP']).c;

  // HTTP Sender loop
  let httpSent = 0;
  const httpInterval = 1000 / httpTargetRps;
  const httpPromise = (async () => {
    while (Date.now() < endTime) {
      const num = targetNumbers[httpSent % targetNumbers.length];
      const seq = httpSent++;
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, {
        number: num,
        cli: testTag + '_HTTP',
        message: `HTTP Code: ${300000 + seq}`
      }).then(r => {
        const ok = r.status === 200 && r.json?.ok === true;
        httpTracker.record(r.ms, r.status, ok);
      });

      const expected = startTime + (httpSent * httpInterval);
      const w = expected - Date.now();
      if (w > 1) await new Promise(r => setTimeout(r, w));
    }
  })();

  // SMPP Sender loop
  let smppSent = 0;
  const smppInterval = 1000 / smppTargetRps;
  const smppPromise = (async () => {
    while (Date.now() < endTime) {
      const num = targetNumbers[(smppSent + 5000) % targetNumbers.length];
      const seq = smppSent++;
      const t0 = performance.now();
      session.submit_sm({
        destination_addr: num,
        source_addr: testTag + '_SMPP',
        short_message: `SMPP Code: ${400000 + seq}`
      }, (pdu) => {
        const ms = performance.now() - t0;
        const ok = pdu && pdu.command_status === 0;
        smppTracker.record(ms, pdu ? pdu.command_status : -1, ok);
      });

      const expected = startTime + (smppSent * smppInterval);
      const w = expected - Date.now();
      if (w > 1) await new Promise(r => setTimeout(r, w));
    }
  })();

  await Promise.all([httpPromise, smppPromise]);
  const sendDuration = (Date.now() - startTime) / 1000;

  // Drain
  await new Promise(res => setTimeout(res, 1200));
  await new Promise(res => session.unbind(() => { session.close(); res(); }));
  const healthEnd = await getHealth();

  const httpStats = httpTracker.summary(sendDuration);
  const smppStats = smppTracker.summary(sendDuration);

  const postHttpDb = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag + '_HTTP']).c;
  const postSmppDb = db.get(`SELECT COUNT(*) c FROM sms_records WHERE cli=?`, [testTag + '_SMPP']).c;

  const httpInserted = postHttpDb - preHttpDb;
  const smppInserted = postSmppDb - preSmppDb;
  const totalInserted = httpInserted + smppInserted;
  const totalAttempted = httpStats.attempted + smppStats.attempted;
  const totalSuccess = httpStats.success + smppStats.success;
  const totalRps = +(totalSuccess / sendDuration).toFixed(2);

  console.log(`    --- Combined Results ---`);
  console.log(`    TOTAL Rate: ${totalRps} SMS/s | Total Succeeded: ${totalSuccess} / ${totalAttempted}`);
  console.log(`    HTTP Channel: ${httpStats.actual_rps} SMS/s | Succeeded: ${httpStats.success} / ${httpStats.attempted} | avg=${httpStats.avg_latency_ms}ms, p95=${httpStats.p95_latency_ms}ms`);
  console.log(`    SMPP Channel: ${smppStats.actual_rps} SMS/s | Succeeded: ${smppStats.success} / ${smppStats.attempted} | avg=${smppStats.avg_latency_ms}ms, p95=${smppStats.p95_latency_ms}ms`);
  console.log(`    DB Verification: HTTP Written = ${httpInserted} | SMPP Written = ${smppInserted} | Total = ${totalInserted}`);
  console.log(`    Health: RSS=${healthEnd.rss_mb}MB | Event Loop Lag p50=${healthEnd.event_loop?.lag_p50_ms}ms, max=${healthEnd.event_loop?.lag_max_ms}ms`);

  return {
    scenario: `${httpTargetRps}_HTTP_${smppTargetRps}_SMPP`,
    duration_s: durationSec,
    http: httpStats,
    smpp: smppStats,
    combined: {
      attempted: totalAttempted,
      success: totalSuccess,
      total_rps: totalRps,
      total_db_written: totalInserted
    },
    health: {
      rss_mb: healthEnd.rss_mb,
      event_loop_lag_p50_ms: healthEnd.event_loop?.lag_p50_ms,
      event_loop_lag_max_ms: healthEnd.event_loop?.lag_max_ms
    }
  };
}

// ============================================================================
// MAIN EXECUTION SUITE
// ============================================================================
async function runAll() {
  console.log('================================================================');
  console.log(' GALAXY SMS — CONTROLLED RUNTIME BYPASS CAPACITY AUDIT');
  console.log('================================================================');

  const auditData = {
    timestamp: new Date().toISOString(),
    system: {
      cpus: os.cpus().length,
      model: os.cpus()[0].model,
      total_mem_gb: +(os.totalmem() / 1e9).toFixed(2),
      free_mem_gb: +(os.freemem() / 1e9).toFixed(2)
    },
    http_tests: [],
    smpp_tests: [],
    simultaneous_tests: [],
    cdr_visibility_audit: {}
  };

  // --------------------------------------------------------------------------
  // TEST 1: HTTP ONLY TESTS
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' SECTION 1: HTTP ONLY CAPACITY TESTS (RATE LIMIT BYPASSED)');
  console.log('================================================================');

  const httpRates = [20, 30, 35, 40, 50, 60, 75];
  for (const r of httpRates) {
    const res = await runHttpTest(r, 15, `HTTP_${r}_RPS`);
    auditData.http_tests.push(res);
  }

  // 1-minute sustained test at 35 SMS/s (Proposed Team Load)
  console.log('\n>>> Running 1-Minute Continuous Sustained HTTP Test at 35 SMS/s (Proposed Team Load)...');
  const http35Sustained = await runHttpTest(35, 60, 'HTTP_35_SUSTAINED_1MIN');
  auditData.http_tests.push({ ...http35Sustained, sustained_1min: true });

  // --------------------------------------------------------------------------
  // TEST 2: SMPP ONLY TESTS
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' SECTION 2: SMPP ONLY CAPACITY TESTS');
  console.log('================================================================');

  const smppRates = [20, 30, 35, 40, 50, 60, 75];
  for (const r of smppRates) {
    const res = await runSmppTest(r, 15, `SMPP_${r}_RPS`);
    auditData.smpp_tests.push(res);
  }

  // 1-minute sustained test at 35 SMS/s SMPP
  console.log('\n>>> Running 1-Minute Continuous Sustained SMPP Test at 35 SMS/s...');
  const smpp35Sustained = await runSmppTest(35, 60, 'SMPP_35_SUSTAINED_1MIN');
  auditData.smpp_tests.push({ ...smpp35Sustained, sustained_1min: true });

  // --------------------------------------------------------------------------
  // TEST 3: HTTP + SMPP SIMULTANEOUS TESTS
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' SECTION 3: HTTP + SMPP SIMULTANEOUS CONCURRENCY TESTS');
  console.log('================================================================');

  // Scenario 1: HTTP 20 + SMPP 20 (40 SMS/s)
  const sim1 = await runSimultaneousTest(20, 20, 15, 'SIM_20_20');
  auditData.simultaneous_tests.push(sim1);

  // Scenario 2: HTTP 30 + SMPP 20 (50 SMS/s)
  const sim2 = await runSimultaneousTest(30, 20, 15, 'SIM_30_20');
  auditData.simultaneous_tests.push(sim2);

  // Scenario 3: HTTP 35 + SMPP 35 (70 SMS/s)
  const sim3 = await runSimultaneousTest(35, 35, 15, 'SIM_35_35');
  auditData.simultaneous_tests.push(sim3);

  // Scenario 4: Asymmetric HTTP 50 + SMPP 15 (65 SMS/s)
  const sim4 = await runSimultaneousTest(50, 15, 15, 'SIM_50_15_ASYM');
  auditData.simultaneous_tests.push(sim4);

  // Scenario 5: Asymmetric HTTP 15 + SMPP 50 (65 SMS/s)
  const sim5 = await runSimultaneousTest(15, 50, 15, 'SIM_15_50_ASYM');
  auditData.simultaneous_tests.push(sim5);

  // --------------------------------------------------------------------------
  // TEST 4: ASR & PANEL CDR VISIBILITY VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' SECTION 4: ASR & PANEL CDR VISIBILITY AUDIT');
  console.log('================================================================');

  const { sign } = require('../backend/auth');
  const adminUser = db.get("SELECT * FROM users WHERE role='admin' LIMIT 1");
  const adminToken = sign(adminUser);

  // Query CDR endpoint via Admin token
  const cdrReq = await httpRequest({
    host: '127.0.0.1',
    port: PORT,
    path: '/api/sms/paged?limit=10&cli=HTTP_35_SUSTAINED_1MIN',
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const totalInDbForTag = db.get("SELECT COUNT(*) c FROM sms_records WHERE cli='HTTP_35_SUSTAINED_1MIN'").c;
  console.log(`CDR API Verification for 'HTTP_35_SUSTAINED_1MIN':`);
  console.log(`  Records in DB: ${totalInDbForTag}`);
  console.log(`  API Response Status: ${cdrReq.status}`);
  console.log(`  API Total Reported: ${cdrReq.json?.total || cdrReq.json?.count || cdrReq.json?.rows?.length}`);
  console.log(`  Sample API Row:`, cdrReq.json?.rows?.[0] || cdrReq.json?.[0]);

  auditData.cdr_visibility_audit = {
    test_tag: 'HTTP_35_SUSTAINED_1MIN',
    db_records_count: totalInDbForTag,
    api_status: cdrReq.status,
    api_total: cdrReq.json?.total,
    sample_row: cdrReq.json?.rows?.[0] || cdrReq.json?.[0]
  };

  // Write results to disk
  fs.writeFileSync(path.join(__dirname, '../bypass-audit-results.json'), JSON.stringify(auditData, null, 2), 'utf8');
  console.log('\n================================================================');
  console.log('✅ ALL TEST PHASES COMPLETE! Results written to bypass-audit-results.json');
  console.log('================================================================');
}

runAll().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
