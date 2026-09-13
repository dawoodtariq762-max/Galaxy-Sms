'use strict';
/* pwbench lib/api.js — HTTP client: keepalive, latency hist, precise concurrency */
const http = require('http'), { Hist } = require('./hist');
const { checkStop } = require('./guard');
const keepAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function raw(base, method, p, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: base, path: p, method, agent: keepAgent,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } },
      res => { let chunks = [], n = 0; res.on('data', c => { chunks.push(c); n += c.length; if (n > 8e6) res.destroy(); }); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {} resolve({ status: res.statusCode, j }); }); });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
class Client {
  constructor(port) { this.port = port; this.h = new Hist(); this.tokens = {}; this.errors = 0; this.timeouts = 0; }
  async call(method, p, body, token, headers) {
    const t = performance.now();
    try { const r = await raw(this.port, method, p, { token, body, headers }); this.h.add(performance.now() - t); if (r.status >= 400) this.errors++; return r; }
    catch (e) { this.timeouts++; this.errors++; this.h.add(performance.now() - t); return { status: 0, j: null, err: e.message }; }
  }
  async login(username, password) {
    const key = username + ':' + password;
    if (this.tokens[key]) return this.tokens[key];
    const r = await raw(this.port, 'POST', '/api/login', { body: { username, password } });
    if (r.status !== 200 || !r.j?.token) throw new Error(`login failed ${username}: ${r.status} ${JSON.stringify(r.j).slice(0, 120)}`);
    this.tokens[key] = r.j; return r.j;
  }
  out() { return { ...this.h.out(), errors: this.errors, timeouts: this.timeouts }; }
}
/** Run N workers; each pulls next item from gen() until deadline/stop. */
async function runWorkers(nWorkers, workFn, { maxItems = Infinity, deadlineMs = Infinity } = {}) {
  let done = 0; const t0 = Date.now();
  const workers = Array.from({ length: nWorkers }, () => (async () => {
    while (done < maxItems && Date.now() - t0 < deadlineMs) {
      if (checkStop()) return;
      done++; try { await workFn(done); } catch (_) {}
    }
  })());
  await Promise.all(workers); return done;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { Client, raw, runWorkers, sleep, keepAgent };
