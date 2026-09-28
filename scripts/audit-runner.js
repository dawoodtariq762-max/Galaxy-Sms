const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const PORT = 4000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const keepAgent = new http.Agent({ keepAlive: true, maxSockets: 300 });

// Latency collector
class StatsCollector {
  constructor() {
    this.latencies = [];
    this.success = 0;
    this.failed = 0;
    this.t0 = performance.now();
  }
  record(ms, ok = true) {
    if (this.latencies.length < 500000) this.latencies.push(ms);
    if (ok) this.success++; else this.failed++;
  }
  getStats(activeDurationSec) {
    const totalTime = activeDurationSec || ((performance.now() - this.t0) / 1000);
    const n = this.latencies.length;
    if (!n) return { count: 0, rps: 0, success: this.success, failed: this.failed };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = +(sum / n).toFixed(2);
    const min = +sorted[0].toFixed(2);
    const max = +sorted[n - 1].toFixed(2);
    const p50 = +sorted[Math.floor(n * 0.50)].toFixed(2);
    const p95 = +sorted[Math.floor(n * 0.95)].toFixed(2);
    const p99 = +sorted[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2);
    const rps = +(this.success / totalTime).toFixed(1);
    const attemptedRps = +(n / totalTime).toFixed(1);
    return {
      duration_s: +totalTime.toFixed(2),
      attempted: n,
      success: this.success,
      failed: this.failed,
      attempted_rps: attemptedRps,
      actual_rps: rps,
      latency_ms: { min, avg, p50, p95, p99, max }
    };
  }
}

function httpRequest(options, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request({
      ...options,
      agent: keepAgent,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ms = performance.now() - t0;
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, ms, bytes: raw.length, json, raw });
      });
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error('timeout'));
      resolve({ status: 504, ms: performance.now() - t0, bytes: 0, error: 'timeout' });
    });
    req.on('error', err => {
      resolve({ status: 0, ms: performance.now() - t0, bytes: 0, error: err.message });
    });
    if (data) req.write(data);
    req.end();
  });
}

async function getHealth() {
  const r = await httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET' });
  return r.json || {};
}

// Generate Auth Tokens for roles
const { sign } = require('../backend/auth');
const db = require('../backend/db');
db.init();

const adminUser = db.get("SELECT * FROM users WHERE role='admin' LIMIT 1") || { id: 47, username: 'admin_u', role: 'admin' };
const mgrUser = db.get("SELECT * FROM users WHERE role='manager' LIMIT 1") || { id: 1, username: 'test_mgr', role: 'manager' };
const agtUser = db.get("SELECT * FROM users WHERE role='agent' LIMIT 1") || { id: 2, username: 'test_agt', role: 'agent' };
const cliUser = db.get("SELECT * FROM users WHERE role='client' LIMIT 1") || { id: 44, username: 'u_child_cli', role: 'client' };

const tokens = {
  admin: sign(adminUser),
  manager: sign(mgrUser),
  agent: sign(agtUser),
  client: sign(cliUser)
};

// Target numbers pool for incoming SMS
const targetNumbers = db.all("SELECT number FROM numbers LIMIT 10000").map(r => r.number);
console.log(`Loaded ${targetNumbers.length} recipient numbers for SMS traffic generator.`);

// Paced SMS Sender
async function runIngestTest(targetRps, durationSec, label) {
  console.log(`\n>>> Starting Ingest Test [${label}]: Target ${targetRps} SMS/s for ${durationSec}s...`);
  const stats = new StatsCollector();
  const startTime = Date.now();
  const endTime = startTime + (durationSec * 1000);
  
  const healthStart = await getHealth();
  const h0_rss = healthStart.rss_mb || 0;
  const h0_lag = healthStart.event_loop?.lag_p50_ms || 0;

  let sent = 0;
  const intervalMs = 1000 / targetRps;
  let nextSend = performance.now();

  while (Date.now() < endTime) {
    const now = performance.now();
    if (now >= nextSend) {
      const num = targetNumbers[sent % targetNumbers.length] || '+44111';
      const otp = String(100000 + (sent % 900000));
      const body = {
        number: num,
        cli: (sent % 2 === 0) ? 'GOOGLE' : 'WHATSAPP',
        message: `Your authentication code is ${otp}. Valid for 5 minutes.`
      };

      // Fire async request
      httpRequest({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/webhook/sms',
        method: 'POST'
      }, body).then(res => {
        const ok = res.status === 200 && res.json && res.json.ok;
        stats.record(res.ms, ok);
      });

      sent++;
      nextSend += intervalMs;
    } else {
      const waitTime = nextSend - now;
      if (waitTime > 2) {
        await new Promise(r => setTimeout(r, Math.floor(waitTime)));
      }
    }
  }

  const sendDuration = (Date.now() - startTime) / 1000;

  // Wait 1.5 seconds for in-flight requests to complete
  await new Promise(r => setTimeout(r, 1500));
  const healthEnd = await getHealth();

  const out = stats.getStats(sendDuration);
  out.target_rps = targetRps;
  out.duration_requested_s = durationSec;
  out.health = {
    rss_mb_start: h0_rss,
    rss_mb_end: healthEnd.rss_mb || 0,
    event_loop_lag_p50_ms: healthEnd.event_loop?.lag_p50_ms || 0,
    event_loop_lag_p95_ms: healthEnd.event_loop?.lag_p95_ms || 0,
    event_loop_lag_max_ms: healthEnd.event_loop?.lag_max_ms || 0,
    db_size_mb: healthEnd.db_size_mb || 0
  };

  console.log(`    Result: ${out.actual_rps} SMS/s | Attempted: ${out.attempted} | Success: ${out.success} | Failed: ${out.failed}`);
  console.log(`    Latency: avg=${out.latency_ms.avg}ms, p50=${out.latency_ms.p50}ms, p95=${out.latency_ms.p95}ms, p99=${out.latency_ms.p99}ms, max=${out.latency_ms.max}ms`);
  console.log(`    Event loop lag p50=${out.health.event_loop_lag_p50_ms}ms, max=${out.health.event_loop_lag_max_ms}ms | RSS=${out.health.rss_mb_end}MB`);
  return out;
}

module.exports = {
  PORT,
  tokens,
  targetNumbers,
  StatsCollector,
  httpRequest,
  getHealth,
  runIngestTest
};
