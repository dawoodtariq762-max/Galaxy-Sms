/**
 * Power X SMS — Backend API
 * Node.js + Express + SQLite (sql.js). MySQL-ready SQL.
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createTables } = require('./schema');
const { seed } = require('./seed');
const { sign, authRequired, requireRole, descendantIds } = require('./auth');
const backup = require('./backup');
const providerSync = require('./providerSync');
const smsFts = require('./fts');
const smppService = require('./smppService');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.text({ type: ['text/plain', 'text/*', 'application/xml', 'application/octet-stream'], limit: '2mb' }));
const upload = multer();
const importJobs = new Map();
const numberJobs = new Map();


// Short in-memory GET cache: removes duplicate heavy queries during rapid UI navigation.
// Any non-GET /api request clears this cache, so changes/incoming SMS are visible immediately after writes.
const apiReadCache = new Map();
function clearApiReadCache(){ try { apiReadCache.clear(); } catch (_) {} }
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    clearApiReadCache();
    try { db.beginBatch && db.beginBatch(); } catch (_) {}
    let ended = false;
    const end = () => { if (ended) return; ended = true; try { db.endBatch && db.endBatch(); } catch (e) { console.warn('[DB_BATCH] save failed:', e.message); } };
    res.on('finish', end);
    res.on('close', end);
  }
  next();
});

/* =========================================================================
 * PHASE-1: event-loop lag monitor (#41) — feeds /api/health + alerts
 * ========================================================================= */
const { monitorEventLoopDelay } = require('perf_hooks');
const elMonitor = monitorEventLoopDelay({ resolution: 20 });
elMonitor.enable();
function eventLoopStats() {
  try {
    return {
      lag_p50_ms: +(elMonitor.percentile(50) / 1e6).toFixed(1),
      lag_p95_ms: +(elMonitor.percentile(95) / 1e6).toFixed(1),
      lag_p99_ms: +(elMonitor.percentile(99) / 1e6).toFixed(1),
      lag_max_ms: +(elMonitor.max / 1e6).toFixed(1),
    };
  } catch (_) { return {}; }
}

/* =========================================================================
 * PHASE-1: version-key cache invalidation (#6/#12)
 * numbers_ver bumps on every numbers write; cachedJson keys include it so a
 * longer TTL stays correct (data freshness = immediate after writes).
 * ========================================================================= */
function getMetaVer(key) {
  try { const r = db.get('SELECT value FROM meta WHERE key=?', [key]); return r ? (+r.value || 0) : 0; }
  catch (_) { return 0; }
}
function bumpMetaVer(key) {
  try {
    db.run(`INSERT INTO meta(key,value) VALUES(?, '1')
            ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`, [key]);
  } catch (_) {}
}
function bumpNumbersVer() { bumpMetaVer('numbers_ver'); }

/* =========================================================================
 * PHASE-1 Step 4: pre-aggregated daily SMS stats
 * ========================================================================= */
function ukStatDate(ts) {
  try {
    if (!ts) return ukTodayDateStr(0);
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts));
    if (!m) return ukTodayDateStr(0);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    const p = ukParts(d);
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) { return ukTodayDateStr(0); }
}
/** O(1) ingest-time counter (called once per stored non-test SMS). */
function recordSmsStats(o) {
  try {
    db.run(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum)
            VALUES (?,?,?,?,?,1,?)
            ON CONFLICT(stat_date,manager_id,agent_id,client_id,cli)
            DO UPDATE SET sms_count = sms_count + 1, payout_sum = payout_sum + excluded.payout_sum`,
      [ukStatDate(o.ts), o.m ?? -1, o.a ?? -1, o.c ?? -1, String(o.cli || ''), Number(o.payout) || 0]);
  } catch (e) { /* stats must never break ingest */ }
}
function statsScope(user) {
  if (user.role === 'manager') return { col: 'manager_id', params: [user.id] };
  if (user.role === 'agent')   return { col: 'agent_id',   params: [user.id] };
  if (user.role === 'client')  return { col: 'client_id',  params: [user.id] };
  return { col: null, params: [] };
}
/** Chunked one-time backfill of sms_daily_stats from sms_records history. */
let backfillRunning = false;
async function backfillSmsStats(user) {
  if (backfillRunning) return { ok: false, error: 'Backfill already running', ...backfillStatus() };
  backfillRunning = true;
  const t0 = Date.now();
  try {
    const maxId = db.get('SELECT COALESCE(MAX(id),0) m FROM sms_records')?.m || 0;
    if (!maxId) { backfillRunning = false; return { ok: true, processed: 0, message: 'no sms_records' }; }
    let last = +(getMetaRaw('stats_backfill_max_id') || 0);
    // fresh rebuild when starting from scratch (prevents double-count on re-run)
    if (!last) { db.runNoSave('DELETE FROM sms_daily_stats'); setMeta('stats_backfill_max_id', '0'); }
    for (; last < maxId;) {
      const hi = Math.min(last + 100000, maxId);
      db.execNoSave('BEGIN IMMEDIATE');
      try {
        // date-owner-cli keys SPAN chunks -> must UPSERT (add), not plain INSERT
        db.runNoSave(`INSERT INTO sms_daily_stats (stat_date,manager_id,agent_id,client_id,cli,sms_count,payout_sum)
          SELECT date(received_at, '${ukSqlModifier()}') AS sd, COALESCE(manager_id,-1), COALESCE(agent_id,-1), COALESCE(client_id,-1), COALESCE(cli,''),
                 COUNT(*), COALESCE(SUM(CAST(COALESCE(NULLIF(payout_amount,''),'0') AS REAL)),0)
          FROM sms_records
          WHERE COALESCE(is_test,0)=0 AND id > ? AND id <= ?
          GROUP BY sd, manager_id, agent_id, client_id, cli
          ON CONFLICT(stat_date,manager_id,agent_id,client_id,cli)
          DO UPDATE SET sms_count = sms_count + excluded.sms_count,
                        payout_sum = payout_sum + excluded.payout_sum`, [last, hi]);
        db.execNoSave('COMMIT');
      } catch (e) { try { db.execNoSave('ROLLBACK'); } catch (_) {} throw e; }
      last = hi;
      try { setMeta('stats_backfill_max_id', String(last)); } catch (_) {}
      setMeta('stats_backfill_progress', JSON.stringify({ processed: last, total: maxId }));
      await new Promise(r => setImmediate(r)); // never block the event loop
    }
    setMeta('stats_backfill_done', '1');
    setMeta('stats_backfill_progress', JSON.stringify({ processed: maxId, total: maxId, ms: Date.now() - t0 }));
    try { logAction({ user }, 'backfill_sms_stats', 'system', { maxId, ms: Date.now() - t0 }); } catch (_) {}
    return { ok: true, processed: maxId, ms: Date.now() - t0 };
  } catch (e) {
    console.error('[BACKFILL] failed:', e.message);
    return { ok: false, error: e.message };
  } finally { backfillRunning = false; }
}
function backfillStatus() {
  try { return { done: getMetaVer('stats_backfill_done') === 1, progress: parseJsonSafe(getMetaRaw('stats_backfill_progress')) || null }; }
  catch (_) { return {}; }
}
function getMetaRaw(key) { try { return db.get('SELECT value FROM meta WHERE key=?', [key])?.value ?? null; } catch (_) { return null; } }
/** PHASE-2: parse a stored JSON string (server's safeJson() is a stringifier, not a parser). */
function parseJsonSafe(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || null); } catch (_) { return null; } }
function setMeta(key, value) { try { db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, String(value)]); } catch (_) {} }

/** Store an idempotent response snapshot (7-day TTL, opportunistic purge). */
function idempotencyStore(req, endpoint, key, response) {
  try {
    db.run(`INSERT INTO idempotency_keys(key,user_id,endpoint,response_json,expires_at) VALUES (?,?,?,?,?)
            ON CONFLICT(key) DO NOTHING`,
      [key, (req.user && req.user.id) || 0, endpoint, JSON.stringify(response),
       new Date(Date.now() + 7 * 864e5).toISOString()]);
    if (Math.random() < 0.02) {
      try { db.run(`DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`); } catch (_) {}
    }
  } catch (_) {}
}

/* =========================================================================
 * PHASE-1: tiny dependency-free rate limiter (#30) — login brute-force guard
 * ========================================================================= */
const _rateBuckets = new Map();
function rateLimit({ windowMs = 60000, max = 300, keyFn }) {
  return function (req, res, next) {
    const now = Date.now();
    let ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    const key = keyFn ? keyFn(req) : ip;
    const k = `${key}`;
    let b = _rateBuckets.get(k);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(k, b); }
    b.count++;
    if (_rateBuckets.size > 20000) { for (const [kk, bb] of _rateBuckets) if (now > bb.resetAt) _rateBuckets.delete(kk); }
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — please slow down' });
    }
    next();
  };
}
const loginRateLimit = rateLimit({ windowMs: 5 * 60000, max: 10, keyFn: req => `login:${req.ip || 'unknown'}` });
// General API guard (per IP until auth attaches user; authRequired re-checks per user in auth.js).
const apiRateLimit = rateLimit({ windowMs: 60000, max: parseInt(process.env.API_RATE_PER_MIN || '1200', 10) || 1200, keyFn: req => `api:${req.ip || 'unknown'}` });
// Carrier ingest guard — generous by design (50–70 SMS/s sustained = 4200/min); 429 tells the carrier to retry.
const smsIngestLimit = rateLimit({ windowMs: 60000, max: parseInt(process.env.INCOMING_SMS_RATE_PER_MIN || '12000', 10) || 12000, keyFn: req => `sms:${req.ip || 'unknown'}` });
// Heavy number writes (allocate/unallocate/delete/import/divide) — 120/min per IP is far above any UI usage.
const heavyWriteLimit = rateLimit({ windowMs: 60000, max: parseInt(process.env.HEAVY_WRITE_RATE_PER_MIN || '120', 10) || 120, keyFn: req => `heavy:${req.ip || 'unknown'}` });
app.use('/api', (req, res, next) => {
  const p = req.path;
  if (p === '/health' || p === '/login' || p.startsWith('/incoming-sms')) return next();
  return apiRateLimit(req, res, next);
});
app.use('/api/numbers', (req, res, next) => {
  if (req.method === 'GET') return next();
  return heavyWriteLimit(req, res, next);
});

/* =========================================================================
 * PHASE-2: background CSV exports (worker threads — never block the API)
 * ========================================================================= */
const { Worker } = require('worker_threads');
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(os.homedir(), 'powerx-exports');
const EXPORT_TTL_HOURS = parseInt(process.env.EXPORT_TTL_HOURS || '24', 10) || 24;
const EXPORT_MAX_CONCURRENT = parseInt(process.env.EXPORT_MAX_CONCURRENT || '2', 10) || 2;
const activeExportWorkers = new Set();
function makeExportJobId() { return 'EXP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }

function startExportJob(user, payload) {
  if (activeExportWorkers.size >= EXPORT_MAX_CONCURRENT) return { error: 'Export already running — try again shortly', busy: true };
  const jobId = makeExportJobId();
  const exportFile = path.join(EXPORT_DIR, jobId + '.csv');
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  db.run(`INSERT INTO jobs (id,type,status,payload_json,created_by) VALUES (?,'export','running',?,?)`,
    [jobId, JSON.stringify(payload), (user && user.id) || null]);
  const scope = payload.type === 'sms' ? smsScopeWhere(user) : numberScopeWhere(user);
  // scope col from "s.manager_id=?" / "n.manager_id=?" style where
  let scopeCol = null, scopeId = null;
  if (user.role !== 'admin') {
    scopeCol = { manager: 'manager_id', agent: 'agent_id', client: 'client_id' }[user.role];
    scopeId = user.id;
  }
  const wd = { jobId, dbFile: db.getDbFile(), exportFile, payload: { ...payload, scopeCol, scopeId } };
  const w = new Worker(path.join(__dirname, 'exportWorker.js'), { workerData: wd });
  activeExportWorkers.add(jobId);
  w.on('message', (m) => {
    try {
      if (m.type === 'progress') db.run(`UPDATE jobs SET processed=?, progress=CASE WHEN total>0 THEN CAST(?*100/total AS INT) ELSE 0 END WHERE id=?`, [m.rows, m.rows, jobId]);
    } catch (_) {}
  });
  w.on('exit', (code) => {
    activeExportWorkers.delete(jobId);
    try {
      if (code === 0 && fs.existsSync(exportFile)) {
        const st = fs.statSync(exportFile);
        const token = crypto.randomBytes(16).toString('hex');
        const rows = db.get(`SELECT processed FROM jobs WHERE id=?`, [jobId])?.processed || 0;
        db.run(`UPDATE jobs SET status='done', progress=100, completed_at=datetime('now'),
                result_json=? WHERE id=?`,
          [JSON.stringify({ file: exportFile, bytes: st.size, rows, token, expires_at: new Date(Date.now() + EXPORT_TTL_HOURS * 3600e3).toISOString() }), jobId]);
        console.log('[EXPORT] done', { jobId, rows, mb: +(st.size / 1048576).toFixed(1) });
      } else {
        db.run(`UPDATE jobs SET status='failed', error='worker exited unexpectedly', completed_at=datetime('now') WHERE id=?`, [jobId]);
      }
    } catch (e) { console.error('[EXPORT] finalize failed:', e.message); }
  });
  w.on('error', (e) => {
    activeExportWorkers.delete(jobId);
    try { db.run(`UPDATE jobs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?`, [String(e.message || e), jobId]); } catch (_) {}
  });
  w.unref();
  return { job_id: jobId };
}

app.post('/api/exports', authRequired, requireRole('admin', 'manager', 'agent'), (req, res) => {
  const b = req.body || {};
  const type = b.type === 'sms' ? 'sms' : 'numbers';
  const payload = {
    type,
    search: String(b.search || '').slice(0, 30) || '',
    range: String(b.range || '').slice(0, 80) || '',
    allocation: ['unallocated', 'allocated'].includes(b.allocation) ? b.allocation : '',
    from: /^\d{4}-\d{2}-\d{2}/.test(String(b.from || '')) ? String(b.from).slice(0, 10) + ' 00:00:00' : '',
    to: /^\d{4}-\d{2}-\d{2}/.test(String(b.to || '')) ? String(b.to).slice(0, 10) + ' 23:59:59' : '',
  };
  const r = startExportJob(req.user, payload);
  if (r.error) return res.status(429).json(r);
  logAction(req, 'start_export', 'exports', { jobId: r.job_id, type });
  res.json({ ok: true, ...r });
});

app.get('/api/jobs', authRequired, (req, res) => {
  const all = req.user.role === 'admin' && truthy(req.query.all);
  const rows = db.all(`SELECT id,type,status,progress,processed,total,error,created_at,completed_at FROM jobs
    ${all ? '' : 'WHERE created_by=?'} ORDER BY created_at DESC LIMIT 100`, all ? [] : [req.user.id]);
  res.json({ rows });
});

app.get('/api/jobs/:id', authRequired, (req, res) => {
  const job = db.get('SELECT * FROM jobs WHERE id=?', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role !== 'admin' && job.created_by !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (job.result_json) job.result = parseJsonSafe(job.result_json);
  res.json(job);
});

app.get('/api/exports/:id/download', (req, res) => {
  const job = db.get(`SELECT * FROM jobs WHERE id=? AND type='export'`, [req.params.id]);
  if (!job || job.status !== 'done' || !job.result_json) return res.status(404).json({ error: 'Export not found or not ready' });
  // token check happens without auth header (browser download); token = capability URL
  if (String(req.query.token || '') !== String(parseJsonSafe(job.result_json)?.token || '')) return res.status(403).json({ error: 'Invalid download token' });
  const file = parseJsonSafe(job.result_json)?.file;
  if (!file || !fs.existsSync(file)) return res.status(410).json({ error: 'Export file expired' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="powerx-${job.payload_json.includes('sms') ? 'sms' : 'numbers'}-${job.id}.csv"`);
  fs.createReadStream(file).pipe(res);
});

function cleanupExports() {
  try {
    const cutoff = new Date(Date.now() - EXPORT_TTL_HOURS * 3600e3).toISOString();
    const stale = db.all(`SELECT id, result_json FROM jobs WHERE type='export' AND status='done' AND completed_at IS NOT NULL AND completed_at < datetime('now','-${EXPORT_TTL_HOURS} hours')`);
    for (const j of stale) { const f = parseJsonSafe(j.result_json)?.file; if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
    db.run(`DELETE FROM jobs WHERE type='export' AND completed_at IS NOT NULL AND completed_at < datetime('now','-7 days')`);
  } catch (_) {}
}

function cachedJson(req, res, ttlMs, producer, verKey) {
  // _nocache bypass is Admin-only (prevents cache-busting abuse by regular users).
  if (String(req.query._nocache || '') === '1' && req.user && req.user.role === 'admin') return res.json(producer());
  const uid = req.user ? `${req.user.id}:${req.user.role}` : 'anon';
  const ver = verKey ? getMetaVer(verKey) : '';
  const key = verKey ? `${uid}:v${ver}:${req.originalUrl}` : `${uid}:${req.originalUrl}`;
  const now = Date.now();
  const hit = apiReadCache.get(key);
  if (hit && hit.expires > now) return res.json(hit.value);
  const value = producer();
  apiReadCache.set(key, { value, expires: now + Math.max(250, ttlMs || 1000) });
  if (apiReadCache.size > 2000) {
    const cutoff = Date.now();
    for (const [k, v] of apiReadCache) if (v.expires <= cutoff || apiReadCache.size > 1800) apiReadCache.delete(k);
  }
  return res.json(value);
}
function pad2(n){ return String(n).padStart(2,'0'); }
function fmtUtcSql(ms){ const d=new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; }
function ukLocalDateToUtcSql(dateStr, plusDays=0){
  const m=String(dateStr||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return '';
  const base=Date.UTC(+m[1], +m[2]-1, +m[3]+plusDays, 0, 0, 0);
  let off=ukOffsetMinutes(new Date(base));
  let utc=base - off*60000;
  const off2=ukOffsetMinutes(new Date(utc));
  if(off2!==off) utc=base - off2*60000;
  return fmtUtcSql(utc);
}

// Clean URL routes (must be before static so /admin.html can redirect to /admin)
const FRONTEND_ROOT = path.join(__dirname, '..');
function sendFrontendPage(res, file) { res.sendFile(path.join(FRONTEND_ROOT, file)); }
// Main panel login (Admin / Manager / Agent / Client) is served at /panel-login.
// Legacy /login and /login.html are permanently redirected so old bookmarks keep working.
app.get('/', (req, res) => res.redirect(302, '/panel-login'));
app.get('/panel-login', (req, res) => sendFrontendPage(res, 'login.html'));
app.get('/panel-login.html', (req, res) => res.redirect(301, '/panel-login'));
app.get('/login', (req, res) => res.redirect(301, '/panel-login'));
app.get('/login.html', (req, res) => res.redirect(301, '/panel-login'));
app.get('/admin', (req, res) => sendFrontendPage(res, 'admin.html'));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/admin/:page', (req, res) => sendFrontendPage(res, 'admin.html'));
app.get('/panel-sharing-login', (req, res) => sendFrontendPage(res, 'panel-sharing-login.html'));
app.get('/panel-sharing-login.html', (req, res) => res.redirect(301, '/panel-sharing-login'));
app.get('/panel-sharing', (req, res) => sendFrontendPage(res, 'panel-sharing.html'));
app.get('/panel-sharing.html', (req, res) => res.redirect(301, '/panel-sharing'));
app.get('/panel-sharing/:page', (req, res) => sendFrontendPage(res, 'panel-sharing.html'));
app.get('/payment-login', (req, res) => sendFrontendPage(res, 'payment-login.html'));
app.get('/payment-login.html', (req, res) => res.redirect(301, '/payment-login'));
app.get('/payment', (req, res) => sendFrontendPage(res, 'payment.html'));
app.get('/payment.html', (req, res) => res.redirect(301, '/payment'));
app.get('/payment/:page', (req, res) => sendFrontendPage(res, 'payment.html'));
app.get('/management-login', (req, res) => sendFrontendPage(res, 'management-login.html'));
app.get('/management-login.html', (req, res) => res.redirect(301, '/management-login'));
app.get('/management', (req, res) => sendFrontendPage(res, 'management.html'));
app.get('/management.html', (req, res) => res.redirect(301, '/management'));
app.get('/management/:page', (req, res) => sendFrontendPage(res, 'management.html'));
app.get('/manager', (req, res) => sendFrontendPage(res, 'manager.html'));
app.get('/manager.html', (req, res) => res.redirect(301, '/manager'));
app.get('/manager/:page', (req, res) => sendFrontendPage(res, 'manager.html'));
app.get('/agent', (req, res) => sendFrontendPage(res, 'agent.html'));
app.get('/agent.html', (req, res) => res.redirect(301, '/agent'));
app.get('/agent/:page', (req, res) => sendFrontendPage(res, 'agent.html'));
app.get('/client', (req, res) => sendFrontendPage(res, 'client.html'));
app.get('/client.html', (req, res) => res.redirect(301, '/client'));
app.get('/client/:page', (req, res) => sendFrontendPage(res, 'client.html'));
app.get('/test-login', (req, res) => sendFrontendPage(res, 'test-login.html'));
app.get('/test-login.html', (req, res) => res.redirect(301, '/test-login'));
app.get('/test', (req, res) => sendFrontendPage(res, 'test.html'));
app.get('/test.html', (req, res) => res.redirect(301, '/test'));
app.get('/test/:page', (req, res) => sendFrontendPage(res, 'test.html'));

// serve frontend assets and static files from project root
app.use(express.static(FRONTEND_ROOT));


/* ============ PROVIDER SYNC ADMIN API ============
   Panels never call a provider. These endpoints only manage the sync
   service; all SMS data continues to be read from the local database
   through the existing /api/sms* endpoints. */

app.get('/api/sync/providers', authRequired, requireRole('admin'), (req, res) => {
  const rows = providerSync.listProviders().map(p => {
    const cfg = providerSync.parseConfig(p);
    // never leak the token back to the browser
    if (cfg.token) cfg.token = '********';
    return { ...p, config_json: JSON.stringify(cfg) };
  });
  res.json(rows);
});

app.post('/api/sync/providers', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try { JSON.parse(b.config_json || '{}'); }
  catch (e) { return res.status(400).json({ error: 'config_json must be valid JSON' }); }
  try {
    db.run(`INSERT INTO sync_providers (name,connector,config_json,active,interval_seconds,overlap_seconds)
            VALUES (?,?,?,?,?,?)`,
      [String(b.name), String(b.connector || 'generic_json'), String(b.config_json || '{}'),
       b.active ? 1 : 0, Math.max(5, parseInt(b.interval_seconds || 12, 10)),
       Math.max(0, parseInt(b.overlap_seconds || 30, 10))]);
    logAction(req, 'create_sync_provider', 'sync', { name: b.name });
    res.json({ ok: true });
  } catch (e) {
    const msg = /UNIQUE/i.test(String(e.message))
      ? `A provider named "${b.name}" already exists. Use a different name, or edit the existing one.`
      : e.message;
    res.status(409).json({ error: msg });
  }
});

app.put('/api/sync/providers/:id', authRequired, requireRole('admin'), (req, res) => {
  const p = providerSync.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const b = req.body || {};
  // keep the stored token if the UI sent back the masked placeholder
  let cfgJson = b.config_json !== undefined ? String(b.config_json) : p.config_json;
  try {
    const incoming = JSON.parse(cfgJson || '{}');
    if (incoming.token === '********') {
      incoming.token = providerSync.parseConfig(p).token || '';
      cfgJson = JSON.stringify(incoming);
    }
  } catch (e) { return res.status(400).json({ error: 'config_json must be valid JSON' }); }

  db.run(`UPDATE sync_providers SET name=?,connector=?,config_json=?,active=?,interval_seconds=?,overlap_seconds=?,updated_at=datetime('now') WHERE id=?`,
    [b.name || p.name, b.connector || p.connector, cfgJson,
     b.active !== undefined ? (b.active ? 1 : 0) : p.active,
     Math.max(5, parseInt(b.interval_seconds || p.interval_seconds, 10)),
     Math.max(0, parseInt(b.overlap_seconds !== undefined ? b.overlap_seconds : p.overlap_seconds, 10)),
     p.id]);
  logAction(req, 'update_sync_provider', 'sync', { id: p.id, name: b.name || p.name });
  res.json({ ok: true });
});

app.delete('/api/sync/providers/:id', authRequired, requireRole('admin'), (req, res) => {
  const p = providerSync.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  db.run('DELETE FROM sync_providers WHERE id=?', [p.id]);
  db.run('DELETE FROM sync_seen WHERE provider_id=?', [p.id]);
  logAction(req, 'delete_sync_provider', 'sync', { id: p.id, name: p.name });
  res.json({ ok: true });
});

// Run one cycle immediately. ?full=1 ignores the cursor (manual resync).
app.post('/api/sync/providers/:id/run', authRequired, requireRole('admin'), async (req, res) => {
  const p = providerSync.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const full = String(req.query.full || req.body?.full || '') === '1';
  const result = await providerSync.syncProvider(p, {
    log: console, processIncomingSmsPayload, clearApiReadCache,
  }, { full });
  logAction(req, full ? 'manual_full_resync' : 'manual_sync', 'sync', { id: p.id, name: p.name });
  res.json(result);
});

// Reset the dedup ledger + cursor for a provider (forces a clean re-pull).
app.post('/api/sync/providers/:id/reset', authRequired, requireRole('admin'), (req, res) => {
  const p = providerSync.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  db.run('DELETE FROM sync_seen WHERE provider_id=?', [p.id]);
  db.run(`UPDATE sync_providers SET last_sync_at='',last_status='',last_error='',consecutive_failures=0,updated_at=datetime('now') WHERE id=?`, [p.id]);
  logAction(req, 'reset_sync_provider', 'sync', { id: p.id, name: p.name });
  res.json({ ok: true });
});

// Test a provider configuration WITHOUT saving it and WITHOUT importing any
// SMS. Used by the "Test Connection" button in Management -> API Providers.
app.post('/api/sync/test', authRequired, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  let cfg;
  try { cfg = JSON.parse(b.config_json || '{}'); }
  catch (e) { return res.status(400).json({ ok: false, error: 'config_json must be valid JSON' }); }
  if (!cfg.url) return res.status(400).json({ ok: false, error: 'Base URL is required' });

  // If the browser sent the masked placeholder, use the stored key instead so
  // the user can test an existing provider without re-typing its token.
  if (cfg.token === '********') {
    const existing = b.name ? db.get('SELECT * FROM sync_providers WHERE name=?', [String(b.name)]) : null;
    cfg.token = existing ? (providerSync.parseConfig(existing).token || '') : '';
  }

  const connector = providerSync.CONNECTORS[b.connector || 'generic_json'] || providerSync.CONNECTORS.generic_json;
  // Look back one hour so a correctly configured provider returns something.
  const since = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  try {
    const records = await connector(cfg, since, console);
    const s = records[0];
    res.json({
      ok: true,
      fetched: records.length,
      sample: s ? { number: s.number, cli: s.cli, date: s.date, has_message: !!s.message } : null,
    });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/sync/logs', authRequired, requireRole('admin'), (req, res) => {
  const pid = req.query.provider_id;
  const rows = pid
    ? db.all('SELECT * FROM sync_logs WHERE provider_id=? ORDER BY id DESC LIMIT 200', [pid])
    : db.all('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

app.get('/api/sync/status', authRequired, requireRole('admin'), (req, res) => {
  const providers = providerSync.listProviders();
  res.json({
    enabled: String(process.env.SYNC_ENABLED || 'true').toLowerCase() !== 'false',
    scheduler_seconds: Math.max(5, parseInt(process.env.SYNC_INTERVAL_SECONDS || '12', 10)),
    providers: providers.map(p => ({
      id: p.id, name: p.name, connector: p.connector, active: !!p.active,
      interval_seconds: p.interval_seconds, overlap_seconds: p.overlap_seconds,
      last_sync_at: p.last_sync_at, last_status: p.last_status,
      last_error: p.last_error, consecutive_failures: p.consecutive_failures,
      seen_count: (db.get('SELECT COUNT(*) c FROM sync_seen WHERE provider_id=?', [p.id]) || {}).c || 0,
    })),
  });
});

/* ============ SMPP CONNECTIONS (additional channel) ============
 * Admin-only management of SMPP links. This block is entirely separate from
 * the HTTP carrier webhook (/api/incoming-sms) and the HTTP provider pull
 * (/api/sync/*). Neither of those reads anything written here.
 */
const SMPP_EDITABLE = [
  'name','mode','active','host','port','system_id','password','system_type','bind_type',
  'address_range','use_tls','listen_port','allowed_ips','enquire_link_seconds',
  'reconnect_seconds','max_reconnect_seconds','connect_timeout_ms','default_source_addr','notes',
];

function smppSanitize(body, forUpdate) {
  const out = {};
  for (const k of SMPP_EDITABLE) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (['active','use_tls'].includes(k)) v = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
    else if (['port','listen_port','enquire_link_seconds','reconnect_seconds','max_reconnect_seconds','connect_timeout_ms'].includes(k)) {
      v = parseInt(v, 10); if (isNaN(v)) continue;
    } else v = String(v == null ? '' : v).trim();
    out[k] = v;
  }
  if (out.mode && !['client','server'].includes(out.mode)) return { error: "mode must be 'client' or 'server'" };
  if (out.bind_type && !['transceiver','receiver','transmitter'].includes(out.bind_type)) return { error: 'invalid bind_type' };
  if (!forUpdate) {
    if (!out.name) return { error: 'name is required' };
    if (!out.mode) out.mode = 'client';
  }
  if (out.mode === 'client' && !forUpdate && !out.host) return { error: 'host is required for client mode' };
  if (out.mode === 'server' && !forUpdate && !out.listen_port) return { error: 'listen_port is required for server mode' };
  if (out.listen_port !== undefined && out.listen_port !== 0) {
    const appPort = parseInt(process.env.PORT || '4000', 10);
    if (out.listen_port === appPort) return { error: `listen_port ${appPort} is already used by the web panel` };
    if (out.listen_port < 1 || out.listen_port > 65535) return { error: 'listen_port must be 1-65535' };
  }
  return { fields: out };
}

// Never send the SMPP password back to the browser.
function smppPublic(row) {
  if (!row) return row;
  const { password, ...rest } = row;
  return { ...rest, has_password: !!password };
}

app.get('/api/smpp/connections', authRequired, requireRole('admin'), (req, res) => {
  res.json(smppService.listConnections().map(smppPublic));
});

app.post('/api/smpp/connections', authRequired, requireRole('admin'), (req, res) => {
  const s = smppSanitize(req.body || {}, false);
  if (s.error) return res.status(400).json({ error: s.error });
  const f = s.fields;
  if (db.get('SELECT id FROM smpp_connections WHERE name=? COLLATE NOCASE', [f.name]))
    return res.status(409).json({ error: 'A connection with this name already exists' });
  const keys = Object.keys(f);
  db.run(`INSERT INTO smpp_connections (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => f[k]));
  const row = db.get('SELECT * FROM smpp_connections WHERE name=?', [f.name]);
  logAction(req, 'smpp_create', 'smpp_connections', { id: row.id, name: row.name, mode: row.mode });
  if (row.active) { try { smppService.startConnection(row.id); } catch (e) { /* reported via status */ } }
  res.json({ ok: true, connection: smppPublic(db.get('SELECT * FROM smpp_connections WHERE id=?', [row.id])) });
});

app.put('/api/smpp/connections/:id', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  const existing = smppService.getConnection(id);
  if (!existing) return res.status(404).json({ error: 'Connection not found' });
  const s = smppSanitize(req.body || {}, true);
  if (s.error) return res.status(400).json({ error: s.error });
  const f = s.fields;
  // An empty password field means "keep the stored one" so the operator can
  // edit other settings without re-typing the credential.
  if (f.password === '') delete f.password;
  if (f.name && f.name.toLowerCase() !== String(existing.name).toLowerCase()
      && db.get('SELECT id FROM smpp_connections WHERE name=? COLLATE NOCASE', [f.name]))
    return res.status(409).json({ error: 'A connection with this name already exists' });
  const keys = Object.keys(f);
  if (keys.length) {
    db.run(`UPDATE smpp_connections SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`, [...keys.map(k => f[k]), id]);
  }
  logAction(req, 'smpp_update', 'smpp_connections', { id, fields: keys.filter(k => k !== 'password') });
  const after = smppService.getConnection(id);
  try {
    if (after.active) smppService.restartConnection(id);   // apply new settings immediately
    else smppService.stopConnection(id);
  } catch (e) { /* reported via status */ }
  res.json({ ok: true, connection: smppPublic(smppService.getConnection(id)) });
});

app.delete('/api/smpp/connections/:id', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  const row = smppService.getConnection(id);
  if (!row) return res.status(404).json({ error: 'Connection not found' });
  try { smppService.stopConnection(id); } catch (_) {}
  db.run('DELETE FROM smpp_connections WHERE id=?', [id]);
  db.run('DELETE FROM smpp_seen WHERE connection_id=?', [id]);
  db.run('DELETE FROM smpp_outbox WHERE connection_id=?', [id]);
  logAction(req, 'smpp_delete', 'smpp_connections', { id, name: row.name });
  res.json({ ok: true });
});

app.post('/api/smpp/connections/:id/start', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  if (!smppService.getConnection(id)) return res.status(404).json({ error: 'Connection not found' });
  db.run('UPDATE smpp_connections SET active=1 WHERE id=?', [id]);
  let r; try { r = smppService.startConnection(id); } catch (e) { r = { ok: false, error: e.message }; }
  logAction(req, 'smpp_start', 'smpp_connections', { id });
  res.json({ ...r, status: smppService.statusOf(id) });
});

app.post('/api/smpp/connections/:id/stop', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  if (!smppService.getConnection(id)) return res.status(404).json({ error: 'Connection not found' });
  db.run('UPDATE smpp_connections SET active=0 WHERE id=?', [id]);
  let r; try { r = smppService.stopConnection(id); } catch (e) { r = { ok: false, error: e.message }; }
  logAction(req, 'smpp_stop', 'smpp_connections', { id });
  res.json({ ...r, status: smppService.statusOf(id) });
});

app.post('/api/smpp/connections/:id/restart', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  if (!smppService.getConnection(id)) return res.status(404).json({ error: 'Connection not found' });
  let r; try { r = smppService.restartConnection(id); } catch (e) { r = { ok: false, error: e.message }; }
  logAction(req, 'smpp_restart', 'smpp_connections', { id });
  res.json({ ...r, status: smppService.statusOf(id) });
});

// Connectivity probe: does the host/port answer at all? Runs before a bind so
// the operator can tell "wrong address" apart from "wrong credentials".
app.post('/api/smpp/connections/:id/test', authRequired, requireRole('admin'), async (req, res) => {
  const conn = smppService.getConnection(+req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (!smppService.isLibraryAvailable())
    return res.json({ ok: false, error: 'SMPP library not installed: ' + smppService.libraryError() });
  if (String(conn.mode) === 'server') {
    const st = smppService.statusOf(conn.id);
    return res.json({ ok: st.status === 'listening' || st.status === 'bound', mode: 'server', status: st.status,
      note: st.status === 'listening' ? `Listening on port ${conn.listen_port}. Waiting for the carrier to bind.` : (conn.last_error || 'Not listening — start the connection first.') });
  }
  const net = require('net');
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(r); };
    sock.setTimeout(Math.min(15000, Math.max(1000, conn.connect_timeout_ms || 15000)));
    sock.on('connect', () => finish({ ok: true, message: `TCP reachable in ${Date.now() - started} ms` }));
    sock.on('timeout', () => finish({ ok: false, error: 'connection timed out — check host/port and firewall' }));
    sock.on('error', (e) => finish({ ok: false, error: e.code === 'ECONNREFUSED' ? 'connection refused — nothing is listening on that port' : e.message }));
    try { sock.connect(conn.port || 2775, conn.host); } catch (e) { finish({ ok: false, error: e.message }); }
  });
  res.json({ ...result, mode: 'client', host: conn.host, port: conn.port, current_status: (smppService.statusOf(conn.id) || {}).status });
});

app.get('/api/smpp/status', authRequired, requireRole('admin'), (req, res) => {
  const conns = smppService.listConnections();
  res.json({
    library_available: smppService.isLibraryAvailable(),
    library_error: smppService.libraryError(),
    enabled: String(process.env.SMPP_ENABLED || 'true').toLowerCase() !== 'false',
    connections: conns.map(c => smppService.statusOf(c.id)).filter(Boolean),
  });
});

app.get('/api/smpp/logs', authRequired, requireRole('admin'), (req, res) => {
  const cid = req.query.connection_id;
  const rows = cid
    ? db.all('SELECT * FROM smpp_logs WHERE connection_id=? ORDER BY id DESC LIMIT 200', [cid])
    : db.all('SELECT * FROM smpp_logs ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

// Outbound send (submit_sm). Queued first, so nothing is lost if the link is down.
app.post('/api/smpp/connections/:id/send', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  const conn = smppService.getConnection(id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (String(conn.bind_type) === 'receiver' && String(conn.mode) === 'client')
    return res.status(400).json({ error: 'This connection is bound as receiver only — it cannot send' });
  try {
    const { destination, message, source_addr } = req.body || {};
    const r = smppService.queueOutbound(id, destination, message, source_addr, req.user.id);
    logAction(req, 'smpp_send', 'smpp_outbox', { connection_id: id, destination });
    res.json({ ...r, status: smppService.statusOf(id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/smpp/outbox', authRequired, requireRole('admin'), (req, res) => {
  const cid = req.query.connection_id;
  const rows = cid
    ? db.all('SELECT * FROM smpp_outbox WHERE connection_id=? ORDER BY id DESC LIMIT 200', [cid])
    : db.all('SELECT * FROM smpp_outbox ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'Galaxy SMS', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => {
  let dbSize = 0, walSize = 0;
  try {
    const st = fs.statSync(db.getDbFile()); dbSize = st.size;
    walSize = (fs.statSync(db.getDbFile() + '-wal') || {}).size || 0;
  } catch (_) {}
  const mem = process.memoryUsage();
  res.json({
    ok: true, service: 'Galaxy SMS', time: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    rss_mb: +(mem.rss / 1048576).toFixed(1),
    heap_mb: +(mem.heapUsed / 1048576).toFixed(1),
    event_loop: eventLoopStats(),
    slow_queries: db.slowQueryStats ? db.slowQueryStats() : null,
    db_size_mb: +(dbSize / 1048576).toFixed(1),
    wal_size_mb: +(walSize / 1048576).toFixed(1),
    cache_entries: apiReadCache.size,
    numbers_ver: getMetaVer('numbers_ver'),
  });
});
app.post('/api/admin/analyze', authRequired, requireRole('admin'), (req, res) => {
  const ok = db.runAnalyze();
  logAction(req, 'run_analyze', 'database', { ok });
  res.json({ ok });
});
// PHASE-3: FTS index status (additive, admin-only)
app.get('/api/admin/fts-status', authRequired, requireRole('admin'), (req, res) => res.json(smsFts.status(db)));
app.get('/api/admin/backfill-stats', authRequired, requireRole('admin'), (req, res) => res.json(backfillStatus()));
app.post('/api/admin/backfill-stats', authRequired, requireRole('admin'), async (req, res) => {
  if (truthy((req.body || {}).reset)) {
    try { db.runNoSave('DELETE FROM sms_daily_stats'); } catch (_) {}
    setMeta('stats_backfill_max_id', '0'); setMeta('stats_backfill_done', '0');
  }
  res.json(await backfillSmsStats(req.user));
});

/* =========================================================================
 * PHASE-1 Step 7: retention (chunked, event-loop friendly; env-controlled)
 *   HISTORY_RETENTION_DAYS    number_history   (default 90)
 *   FAILED_SMS_RETENTION_DAYS failed_sms_queue  (default 7)
 *   SMS_RETENTION_DAYS        sms_records       (default 0 = NEVER auto-delete)
 * ========================================================================= */
async function chunkDelete(table, whereSql, params = []) {
  let total = 0;
  for (;;) {
    const info = db.runNoSave(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${whereSql} LIMIT 20000)`, params);
    total += info.changes || 0;
    if ((info.changes || 0) < 20000) break;
    await new Promise(r => setImmediate(r));
  }
  return total;
}
let retentionRunning = false;
async function runRetentionSweep() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const histDays = parseInt(process.env.HISTORY_RETENTION_DAYS || '90', 10) || 90;
    const n1 = await chunkDelete('number_history', `created_at IS NOT NULL AND created_at <> '' AND created_at < datetime('now', '-${histDays} days')`);
    const failDays = parseInt(process.env.FAILED_SMS_RETENTION_DAYS || '7', 10) || 7;
    const n2 = await chunkDelete('failed_sms_queue', `created_at IS NOT NULL AND created_at <> '' AND created_at < datetime('now', '-${failDays} days')`);
    const n3 = await chunkDelete('idempotency_keys', `expires_at IS NOT NULL AND expires_at < datetime('now')`);
    let n4 = 0;
    const smsDays = parseInt(process.env.SMS_RETENTION_DAYS || '0', 10) || 0;
    if (smsDays > 0) n4 = await chunkDelete('sms_records', `received_at IS NOT NULL AND received_at <> '' AND received_at < datetime('now', '-${smsDays} days')`);
    if (n1 || n2 || n3 || n4) console.log(`[RETENTION] history=${n1} failed_queue=${n2} idempotency=${n3} sms=${n4}`);
    cleanupExports();
  } catch (e) { console.warn('[RETENTION] sweep failed:', e.message); }
  finally { retentionRunning = false; }
}
setTimeout(() => { runRetentionSweep(); }, 90 * 1000);
setInterval(() => { runRetentionSweep(); }, 24 * 60 * 60 * 1000);
// Auto backfill (one-time) shortly after boot so dashboards never scan sms_records.
setTimeout(() => {
  try {
    if (getMetaVer('stats_backfill_done') !== 1) {
      const c = db.get('SELECT COUNT(*) c FROM sms_records')?.c || 0;
      if (c > 0) backfillSmsStats(null).then(r => console.log('[BACKFILL] auto:', JSON.stringify(r))).catch(() => {});
    }
  } catch (_) {}
}, 8000).unref();
if (!process.env.JWT_SECRET) console.warn('[SECURITY] JWT_SECRET env var is NOT set — using the default development secret. Set a strong JWT_SECRET in .env before going live!');

/* ============ helpers ============ */
function ukOffsetMinutes(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch (_) { return 0; }
}
function ukSqlModifier() {
  const off = ukOffsetMinutes();
  return off >= 0 ? `+${off} minutes` : `${off} minutes`;
}
function ukDateExpr(column) { return `date(${column}, '${ukSqlModifier()}')`; }
function ukDateNowSql(extra = '') { return `date('now','${ukSqlModifier()}'${extra ? `, '${extra}'` : ''})`; }
function ukDateTimeExpr(column) { return `datetime(${column}, '${ukSqlModifier()}')`; }

/* ------------------------------------------------------------------ *
 * Indexable UK-day range helpers
 *
 * PERFORMANCE ONLY — these produce EXACTLY the same result set as the
 * date()/strftime() forms above, but in a shape SQLite can serve from an
 * index.
 *
 * Why: `date(received_at,'+60 minutes') = date('now','+60 minutes')` applies a
 * function to the column, so the index on received_at cannot be used and
 * SQLite falls back to a full SCAN. Measured on 600k rows: 75-194 ms per
 * query, and /api/dashboard runs ~14 of them = ~2 s per load.
 *
 * The same condition expressed as a half-open UTC range
 * (`received_at >= start AND received_at < end`) is an indexed range SEARCH.
 *
 * Correctness: ukLocalDateToUtcSql() already converts a UK calendar date to
 * the exact UTC instant that day begins, and it is DST-aware (it re-checks the
 * offset after shifting). The end bound is the start of the NEXT UK day, so
 * the window is identical to what date() matched — verified against the old
 * form across DST boundaries.
 * ------------------------------------------------------------------ */
function ukTodayDateStr(offsetDays = 0) {
  const p = ukParts(new Date());
  const base = Date.UTC(+p.year, +p.month - 1, +p.day + offsetDays);
  const d = new Date(base);
  const q = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${q(d.getUTCMonth() + 1)}-${q(d.getUTCDate())}`;
}
/** WHERE fragment: column falls inside the UK day `dateStr` (spanning `days` days). */
function ukDayRangeSql(column, dateStr, days = 1) {
  const start = ukLocalDateToUtcSql(dateStr, 0);
  const end = ukLocalDateToUtcSql(dateStr, days);
  return `${column} >= '${start}' AND ${column} < '${end}'`;
}
/** WHERE fragment: column is on the UK day that is `offsetDays` from today. */
function ukDayOffsetSql(column, offsetDays = 0) {
  return ukDayRangeSql(column, ukTodayDateStr(offsetDays), 1);
}
/**
 * WHERE fragment: column is within the last `n` UK days, including today.
 *
 * NOTE: the original SQL was `date(col) >= date('now','-6 days')` — a
 * lower bound only, with NO upper bound. Rows dated in the future (e.g. a
 * provider sending a timestamp later today, or clock skew) were therefore
 * counted. Only the lower bound is emitted here so the result stays exactly
 * the same, including those future-dated rows.
 */
function ukLastDaysSql(column, n) {
  const start = ukLocalDateToUtcSql(ukTodayDateStr(-(n - 1)), 0);
  return `${column} >= '${start}'`;
}
/**
 * WHERE fragment: column is inside the current UK calendar month.
 * Mirrors `strftime('%Y-%m', datetime(col)) = strftime('%Y-%m','now')`, which
 * is bounded on both sides, so both bounds are kept here.
 */
function ukThisMonthSql(column) {
  const p = ukParts(new Date());
  const first = `${p.year}-${p.month}-01`;
  const start = ukLocalDateToUtcSql(first, 0);
  const nextMonth = new Date(Date.UTC(+p.year, +p.month, 1));
  const q = n => String(n).padStart(2, '0');
  const firstNext = `${nextMonth.getUTCFullYear()}-${q(nextMonth.getUTCMonth() + 1)}-01`;
  const end = ukLocalDateToUtcSql(firstNext, 0);
  return `${column} >= '${start}' AND ${column} < '${end}'`;
}

function scopeIds(user) {
  // admin sees everyone; others see their downstream hierarchy
  if (user.role === 'admin') return db.all('SELECT id FROM users').map(r => r.id);
  return descendantIds(user.id);
}
function maskCli(cli) {
  if (!cli) return '';
  if (cli.length <= 2) return cli;
  return cli.slice(0, 2) + 'x'.repeat(cli.length - 2);
}

function safeJson(v){ try{return JSON.stringify(v||{});}catch(e){return '{}';} }

function normalizeDecimalString(input){
  let s=String(input ?? '').trim().replace(/[$,\s]/g,'');
  if(!s || s.toUpperCase()==='NA') return '';
  const m=s.match(/-?\d+(?:\.\d+)?/);
  if(!m) return '';
  s=m[0];
  if(!s.includes('.')) return String(BigInt(s));
  let [a,b]=s.split('.'); b=(b||'').replace(/0+$/,'');
  a=String(BigInt(a||'0'));
  return b ? `${a}.${b}` : a;
}
function isPositiveDecimal(s){
  s=normalizeDecimalString(s);
  if(!s) return false;
  return BigInt(s.replace('.','').replace('-','')) !== 0n && !s.startsWith('-');
}
function decimalAdd(a,b){
  a=normalizeDecimalString(a)||'0'; b=normalizeDecimalString(b)||'0';
  const [ai,af='']=a.split('.'); const [bi,bf='']=b.split('.');
  const scale=Math.max(af.length,bf.length);
  const av=BigInt(ai+af.padEnd(scale,'0'));
  const bv=BigInt(bi+bf.padEnd(scale,'0'));
  let sum=(av+bv).toString();
  const neg=sum.startsWith('-'); if(neg) sum=sum.slice(1);
  if(scale===0) return (neg?'-':'')+sum;
  sum=sum.padStart(scale+1,'0');
  let out=sum.slice(0,-scale)+'.'+sum.slice(-scale);
  out=out.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
  return (neg?'-':'')+out;
}
function decimalMulInt(a,n){
  let total='0'; n=Number(n)||0;
  for(let i=0;i<n;i++) total=decimalAdd(total,a);
  return total;
}
function payoutRateFromRow(r){
  // sms_records payout snapshot must be final, including explicit zero from limits/external payout.
  if (r && Object.prototype.hasOwnProperty.call(r, 'payout_amount')) {
    const v = normalizeDecimalString(r.payout_amount);
    if (v !== '') return v;
  }
  if (r && Object.prototype.hasOwnProperty.call(r, 'payout_rate')) {
    const v = normalizeDecimalString(r.payout_rate);
    if (v !== '') return v;
  }
  const assignedType = normalizePaymentCycle(r.payterm || r.payment_type || 'weekly_7_1');
  const typed = payoutRateForPaymentCycle(r, assignedType);
  if(isPositiveDecimal(typed)) return typed;
  const candidates=[r.sms_payout_rate,r.number_payout,r.number_rate,r.rate_30_45,r.rate_7_1,r.rate_7_7,r.rate_1_1];
  for(const c of candidates){ const v=normalizeDecimalString(c); if(isPositiveDecimal(v)) return v; }
  return '0';
}
function attachSmsPayoutFields(rows){
  return (rows||[]).map(r=>{ const rate=payoutRateFromRow(r); return {...r,payout_rate:rate,payout_amount:rate}; });
}
function sumPayout(rows){ return (rows||[]).reduce((s,r)=>decimalAdd(s,r.payout_amount ?? r.payout_rate ?? payoutRateFromRow(r)), '0'); }
/**
 * Rows for the caller's scope.
 *
 * SAFETY CAP: this used to return EVERY matching SMS row with no LIMIT. On a
 * production database (150k rows) that is a 6-way JOIN materialising 150,000
 * objects into JS memory and serialising a ~96 MB JSON response - measured at
 * 5.7 SECONDS of fully blocked event loop for a single request, plus ~400 MB of
 * heap. One agent opening a report was enough to freeze the whole server for
 * every other user, and repeated clicks pushed Node to an OOM/100% CPU stall.
 *
 * Every screen that needs real paging already uses /api/sms/paged (server-side
 * LIMIT/OFFSET). This legacy endpoint only feeds summary widgets, so a bounded
 * newest-first window gives identical visible results without the meltdown.
 */
const SMS_SCOPE_ROW_CAP = Math.max(1, parseInt(process.env.SMS_SCOPE_ROW_CAP || '5000', 10));
function smsRowsForScope(user, extraWhere='', extraParams=[], opts={}){
  const scope=smsScopeWhere(user,'s');
  // Normal SMS/report/earning modules should not mix Test Panel OTPs.
  // Test Panel data is served separately by /api/test-panel/sms.
  const where=[scope.where, 'COALESCE(s.is_test,0)=0']; const params=[...scope.params];
  if(extraWhere){ where.push(extraWhere); params.push(...extraParams); }
  const cap = Math.max(1, parseInt(opts.limit || SMS_SCOPE_ROW_CAP, 10));
  const rows=db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
      n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
      cu.username AS client_name, COALESCE(su.panel_name, au.username) AS agent_name, au.username AS agent_username, su.panel_name AS sharing_panel_name, su.id AS sharing_user_id, mu.username AS manager_name
    FROM sms_records s
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN sharing_users su ON su.agent_user_id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE ${where.join(' AND ')} ORDER BY s.received_at DESC LIMIT ?`, [...params, cap]);
  return attachSmsPayoutFields(rows);
}
function logAction(req, action, module, details=''){
  try{
    const u=req.user||{};
    db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)',
      [u.id||null,u.username||'',u.role||'',action,module,typeof details==='string'?details:safeJson(details),req.ip||'']);
  }catch(e){ console.warn('audit log failed', e.message); }
}
function logNumberHistory(req, numberRow, action, fromOwner='', toOwner='', details=''){
  try{
    db.run('INSERT INTO number_history (number_id,number,action,from_owner,to_owner,details,user_id) VALUES (?,?,?,?,?,?,?)',
      [numberRow?.id||null,numberRow?.number||'',action,fromOwner||'',toOwner||'',typeof details==='string'?details:safeJson(details),(req.user||{}).id||null]);
  }catch(e){ console.warn('number history failed', e.message); }
}
function logWebhook(status, payload, number='', matched='', cli='', message='', error='', sourceIp=''){
  try{ db.run('INSERT INTO webhook_logs (status,number,matched_number,cli,message,raw_payload,error,source_ip) VALUES (?,?,?,?,?,?,?,?)',
    [status, String(number||''), String(matched||''), String(cli||''), String(message||''), safeJson(payload), String(error||''), String(sourceIp||'')]); }
  catch(e){ console.warn('webhook log failed', e.message); }
}
function addFailedSms(payload, number='', cli='', message='', error=''){
  try{ db.run('INSERT INTO failed_sms_queue (number,cli,message,raw_payload,error) VALUES (?,?,?,?,?)',
    [String(number||''),String(cli||''),String(message||''),safeJson(payload),String(error||'')]); }
  catch(e){ console.warn('failed sms queue failed', e.message); }
}

/* ============ AUTH ============ */
app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username/password required' });
  const u = db.get('SELECT * FROM users WHERE username=? COLLATE NOCASE', [String(username).trim()]);
  if (!u) return res.status(401).json({ error: 'Invalid username or password' });
  if (!u.active) return res.status(403).json({ error: 'Account is disabled' });
  if (!bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = sign(u);
  try{ db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)',[u.id,u.username,u.role,'login','auth','Successful login',req.ip||'']); }catch(e){}
  res.json({ token, user: { id: u.id, username: u.username, role: u.role, name: u.name } });
});

app.get('/api/me', authRequired, (req, res) => {
  const u = db.get('SELECT id,username,role,name,email,whatsapp FROM users WHERE id=?', [req.user.id]);
  res.json(u);
});

/* ============ USERS (managers/agents/clients) ============ */
// list users of a role within caller's scope
app.get('/api/users/:role', authRequired, (req, res) => {
  const role = req.params.role; // manager|agent|client
  const ids = scopeIds(req.user);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  // for role list we want users of that role whose id is in scope (excluding self)
  const rows = db.all(
    `SELECT id,username,name,email,whatsapp,contact,skype,active,parent_id,payment_type
     FROM users WHERE role=? AND id IN (${ph}) AND id<>? ORDER BY id DESC`,
    [role, ...ids, req.user.id]
  );
  res.json(rows);
});

// create user (admin->manager, manager->agent, agent->client)
app.post('/api/users', authRequired, (req, res) => {
  const { username, password, role, name, email, whatsapp, contact, skype, active, payment_type } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });

  // permission: Admin can create Manager/Agent/Client. Manager can create Agent/Client. Agent can create Client.
  const allowed = {
    admin: ['manager','agent','client'],
    manager: ['agent','client'],
    agent: ['client']
  };
  if (!(allowed[req.user.role] || []).includes(role))
    return res.status(403).json({ error: `You are not allowed to create this role` });

  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return res.status(400).json({ error: 'username required' });
  const exists = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [cleanUsername]);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  let parentId = req.body && req.body.parent_id ? parseInt(req.body.parent_id, 10) : req.user.id;
  if (!Number.isFinite(parentId) || parentId <= 0) parentId = req.user.id;
  // If a parent is provided, it must be in caller scope unless caller is admin.
  if (parentId !== req.user.id && req.user.role !== 'admin') {
    const ids = scopeIds(req.user);
    if (!ids.includes(parentId)) return res.status(403).json({ error: 'Invalid parent user' });
  }

  db.run(
    `INSERT INTO users (username,password,role,name,email,whatsapp,contact,skype,parent_id,active,payment_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cleanUsername, bcrypt.hashSync(String(password), 10), role, name || '', email || '',
     whatsapp || '', contact || '', skype || '', parentId, active === false ? 0 : 1, role==='agent'?normalizePaymentCycle(payment_type||'weekly_7_1'):'weekly_7_1']
  );
  logAction(req,'create_user','users',{username,role});
  res.json({ ok: true });
});

// update user
app.put('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id)) return res.status(403).json({ error: 'Not your user' });
  const { name, email, whatsapp, contact, skype, active, password, payment_type } = req.body || {};
  db.run(
    `UPDATE users SET name=?,email=?,whatsapp=?,contact=?,skype=?,active=?,payment_type=CASE WHEN role='agent' THEN ? ELSE payment_type END WHERE id=?`,
    [name || '', email || '', whatsapp || '', contact || '', skype || '', active ? 1 : 0, normalizePaymentCycle(payment_type||'weekly_7_1'), id]
  );
  if (password) db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(password, 10), id]);
  logAction(req,'update_user','users',{id});
  res.json({ ok: true });
});

// delete user
app.delete('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id) || id === req.user.id) return res.status(403).json({ error: 'Not allowed' });
  db.run('DELETE FROM users WHERE id=?', [id]);
  logAction(req,'delete_user','users',{id});
  res.json({ ok: true });
});



/* ============ PAYMENT V2 HELPERS ============ */
const PAYMENT_TYPES = ['daily','weekly','monthly_30x45'];
function normalizePaymentType(v){
  const s=String(v||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  if(['daily','day','1_1'].includes(s)) return 'daily';
  if(['monthly','month','30x45','monthly_30x45','30_45'].includes(s)) return 'monthly_30x45';
  return 'weekly';
}
function normalizePaymentCycle(v){
  const s=String(v||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  if(['daily','day','1_1'].includes(s)) return 'daily';
  if(['weekly_7_7','week_7_7','7_7','weekly7'].includes(s)) return 'weekly_7_7';
  if(['monthly','month','30x45','monthly_30x45','30_45'].includes(s)) return 'monthly_30x45';
  return 'weekly_7_1';
}
function paymentTypeLabel(t){ return ({daily:'Daily',weekly:'Weekly',weekly_7_1:'Weekly (7/1)',weekly_7_7:'Weekly (7/7)',monthly_30x45:'Monthly (30x45)'})[t] || ({daily:'Daily',weekly:'Weekly',monthly_30x45:'Monthly (30x45)'})[normalizePaymentType(t)] || 'Weekly'; }
/* P12 PAYMENT FIX: per-allocation cycle is the law.
   Priority: 1) numbers.payterm (set on THIS allocation) 2) users.payment_type (agent DEFAULT only)
   3) ranges.payment_type (rate-card fallback) 4) weekly_7_1.
   Previous order (recorded for rollback): users.payment_type || n.payterm || range.payment_type || weekly_7_1 —
   agent-level default used to override the allocation and every allocation overwrote the agent default. */
function assignedPaymentCycleForNumber(n, rangeRow={}){ const u=n?.agent_id?db.get('SELECT payment_type FROM users WHERE id=?',[n.agent_id]):null; return normalizePaymentCycle(n?.payterm || u?.payment_type || rangeRow?.payment_type || 'weekly_7_1'); }
function assignedPaymentTypeForNumber(n, rangeRow={}){ return normalizePaymentType(assignedPaymentCycleForNumber(n, rangeRow)); }
function payoutRateForPaymentCycle(row, cycle){
  cycle=normalizePaymentCycle(cycle);
  const candidates = cycle==='daily' ? [row.rate_1_1,row.number_rate,row.rate_7_1,row.rate_30_45] : (cycle==='weekly_7_7' ? [row.rate_7_7,row.rate_7_1,row.number_rate,row.rate_30_45,row.rate_1_1] : (cycle==='monthly_30x45' ? [row.rate_30_45,row.number_rate,row.rate_7_1,row.rate_1_1] : [row.rate_7_1,row.rate_7_7,row.number_rate,row.rate_30_45,row.rate_1_1]));
  for(const c of candidates){ const v=normalizeDecimalString(c); if(isPositiveDecimal(v)) return v; }
  return '0';
}
function payoutRateForPaymentType(row, type){ return payoutRateForPaymentCycle(row, type); }
function cents(v){ return Math.round((parseFloat(normalizeDecimalString(v)||'0')||0)*100); }
function moneyFromCents(c){ return (Math.max(0, Math.round(c||0))/100).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1'); }
function ukParts(date=new Date()){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(date).reduce((a,p)=>(a[p.type]=p.value,a),{});
}
function utcMsFromUkDate(dateStr, plusDays=0){
  const m=String(dateStr||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m)return Date.now();
  const base=Date.UTC(+m[1],+m[2]-1,+m[3]+plusDays,0,0,0);
  let off=ukOffsetMinutes(new Date(base)); let out=base-off*60000; const off2=ukOffsetMinutes(new Date(out)); if(off2!==off)out=base-off2*60000; return out;
}
function utcSqlFromMs(ms){ const d=new Date(ms); const p=n=>String(n).padStart(2,'0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }
function ukDateFromDb(ts){ return ukDateExprValue(ts); }
function ukDateExprValue(ts){
  const d = dbDateToDate(ts); if(!d)return '';
  const p=ukParts(d); return `${p.year}-${p.month}-${p.day}`;
}
function dbDateToDate(ts){
  const m=String(ts||'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!m)return null; return new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0)));
}
function paymentCycleInfo(type, earnedAt){
  type=normalizePaymentType(type); const d=dbDateToDate(earnedAt)||new Date(); const uk=ukParts(d); const date=`${uk.year}-${uk.month}-${uk.day}`;
  if(type==='daily') return {cycle_key:date, eligible_at:utcSqlFromMs(utcMsFromUkDate(date,1))};
  const startMs=utcMsFromUkDate(date,0); const weekdayMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}; const dow=weekdayMap[uk.weekday] ?? 0; const daysSinceTue=(dow-2+7)%7;
  if(type==='weekly'){
    const start=new Date(startMs-daysSinceTue*86400000); const key=utcSqlFromMs(start.getTime()).slice(0,10); return {cycle_key:key, eligible_at:utcSqlFromMs(start.getTime()+7*86400000)};
  }
  // 30-day work cycle anchored at Unix epoch in UK-date days; eligible after 30+45 days.
  const dayNo=Math.floor(utcMsFromUkDate(date,0)/86400000); const cycleStartDay=dayNo-(dayNo%30); const startDate=utcSqlFromMs(cycleStartDay*86400000).slice(0,10); return {cycle_key:startDate, eligible_at:utcSqlFromMs((cycleStartDay+75)*86400000)};
}
function walletValid(v){ return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(v||'').trim()); }
function agentManagerId(agentId){ return db.get("SELECT parent_id FROM users WHERE id=? AND role='agent'",[agentId])?.parent_id || null; }
function recordPaymentLedgerForSms(smsId, persist=true){
  const srow=db.get(`SELECT s.id,s.agent_id,s.manager_id,s.range_id,s.payout_amount,s.received_at,COALESCE(NULLIF(s.payment_type,''), r.payment_type) AS payment_type FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id WHERE s.id=?`,[smsId]);
  if(!srow || !srow.agent_id || cents(srow.payout_amount)<=0) return;
  if(db.get('SELECT id FROM payment_ledger WHERE sms_record_id=?',[smsId])) return;
  const type=normalizePaymentType(srow.payment_type||'weekly'); const cyc=paymentCycleInfo(type,srow.received_at);
  db.runNoSave(`INSERT INTO payment_ledger (sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,'open')`, [srow.id,srow.agent_id,srow.manager_id||agentManagerId(srow.agent_id),srow.range_id,type,normalizeDecimalString(srow.payout_amount)||'0',srow.received_at,cyc.cycle_key,cyc.eligible_at]);
  db.runNoSave('UPDATE sms_records SET payment_type=? WHERE id=?',[type,smsId]);
  if(persist) db.save();
}
function backfillPaymentLedger(){
  const rows=db.all(`SELECT s.id FROM sms_records s LEFT JOIN payment_ledger l ON l.sms_record_id=s.id WHERE l.id IS NULL AND COALESCE(s.is_test,0)=0 AND s.agent_id IS NOT NULL AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)>0 ORDER BY s.id ASC LIMIT 5000`);
  rows.forEach(r=>{ try{recordPaymentLedgerForSms(r.id, false)}catch(e){} });
  if(rows.length) db.save();
  if(rows.length) console.log('• Payment ledger backfilled:', rows.length);
}
function paymentOpenBalance(agentId,type,eligibleOnly=true){
  const now=utcSqlFromMs(Date.now()); const params=[agentId,normalizePaymentType(type),'open']; let where='agent_id=? AND payment_type=? AND status=?';
  if(eligibleOnly){ where+=' AND eligible_at<=?'; params.push(now); }
  return moneyFromCents(db.all(`SELECT amount FROM payment_ledger WHERE ${where}`,params).reduce((a,r)=>a+cents(r.amount),0));
}
function paymentPendingAmount(agentId,type){ return moneyFromCents(db.all(`SELECT amount FROM payment_requests_v2 WHERE agent_id=? AND payment_type=? AND status='Pending'`,[agentId,normalizePaymentType(type)]).reduce((a,r)=>a+cents(r.amount),0)); }
function paymentMinimum(type){ return normalizeDecimalString(db.get('SELECT min_withdrawal FROM payment_v2_settings WHERE payment_type=?',[normalizePaymentType(type)])?.min_withdrawal || '0') || '0'; }
function paymentNotify(agentId,requestId,event,message){ db.run('INSERT INTO payment_notifications_v2 (agent_id,request_id,event,message) VALUES (?,?,?,?)',[agentId,requestId,event,message]); }
function paymentAudit(req,action,body={}){ const u=req?.user||{}; db.run(`INSERT INTO payment_audit_logs (actor_id,actor_name,actor_role,action,request_id,agent_id,manager_id,payment_type,amount,wallet_address,status,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [u.id||null,u.username||'',u.role||'',action,body.request_id||null,body.agent_id||null,body.manager_id||null,body.payment_type||'',body.amount||'',body.wallet_address||'',body.status||'',safeJson(body.details||{})]); }

function parseTestNumbers(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[\s,;]+/).map(v => v.trim()).filter(Boolean);
}
function syncRangeTestNumbers(rangeId, testValue) {
  const nums = [...new Set(parseTestNumbers(testValue))];
  db.run('DELETE FROM range_test_numbers WHERE range_id=?', [rangeId]);
  nums.forEach(n => db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [rangeId, n]));
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [nums.join(', '), rangeId]);
  return nums;
}

/* ============ RANGES / RATE MANAGEMENT ============ */
app.get('/api/ranges', authRequired, (req, res) => cachedJson(req, res, 5000, () => {
  const includeDeleted = String(req.query.include_deleted || '').toLowerCase() === '1' || String(req.query.include_deleted || '').toLowerCase() === 'true';
  const includeTests = String(req.query.include_tests || '').toLowerCase() === '1' || String(req.query.include_tests || '').toLowerCase() === 'true';
  const where = includeDeleted ? '1=1' : "COALESCE(r.deleted_at,'')=''";
  if (!includeTests) {
    return db.all(`SELECT r.id,r.name,r.prefix,r.currency,r.rate_1_1,r.rate_7_1,r.rate_7_7,r.rate_30_45,r.memo,r.payment_type,r.created_at,r.deleted_at,r.country,r.provider,r.currency_rate,r.cli_limit,r.range_start,r.range_end,r.status,'' AS test_number,'' AS test_numbers
      FROM ranges r WHERE ${where} ORDER BY r.name COLLATE NOCASE ASC, r.id ASC`);
  }
  const rows = db.all(`SELECT r.*,
    COALESCE((SELECT GROUP_CONCAT(test_number, ', ') FROM range_test_numbers t WHERE t.range_id=r.id AND t.active=1), r.test_number, '') AS test_numbers
    FROM ranges r WHERE ${where} ORDER BY r.name COLLATE NOCASE ASC, r.id ASC`);
  rows.forEach(r => { if (r.test_numbers) r.test_number = r.test_numbers; });
  return rows;
}));
// only admin can set rates / create ranges
app.post('/api/ranges', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Range name required' });
  const ins = db.run(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type,country,provider,currency_rate,cli_limit,range_start,range_end,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name, b.prefix || '', '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '', normalizePaymentType(b.payment_type || b.payterm || 'weekly'),
     b.country || '', b.provider || '', b.currency_rate || '', b.cli_limit || '', b.range_start || '', b.range_end || '', b.status || 'Active']);
  const newRange = db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1', [b.name]);
  syncRangeTestNumbers(newRange ? newRange.id : ins.lastInsertRowid, b.test_numbers || b.test_number || '');
  logAction(req,'create_range','ranges',b.name);
    try { require('./assistant').refreshRanges(); } catch (e) { console.warn('[ASSISTANT] refresh failed:', e.message); }
  res.json({ ok: true });
});

function parseBulkRangeNames(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\r\n,;]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
app.post('/api/ranges/bulk-create', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const names = parseBulkRangeNames(b.names || b.text || b.range_names);
  if (!names.length) return res.status(400).json({ error: 'Enter at least one range name' });
  const currency = b.currency || 'USD';
  const defaults = {
    prefix: b.prefix || '',
    rate_1_1: b.rate_1_1 || 'NA',
    rate_7_1: b.rate_7_1 || 'NA',
    rate_7_7: b.rate_7_7 || 'NA',
    rate_30_45: b.rate_30_45 || 'NA',
    memo: b.memo || ''
  };
  let inserted = 0, restored = 0, skipped = 0;
  const created = [], existing = [];
  try {
    // No long transaction here: job yields between chunks so other API calls remain responsive.
    // Changes are persisted once at the end with db.save().
    for (const name of names) {
      const old = db.get("SELECT id, COALESCE(deleted_at,'') AS deleted_at FROM ranges WHERE lower(name)=lower(?) LIMIT 1", [name]);
      if (old) {
        if (old.deleted_at) { db.runNoSave("UPDATE ranges SET deleted_at='' WHERE id=?", [old.id]); restored++; }
        else skipped++;
        existing.push(name);
        continue;
      }
      const ins = db.runNoSave(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [name, defaults.prefix, '', currency, defaults.rate_1_1, defaults.rate_7_1, defaults.rate_7_7, defaults.rate_30_45, defaults.memo, normalizePaymentType(b.payment_type || 'weekly')]);
      inserted++;
      created.push({ id: ins.lastInsertRowid, name });
    }
    db.execNoSave('COMMIT');
    db.save();
  } catch (e) {
    try { db.execNoSave('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: e.message || 'Bulk range creation failed' });
  }
  clearApiReadCache();
  logAction(req, 'bulk_create_ranges', 'ranges', { inserted, restored, skipped, total: names.length });
    try { require('./assistant').refreshRanges(); } catch (e) { console.warn('[ASSISTANT] refresh failed:', e.message); }
  res.json({ ok: true, inserted, restored, skipped, total: names.length, created, existing });
});

function normalizeRangeImportRow(row) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(row || {}).find(x => x.trim().toLowerCase() === k.trim().toLowerCase());
      if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== '') return String(row[found]).trim();
    }
    return '';
  };
  const name = get('Range','Range Name','name','range_name','Country');
  const payout = get('Payout','30/45','rate_30_45','Rate','Rate 30/45');
  const currency = get('Currency','cur') || 'USD';
  return {
    name,
    prefix: get('Prefix','prefix'),
    test_number: get('Test Number','Test Numbers','test_number','test_numbers'),
    currency: currency === '$' ? 'USD' : currency,
    rate_1_1: get('1/1','rate_1_1') || 'NA',
    rate_7_1: get('7/1','rate_7_1') || payout || 'NA',
    rate_7_7: get('7/7','rate_7_7') || 'NA',
    rate_30_45: payout || get('30/45','rate_30_45') || 'NA',
    memo: get('Memo','memo','notes'),
    payment_type: normalizePaymentType(get('Payment Type','PaymentType','Pay Type','payterm','payment_type') || 'weekly')
  };
}

function isPhoneLikeLine(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  const d = s.replace(/[^0-9]/g, '');
  return d.length >= 5 && d.length >= Math.max(5, Math.floor(s.length * 0.65));
}
function normalizeTestPhone(v) { return String(v || '').trim().replace(/[^0-9+]/g, '').replace(/^\+/, ''); }
function parseRangeTestNumberBlocks(text) {
  const groups = [];
  let current = null;
  const pushRange = (name) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    current = { range_name: clean, test_numbers: [] };
    groups.push(current);
  };
  const tokens = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const raw = String(line || '').trim();
    if (!raw) return;
    // CSV/TSV rows: read cells left-to-right. Normal TXT lines are one token.
    const cells = raw.includes('\t') || raw.includes(',') || raw.includes(';')
      ? raw.split(/[\t,;]+/).map(x => x.trim()).filter(Boolean)
      : [raw];
    tokens.push(...cells);
  });
  for (const token of tokens) {
    if (isPhoneLikeLine(token)) {
      const n = normalizeTestPhone(token);
      if (!current) pushRange('Imported Range');
      if (n && !current.test_numbers.includes(n)) current.test_numbers.push(n);
    } else {
      pushRange(token);
    }
  }
  return groups.filter(g => g.range_name && g.test_numbers.length);
}
function sheetRowsToText(wb, XLSX) {
  const lines = [];
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    rows.forEach(row => {
      (row || []).forEach(cell => { const v = String(cell || '').trim(); if (v) lines.push(v); });
    });
  }
  return lines.join('\n');
}
function upsertRangeWithTestNumbers(rangeName, testNumbers, defaults = {}) {
  const name = String(rangeName || '').trim().replace(/\s+/g, ' ');
  if (!name) return { skipped: true };
  let row = db.get('SELECT id FROM ranges WHERE lower(name)=lower(?) LIMIT 1', [name]);
  let inserted = false, restored = false;
  if (!row) {
    const ins = db.runNoSave(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [name, defaults.prefix || '', '', defaults.currency || 'USD', defaults.rate_1_1 || 'NA', defaults.rate_7_1 || 'NA', defaults.rate_7_7 || 'NA', defaults.rate_30_45 || 'NA', defaults.memo || '', normalizePaymentType(defaults.payment_type || 'weekly')]);
    row = { id: ins.lastInsertRowid };
    inserted = true;
  } else {
    const old = db.get("SELECT COALESCE(deleted_at,'') AS deleted_at FROM ranges WHERE id=?", [row.id]);
    if (old && old.deleted_at) { db.runNoSave("UPDATE ranges SET deleted_at='' WHERE id=?", [row.id]); restored = true; }
  }
  const existing = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=?', [row.id]).map(x => String(x.test_number));
  const seen = new Set(existing.map(normalizeTestPhone));
  let added = 0;
  for (const raw of testNumbers || []) {
    const n = normalizeTestPhone(raw);
    if (!n || seen.has(n)) continue;
    db.runNoSave('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [row.id, n]);
    seen.add(n); added++;
  }
  const finalNums = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id ASC', [row.id]).map(x => x.test_number);
  db.runNoSave('UPDATE ranges SET test_number=? WHERE id=?', [finalNums.join(', '), row.id]);
  return { id: row.id, name, inserted, restored, added_test_numbers: added, total_test_numbers: finalNums.length };
}
app.post('/api/ranges/import-test-bulk', authRequired, requireRole('admin'), upload.single('file'), (req, res) => {
  let text = '';
  try {
    if (req.file && req.file.buffer) {
      const fileName = String(req.file.originalname || '').toLowerCase();
      if (/\.xlsx?$/.test(fileName)) {
        const XLSX = require('xlsx');
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        text = sheetRowsToText(wb, XLSX);
      } else {
        text = req.file.buffer.toString('utf8');
      }
    } else if (req.body && (req.body.text || req.body.content)) {
      text = String(req.body.text || req.body.content || '');
    }
    const groups = parseRangeTestNumberBlocks(text);
    if (!groups.length) return res.status(400).json({ error: 'No range/test-number blocks found. First line should be range name, followed by test numbers.' });
    const details = [];
    let inserted = 0, restored = 0, added_test_numbers = 0;
    // Process in chunks without a long transaction so other requests can run between chunks.
    try {
      for (const g of groups) {
        const r = upsertRangeWithTestNumbers(g.range_name, g.test_numbers, { currency: req.body?.currency || 'USD', payment_type: req.body?.payment_type || 'weekly' });
        if (r.inserted) inserted++;
        if (r.restored) restored++;
        added_test_numbers += r.added_test_numbers || 0;
        details.push(r);
      }
      db.execNoSave('COMMIT'); db.save();
    } catch(e) { try { db.execNoSave('ROLLBACK'); } catch(_){} throw e; }
    clearApiReadCache();
    logAction(req, 'import_ranges_with_test_numbers', 'ranges', { total_ranges: groups.length, inserted, restored, added_test_numbers });
    res.json({ ok: true, total_ranges: groups.length, inserted, restored, added_test_numbers, details });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Import failed' });
  }
});

app.post('/api/ranges/import', authRequired, requireRole('admin'), (req,res)=>{
  const rows = Array.isArray(req.body?.ranges) ? req.body.ranges : [];
  const updateExisting = req.body?.update_existing !== false;
  if(!rows.length) return res.status(400).json({error:'ranges[] required'});
  let inserted=0, updated=0, skipped=0, errors=[];
  for(const raw of rows){
    const r=normalizeRangeImportRow(raw);
    if(!r.name){ skipped++; errors.push({row: raw, error:'Range name missing'}); continue; }
    const existing=db.get('SELECT id FROM ranges WHERE name=?',[r.name]);
    if(existing && updateExisting){
      db.run(`UPDATE ranges SET prefix=?,currency=?,rate_1_1=?,rate_7_1=?,rate_7_7=?,rate_30_45=?,memo=?,payment_type=?,deleted_at='' WHERE id=?`,
        [r.prefix,r.currency,r.rate_1_1,r.rate_7_1,r.rate_7_7,r.rate_30_45,r.memo,r.payment_type,existing.id]);
      syncRangeTestNumbers(existing.id, r.test_number || '');
      updated++;
    } else if(existing){ skipped++; }
    else {
      const ins=db.run(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [r.name,r.prefix,'',r.currency,r.rate_1_1,r.rate_7_1,r.rate_7_7,r.rate_30_45,r.memo,r.payment_type]);
      const nr=db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1',[r.name]);
      syncRangeTestNumbers(nr?nr.id:ins.lastInsertRowid, r.test_number || '');
      inserted++;
    }
  }
  logAction(req,'import_ranges_bulk','ranges',{inserted,updated,skipped,total:rows.length});
  res.json({ok:true,inserted,updated,skipped,total:rows.length,errors});
});
app.put('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.run(`UPDATE ranges SET name=?,prefix=?,currency=?,rate_1_1=?,rate_7_1=?,rate_7_7=?,rate_30_45=?,memo=?,payment_type=?,country=?,provider=?,currency_rate=?,cli_limit=?,range_start=?,range_end=?,status=? WHERE id=?`,
    [b.name, b.prefix || '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '', normalizePaymentType(b.payment_type || 'weekly'),
     b.country || '', b.provider || '', b.currency_rate || '', b.cli_limit || '', b.range_start || '', b.range_end || '', b.status || 'Active', +req.params.id]);
  syncRangeTestNumbers(+req.params.id, b.test_numbers || b.test_number || '');
  logAction(req,'update_range','ranges',{id:+req.params.id});
  try { require('./assistant').refreshRanges(); } catch (e) { console.warn('[ASSISTANT] refresh failed:', e.message); }
  res.json({ ok: true });
});
app.delete('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  const rangeId = +req.params.id;
  const range = db.get('SELECT * FROM ranges WHERE id=?', [rangeId]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const deleteSms = truthy(req.query.delete_sms);
  const numberResult = deleteNumbersWhere('range_id=?', [rangeId], req, 'delete_range_numbers_during_range_delete', { rangeId, range: range.name }, deleteSms);
  let rangeSmsDeleted = 0, rangeSmsPreserved = 0;
  const rangeSmsCount = db.get('SELECT COUNT(*) c FROM sms_records WHERE range_id=?', [rangeId])?.c || 0;
  if (deleteSms) {
    db.run('DELETE FROM sms_records WHERE range_id=?', [rangeId]);
    rangeSmsDeleted = rangeSmsCount;
  } else {
    rangeSmsPreserved = rangeSmsCount;
  }
  db.run('DELETE FROM range_test_numbers WHERE range_id=?', [rangeId]);
  // Soft-delete the range so historical SMS reports can still show the old range name via joins.
  db.run("UPDATE ranges SET deleted_at=datetime('now') WHERE id=?", [rangeId]);
  logAction(req,'delete_range','ranges',{id:rangeId,range:range.name,deleteSms,numberResult,rangeSmsDeleted,rangeSmsPreserved});
  try { require('./assistant').refreshRanges(); } catch (e) { console.warn('[ASSISTANT] refresh failed:', e.message); }
  res.json({ ok: true, deleted_range: 1, deleted_numbers: numberResult.deleted || 0, deleted_sms: (numberResult.deleted_sms || 0) + rangeSmsDeleted, preserved_sms: (numberResult.preserved_sms || 0) + rangeSmsPreserved });
});

app.get('/api/test-numbers', authRequired, (req, res) => cachedJson(req, res, 3000, () => {
  // Test panel numbers are separate from actual panel numbers. UI should show only range name + number.
  const q=String(req.query.search||'').trim();
  const range=String(req.query.range||'').trim();
  const where=['t.active=1']; const params=[];
  if(q){where.push('(LOWER(t.test_number) LIKE ? OR LOWER(r.name) LIKE ?)'); params.push('%'+String(q).toLowerCase()+'%','%'+String(q).toLowerCase()+'%');}
  if(range){where.push('r.name=?'); params.push(range);}
  const base=`FROM range_test_numbers t JOIN ranges r ON r.id=t.range_id WHERE ${where.join(' AND ')}`;
  const paged=req.query.paged||req.query.page||req.query.limit;
  const total=+(db.get(`SELECT COUNT(*) c ${base}`,params)?.c||0);
  const limitRaw=String(req.query.limit||'100');
  const limit=limitRaw.toLowerCase()==='all'?Math.max(1,Math.min(total||1,10000)):Math.max(1,Math.min(parseInt(limitRaw||'500',10)||500,2000));
  const totalPages=Math.max(1,Math.ceil(total/limit));
  const page=Math.min(Math.max(1,parseInt(req.query.page||'1',10)||1),totalPages);
  const offset=(page-1)*limit;
  const rows = db.all(`SELECT t.id, t.range_id, t.test_number AS number, t.label, t.created_at, r.name AS range_name, r.prefix,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), 'Ask') AS payout
    ${base}
    ORDER BY r.name COLLATE NOCASE, t.id DESC LIMIT ? OFFSET ?`, [...params,limit,offset]);
  return paged ? {rows,total,page,limit,totalPages} : rows;
}));

app.post('/api/test-numbers/import', authRequired, requireRole('admin'), (req, res) => {
  const { range_id, range_name, numbers } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers[] required' });
  let range = range_id ? db.get('SELECT * FROM ranges WHERE id=?', [+range_id]) : null;
  if (!range && range_name) range = db.get('SELECT * FROM ranges WHERE name=?', [range_name]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  let inserted = 0, skipped = 0;
  for (const raw of numbers) {
    const n = String(raw || '').trim();
    if (!n) { skipped++; continue; }
    const cleaned = cleanPhone(n);
    const existsInPanel = db.get(`SELECT id FROM numbers
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
    if (existsInPanel) { skipped++; continue; }
    const existsTest = db.get(`SELECT id FROM range_test_numbers WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [range.id, cleaned]);
    if (existsTest) { skipped++; continue; }
    db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [range.id, n]);
    inserted++;
  }
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [range.id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, range.id]);
  logAction(req, 'import_test_numbers', 'test_numbers', { range: range.name, inserted, skipped });
  res.json({ ok: true, inserted, skipped, range_id: range.id });
});

app.post('/api/test-numbers', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const number = String(b.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number required' });
  let range = b.range_id ? db.get('SELECT * FROM ranges WHERE id=?', [+b.range_id]) : null;
  if (!range && b.range_name) range = db.get('SELECT * FROM ranges WHERE name=?', [String(b.range_name).trim()]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const cleaned = cleanPhone(number);
  const existsPanel = db.get(`SELECT id FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
  if (existsPanel) return res.status(409).json({ error: 'This number already exists in live SMS Numbers' });
  const existsTest = db.get(`SELECT id FROM range_test_numbers WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [range.id, cleaned]);
  if (existsTest) return res.status(409).json({ error: 'This test number already exists in this range' });
  db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [range.id, number]);
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [range.id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, range.id]);
  logAction(req, 'add_test_number', 'test_numbers', { range: range.name, number });
  res.json({ ok: true, inserted: 1, range_id: range.id });
});

app.delete('/api/test-numbers/:id', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  const row = db.get('SELECT * FROM range_test_numbers WHERE id=?', [id]);
  if (!row) return res.status(404).json({ error: 'Test number not found' });
  db.run('DELETE FROM range_test_numbers WHERE id=?', [id]);
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [row.range_id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, row.range_id]);
  logAction(req, 'delete_test_number', 'test_numbers', { id, number: row.test_number, range_id: row.range_id });
  res.json({ ok: true, deleted: 1 });
});

app.get('/api/test-panel/dashboard', authRequired, requireRole('admin','manager','agent','client','test'), (req, res) => {
  const nums = db.get('SELECT COUNT(*) c FROM range_test_numbers WHERE active=1')?.c || 0;
  const normalTest = 'COALESCE(is_test,0)=1';
  const dExpr = ukDateExpr('received_at');
  const today = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${normalTest} AND ${dExpr}=${ukDateNowSql()}`)?.c || 0;
  const daily7 = db.all(`WITH days(n,d) AS (
      SELECT 6, ${ukDateNowSql('-6 days')} UNION ALL SELECT n-1, date(d,'+1 day') FROM days WHERE n>0
    ) SELECT d AS date, COALESCE((SELECT COUNT(*) FROM sms_records s WHERE COALESCE(s.is_test,0)=1 AND ${ukDateExpr('s.received_at')}=d),0) AS count FROM days ORDER BY d`);
  res.json({ today_otps: today, total_test_numbers: nums, daily7, reporting_timezone: 'Europe/London' });
});

app.get('/api/test-panel/sms', authRequired, requireRole('admin','manager','agent','client','test'), (req, res) => cachedJson(req, res, 1500, () => {
  const number = String(req.query.number || '').trim();
  const search = String(req.query.search || '').trim();
  const cli = String(req.query.cli || '').trim();
  const params = [];
  const where = ['COALESCE(s.is_test,0)=1'];
  if (number) { where.push("REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?"); params.push(cleanPhone(number)); }
  if (cli) { where.push('LOWER(s.cli) LIKE ?'); params.push('%' + String(cli).toLowerCase() + '%'); }
  if (search) {
    where.push('(LOWER(s.number) LIKE ? OR LOWER(s.cli) LIKE ? OR LOWER(s.message) LIKE ? OR LOWER(r.name) LIKE ?)');
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%', '%' + search + '%');
  }
  const base = `FROM sms_records s
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN range_test_numbers t ON t.range_id=s.range_id AND t.active=1 AND REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')=REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN sharing_users su ON su.agent_user_id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE ${where.join(' AND ')}`;

  // Paged mode is opt-in so existing callers keep receiving a plain array.
  const paged = req.query.paged || req.query.page;
  const total = paged
    ? +(db.get(`SELECT COUNT(*) c ${base}`, params)?.c || 0)
    : 0;
  const limitRaw = String(req.query.limit || '50');
  const limit = limitRaw.toLowerCase() === 'all'
    ? Math.max(1, Math.min(total || 1, 10000))
    : Math.max(1, Math.min(parseInt(limitRaw, 10) || 50, 5000));
  const totalPages = Math.max(1, Math.ceil((total || 1) / limit));
  const page = Math.min(Math.max(1, parseInt(req.query.page || '1', 10) || 1), totalPages);
  const offset = paged ? (page - 1) * limit : 0;

  const rows = db.all(`SELECT s.*, r.name AS range_name,
      t.id AS test_number_id, COALESCE(t.test_number, s.number) AS test_number, t.created_at AS test_number_created_at,
      cu.username AS client_name, COALESCE(su.panel_name, au.username) AS agent_name, au.username AS agent_username, su.panel_name AS sharing_panel_name, su.id AS sharing_user_id, mu.username AS manager_name
    ${base}
    ORDER BY s.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return paged ? { rows, total, page, limit, totalPages } : rows;
}));


function testPanelNumbersPool() {
  return db.all(`SELECT t.id, t.range_id, t.test_number AS number, r.name AS range_name,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), NULLIF(r.rate_7_7,''), NULLIF(r.rate_1_1,''), '0') AS payout_rate
    FROM range_test_numbers t
    LEFT JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1
    ORDER BY t.id ASC`);
}
function demoSqlDate(minutesAgo) {
  const d = new Date(Date.now() - (Number(minutesAgo)||0) * 60000);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function generateTestPanelFakeMessages({ limit=25, cli='', message='' }, req) {
  const pool = testPanelNumbersPool();
  if (!pool.length) return { ok:false, error:'No test numbers found. Add/import test numbers first.' };
  const owners = db.all(`SELECT c.id AS client_id, c.username AS client_name, a.id AS agent_id, a.parent_id AS manager_id
    FROM users c LEFT JOIN users a ON a.id=c.parent_id
    WHERE c.role='client' AND c.active=1
    ORDER BY c.id ASC`);
  const max = Math.max(1, Math.min(1000, parseInt(limit || 25, 10)));
  const defaultClis = ['Affirm','TikTok','WhatsApp','Google','Telegram','JD STATUS','Amazon','Facebook','Binance','Verify'];
  const defaultTemplates = [
    '{service}: Your verification code is {code}. Do not share it with anyone.',
    'Your {service} code is {code}. This code will expire in 3 minutes.',
    '{code} is your {service} OTP. Never share this code.',
    'Use {code} to verify your {service} login request.',
    '{service} security code: {code}. If this was not you, ignore this message.'
  ];
  let inserted = 0;
  for (let i=0; i<max; i++) {
    const n = pool[i % pool.length];
    const service = cli || defaultClis[i % defaultClis.length];
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const tpl = message || defaultTemplates[i % defaultTemplates.length];
    const body = String(tpl)
      .replaceAll('{code}', code)
      .replaceAll('{number}', n.number)
      .replaceAll('{service}', service)
      .replaceAll('{range}', n.range_name || 'Test Range')
      .replaceAll('{index}', String(i+1));
    const senderType = classifySender(service);
    const otpCode = extractOtpCode(body) || code;
    // Keep demo traffic at current time so generated limit, dashboard count and displayed rows match exactly.
    const when = demoSqlDate(0);
    const owner = owners.length ? owners[i % owners.length] : {};
    db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [null, n.number, n.range_id, service, senderType, body, otpCode, owner.client_id || null, owner.agent_id || null, owner.manager_id || null, 1, 'DEMO-' + Date.now(), 'test_panel_fake', n.payout_rate || '0', n.payout_rate || '0', when]);
    inserted++;
  }
  logAction(req, 'generate_test_panel_fake_sms', 'test_panel', { inserted, mode: message || cli ? 'custom' : 'default' });
  return { ok:true, inserted, available_test_numbers: pool.length };
}
app.post('/api/test-panel/fake/default', authRequired, requireRole('admin'), (req, res) => {
  const result = generateTestPanelFakeMessages({ limit: req.body?.limit || 25 }, req);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/test-panel/fake/custom', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const cli = String(b.cli || '').trim();
  const message = String(b.message || '').trim();
  if (!cli) return res.status(400).json({ error:'CLI is required' });
  if (!message) return res.status(400).json({ error:'Message body is required' });
  const result = generateTestPanelFakeMessages({ limit: b.limit || 25, cli, message }, req);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.delete('/api/test-panel/fake', authRequired, requireRole('admin'), (req, res) => {
  const count = db.get("SELECT COUNT(*) c FROM sms_records WHERE source='test_panel_fake'")?.c || 0;
  db.run("DELETE FROM sms_records WHERE source='test_panel_fake'");
  logAction(req, 'clear_test_panel_fake_sms', 'test_panel', { count });
  res.json({ ok:true, deleted: count });
});


/* ============ NUMBERS ============ */
function numberOwnerColumnForRole(role) {
  if (role === 'admin') return 'manager_id';
  if (role === 'manager') return 'agent_id';
  if (role === 'agent') return 'client_id';
  return 'client_id';
}
function numberScope(user, alias='n') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function buildNumberQuery(user, q) {
  const scope = numberScope(user, 'n');
  const where = [scope.where];
  const params = [...scope.params];
  // PHASE-1: only include the JOINs a filter actually needs.
  // The hot path (scope/allocation/range_id filters, digit search) touches ONLY
  // the numbers table — no ranges/users JOINs, so the planner drives from
  // numbers indexes and COUNT stops scanning joined tables.
  const need = { ranges: false, users: false };
  // Clean-phone expression MUST match idx_numbers_clean_phone exactly.
  const cleanN = `REPLACE(REPLACE(REPLACE(REPLACE(n.number,'+',''),' ',''),'-',''),'_','')`;
  if (q.search) {
    const raw = String(q.search).trim();
    // Fast path: digits-only input (99% of number searches) → indexed prefix
    // search on number / clean_phone instead of 6-column '%..%' scan.
    if (/^[+]?[\d][\d\s\-()]{0,24}$/.test(raw)) {
      const digits = raw.replace(/\D+/g, '');
      if (digits) {
        // PHASE-1 fast path (measured @5M: 2.5 s → 1.3 ms):
        //  - n.number LIKE 'dig%'  → prefix range SEARCH on idx_numbers_number(_unique)
        //  - clean expr = 'dig'    → exact hit on idx_numbers_clean_phone
        // MULTI-INDEX OR lets SQLite use both indexes.
        where.push(`(n.number LIKE ? OR ${cleanN} = ?)`);
        params.push(`${digits}%`, digits);
      }
    } else {
      where.push(`(LOWER(n.number) LIKE ? OR LOWER(r.name) LIKE ? OR LOWER(n.prefix) LIKE ? OR LOWER(COALESCE(cu.username,'')) LIKE ? OR LOWER(COALESCE(au.username,'')) LIKE ? OR LOWER(COALESCE(mu.username,'')) LIKE ?)`);
      const v = `%${raw.toLowerCase()}%`;
      params.push(v, v, v, v, v, v);
      need.ranges = true; need.users = true;
    }
  }
  if (q.range) { where.push('r.name=?'); params.push(q.range); need.ranges = true; }
  if (q.range_id) { where.push('n.range_id=?'); params.push(+q.range_id); }
  if (q.owner) {
    if (user.role === 'admin') {
      // Admin owner can be Manager allocation or direct Agent allocation.
      where.push('(mu.username=? OR au.username=?)'); params.push(q.owner, q.owner);
    }
    else if (user.role === 'manager') { where.push('au.username=?'); params.push(q.owner); }
    else if (user.role === 'agent') { where.push('cu.username=?'); params.push(q.owner); }
    need.users = true;
  }
  if (q.allocation === 'unallocated') {
    // unqualified: lets the planner use idx_numbers_unallocated (measured @5M: 2.1 s → 250 ms)
    if (user.role === 'admin') where.push('manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL');
    else { const col = numberOwnerColumnForRole(user.role); where.push(`${col} IS NULL`); }
  } else if (q.allocation === 'allocated') {
    if (user.role === 'admin') where.push('(manager_id IS NOT NULL OR agent_id IS NOT NULL OR client_id IS NOT NULL)');
    else { const col = numberOwnerColumnForRole(user.role); where.push(`${col} IS NOT NULL`); }
  }
  return { where: where.join(' AND '), params, need };
}
/**
 * PHASE-1: JOINs are conditional (need={ranges,users}).
 * The sharing_users JOIN was REMOVED from every query — it could duplicate
 * rows (an agent with several sharing panels multiplied listing + COUNT rows).
 * Listing display now reads it via a LIMIT-1 scalar subquery instead.
 */
function numberFromSql(where, need = {}) {
  const joins = [];
  if (need.ranges) joins.push(`LEFT JOIN ranges r ON r.id=n.range_id`);
  if (need.users) joins.push(`LEFT JOIN users cu ON cu.id=n.client_id`,
                             `LEFT JOIN users au ON au.id=n.agent_id`,
                             `LEFT JOIN users mu ON mu.id=n.manager_id`);
  return `FROM numbers n ${joins.join(' ')} ${joins.length ? '' : ''}WHERE ${where}`;
}
function numberSelectSql(where, options = {}) {
  const lastSms = options.lastSms ? `,
            (SELECT MAX(s.received_at) FROM sms_records s WHERE s.number=n.number AND COALESCE(s.is_test,0)=0) AS last_sms_at` : '';
  // Display query: LIMIT-bounded, so keeping display JOINs here is cheap.
  // sharing_users becomes a scalar subquery (no row duplication).
  return `SELECT n.*, r.name AS range_name,
            COALESCE(
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(n.rate,''))),'NA'),''),
      CASE
        WHEN UPPER(TRIM(COALESCE(n.payterm, r.payment_type,'')))  LIKE '%30%'
          OR UPPER(TRIM(COALESCE(n.payterm, r.payment_type,'')))  LIKE '%MONTH%'
          THEN NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_30_45,''))),'NA'),'')
        WHEN UPPER(TRIM(COALESCE(n.payterm, r.payment_type,'')))  LIKE '%7_7%'
          THEN NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_7_7,''))),'NA'),'')
        WHEN UPPER(TRIM(COALESCE(n.payterm, r.payment_type,'')))  LIKE '%1_1%'
          OR UPPER(TRIM(COALESCE(n.payterm, r.payment_type,'')))  LIKE '%DAIL%'
          THEN NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_1_1,''))),'NA'),'')
        ELSE NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_7_1,''))),'NA'),'')
      END,
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_7_1,''))),'NA'),''),
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_7_7,''))),'NA'),''),
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_1_1,''))),'NA'),''),
      NULLIF(NULLIF(UPPER(TRIM(COALESCE(r.rate_30_45,''))),'NA'),''),
      '0') AS effective_rate,
            CASE WHEN n.manager_id IS NOT NULL THEN 'manager' WHEN n.agent_id IS NOT NULL THEN 'agent' WHEN n.client_id IS NOT NULL THEN 'client' ELSE 'unallocated' END AS owner_type,
            cu.username AS client_name,
            COALESCE((SELECT s1.panel_name FROM sharing_users s1 WHERE s1.agent_user_id=n.agent_id ORDER BY s1.id LIMIT 1), au.username) AS agent_name,
            au.username AS agent_username,
            (SELECT s1.panel_name FROM sharing_users s1 WHERE s1.agent_user_id=n.agent_id ORDER BY s1.id LIMIT 1) AS sharing_panel_name,
            (SELECT s1.id FROM sharing_users s1 WHERE s1.agent_user_id=n.agent_id ORDER BY s1.id LIMIT 1) AS sharing_user_id,
            mu.username AS manager_name${lastSms}
     ${numberFromSql(where, { ranges: true, users: true })}`;
}
app.get('/api/numbers/summary', authRequired, (req, res) => cachedJson(req, res, 60000, () => {
  const scope = numberScope(req.user, 'n');
  const ownerExpr = req.user.role === 'admin'
    ? '(n.manager_id IS NOT NULL OR n.agent_id IS NOT NULL OR n.client_id IS NOT NULL)'
    : `n.${numberOwnerColumnForRole(req.user.role)} IS NOT NULL`;
  const having = req.user.role === 'admin' ? '' : 'HAVING total > 0';
  const rows = db.all(`SELECT r.id AS range_id, r.name AS range_name,
      r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45, r.payment_type,
      COUNT(n.id) AS total,
      SUM(CASE WHEN n.id IS NOT NULL AND NOT (${ownerExpr}) THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN n.id IS NOT NULL AND ${ownerExpr} THEN 1 ELSE 0 END) AS allocated,
      COALESCE(NULLIF(r.rate_7_1,''), NULLIF(r.rate_7_7,''), NULLIF(r.rate_30_45,''), NULLIF(r.rate_1_1,''), '0') AS rate
    FROM ranges r
    LEFT JOIN numbers n ON n.range_id=r.id AND ${scope.where}
    WHERE COALESCE(r.deleted_at,'')=''
    GROUP BY r.id, r.name
    ${having}
    ORDER BY r.name COLLATE NOCASE ASC`, scope.params);
  return rows.map(r => ({...r, total:+(r.total||0), available:+(r.available||0), allocated:+(r.allocated||0)}));
}, 'numbers_ver'));

// list numbers visible to caller (supports server-side pagination with ?paged=1)
const NUMBER_PAGE_DEFAULT = 25;
// PHASE-1 (#31): 100,000-row pages blocked the event loop for seconds
// (JSON.stringify + transfer). Cap is now env-tunable, default 1,000 rows;
// Admin "All" views may use up to NUMBER_PAGE_MAX_ADMIN (default 5,000).
const NUMBER_PAGE_MAX = Math.max(100, parseInt(process.env.NUMBER_PAGE_MAX || '1000', 10) || 1000);
const NUMBER_PAGE_MAX_ADMIN = Math.max(NUMBER_PAGE_MAX, parseInt(process.env.NUMBER_PAGE_MAX_ADMIN || '5000', 10) || 5000);
/* P11: ROLE-BASED PAGE CEILINGS — backend-enforced (frontend options per role are cosmetic; THIS is the law).
   A lower-role user cannot get a bigger page by tampering with limit/all params: values are clamped here.
   Previous behaviour (recorded for rollback): every role capped at NUMBER_PAGE_MAX (1000);
   admin 'all' capped at NUMBER_PAGE_MAX_ADMIN (5000). */
const ROLE_PAGE_MAX = { admin: 100000, manager: 5000, agent: 1000, client: 500, test: 500 };
const ROLE_ALL_MAX  = { admin: 200000 }; /* 'All' page-size allowed for admin only; others fall back to their role cap */
function rolePageMax(role) { return ROLE_PAGE_MAX[role] || 500; }
/* P11: memory-safe big-page responses. Pages <= STREAM_JSON_MAX_ROWS are built
   normally (and cached); larger pages stream row-by-row from the SQLite cursor so
   peak memory stays flat (a 100k-row res.json() triple-copies ~60MB+ and can OOM).
   Response JSON shape is IDENTICAL to the cached path. */
const STREAM_JSON_MAX_ROWS = 5000;
function sendPagedStreaming(res, tailFields, sql, params, mapRow) {
  res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.write('{"rows":[');
  let first = true, buf = [], n = 0, lastRow = null;
  const PUSH = (row) => {
    if (mapRow) { const m = mapRow(row); if (m) row = m; }
    lastRow = row;
    buf.push(JSON.stringify(row));
    if (buf.length >= 500) { res.write((first ? '' : ',') + buf.join(',')); first = false; buf = []; }
  };
  for (const row of db.iterate(sql, params)) { PUSH(row); n++; }
  if (buf.length) res.write((first ? '' : ',') + buf.join(','));
  let out = '';
  out += '],"rows_count":' + n;
  for (const [k, v] of Object.entries(tailFields || {})) out += ',' + JSON.stringify(k) + ':' + JSON.stringify(v === undefined ? null : v);
  res.end(out + '}');
}
function parsePositiveInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/* P11: streaming big-page route (must stay registered ABOVE the cached small-page route).
   Pages > STREAM_JSON_MAX_ROWS stream row-by-row (flat memory, identical JSON shape). */
app.get('/api/numbers', authRequired, (req, res, next) => {
  const q = req.query || {};
  const paged = q.paged || q.page || q.limit;
  if (!paged) return next();
  const limitRaw = String(q.limit || NUMBER_PAGE_DEFAULT);
  const isAllReq = limitRaw.toLowerCase() === 'all';
  const numericReq = parsePositiveInt(limitRaw, 0);
  const roleCap = rolePageMax(req.user.role);
  const bigLimit = isAllReq ? (ROLE_ALL_MAX[req.user.role] || roleCap)
                 : (numericReq > STREAM_JSON_MAX_ROWS ? Math.min(numericReq, roleCap) : 0);
  if (!bigLimit) return next();
  try {
    const query = buildNumberQuery(req.user, q);
    const countFrom = numberFromSql(query.where, query.need);
    const total = +(db.get(`SELECT COUNT(*) AS c ${countFrom}`, query.params)?.c || 0);
    const limit = isAllReq ? Math.min(bigLimit, Math.max(1, total || 1)) : bigLimit;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, parsePositiveInt(q.page || '1', 1)), totalPages);
    const offset = (page - 1) * limit;
    const sortMap = { range:'r.name COLLATE NOCASE', prefix:'n.prefix COLLATE NOCASE', number:'n.number', myVal:"CAST(COALESCE(NULLIF(n.rate,''),'0') AS REAL)", payVal:"CAST(COALESCE(NULLIF(n.payout,''),'0') AS REAL)", manager:'mu.username COLLATE NOCASE', agent:'au.username COLLATE NOCASE', client:'cu.username COLLATE NOCASE', owner:"COALESCE(mu.username,au.username,cu.username,'') COLLATE NOCASE" };
    const sortCol = sortMap[q.sort] || 'n.number';
    const dir = String(q.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    sendPagedStreaming(res,
      { total, page, limit, totalPages, role_max: roleCap, count_source: 'fast_database_count' },
      `${numberSelectSql(query.where)} ORDER BY ${sortCol} ${dir}, n.id ASC LIMIT ? OFFSET ?`,
      [...query.params, limit, offset], null);
  } catch (e) { console.warn('numbers stream failed', e.message); if (res.headersSent) { try { res.end(); } catch (_) {} } else res.status(500).json({ error: 'Query failed' }); }
});

app.get('/api/numbers', authRequired, (req, res) => cachedJson(req, res, 60000, () => {
  const query = buildNumberQuery(req.user, req.query || {});

  // PHASE-1 (#1/#6): COUNT runs on the SAME conditional-JOIN path as filters —
  // no display JOINs. Measured [audit]: 35 s → sub-second at 30M rows; with the
  // version-key cache below, repeat loads are ~0 ms.
  const countFrom = numberFromSql(query.where, query.need);
  const total = +(db.get(`SELECT COUNT(*) AS c ${countFrom}`, query.params)?.c || 0);

  const paged = req.query.paged || req.query.page || req.query.limit;
  const roleCap = rolePageMax(req.user.role); /* P11: per-role ceiling, clamped below */
  if (paged) {
    const requestedLimitRaw = String(req.query.limit || NUMBER_PAGE_DEFAULT);
    const isAll = requestedLimitRaw.toLowerCase() === 'all';
    const hardCap = isAll ? (ROLE_ALL_MAX[req.user.role] || roleCap) : roleCap;
    const requestedLimit = isAll ? Math.max(1, Math.min(total || 1, hardCap)) : parsePositiveInt(requestedLimitRaw, NUMBER_PAGE_DEFAULT);
    const limit = Math.min(hardCap, Math.max(1, requestedLimit));
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
    const requestedPage = parsePositiveInt(req.query.page || '1', 1);
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const offset = (page - 1) * limit;
    const sortMap = { range:'r.name COLLATE NOCASE', prefix:'n.prefix COLLATE NOCASE', number:'n.number', myVal:"CAST(COALESCE(NULLIF(n.rate,''),'0') AS REAL)", payVal:"CAST(COALESCE(NULLIF(n.payout,''),'0') AS REAL)", manager:'mu.username COLLATE NOCASE', agent:'au.username COLLATE NOCASE', client:'cu.username COLLATE NOCASE', owner:"COALESCE(mu.username,au.username,cu.username,'') COLLATE NOCASE" };
    const sortCol = sortMap[req.query.sort] || 'n.number';
    const dir = String(req.query.dir||'asc').toLowerCase()==='desc'?'DESC':'ASC';
    const withLastSms = String(req.query.last_sms || req.query.include_last_sms || '') === '1';
    const rows = db.all(`${numberSelectSql(query.where, { lastSms: withLastSms })} ORDER BY ${sortCol} ${dir}, n.id ASC LIMIT ? OFFSET ?`, [...query.params, limit, offset]);
    return { rows, total, page, limit, totalPages, role_max: roleCap, count_source: 'fast_database_count', capped: total > limit * totalPages && total > hardCap ? hardCap : undefined };
  }

  let rows = db.all(`${numberSelectSql(query.where)} ORDER BY n.number ASC`, query.params);
  /* P11: legacy full-list path capped for non-admin roles (admin keeps legacy full dump for exports) */
  if (req.user.role !== 'admin' && rows.length > roleCap) rows = rows.slice(0, roleCap);
  return rows;
}, 'numbers_ver'));

// allocate selected numbers to a target user (one level down)
function handleAllocate(req, res) {
  const { ids, target_id, payterm, payout } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !target_id)
    return res.status(400).json({ error: 'ids[] and target_id are required' });

  // PHASE-1 (#45.6): idempotent retries — same Idempotency-Key returns the
  // original response instead of double-processing.
  const idemKey = String(req.headers['idempotency-key'] || '').slice(0, 100);
  if (idemKey) {
    try {
      const prev = db.get('SELECT * FROM idempotency_keys WHERE key=?', [idemKey]);
      if (prev) {
        if (prev.user_id !== (req.user.id || 0) || prev.endpoint !== 'allocate')
          return res.status(409).json({ error: 'Idempotency-Key already used for a different user/endpoint' });
        if (prev.response_json) return res.json(JSON.parse(prev.response_json));
      }
    } catch (_) {}
  }

  const target = db.get('SELECT * FROM users WHERE id=?', [target_id]);
  if (!target) return res.status(404).json({ error: 'Target not found' });

  const allowedTargets = { admin: ['manager','agent'], manager: ['agent'], agent: ['client'] }[req.user.role] || [];
  if (!allowedTargets.includes(target.role))
    return res.status(403).json({ error: 'You are not allowed to allocate to this role' });
  // Managers/Agents can allocate only to their direct child. Admin can allocate directly to any Manager or Agent.
  if (req.user.role !== 'admin' && target.parent_id !== req.user.id)
    return res.status(403).json({ error: 'You can only allocate to your direct child user' });

  let sets = '', vals = [];
  if (target.role === 'manager') {
    // Admin -> Manager: reset downstream ownership so old Agent/Client links do not remain.
    sets = "manager_id=?, agent_id=NULL, client_id=NULL, payout='0', rate=''";
    vals = [target.id];
  } else if (target.role === 'agent') {
    // Manager -> Agent keeps manager chain. Admin -> Agent direct has no manager owner.
    const mgrId = req.user.role === 'admin' ? null : target.parent_id;
    sets = "agent_id=?, manager_id=?, client_id=NULL, payout='0', rate=''";
    vals = [target.id, mgrId];
  } else if (target.role === 'client') {
    // Agent -> Client: snapshot chain for future SMS.
    const agentId = target.parent_id;
    const mgrId = agentId ? (db.get('SELECT parent_id FROM users WHERE id=?', [agentId])?.parent_id || null) : null;
    sets = 'client_id=?, agent_id=?, manager_id=?';
    vals = [target.id, agentId, mgrId];
  }
  /* P12 PAYMENT FIX: cycle sirf IS allocation par (numbers.payterm). Agent ka global
     users.payment_type default ab allocation se OVERWRITE NAHI hota — wo sirf Agent
     settings (PUT /api/users/:id) se badalta hai. Purana line (rollback):
     try{ db.run('UPDATE users SET payment_type=? WHERE id=? AND role=\'agent\'',[pt,target.id]); }catch(e){} */
  if (target.role === 'agent' && payterm) { const pt=normalizePaymentCycle(payterm); sets += ', payterm=?'; vals.push(pt); }
  // Rate lock rule: Admin->Manager and Manager->Agent must keep the existing/Admin rate.
  // Only Agent->Client can set/change client payout.
  if (req.user.role === 'agent' && payout !== undefined && payout !== '') { sets += ', payout=?'; vals.push(String(payout)); }

  // PHASE-1 (#21–#25): transactional, guarded, chunk-free allocation.
  //  - temp table instead of WHERE id IN (?,?,…) → SQLite 32,761 variable
  //    limit is GONE (50k+ ids work — measured [audit] HTTP 500 before).
  //  - caller-scope guard: you can only touch numbers inside your own tree.
  //  - ownership guard: only unallocated numbers (or numbers already owned by
  //    this target) are assigned — silent ownership steal is impossible.
  //    Explicit force=true (owner of the numbers / admin) reassigns within
  //    their own scope and is audit-logged.
  //  - single BEGIN IMMEDIATE transaction → concurrent duplicate requests can
  //    no longer both "succeed" (race condition [audit-confirmed] fixed).
  const slotCol = { manager: 'manager_id', agent: 'agent_id', client: 'client_id' }[target.role];
  const force = truthy(req.body && req.body.force) && slotCol !== undefined; // callers are never clients, but stay defensive
  const scope = numberScope(req.user, 'n');
  const ownGuard = force ? '1=1'
    : `((n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL) OR n.${slotCol}=?)`;

  const TEMP = 'tmp_alloc_ids';
  let allocatedCount = 0;
  try {
    if (!db.inTransaction()) db.exec('BEGIN IMMEDIATE');
    db.execNoSave(`DROP TABLE IF EXISTS ${TEMP}`);
    db.execNoSave(`CREATE TEMP TABLE ${TEMP} (id INTEGER PRIMARY KEY)`);
    const CHUNK = 5000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = [...new Set(ids.slice(i, i + CHUNK).map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0))];
      if (!chunk.length) continue;
      db.runNoSave(`INSERT OR IGNORE INTO ${TEMP} (id) VALUES ${chunk.map(() => '(?)').join(',')}`, chunk);
    }
    const beforeRows = db.all(`SELECT n.id, n.number, n.manager_id, n.agent_id, n.client_id
      FROM numbers n WHERE n.id IN (SELECT id FROM ${TEMP})`);
    if (!beforeRows.length) {
      db.execNoSave(`DROP TABLE IF EXISTS ${TEMP}`);
      if (db.inTransaction()) db.exec('COMMIT');
      return res.status(404).json({ error: 'No numbers found' });
    }
    const updParams = force ? [...vals, ...scope.params] : [...vals, ...scope.params, target.id];
    const upd = db.runNoSave(
      `UPDATE numbers AS n SET ${sets}
       WHERE n.id IN (SELECT id FROM ${TEMP}) AND (${scope.where}) AND ${ownGuard}`,
      updParams);
    allocatedCount = upd.changes || 0;
    // capture the post-state rows we actually own now (for history + response)
    const afterRows = db.all(`SELECT n.id, n.number, n.manager_id, n.agent_id, n.client_id
      FROM numbers n WHERE n.id IN (SELECT id FROM ${TEMP}) AND n.${slotCol}=?`, [target.id]);
    db.execNoSave(`DROP TABLE IF EXISTS ${TEMP}`);
    if (db.inTransaction()) db.exec('COMMIT');

    const conflictRows = beforeRows.filter(r => (r.manager_id || r.agent_id || r.client_id) && r[slotCol] !== target.id);
    // history only for rows this call actually set to the target (before-state kept)
    try {
      db.beginBatch();
      for (const nr of afterRows) logNumberHistory(req, nr, 'allocated', '', target.username, { target_role: target.role, forced: force || undefined });
    } finally { db.endBatch(); }

    const response = {
      ok: true,
      count: allocatedCount,                    // backward-compatible field
      requested: beforeRows.length,
      allocated: allocatedCount,
      skipped: Math.max(0, beforeRows.length - allocatedCount),
      ...(force && conflictRows.length ? { reassigned: conflictRows.length } : {}),
      ...(conflictRows.length && !force ? { conflicts_sample: conflictRows.slice(0, 10).map(r => ({ id: r.id, number: r.number })) } : {}),
    };
    logAction(req, 'allocate_numbers', 'numbers',
      { count: allocatedCount, requested: beforeRows.length, skipped: response.skipped, target: target.username, target_role: target.role, ...(force ? { force: true } : {}) });
    bumpNumbersVer();
    if (idemKey) idempotencyStore(req, 'allocate', idemKey, response);
    return res.json(response);
  } catch (e) {
    try { db.execNoSave(`DROP TABLE IF EXISTS ${TEMP}`); } catch (_) {}
    try { if (db.inTransaction()) db.exec('ROLLBACK'); } catch (_) {}
    console.error('[ALLOCATE] failed:', e.message);
    return res.status(500).json({ error: 'Allocation failed: ' + e.message });
  }
}

// unallocate selected numbers (clear the caller's ownership level downward, without changing old SMS snapshots)
app.post('/api/numbers/allocate', authRequired, (req, res) => { handleAllocate(req, res); });
app.post('/api/numbers/unallocate', authRequired, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });

  let where = '', params = [];
  let updateSql = '';
  if (req.user.role === 'admin') {
    where = `n.id IN (SELECT id FROM tmp_unalloc_ids)`;
    params = [];
    updateSql = `UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (SELECT id FROM tmp_unalloc_ids)`;
  } else if (req.user.role === 'manager') {
    where = `n.id IN (SELECT id FROM tmp_unalloc_ids) AND n.manager_id=?`;
    params = [req.user.id];
    updateSql = `UPDATE numbers SET agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (SELECT id FROM tmp_unalloc_ids) AND manager_id=?`;
  } else if (req.user.role === 'agent') {
    where = `n.id IN (SELECT id FROM tmp_unalloc_ids) AND n.agent_id=?`;
    params = [req.user.id];
    updateSql = `UPDATE numbers SET client_id=NULL, payout='0', rate='' WHERE id IN (SELECT id FROM tmp_unalloc_ids) AND agent_id=?`;
  } else {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // PHASE-1: temp table (no 32,761-variable limit) + single transaction +
  // per-caller scope guard already built into the UPDATE conditions.
  let count = 0;
  try {
    if (!db.inTransaction()) db.exec('BEGIN IMMEDIATE');
    db.execNoSave('DROP TABLE IF EXISTS tmp_unalloc_ids');
    db.execNoSave('CREATE TEMP TABLE tmp_unalloc_ids (id INTEGER PRIMARY KEY)');
    const CHUNK = 5000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = [...new Set(ids.slice(i, i + CHUNK).map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0))];
      if (!chunk.length) continue;
      db.runNoSave(`INSERT OR IGNORE INTO tmp_unalloc_ids (id) VALUES ${chunk.map(() => '(?)').join(',')}`, chunk);
    }
    const beforeRows = db.all(`SELECT n.id,n.number,n.manager_id,n.agent_id,n.client_id FROM numbers n WHERE ${where}`, params);
    if (!beforeRows.length) {
      db.execNoSave('DROP TABLE IF EXISTS tmp_unalloc_ids');
      if (db.inTransaction()) db.exec('COMMIT');
      return res.status(404).json({ error: 'No matching allocated numbers found' });
    }
    const upd = db.runNoSave(updateSql, params);
    count = upd.changes || count;
    db.execNoSave('DROP TABLE IF EXISTS tmp_unalloc_ids');
    if (db.inTransaction()) db.exec('COMMIT');
    try {
      db.beginBatch();
      for (const nr of beforeRows) logNumberHistory(req, nr, 'unallocated', '', '', 'Unallocate selected numbers');
    } finally { db.endBatch(); }
    logAction(req, 'unallocate_numbers', 'numbers', { count, role: req.user.role });
    bumpNumbersVer();
    res.json({ ok: true, count });
  } catch (e) {
    try { db.execNoSave('DROP TABLE IF EXISTS tmp_unalloc_ids'); } catch (_) {}
    try { if (db.inTransaction()) db.exec('ROLLBACK'); } catch (_) {}
    console.error('[UNALLOCATE] failed:', e.message);
    return res.status(500).json({ error: 'Unallocate failed: ' + e.message });
  }
});

function truthy(v) { return v === true || v === 1 || v === '1' || String(v || '').toLowerCase() === 'true' || String(v || '').toLowerCase() === 'yes'; }
function deleteNumbersFromRows(rows, req, action, details = {}, deleteSms = false) {
  const cleanRows = (rows || [])
    .map(r => ({ id: parseInt(r.id, 10), number: String(r.number || '') }))
    .filter(r => Number.isFinite(r.id) && r.id > 0);
  const count = cleanRows.length;
  if (!count) return { deleted: 0, deleted_sms: 0, preserved_sms: 0, vacuum: false };

  let smsCount = 0;
  try {
    db.execNoSave('BEGIN TRANSACTION');
    db.execNoSave('DROP TABLE IF EXISTS tmp_delete_numbers');
    db.execNoSave('CREATE TEMP TABLE tmp_delete_numbers (id INTEGER PRIMARY KEY, number TEXT)');
    for (const r of cleanRows) db.runNoSave('INSERT OR IGNORE INTO tmp_delete_numbers (id,number) VALUES (?,?)', [r.id, r.number]);

    // Count linked SMS records. Delete them only when the caller explicitly asks.
    // number text match covers old SMS rows where number_id was not populated.
    smsCount = db.get(`SELECT COUNT(*) c FROM sms_records
      WHERE number_id IN (SELECT id FROM tmp_delete_numbers)
         OR number IN (SELECT number FROM tmp_delete_numbers WHERE number<>'')`)?.c || 0;
    if (deleteSms) {
      db.runNoSave(`DELETE FROM sms_records
        WHERE number_id IN (SELECT id FROM tmp_delete_numbers)
           OR number IN (SELECT number FROM tmp_delete_numbers WHERE number<>'')`);
    }
    db.runNoSave('DELETE FROM numbers WHERE id IN (SELECT id FROM tmp_delete_numbers)');
    db.execNoSave('DROP TABLE IF EXISTS tmp_delete_numbers');
    db.execNoSave('COMMIT');
    db.save();
  } catch (e) {
    try { db.execNoSave('ROLLBACK'); } catch (_) {}
    throw e;
  }

  // Do not VACUUM after every delete; it rewrites the whole DB and makes small delete/range actions feel frozen.
  const vacuum = false;
  logAction(req, action, 'numbers', { ...details, count, linkedSms: smsCount, deleteSms: !!deleteSms });
  bumpNumbersVer();
  return { deleted: count, deleted_sms: deleteSms ? smsCount : 0, preserved_sms: deleteSms ? 0 : smsCount, vacuum };
}
function deleteNumbersFromSelect(selectSql, params = [], req, action, details = {}, deleteSms = false) {
  const rows = db.all(selectSql, params);
  return deleteNumbersFromRows(rows, req, action, details, deleteSms);
}
function deleteNumbersWhere(whereSql, params = [], req, action, details = {}, deleteSms = false) {
  return deleteNumbersFromSelect(`SELECT id, number FROM numbers WHERE ${whereSql}`, params, req, action, details, deleteSms);
}

// hard delete selected numbers (Admin only). This is not a soft-delete, so no "Deleted" rows remain in lists.
app.post('/api/numbers/delete', authRequired, requireRole('admin'), (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : [])
    .map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const uniqueIds = [...new Set(ids)];
  const ph = uniqueIds.map(() => '?').join(',');
  const result = deleteNumbersWhere(`id IN (${ph})`, uniqueIds, req, 'delete_selected_numbers', { requested: ids.length }, truthy(req.body?.delete_sms));
  res.json({ ok: true, ...result });
});

// Move selected live SMS Numbers into Test Panel numbers.
// This removes them from live numbers table and keeps only range + number in range_test_numbers.
app.post('/api/numbers/move-to-test', authRequired, requireRole('admin'), (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : [])
    .map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const uniqueIds = [...new Set(ids)];
  const ph = uniqueIds.map(() => '?').join(',');
  const rows = db.all(`SELECT n.id,n.number,n.range_id,r.name AS range_name FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE n.id IN (${ph})`, uniqueIds);
  if (!rows.length) return res.status(404).json({ error: 'No matching numbers found' });

  let moved = 0, skipped = 0, deletedFromLive = 0;
  const seenCleaned = new Set();
  const affectedRanges = new Set();
  for (const n of rows) {
    const cleaned = cleanPhone(n.number);
    if (!cleaned || !n.range_id) { skipped++; continue; }
    if (seenCleaned.has(cleaned)) { skipped++; continue; }
    seenCleaned.add(cleaned);
    const existsTest = db.get(`SELECT id FROM range_test_numbers
      WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [n.range_id, cleaned]);
    if (!existsTest) {
      db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [n.range_id, n.number]);
    }
    const liveCount = db.get(`SELECT COUNT(*) c FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned])?.c || 0;
    db.run(`DELETE FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
    deletedFromLive += liveCount;
    affectedRanges.add(n.range_id);
    moved++;
  }

  for (const rid of affectedRanges) {
    const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [rid]).map(x => x.test_number).join(', ');
    db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, rid]);
  }
  logAction(req, 'move_numbers_to_test_panel', 'numbers', { requested: ids.length, moved, skipped, deleted_from_live: deletedFromLive, ranges: [...affectedRanges] });
  res.json({ ok: true, moved, skipped, deleted_from_live: deletedFromLive, ranges: [...affectedRanges] });
});

// hard delete all numbers that match current filters/search/range (Admin only, DB-side, not current page only)
app.post('/api/numbers/delete-filtered', authRequired, requireRole('admin'), (req, res) => {
  const query = buildNumberQuery(req.user, req.body || {});
  const baseSql = numberSelectSql(query.where);
  const result = deleteNumbersFromSelect(`SELECT id, number FROM (${baseSql}) x`, query.params, req, 'delete_filtered_numbers', req.body || {}, truthy(req.body?.delete_sms));
  res.json({ ok: true, ...result });
});

// hard delete every number in the database (Admin only)
app.delete('/api/numbers/all', authRequired, requireRole('admin'), (req, res) => {
  const result = deleteNumbersWhere('1=1', [], req, 'delete_all_numbers', {}, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE status<>'deleted'`);
  res.json({ ok: true, ...result });
});

// hard delete all numbers for one range (Admin only)
app.delete('/api/numbers/range/:rangeId', authRequired, requireRole('admin'), (req, res) => {
  const rangeId = parsePositiveInt(req.params.rangeId, 0);
  if (!rangeId) return res.status(400).json({ error: 'Valid range id required' });
  const range = db.get('SELECT id,name FROM ranges WHERE id=?', [rangeId]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const result = deleteNumbersWhere('range_id=?', [rangeId], req, 'delete_range_numbers', { rangeId, range: range.name }, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE range_id=? AND status<>'deleted'`, [rangeId]);
  res.json({ ok: true, range_id: rangeId, range_name: range.name, ...result });
});

// unallocate a quantity from a range using the database directly (works even with server-side pagination).
app.post('/api/numbers/unallocate-by-range', authRequired, (req, res) => {
  const rangeId = parsePositiveInt(req.body?.range_id, 0);
  const qty = Math.min(NUMBER_PAGE_MAX, parsePositiveInt(req.body?.qty, 0));
  if (!rangeId || !qty) return res.status(400).json({ error: 'range_id and qty required' });
  if (!['admin','manager','agent'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });

  const scope = numberScope(req.user, 'n');
  const ownerCol = numberOwnerColumnForRole(req.user.role);
  const rows = db.all(`SELECT n.id,n.number,n.manager_id,n.agent_id,n.client_id
    FROM numbers n
    WHERE n.range_id=? AND ${scope.where} AND n.${ownerCol} IS NOT NULL
    ORDER BY n.id ASC LIMIT ?`, [rangeId, ...scope.params, qty]);
  if (!rows.length) return res.status(404).json({ error: 'Allocated numbers were not found' });
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');

  if (req.user.role === 'admin') db.run(`UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph})`, ids);
  else if (req.user.role === 'manager') db.run(`UPDATE numbers SET agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND manager_id=?`, [...ids, req.user.id]);
  else if (req.user.role === 'agent') db.run(`UPDATE numbers SET client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND agent_id=?`, [...ids, req.user.id]);

  rows.forEach(nr=>logNumberHistory(req,nr,'unallocated','','','Unallocate range quantity'));
  logAction(req,'unallocate_numbers_by_range','numbers',{rangeId,count:rows.length,role:req.user.role});
  res.json({ ok:true, count: rows.length });
});


function makeNumberJobId(){ return 'NUMJOB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase(); }
function setJob(job, patch){ Object.assign(job, patch, { updated_at: new Date().toISOString() }); return job; }
function sleepImmediate(){ return new Promise(resolve => setImmediate(resolve)); }
function chunkIds(ids, size=1000){ const out=[]; for(let i=0;i<ids.length;i+=size) out.push(ids.slice(i,i+size)); return out; }
function auditJobAction(user, action, module, details={}){
  try{ db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)', [user.id||null,user.username||'',user.role||'',action,module,safeJson(details),'background-job']); }catch(e){}
}
async function performSmartDivideJob(job){
  const { user, range_ids, target_ids, qty, payterm } = job;
  const wantRole = job.wantRole || { admin: 'manager', manager: 'agent', agent: 'client' }[user.role];
  const col = { manager: 'manager_id', agent: 'agent_id', client: 'client_id' }[wantRole];
  let ownerCond = '1=1', ownerParams = [];
  if (user.role === 'manager') { ownerCond = 'manager_id=?'; ownerParams = [user.id]; }
  else if (user.role === 'agent') { ownerCond = 'agent_id=?'; ownerParams = [user.id]; }
  /* P12 PAYMENT FIX: normalizePaymentCycle (pehle normalizePaymentType tha jo weekly_7_7 ko 'weekly' collapse kar deta tha — rollback: normalizePaymentType(payterm || 'weekly')) */
  const smartType = normalizePaymentCycle(payterm || 'weekly_7_1');
  setJob(job,{status:'processing',started_at:new Date().toISOString(),progress:0,processed:0,total:0,message:'Selecting numbers'});
  try{
    /* P12 PAYMENT FIX: users.payment_type overwrite removed — smart-divide cycle ab sirf allocated numbers ke payterm par (rollback: upar wala line). */
    const report=[]; let total=0; let planned=0;
    // First pass counts selected IDs and keeps pools in memory; avoids DB save per number.
    const rangePools=[];
    for(const rid of range_ids){
      const pool=db.all(`SELECT id FROM numbers WHERE range_id=? AND ${col} IS NULL AND ${ownerCond} LIMIT ?`, [rid, ...ownerParams, qty]).map(r=>r.id);
      rangePools.push({rid,pool}); planned += pool.length;
    }
    setJob(job,{total:planned,message:'Updating allocations'});
    // Process in chunks without a long transaction so other requests can run between chunks.
    for(const {rid,pool} of rangePools){
      const take=pool.length;
      const perBase=Math.floor(take/target_ids.length); let rem=take%target_ids.length, ptr=0;
      const split=target_ids.map(t=>{const c=perBase+(rem>0?1:0); if(rem>0)rem--; return {t,c};});
      for(const sp of split){
        const ids=pool.slice(ptr, ptr+sp.c); ptr += sp.c;
        for(const part of chunkIds(ids, 1000)){
          if(!part.length) continue;
          const ph=part.map(()=>'?').join(',');
          if(wantRole==='client'){
            const agt=db.get('SELECT parent_id FROM users WHERE id=?',[sp.t]);
            const mgr=agt?db.get('SELECT parent_id FROM users WHERE id=?',[agt.parent_id]):null;
            db.runNoSave(`UPDATE numbers SET client_id=?, agent_id=?, manager_id=? WHERE id IN (${ph})`, [sp.t, agt?agt.parent_id:null, mgr?mgr.parent_id:null, ...part]);
          } else if(wantRole==='agent'){
            const mgr=db.get('SELECT parent_id FROM users WHERE id=?',[sp.t]);
            const mgrId = user.role === 'admin' ? null : (mgr?mgr.parent_id:null);
            db.runNoSave(`UPDATE numbers SET agent_id=?, manager_id=?, client_id=NULL, payout='0', rate='', payterm=? WHERE id IN (${ph})`, [sp.t, mgrId, smartType, ...part]);
          } else {
            db.runNoSave(`UPDATE numbers SET manager_id=?, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph})`, [sp.t, ...part]);
          }
          total += part.length;
          setJob(job,{processed:total,progress:planned?Math.floor(total/planned*100):100});
          await sleepImmediate();
        }
      }
      const rname=db.get('SELECT name FROM ranges WHERE id=?',[rid]);
      report.push({range:rname?rname.name:rid,taken:take,split});
    }
    db.save(); clearApiReadCache();
    auditJobAction(user,'smart_divide_numbers_background','numbers',{total,report,payterm:smartType});
    setJob(job,{status:'done',progress:100,total,processed:total,report,completed_at:new Date().toISOString(),message:'Completed'});
    bumpNumbersVer();
  }catch(e){
    setJob(job,{status:'failed',error:e.message||String(e),completed_at:new Date().toISOString(),message:'Failed'});
  }
}
function validateSmartDivideTargets(user,wantRole,target_ids){
  for (const tid of target_ids) {
    const t = db.get('SELECT * FROM users WHERE id=?', [tid]);
    if (!t || t.role !== wantRole || (user.role !== 'admin' && t.parent_id !== user.id)) return false;
    if (user.role==='admin' && wantRole==='manager') continue;
    if (user.role==='admin' && wantRole==='agent') continue;
  }
  return true;
}
app.get('/api/number-jobs/:jobId', authRequired, (req,res)=>{
  const job=numberJobs.get(req.params.jobId);
  if(!job) return res.status(404).json({error:'Number job not found'});
  if(job.user.id!==req.user.id && req.user.role!=='admin') return res.status(403).json({error:'Not allowed'});
  const {user, ...safe}=job;
  res.json(safe);
});

// smart divide: multi-range + multi-target, split UNALLOCATED evenly
app.post('/api/numbers/smart-divide', authRequired, async (req, res) => {
  const { range_ids, target_ids, qty, payterm, background } = req.body || {};
  if (!Array.isArray(range_ids) || !range_ids.length || !Array.isArray(target_ids) || !target_ids.length || !qty)
    return res.status(400).json({ error: 'range_ids[], target_ids[], qty required' });
  const cleanRangeIds=range_ids.map(x=>parseInt(x,10)).filter(x=>x>0);
  const cleanTargetIds=target_ids.map(x=>parseInt(x,10)).filter(x=>x>0);
  const cleanQty=Math.max(1, Math.min(parseInt(qty,10)||0, NUMBER_PAGE_MAX));
  let wantRole = { manager: 'agent', agent: 'client' }[req.user.role];
  if (req.user.role === 'admin') {
    const roles=[...new Set(cleanTargetIds.map(id=>db.get('SELECT role FROM users WHERE id=?',[id])?.role).filter(Boolean))];
    if(roles.length!==1 || !['manager','agent'].includes(roles[0])) return res.status(403).json({ error: 'Admin target must be all Managers or all Agents' });
    wantRole=roles[0];
  }
  if(!wantRole) return res.status(403).json({error:'Not allowed'});
  if(!validateSmartDivideTargets(req.user,wantRole,cleanTargetIds)) return res.status(403).json({ error: 'Invalid target(s)' });
  const estimated=cleanRangeIds.length*cleanQty;
  const shouldBackground = background !== false && estimated >= 1000;
  const job={job_id:makeNumberJobId(),type:'smart_divide',status:'queued',progress:0,processed:0,total:estimated,user:{id:req.user.id,username:req.user.username,role:req.user.role},wantRole,range_ids:cleanRangeIds,target_ids:cleanTargetIds,qty:cleanQty,payterm:normalizePaymentCycle(payterm||'weekly_7_1'),created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  numberJobs.set(job.job_id, job);
  setImmediate(()=>performSmartDivideJob(job));
  if(shouldBackground){
    const {user,...safe}=job;
    return res.json({ok:true,background:true,job_id:job.job_id,job:safe,message:'Number allocation started in background'});
  }
  // Small jobs: wait for completion but still yield internally so event loop stays responsive.
  while(['queued','processing'].includes(job.status)) await new Promise(r=>setTimeout(r,50));
  if(job.status==='failed') return res.status(500).json({ok:false,error:job.error||'Job failed',job_id:job.job_id});
  res.json({ok:true,total:job.total||0,report:job.report||[],job_id:job.job_id});
});


/* ============ SMS RECORDS / CDR STATS ============ */
function buildSmsPagedQuery(user, q = {}) {
  const scope = smsScopeWhere(user, 's');
  const where = [scope.where, 'COALESCE(s.is_test,0)=0'];
  const params = [...scope.params];
  if (q.from) { const start = ukLocalDateToUtcSql(String(q.from), 0); if (start) { where.push('s.received_at >= ?'); params.push(start); } }
  if (q.to) { const end = ukLocalDateToUtcSql(String(q.to), 1); if (end) { where.push('s.received_at < ?'); params.push(end); } }
  if (q.range) { where.push('r.name=?'); params.push(String(q.range)); }
  if (q.range_id) { where.push('s.range_id=?'); params.push(+q.range_id); }
  if (q.number) { where.push('s.number=?'); params.push(String(q.number)); }
  if (q.cli) { where.push('s.cli=?'); params.push(String(q.cli)); }
  if (q.manager) { where.push('mu.username=?'); params.push(String(q.manager)); }
  if (q.agent) { where.push('au.username=?'); params.push(String(q.agent)); }
  if (q.client) { where.push('cu.username=?'); params.push(String(q.client)); }
  if (q.search) {
    const term = String(q.search).trim();
    // PHASE-3 FIX: columns are wrapped in LOWER() and case_sensitive_like=ON
    // (Phase-1), so the param MUST be lowercased too — mixed-case params were
    // silently matching nothing (latent bug, digits-only searches hid it).
    const v = `%${term.toLowerCase()}%`;
    // PHASE-3: with the FTS index ready, message matching uses the trigram
    // index instead of a full-scan LIKE. Same 7-column OR semantics, same
    // response shape. Without FTS (default) this is byte-identical to before.
    if (smsFts.enabled() && smsFts.isReady() && term.length >= 3) {
      where.push(`(LOWER(s.number) LIKE ? OR LOWER(s.cli) LIKE ? OR s.id IN (SELECT rowid FROM sms_fts WHERE sms_fts MATCH ?) OR LOWER(COALESCE(r.name,'')) LIKE ? OR LOWER(COALESCE(mu.username,'')) LIKE ? OR LOWER(COALESCE(au.username,'')) LIKE ? OR LOWER(COALESCE(cu.username,'')) LIKE ?)`);
      params.push(v, v, smsFts.matchClause(term), v, v, v, v);
    } else {
      where.push(`(LOWER(s.number) LIKE ? OR LOWER(s.cli) LIKE ? OR LOWER(s.message) LIKE ? OR LOWER(COALESCE(r.name,'')) LIKE ? OR LOWER(COALESCE(mu.username,'')) LIKE ? OR LOWER(COALESCE(au.username,'')) LIKE ? OR LOWER(COALESCE(cu.username,'')) LIKE ?)`);
      params.push(v, v, v, v, v, v, v);
    }
  }
  const baseSql = `FROM sms_records s
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN sharing_users su ON su.agent_user_id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE ${where.join(' AND ')}`;
  return { baseSql, params };
}
/* P11: streaming big-page route (must stay registered ABOVE the cached small-page route). */
app.get('/api/sms/paged', authRequired, (req, res, next) => {
  const q = req.query || {};
  const limitRaw0 = String(q.limit || '25');
  const isAllReq = limitRaw0.toLowerCase() === 'all';
  const numericReq = parseInt(limitRaw0, 10) || 0;
  const smsRoleCap = rolePageMax(req.user.role);
  const bigLimit = isAllReq ? (ROLE_ALL_MAX[req.user.role] || smsRoleCap)
                 : (numericReq > STREAM_JSON_MAX_ROWS ? Math.min(numericReq, smsRoleCap) : 0);
  if (!bigLimit) return next();
  try {
    const built = buildSmsPagedQuery(req.user, q);
    /* one combined scan for COUNT + totalPayment (was two identical scans per page) */
    const agg = db.get(`SELECT COUNT(*) c, COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) p ${built.baseSql}`, built.params) || {};
    const total = +(agg.c || 0);
    const totalPayment = normalizeDecimalString(agg.p || '0') || '0';
    const limit = isAllReq ? Math.min(bigLimit, Math.max(1, total || 1)) : bigLimit;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, parseInt(q.page || '1', 10) || 1), totalPages);
    const offset = (page - 1) * limit;
    const sortMap = { date:'s.received_at', number:'s.number', cli:'s.cli', range:'r.name', manager:'mu.username', agent:'au.username', client:'cu.username', payout:"CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)" };
    const sortCol = sortMap[q.sort] || 's.received_at';
    const dir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    sendPagedStreaming(res,
      { total, page, limit, totalPages, totalPayment },
      `SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
          n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
          cu.username AS client_name, COALESCE(su.panel_name, au.username) AS agent_name, au.username AS agent_username, su.panel_name AS sharing_panel_name, su.id AS sharing_user_id, mu.username AS manager_name
        ${built.baseSql}
        ORDER BY ${sortCol} ${dir}, s.id DESC LIMIT ? OFFSET ?`,
      [...built.params, limit, offset], (row) => attachSmsPayoutFields([row])[0]);
  } catch (e) { console.warn('sms stream failed', e.message); if (res.headersSent) { try { res.end(); } catch (_) {} } else res.status(500).json({ error: 'Query failed' }); }
});

app.get('/api/sms/paged', authRequired, (req, res) => cachedJson(req, res, 1200, () => {
  const q = req.query || {};
  const built = buildSmsPagedQuery(req.user, q);
  const total = +(db.get(`SELECT COUNT(*) c ${built.baseSql}`, built.params)?.c || 0);
  const totalPayment = normalizeDecimalString(db.get(`SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) p ${built.baseSql}`, built.params)?.p || '0') || '0';
  const limitRaw = String(q.limit || '25');
  /* P11: role-based ceiling (was: numeric<=1000, all<=10000 for every role) */
  const smsRoleCap = rolePageMax(req.user.role);
  const limit = limitRaw.toLowerCase() === 'all' ? Math.max(1, Math.min(total || 1, ROLE_ALL_MAX[req.user.role] || smsRoleCap)) : Math.max(1, Math.min(parseInt(limitRaw || '25', 10) || 25, smsRoleCap));
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, parseInt(q.page || '1', 10) || 1), totalPages);
  const offset = (page - 1) * limit;
  const sortMap = { date:'s.received_at', number:'s.number', cli:'s.cli', range:'r.name', manager:'mu.username', agent:'au.username', client:'cu.username', payout:'CAST(COALESCE(NULLIF(s.payout_amount,\'\'),\'0\') AS REAL)' };
  const sortCol = sortMap[q.sort] || 's.received_at';
  const dir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // PHASE-2: additive keyset mode — pass &cursor=<lastRowId> to walk deep SMS
  // history in constant time (OFFSET on 10M+ rows is O(offset); cursor is O(1)
  // per page). Without cursor, behaviour is unchanged (page/offset as before).
  const cursor = parseInt(q.cursor, 10);
  if (Number.isFinite(cursor) && cursor > 0) {
    const cRows = db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
        n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
        cu.username AS client_name, COALESCE(su.panel_name, au.username) AS agent_name, au.username AS agent_username, su.panel_name AS sharing_panel_name, su.id AS sharing_user_id, mu.username AS manager_name
      ${built.baseSql} AND s.id < ?
      ORDER BY s.id DESC LIMIT ?`, [...built.params, cursor, limit]);
    const nextCursor = cRows.length === limit ? cRows[cRows.length - 1].id : null;
    return { rows: attachSmsPayoutFields(cRows), total, page: 1, limit, totalPages: Math.max(1, Math.ceil(total / limit)), totalPayment, next_cursor: nextCursor, cursor_mode: true };
  }
  const rows = db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
      n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
      cu.username AS client_name, COALESCE(su.panel_name, au.username) AS agent_name, au.username AS agent_username, su.panel_name AS sharing_panel_name, su.id AS sharing_user_id, mu.username AS manager_name
    ${built.baseSql}
    ORDER BY ${sortCol} ${dir}, s.id DESC LIMIT ? OFFSET ?`, [...built.params, limit, offset]);
  return { rows: attachSmsPayoutFields(rows), total, page, limit, totalPages, totalPayment };
}));
app.get('/api/stats-summary/:by', authRequired, (req, res) => cachedJson(req, res, 1500, () => {
  const by = req.params.by;
  const built = buildSmsPagedQuery(req.user, req.query || {});
  const groupMap = {
    client: { expr:'cu.username', label:'client_name' },
    agent: { expr:'au.username', label:'agent_name' },
    manager: { expr:'mu.username', label:'manager_name' },
    range: { expr:'r.name', label:'range_name' },
    number: { expr:'s.number', label:'number' },
    cli: { expr:'s.cli', label:'cli' }
  };
  const g = groupMap[by];
  if (!g) { res.status(400); return { error: 'Invalid stats dimension' }; }
  const extra = ['client','agent','manager'].includes(by) ? ` AND ${g.expr} IS NOT NULL AND ${g.expr}<>''` : '';
  const rows = db.all(`SELECT ${g.expr} AS key, COUNT(*) AS sms,
      COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) AS payment
    ${built.baseSql}${extra}
    GROUP BY ${g.expr}
    HAVING key IS NOT NULL AND key<>''
    ORDER BY sms DESC, key ASC`, built.params).map(r => ({...r, payment: normalizeDecimalString(r.payment)||'0'}));
  const totalSms = rows.reduce((a,r)=>a+(+r.sms||0),0);
  const totalPayment = rows.reduce((a,r)=>decimalAdd(a,r.payment||'0'),'0');
  return { rows, totalSms, totalPayment, by };
}));
// Legacy bulk endpoint kept for the summary widgets. Capped (see
// smsRowsForScope) and cached, because panels re-call it on every page click.
app.get('/api/sms', authRequired, (req, res) => cachedJson(req, res, 2500, () => {
  return smsRowsForScope(req.user);
}));

// aggregated stats by dimension
app.get('/api/stats/:by', authRequired, (req, res) => {
  const by = req.params.by; // client|agent|manager|range|number
  const q = req.query || {};
  // PHASE-1 Step 4: SQL aggregation (old code pulled up to 5,000 rows into JS —
  // stats silently WRONG beyond the cap and slow at scale). Response shape unchanged:
  // { rows:[{key,sms,payment}], totalSms, totalPayment }
  const userDims = { client: 'client_id', agent: 'agent_id', manager: 'manager_id' };
  if (userDims[by]) {
    const col = userDims[by];
    const st = statsScope(req.user);
    const where = [`s.${col} > 0`]; // -1 sentinel rows excluded (matches old skip-empty behaviour)
    const params = [];
    if (st.col && st.col !== col) { where.push(`s.${st.col}=?`); params.push(...st.params); }
    else if (st.col === col) { where.push(`s.${st.col}=?`); params.push(...st.params); }
    if (q.from) { where.push('s.stat_date >= date(?)'); params.push(q.from); }
    if (q.to)   { where.push('s.stat_date <= date(?)'); params.push(q.to); }
    const rows = db.all(`SELECT u.username AS key, SUM(s.sms_count) AS sms, SUM(s.payout_sum) AS pay
      FROM sms_daily_stats s JOIN users u ON u.id = s.${col}
      WHERE ${where.join(' AND ')}
      GROUP BY s.${col}, u.username
      ORDER BY sms DESC`, params)
      .map(r => ({ key: r.key, sms: +(r.sms || 0), payment: normalizeDecimalString(r.pay) || '0' }));
    const totalSms = rows.reduce((a, r) => a + (+r.sms || 0), 0);
    const totalPayment = rows.reduce((a, r) => decimalAdd(a, r.payment || '0'), '0');
    return res.json({ rows, totalSms, totalPayment });
  }
  // range / number dimensions: SQL GROUP BY directly on sms_records (scope-indexed)
  const g = { range: { expr: "COALESCE(r.name,'—')", label: 'range_name' }, number: { expr: 's.number', label: 'number' } }[by];
  if (!g) return res.status(400).json({ error: 'Invalid stats dimension' });
  const built = buildSmsPagedQuery(req.user, q);
  const dr = dateRangeWhere(q, 's');
  const rows = db.all(`SELECT ${g.expr} AS key, COUNT(*) AS sms,
      COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) AS pay
    ${built.baseSql}
    GROUP BY ${g.expr}
    ORDER BY sms DESC
    LIMIT 50000`, [...built.params, ...dr.params])
    .map(r => ({ key: r.key, sms: +(r.sms || 0), payment: normalizeDecimalString(r.pay) || '0' }));
  const totalSms = rows.reduce((a, r) => a + (+r.sms || 0), 0);
  const totalPayment = rows.reduce((a, r) => decimalAdd(a, r.payment || '0'), '0');
  return res.json({ rows, totalSms, totalPayment });
});


/* ============ CLI SEARCH & ANALYTICS ============ */
function cliSearchScope(user, alias='s') {
  if (!['admin','manager'].includes(user.role)) return null;
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function hasCustomDate(q){ return !!(q.from || q.to); }
function dateRangeWhere(q, alias='s') {
  const p = alias ? alias + '.' : '';
  const where=[]; const params=[];
  const dExpr=ukDateExpr(`${p}received_at`);
  if(q.from){ where.push(`${dExpr} >= date(?)`); params.push(q.from); }
  if(q.to){ where.push(`${dExpr} <= date(?)`); params.push(q.to); }
  return { where: where.length ? where.join(' AND ') : '1=1', params };
}
function cliBaseWhere(user, cli, q, alias='s') {
  const scope=cliSearchScope(user, alias);
  if(!scope) return null;
  const dr=dateRangeWhere(q, alias);
  const p=alias ? alias+'.' : '';
  const where=[scope.where, `${p}cli=?`, dr.where];
  return { where: where.join(' AND '), params:[...scope.params, cli, ...dr.params] };
}
app.get('/api/cli-search/suggestions', authRequired, requireRole('admin','manager'), (req,res)=>{
  const prefix=String(req.query.q||'').trim();
  if(!prefix) return res.json([]);
  const scope=cliSearchScope(req.user,'s');
  const rows=db.all(`SELECT s.cli AS cli, COUNT(*) AS count
    FROM sms_records s
    WHERE ${scope.where} AND s.cli IS NOT NULL AND s.cli<>'' AND LOWER(s.cli) LIKE ?
    GROUP BY s.cli
    ORDER BY count DESC, s.cli ASC
    LIMIT 20`, [...scope.params, prefix+'%']);
  res.json(rows);
});
app.get('/api/cli-search', authRequired, requireRole('admin','manager'), (req,res)=>{
  const cli=String(req.query.cli||'').trim();
  if(!cli) return res.status(400).json({error:'CLI is required'});
  const custom=hasCustomDate(req.query);
  const base=cliBaseWhere(req.user, cli, req.query, 's');
  if(!base) return res.status(403).json({error:'Forbidden'});
  const countWhere=(extra, extraParams=[]) => db.get(`SELECT COUNT(*) AS c FROM sms_records s WHERE ${base.where} ${extra?(' AND '+extra):''}`, [...base.params, ...extraParams])?.c||0;
  let summary;
  if(custom){
    summary={ selected_period: countWhere(''), from:req.query.from||'', to:req.query.to||'' };
  } else {
    summary={
      today: countWhere(`${ukDateExpr('s.received_at')}=${ukDateNowSql()}`),
      yesterday: countWhere(`${ukDateExpr('s.received_at')}=${ukDateNowSql('-1 day')}`),
      last7: countWhere(`${ukDateExpr('s.received_at')} >= ${ukDateNowSql('-6 days')}`),
      month: countWhere(`strftime('%Y-%m',${ukDateTimeExpr('s.received_at')})=strftime('%Y-%m',datetime('now','${ukSqlModifier()}'))`)
    };
  }
  let rangeRows;
  if(custom){
    rangeRows=db.all(`SELECT COALESCE(r.name,'Unknown') AS range_name, COUNT(*) AS total_count
      FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id
      WHERE ${base.where}
      GROUP BY s.range_id, r.name ORDER BY total_count DESC`, base.params);
  } else {
    rangeRows=db.all(`SELECT COALESCE(r.name,'Unknown') AS range_name,
      SUM(CASE WHEN ${ukDateExpr('s.received_at')}=${ukDateNowSql()} THEN 1 ELSE 0 END) AS today_count,
      SUM(CASE WHEN ${ukDateExpr('s.received_at')}=${ukDateNowSql('-1 day')} THEN 1 ELSE 0 END) AS yesterday_count
      FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id
      WHERE ${base.where}
      GROUP BY s.range_id, r.name ORDER BY today_count DESC, yesterday_count DESC`, base.params);
  }
  res.json({ cli, custom_date:custom, summary, ranges:rangeRows });
});

/* ============ DASHBOARD ============ */
function smsScopeWhere(user, alias = '') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function numberScopeWhere(user, alias = '') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
/* GALAXY: hierarchy counts for User Management lists (3 GROUP BYs + numbers
   counts via existing leading-column indexes; cached 30s — no N+1). */
app.get('/api/users/hierarchy-stats', authRequired, requireRole('admin', 'manager'), (req, res) => cachedJson(req, res, 30000, () => {
  const u = req.user;
  const out = { managers: {}, agents: {}, clients: {} };
  try {
    db.all(`SELECT parent_id pid, COUNT(*) c FROM users WHERE role='agent' AND parent_id IS NOT NULL GROUP BY 1`)
      .forEach(r => { out.managers[r.pid] = out.managers[r.pid] || { agents: 0, clients: 0, numbers: 0 }; out.managers[r.pid].agents = r.c; });
    db.all(`SELECT parent_id pid, COUNT(*) c FROM users WHERE role='client' AND parent_id IS NOT NULL GROUP BY 1`)
      .forEach(r => { out.agents[r.pid] = out.agents[r.pid] || { clients: 0, numbers: 0 }; out.agents[r.pid].clients = r.c; });
    db.all(`SELECT m.id mid, COUNT(*) c FROM users m JOIN users a ON a.role='agent' AND a.parent_id=m.id JOIN users cl ON cl.role='client' AND cl.parent_id=a.id WHERE m.role='manager' GROUP BY 1`)
      .forEach(r => { out.managers[r.mid] = out.managers[r.mid] || { agents: 0, clients: 0, numbers: 0 }; out.managers[r.mid].clients = r.c; });
    db.all(`SELECT manager_id pid, COUNT(*) c FROM numbers WHERE manager_id IS NOT NULL GROUP BY 1`)
      .forEach(r => { out.managers[r.pid] = out.managers[r.pid] || { agents: 0, clients: 0, numbers: 0 }; out.managers[r.pid].numbers = r.c; });
    db.all(`SELECT agent_id pid, COUNT(*) c FROM numbers WHERE agent_id IS NOT NULL GROUP BY 1`)
      .forEach(r => { out.agents[r.pid] = out.agents[r.pid] || { clients: 0, numbers: 0 }; out.agents[r.pid].numbers = r.c; });
    db.all(`SELECT client_id pid, COUNT(*) c FROM numbers WHERE client_id IS NOT NULL GROUP BY 1`)
      .forEach(r => { out.clients[r.pid] = out.clients[r.pid] || { numbers: 0 }; out.clients[r.pid].numbers = r.c; });
  } catch (e) {}
  if (u.role !== 'admin') {
    const ags = db.all(`SELECT id FROM users WHERE role='agent' AND parent_id=?`, [u.id]).map(x => x.id);
    const keepA = {}, keepC = {};
    ags.forEach(id => { keepA[id] = out.agents[id] || { clients: 0, numbers: 0 }; });
    if (ags.length) {
      const ph = ags.map(() => '?').join(',');
      db.all(`SELECT id FROM users WHERE role='client' AND parent_id IN (${ph})`, ags)
        .forEach(x => { keepC[x.id] = out.clients[x.id] || { numbers: 0 }; });
    }
    return { managers: {}, agents: keepA, clients: keepC };
  }
  return out;
}));

app.get('/api/dashboard', authRequired, (req, res) => cachedJson(req, res, 10000, () => {
  const u = req.user;
  const smsScope = smsScopeWhere(u);
  const numScope = numberScopeWhere(u);
  // PHASE-1 Step 4: counters now read the pre-aggregated sms_daily_stats table
  // (O(rows-of-today), never a sms_records scan). Same numbers, same keys.
  const st = statsScope(u);
  const stWhere = st.col ? ` AND ${st.col}=?` : '';
  const stP = st.params;
  const dToday = ukTodayDateStr(0), dYesterday = ukTodayDateStr(-1);
  const d7Start = ukTodayDateStr(-6);
  const monthStart = dToday.slice(0, 7) + '-01';
  const statSum = (extra, params = []) => db.get(
    `SELECT COALESCE(SUM(sms_count),0) c FROM sms_daily_stats WHERE 1=1${stWhere}${extra}`, [...stP, ...params])?.c || 0;
  const statPay = (extra, params = []) => normalizeDecimalString(db.get(
    `SELECT COALESCE(SUM(payout_sum),0) p FROM sms_daily_stats WHERE 1=1${stWhere}${extra}`, [...stP, ...params])?.p || 0) || '0';
  const today = statSum(` AND stat_date=?`, [dToday]);
  const yesterday = statSum(` AND stat_date=?`, [dYesterday]);
  const d7 = statSum(` AND stat_date BETWEEN ? AND ?`, [d7Start, dToday]);
  const month = statSum(` AND stat_date >= ? AND stat_date <= ?`, [monthStart, dToday]);
  const totalSmsStats = statSum('');
  const payout7 = statPay(` AND stat_date BETWEEN ? AND ?`, [d7Start, dToday]);
  const payoutMonth = statPay(` AND stat_date >= ? AND stat_date <= ?`, [monthStart, dToday]);
  const numbers = db.get(`SELECT COUNT(*) c FROM numbers WHERE ${numScope.where}`, numScope.params)?.c || 0;
  const managers = u.role === 'admin' ? (db.get(`SELECT COUNT(*) c FROM users WHERE role='manager'`)?.c || 0) : 0;
  let agents = 0, clients = 0;
  if (u.role === 'admin') {
    agents = db.get(`SELECT COUNT(*) c FROM users WHERE role='agent'`)?.c || 0;
    clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client'`)?.c || 0;
  } else if (u.role === 'manager') {
    agents = db.get(`SELECT COUNT(*) c FROM users WHERE role='agent' AND parent_id=?`, [u.id])?.c || 0;
    const ags = db.all(`SELECT id FROM users WHERE role='agent' AND parent_id=?`, [u.id]).map(x => x.id);
    if (ags.length) {
      const ph = ags.map(() => '?').join(',');
      clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client' AND parent_id IN (${ph})`, ags)?.c || 0;
    }
  } else if (u.role === 'agent') {
    clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client' AND parent_id=?`, [u.id])?.c || 0;
  }
  const daily7 = [];
  {
    const rows = db.all(`SELECT stat_date, SUM(sms_count) c FROM sms_daily_stats WHERE 1=1${stWhere} AND stat_date BETWEEN ? AND ? GROUP BY stat_date`, [...stP, d7Start, dToday]);
    const byDate = {}; rows.forEach(r => byDate[r.stat_date] = r.c || 0);
    for (let i = 6; i >= 0; i--) { const dayStr = ukTodayDateStr(-i); daily7.push({ date: dayStr, count: byDate[dayStr] || 0 }); }
  }
  const recentRows = db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45, n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type
    FROM sms_records s
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN ranges r ON r.id=s.range_id
    WHERE ${smsScopeWhere(u,'s').where} AND COALESCE(s.is_test,0)=0
    ORDER BY s.received_at DESC, s.id DESC LIMIT 5`, smsScopeWhere(u,'s').params);
  const recent = attachSmsPayoutFields(recentRows).map(r=>({received_at:r.received_at,number:r.number,cli:r.cli,message:r.message,range_name:r.range_name,payout_rate:r.payout_rate}));
  const totalSms = totalSmsStats;
  const successToday = today;
  let failedToday = 0, failedTotal = 0;
  try {
    if (u.role === 'admin') {
      failedToday = db.get(`SELECT COUNT(*) c FROM failed_sms_queue WHERE ${ukDayOffsetSql('created_at', 0)}`)?.c || 0;
      failedTotal = db.get('SELECT COUNT(*) c FROM failed_sms_queue')?.c || 0;
    } else {
      // PERFORMANCE: this used to be a correlated EXISTS subquery with
      // REPLACE() applied to BOTH sides. SQLite could not use either index for
      // the correlation, so it degenerated into
      //   SCAN failed_sms_queue x (search numbers for every single row)
      // On live data (105,571 failed rows x 24,557 numbers) that is billions of
      // string operations - measured at OVER 300 SECONDS and never completing,
      // twice per dashboard load. Admin never hit it (plain COUNT), which is
      // exactly why only the Admin panel worked while every other role froze
      // the whole server.
      //
      // Rewritten as an explicit JOIN so SQLite drives from
      // idx_numbers_<role>_range_number and probes
      // idx_failed_sms_number_clean. Same result, measured 84 ms.
      const nScope = numberScopeWhere(u, 'n');
      const cleanN = `REPLACE(REPLACE(REPLACE(REPLACE(n.number,'+',''),' ',''),'-',''),'_','')`;
      const cleanF = `REPLACE(REPLACE(REPLACE(REPLACE(f.number,'+',''),' ',''),'-',''),'_','')`;
      failedToday = db.get(`SELECT COUNT(*) c FROM failed_sms_queue f
        JOIN numbers n ON ${cleanN}=${cleanF}
        WHERE ${nScope.where} AND ${ukDayOffsetSql('f.created_at', 0)}`, nScope.params)?.c || 0;
      failedTotal = db.get(`SELECT COUNT(*) c FROM failed_sms_queue f
        JOIN numbers n ON ${cleanN}=${cleanF}
        WHERE ${nScope.where}`, nScope.params)?.c || 0;
    }
  } catch(e) {}
  /* ===== GALAXY: additive dashboard fields (existing keys unchanged) ===== */
  const smsYear = statSum(` AND stat_date >= ? AND stat_date <= ?`, [dToday.slice(0,4) + '-01-01', dToday]);
  const dowMon = (new Date(dToday + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0=Monday
  const payoutWeek = statPay(` AND stat_date BETWEEN ? AND ?`, [ukTodayDateStr(-dowMon), dToday]);
  let over_limit_today = 0, over_limit_week = 0, sms_by_country = [];
  try {
    const stCol = st.col ? ` AND s.${st.col}=?` : '';
    const stP2 = st.params;
    const overQ = (since) => db.get(`SELECT COUNT(*) c FROM (
        SELECT s.number_id nid, COUNT(*) c FROM sms_records s WHERE s.received_at >= ? AND s.number_id IS NOT NULL${stCol} GROUP BY s.number_id
      ) x JOIN numbers n ON n.id=x.nid WHERE CAST(n.sd_limit AS INTEGER)>0 AND x.c>=CAST(n.sd_limit AS INTEGER)`, [since, ...stP2])?.c || 0;
    over_limit_today = overQ(dToday + ' 00:00:00');
    over_limit_week = overQ(d7Start + ' 00:00:00');
  } catch(e) {}
  try {
    const E164 = require('./e164-country.json');
    const cleanNum = `REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')`;
    const since = dToday + ' 00:00:00';
    const agg = {};
    const addCount = (code, c) => { const hit = E164[code]; if (!hit) return; const k = hit[0]; agg[k] = agg[k] || { iso: hit[0], name: hit[1], count: 0 }; agg[k].count += c; };
    // length-2 country codes (no valid code starts with 1 or 7, so safe)
    db.all(`SELECT SUBSTR(${cleanNum},1,2) p, COUNT(*) c FROM sms_records s WHERE s.received_at >= ? GROUP BY 1`, [since])
      .forEach(r => addCount(r.p, r.c));
    // length-1 codes (1 = NANP, 7 = Russia)
    db.all(`SELECT SUBSTR(${cleanNum},1,1) p, COUNT(*) c FROM sms_records s WHERE s.received_at >= ? GROUP BY 1`, [since])
      .forEach(r => { if (r.p === '1' || r.p === '7') addCount(r.p, r.c); });
    sms_by_country = Object.values(agg).sort((a,b) => b.count - a.count);
  } catch(e) {}
  /* ===== /GALAXY ===== */
  return { sms_today: today, otp_today: today, successful_otp_today: successToday, failed_otp_today: failedToday, failed_sms_today: failedToday, total_sms: totalSms, failed_total: failedTotal, sms_yesterday: yesterday, sms_7d: d7, sms_month: month, payout_7d: payout7, payout_month: payoutMonth, managers, agents, clients, numbers, daily7, recent, sms_year: smsYear, payout_week: payoutWeek, over_limit_today, over_limit_week, sms_by_country };
}));


/* ============ NUMBER IMPORT (Admin only, background/batched) ============ */
function makeImportJobId(){return 'IMPORT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase();}
function normalizeNumberForImport(n){return String(n||'').trim();}
function getOrCreateRange(range_id, range_name, prefix, firstNumber){
  if(range_id) return +range_id;
  if(!range_name) throw new Error('range_id or range_name is required');
  const existing=db.get('SELECT id FROM ranges WHERE name=?',[range_name]);
  if(existing) return existing.id;
  db.run(`INSERT INTO ranges (name,prefix,test_number,currency) VALUES (?,?,?,?)`,[range_name,prefix||'', '', 'USD']);
  return db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1',[range_name]).id;
}
async function processNumberImportJob(jobId, payload, user){
  console.log('[IMPORT] started', { jobId, total: (payload.numbers||[]).length, range_name: payload.range_name || '', file_name: payload.file_name || '' });
  const job=importJobs.get(jobId);
  if(!job) return;
  try{
    const { range_id, range_name, prefix, numbers, payterm, payout, file_name } = payload;
    const rid=getOrCreateRange(range_id, range_name, prefix, numbers[0]);
    const range=db.get('SELECT name FROM ranges WHERE id=?',[rid]);
    db.run(`INSERT INTO number_import_batches (batch_id,range_id,range_name,file_name,total,status,created_by) VALUES (?,?,?,?,?,?,?)`,
      [jobId,rid,range?range.name:(range_name||''),file_name||'',numbers.length,'processing',user.id]);
    const batchSize=parseInt(process.env.IMPORT_BATCH_SIZE||'1000',10);
    let inserted=0, skipped=0, processed=0;
    for(let i=0;i<numbers.length;i+=batchSize){
      const chunk=numbers.slice(i,i+batchSize);
      db.execNoSave('BEGIN TRANSACTION');
      try{
        for(const raw of chunk){
          const number=normalizeNumberForImport(raw);
          processed++;
          if(!number){skipped++; continue;}
          if(db.get('SELECT id FROM numbers WHERE number=?',[number])){skipped++; continue;}
          db.runNoSave(`INSERT INTO numbers (range_id,number,prefix,payterm,payout,import_batch_id,import_source,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
            [rid,number,prefix||'',payterm||'Weekly',payout||'0',jobId,'file',user.id]);
          inserted++;
        }
        db.execNoSave('COMMIT');
        db.save();
      }catch(e){
        try{db.execNoSave('ROLLBACK');}catch(_){}
        throw e;
      }
      job.processed=processed; job.inserted=inserted; job.skipped=skipped; job.progress=Math.round((processed/numbers.length)*100);
      db.run(`UPDATE number_import_batches SET inserted=?, skipped=? WHERE batch_id=?`,[inserted,skipped,jobId]);
      await new Promise(r=>setTimeout(r,0));
    }
    job.status='done'; job.progress=100; job.completed_at=new Date().toISOString();
    console.log('[IMPORT] completed', { jobId, inserted, skipped, total: numbers.length });
    db.run(`UPDATE number_import_batches SET inserted=?, skipped=?, status='done', completed_at=datetime('now') WHERE batch_id=?`,[inserted,skipped,jobId]);
    logAction({user},'import_numbers_background','numbers',{jobId,inserted,skipped,range_id:rid});
  }catch(e){
    job.status='failed'; job.error=e.message;
    console.error('[IMPORT] failed', { jobId, error: e.message });
    db.run(`UPDATE number_import_batches SET status='failed', error=?, completed_at=datetime('now') WHERE batch_id=?`,[e.message,jobId]);
  }
}
// PHASE-2: streaming multipart import — large CSV/number files (up to 200 MB)
// are parsed line-by-line on the server; browsers no longer build a giant JSON body.
const uploadDisk = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post('/api/numbers/import-file', authRequired, requireRole('admin'), heavyWriteLimit, uploadDisk.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });
    const b = req.body || {};
    const range_name = String(b.range_name || '').trim();
    const range_id = b.range_id ? +b.range_id : 0;
    if (!range_id && !range_name) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ error: 'range_name required' }); }
    const jobId = makeImportJobId();
    const job = { job_id: jobId, status: 'queued', total: 0, processed: 0, inserted: 0, skipped: 0, progress: 0, error: '', created_at: new Date().toISOString() };
    importJobs.set(jobId, job);
    res.json({ ok: true, background: true, job });
    // background stream processing
    setImmediate(async () => {
      const readline = require('readline');
      const t0 = Date.now();
      let rid = 0, inserted = 0, skipped = 0, processed = 0;
      try {
        rid = getOrCreateRange(b.range_id ? +b.range_id : 0, range_name, b.prefix || '', '');
        db.run(`INSERT INTO number_import_batches (batch_id,range_id,range_name,file_name,total,status,created_by) VALUES (?,?,?,?,?,'processing',?)`,
          [jobId, rid, range_name, b.file_name || req.file.originalname || '', 0, (req.user && req.user.id) || null]);
        job.status = 'processing';
        const rl = readline.createInterface({ input: fs.createReadStream(req.file.path), crlfDelay: Infinity });
        let batch = [];
        const flush = () => {
          if (!batch.length) return;
          if (!db.inTransaction()) db.execNoSave('BEGIN IMMEDIATE');
          try {
            for (const number of batch) {
              processed++;
              if (db.get('SELECT id FROM numbers WHERE number=?', [number])) { skipped++; continue; }
              db.runNoSave(`INSERT INTO numbers (range_id,number,prefix,payterm,payout,import_batch_id,import_source,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
                [rid, number, b.prefix || '', b.payterm || 'Weekly', b.payout || '0', jobId, 'file', (req.user && req.user.id) || null]);
              inserted++;
            }
            db.execNoSave('COMMIT');
          } catch (e) { try { db.execNoSave('ROLLBACK'); } catch (_) {} throw e; }
          batch = [];
          job.processed = processed; job.inserted = inserted; job.skipped = skipped;
          job.total = processed; job.progress = 0; // total unknown until stream ends
        };
        for await (let line of rl) {
          line = String(line || '').trim();
          if (!line) continue;
          let tok = line.split(/[\t,;]/)[0].replace(/^["']+|["']+$/g, '').trim();
          const number = normalizeNumberForImport(tok);
          if (!number) { continue; }
          if (batch.length >= 1000) { flush(); await new Promise(r => setImmediate(r)); }
          batch.push(number);
        }
        flush();
        job.status = 'done'; job.progress = 100; job.completed_at = new Date().toISOString();
        db.run(`UPDATE number_import_batches SET total=?, inserted=?, skipped=?, status='done', completed_at=datetime('now') WHERE batch_id=?`,
          [processed, inserted, skipped, jobId]);
        logAction({ user: req.user }, 'import_numbers_file', 'numbers', { jobId, inserted, skipped, total: processed });
        bumpNumbersVer();
        console.log('[IMPORT-FILE] completed', { jobId, inserted, skipped, total: processed, s: ((Date.now() - t0) / 1000).toFixed(1) });
      } catch (e) {
        job.status = 'failed'; job.error = e.message;
        try { db.run(`UPDATE number_import_batches SET status='failed', error=?, completed_at=datetime('now') WHERE batch_id=?`, [e.message, jobId]); } catch (_) {}
        console.error('[IMPORT-FILE] failed:', e.message);
      } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/numbers/import', authRequired, requireRole('admin'), (req, res) => {
  const { range_id, range_name, prefix, numbers, payterm, payout, file_name } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers[] required' });
  const jobId=makeImportJobId();
  const job={job_id:jobId,status:'queued',total:numbers.length,processed:0,inserted:0,skipped:0,progress:0,error:'',created_at:new Date().toISOString()};
  importJobs.set(jobId,job);
  setImmediate(()=>processNumberImportJob(jobId,{range_id,range_name,prefix,numbers,payterm,payout,file_name},req.user));
  res.json({ok:true,background:true,job});
});
app.get('/api/numbers/import-jobs/:jobId', authRequired, requireRole('admin'), (req,res)=>{
  const job=importJobs.get(req.params.jobId);
  if(job) return res.json(job);
  const b=db.get('SELECT * FROM number_import_batches WHERE batch_id=?',[req.params.jobId]);
  if(!b) return res.status(404).json({error:'Import job not found'});
  res.json({job_id:b.batch_id,status:b.status,total:b.total,processed:b.inserted+b.skipped,inserted:b.inserted,skipped:b.skipped,progress:b.status==='done'?100:0,error:b.error,created_at:b.created_at,completed_at:b.completed_at});
});
app.get('/api/number-import-batches', authRequired, requireRole('admin'), (req,res)=>{
  const includeDeleted = String(req.query.include_deleted || '').toLowerCase() === '1' || String(req.query.include_deleted || '').toLowerCase() === 'true';
  const where = includeDeleted ? '1=1' : `status<>'deleted'`;
  res.json(db.all(`SELECT * FROM number_import_batches WHERE ${where} ORDER BY id DESC LIMIT 200`));
});
app.delete('/api/number-import-batches/:batchId', authRequired, requireRole('admin'), (req,res)=>{
  const batchId=req.params.batchId;
  const result = deleteNumbersWhere('import_batch_id=?', [batchId], req, 'delete_import_batch', { batchId }, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE batch_id=?`,[batchId]);
  res.json({ok:true,...result});
});
app.delete('/api/numbers/imported-all', authRequired, requireRole('admin'), (req,res)=>{
  const result = deleteNumbersWhere(`import_source='file' OR import_batch_id<>''`, [], req, 'delete_all_imported_numbers', {}, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE status<>'deleted'`);
  res.json({ok:true,...result});
});

/* ============ PAYMENTS ============ */


/* ============ PAYMENT V2 (separate payment system) ============ */
function paymentTypesSettings(){ return db.all('SELECT * FROM payment_v2_settings WHERE active=1 ORDER BY sort_order ASC').map(r=>({payment_type:r.payment_type,label:r.label,min_withdrawal:normalizeDecimalString(r.min_withdrawal)||'0'})); }
function agentPaymentSummary(agentId){
  return paymentTypesSettings().map(t=>{
    const available=paymentOpenBalance(agentId,t.payment_type,true), pending=paymentPendingAmount(agentId,t.payment_type), minimum=t.min_withdrawal;
    return {...t, available_balance:available, pending_amount:pending, minimum, can_request:cents(available)>=cents(minimum) && cents(available)>0 && cents(pending)===0};
  });
}
app.get('/api/payment-v2/settings', authRequired, requireRole('admin'), (req,res)=>res.json(paymentTypesSettings()));
app.put('/api/payment-v2/settings', authRequired, requireRole('admin'), (req,res)=>{
  const rows=Array.isArray(req.body?.settings)?req.body.settings:[];
  rows.forEach(r=>{ const t=normalizePaymentType(r.payment_type); db.run('UPDATE payment_v2_settings SET min_withdrawal=?, updated_at=datetime(\'now\') WHERE payment_type=?',[normalizeDecimalString(r.min_withdrawal)||'0',t]); paymentAudit(req,'update_minimum',{payment_type:t,amount:r.min_withdrawal,status:'settings'}); });
  res.json({ok:true,settings:paymentTypesSettings()});
});
app.get('/api/payment-v2/agent/summary', authRequired, requireRole('agent'), (req,res)=>res.json({agent_id:req.user.id, balances:agentPaymentSummary(req.user.id), wallet:db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id])||{wallet_address:'',network:'USDT_TRC20'}}));
app.get('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), (req,res)=>res.json(db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id])||{wallet_address:'',network:'USDT_TRC20'}));
app.put('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), (req,res)=>{
  const wallet=String(req.body?.wallet_address||'').trim(); if(!walletValid(wallet)) return res.status(400).json({error:'Invalid USDT TRC20 wallet. It should start with T and be 34 characters.'});
  const ex=db.get('SELECT agent_id FROM agent_wallets WHERE agent_id=?',[req.user.id]);
  if(ex) db.run('UPDATE agent_wallets SET wallet_address=?,network=\'USDT_TRC20\',updated_at=datetime(\'now\') WHERE agent_id=?',[wallet,req.user.id]);
  else db.run('INSERT INTO agent_wallets (agent_id,wallet_address,network) VALUES (?,?,\'USDT_TRC20\')',[req.user.id,wallet]);
  paymentAudit(req,'update_wallet',{agent_id:req.user.id,wallet_address:wallet,status:'saved'});
  res.json({ok:true,wallet_address:wallet,network:'USDT_TRC20'});
});
app.post('/api/payment-v2/agent/request', authRequired, requireRole('agent'), (req,res)=>{
  const type=normalizePaymentType(req.body?.payment_type); const wallet=db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id]);
  if(!wallet || !walletValid(wallet.wallet_address)) return res.status(400).json({error:'Save a valid USDT (TRC20) wallet first.'});
  if(db.get("SELECT id FROM payment_requests_v2 WHERE agent_id=? AND payment_type=? AND status='Pending'",[req.user.id,type])) return res.status(409).json({error:'A pending request already exists for this payment type.'});
  const amount=paymentOpenBalance(req.user.id,type,true); const min=paymentMinimum(type); if(cents(amount)<=0 || cents(amount)<cents(min)) return res.status(400).json({error:`Minimum withdrawal not reached. Available ${amount}, minimum ${min}.`});
  const rows=db.all("SELECT id FROM payment_ledger WHERE agent_id=? AND payment_type=? AND status='open' AND eligible_at<=?",[req.user.id,type,utcSqlFromMs(Date.now())]); if(!rows.length) return res.status(400).json({error:'No eligible balance found.'});
  try{ db.execNoSave('BEGIN');
    const ins=db.runNoSave(`INSERT INTO payment_requests_v2 (agent_id,manager_id,payment_type,amount,wallet_address,status) VALUES (?,?,?,?,?,'Pending')`,[req.user.id,agentManagerId(req.user.id),type,amount,wallet.wallet_address]);
    const ph=rows.map(()=>'?').join(','); db.runNoSave(`UPDATE payment_ledger SET status='requested',request_id=? WHERE id IN (${ph})`,[ins.lastInsertRowid,...rows.map(r=>r.id)]);
    db.execNoSave('COMMIT'); db.save(); paymentNotify(req.user.id,ins.lastInsertRowid,'submitted',`${paymentTypeLabel(type)} payment request submitted: $${amount}`); paymentAudit(req,'request_submitted',{request_id:ins.lastInsertRowid,agent_id:req.user.id,manager_id:agentManagerId(req.user.id),payment_type:type,amount,wallet_address:wallet.wallet_address,status:'Pending'}); res.json({ok:true,id:ins.lastInsertRowid,amount,status:'Pending'});
  }catch(e){ try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message}); }
});
app.get('/api/payment-v2/agent/requests', authRequired, requireRole('agent'), (req,res)=>res.json(db.all('SELECT * FROM payment_requests_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 300',[req.user.id])));
app.get('/api/payment-v2/agent/notifications', authRequired, requireRole('agent'), (req,res)=>res.json(db.all('SELECT * FROM payment_notifications_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 100',[req.user.id])));
app.post('/api/payment-v2/agent/notifications/read-all', authRequired, requireRole('agent'), (req,res)=>{db.run("UPDATE payment_notifications_v2 SET read_at=datetime('now') WHERE agent_id=? AND read_at IS NULL",[req.user.id]);res.json({ok:true});});
app.get('/api/payment-v2/manager/agents', authRequired, requireRole('manager'), (req,res)=>{
  const agents=db.all("SELECT id,username,name FROM users WHERE role='agent' AND parent_id=? ORDER BY username COLLATE NOCASE",[req.user.id]);
  res.json(agents.map(a=>({agent_id:a.id,agent_name:a.username,name:a.name||'',balances:agentPaymentSummary(a.id),payment_status:db.get("SELECT status FROM payment_requests_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 1",[a.id])?.status||'No Request'})));
});
app.get('/api/payment-v2/admin/summary', authRequired, requireRole('admin'), (req,res)=>{
  const pending=db.get("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) a FROM payment_requests_v2 WHERE status='Pending'");
  const paid=db.get("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) a FROM payment_requests_v2 WHERE status='Paid'");
  res.json({pending_count:pending?.c||0,pending_amount:normalizeDecimalString(pending?.a||0),paid_count:paid?.c||0,paid_amount:normalizeDecimalString(paid?.a||0),settings:paymentTypesSettings()});
});
app.get('/api/payment-v2/admin/requests', authRequired, requireRole('admin'), (req,res)=>{
  const status=req.query.status?String(req.query.status):''; const where=status?'WHERE pr.status=?':''; const params=status?[status]:[];
  const rows=db.all(`SELECT pr.*, au.username AS agent_name, au.name AS agent_full_name, mu.username AS manager_name, admin.username AS processed_by_name FROM payment_requests_v2 pr JOIN users au ON au.id=pr.agent_id LEFT JOIN users mu ON mu.id=pr.manager_id LEFT JOIN users admin ON admin.id=pr.processed_by ${where} ORDER BY pr.id DESC LIMIT 500`,params);
  res.json(rows.map(r=>({...r,payment_label:paymentTypeLabel(r.payment_type)})));
});
app.post('/api/payment-v2/admin/requests/:id/reject', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const r=db.get("SELECT * FROM payment_requests_v2 WHERE id=? AND status='Pending'",[id]); if(!r)return res.status(404).json({error:'Pending request not found'});
  try{db.execNoSave('BEGIN'); db.runNoSave("UPDATE payment_requests_v2 SET status='Rejected',reject_reason=?,processed_by=?,rejected_at=datetime('now'),admin_notes=? WHERE id=?",[req.body?.reason||'',req.user.id,req.body?.notes||'',id]); db.runNoSave("UPDATE payment_ledger SET status='open',request_id=NULL WHERE request_id=?",[id]); db.execNoSave('COMMIT'); db.save(); paymentNotify(r.agent_id,id,'rejected',`${paymentTypeLabel(r.payment_type)} payment request rejected.`); paymentAudit(req,'request_rejected',{request_id:id,agent_id:r.agent_id,manager_id:r.manager_id,payment_type:r.payment_type,amount:r.amount,wallet_address:r.wallet_address,status:'Rejected',details:{reason:req.body?.reason||''}}); res.json({ok:true});}catch(e){try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message});}
});
app.post('/api/payment-v2/admin/requests/:id/pay', authRequired, requireRole('admin'), upload.single('screenshot'), (req,res)=>{
  const id=+req.params.id; const r=db.get("SELECT * FROM payment_requests_v2 WHERE id=? AND status='Pending'",[id]); if(!r)return res.status(404).json({error:'Pending request not found'});
  let screenshotUrl=''; if(req.file&&req.file.buffer){ const dir=path.join(FRONTEND_ROOT,'uploads','payment-screenshots'); fs.mkdirSync(dir,{recursive:true}); const ext=(path.extname(req.file.originalname||'')||'.png').toLowerCase(); const file=`payment-${id}-${Date.now()}${ext}`; fs.writeFileSync(path.join(dir,file),req.file.buffer); screenshotUrl='/uploads/payment-screenshots/'+file; }
  try{db.execNoSave('BEGIN'); db.runNoSave("UPDATE payment_requests_v2 SET status='Paid',processed_by=?,paid_at=datetime('now'),txid=?,screenshot_url=?,admin_notes=? WHERE id=?",[req.user.id,req.body?.txid||'',screenshotUrl,req.body?.notes||'',id]); db.runNoSave("UPDATE payment_ledger SET status='paid' WHERE request_id=?",[id]); db.execNoSave('COMMIT'); db.save(); paymentNotify(r.agent_id,id,'paid',`${paymentTypeLabel(r.payment_type)} payment sent: $${r.amount}`); paymentAudit(req,'payment_sent',{request_id:id,agent_id:r.agent_id,manager_id:r.manager_id,payment_type:r.payment_type,amount:r.amount,wallet_address:r.wallet_address,status:'Paid',details:{txid:req.body?.txid||'',screenshot_url:screenshotUrl,notes:req.body?.notes||''}}); res.json({ok:true,screenshot_url:screenshotUrl});}catch(e){try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message});}
});
app.get('/api/payment-v2/admin/audit-logs', authRequired, requireRole('admin'), (req,res)=>res.json(db.all('SELECT * FROM payment_audit_logs ORDER BY id DESC LIMIT 1000')));



/* ============ LIMIT MANAGEMENT (Admin only, payout-zero after daily UK limits) ============ */
function dailyLimitUsage(row){
  if(!row || !row.limit_type) return 0;
  if(row.limit_type==='range') return countTodayUk('s.range_id=?', [row.range_id]);
  if(row.limit_type==='range_number') return 0;
  if(row.limit_type==='number') return countTodayUk(`REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [cleanPhone(row.number)]);
  if(row.limit_type==='cli') return countTodayUk('LOWER(s.cli)=LOWER(?)', [row.cli||'']);
  return 0;
}
function paidToday(whereSql, params=[]){ return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)>0 AND ${whereSql}`, params)?.c||0; }
function zeroedToday(whereSql, params=[]){ return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)=0 AND ${whereSql}`, params)?.c||0; }
function oneLimit(type, where, params=[]){ return db.get(`SELECT * FROM daily_limit_rules WHERE active=1 AND limit_type=? AND ${where} ORDER BY id DESC LIMIT 1`, [type, ...params]); }
app.get('/api/limit-management', authRequired, requireRole('admin'), (req,res)=>{
  const rows=db.all(`SELECT l.*, r.name AS range_name FROM daily_limit_rules l LEFT JOIN ranges r ON r.id=l.range_id ORDER BY l.id DESC`);
  res.json(rows.map(r=>{ const used=dailyLimitUsage(r); const limit=Number(r.daily_limit||0); return {...r, used_today:used, remaining_today:Math.max(0,limit-used), reporting_timezone:'Europe/London'}; }));
});
app.get('/api/limit-management/overview', authRequired, requireRole('admin'), (req,res)=>{
  const ranges=db.all('SELECT id,name FROM ranges ORDER BY name ASC').map(r=>{
    const rangeRule=oneLimit('range','range_id=?',[r.id]);
    const perRule=oneLimit('range_number','range_id=?',[r.id]);
    const where='s.range_id=?', params=[r.id];
    const today=countTodayUk(where,params);
    return {range_id:r.id,range_name:r.name,daily_limit:rangeRule?Number(rangeRule.daily_limit||0):0,per_number_limit:perRule?Number(perRule.daily_limit||0):0,today_otps:today,paid:paidToday(where,params),zeroed:zeroedToday(where,params)};
  });
  const cliSet=new Set();
  db.all("SELECT DISTINCT cli FROM sms_records WHERE cli IS NOT NULL AND cli<>'' ORDER BY cli ASC LIMIT 5000").forEach(x=>cliSet.add(String(x.cli)));
  db.all("SELECT cli FROM daily_limit_rules WHERE limit_type='cli' AND cli<>''").forEach(x=>cliSet.add(String(x.cli)));
  const clis=[...cliSet].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(cli=>{
    const rule=oneLimit('cli','LOWER(cli)=LOWER(?)',[cli]);
    const where='LOWER(s.cli)=LOWER(?)', params=[cli];
    const today=countTodayUk(where,params);
    return {cli,daily_limit:rule?Number(rule.daily_limit||0):0,today_otps:today,paid:paidToday(where,params),zeroed:zeroedToday(where,params)};
  });
  res.json({reporting_timezone:'Europe/London',ranges,clis});
});
app.post('/api/limit-management', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const type=String(b.limit_type||'').toLowerCase();
  const dailyLimit=Math.max(1, parseInt(b.daily_limit||0,10));
  if(!['range','number','cli'].includes(type)) return res.status(400).json({error:'limit_type must be range, number, or cli'});
  if(!dailyLimit) return res.status(400).json({error:'daily_limit required'});
  let rangeId=null, cli='', number='';
  if(type==='range'){
    rangeId=parseInt(b.range_id||0,10); if(!rangeId) return res.status(400).json({error:'range_id required'});
    if(!db.get('SELECT id FROM ranges WHERE id=?',[rangeId])) return res.status(404).json({error:'Range not found'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='range' AND range_id=?",[rangeId]);
  } else if(type==='cli'){
    cli=String(b.cli||'').trim(); if(!cli) return res.status(400).json({error:'cli required'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='cli' AND LOWER(cli)=LOWER(?)",[cli]);
  } else if(type==='number'){
    number=String(b.number||'').trim(); if(!number) return res.status(400).json({error:'number required'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='number' AND REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?",[cleanPhone(number)]);
  }
  db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,cli,number,daily_limit,active) VALUES (?,?,?,?,?,1)`,[type,rangeId,cli,number,dailyLimit]);
  logAction(req,'set_daily_limit','limit_management',{type,rangeId,cli,number,dailyLimit});
  res.json({ok:true});
});
app.post('/api/limit-management/range', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const rangeId=parseInt(b.range_id||0,10);
  if(!rangeId) return res.status(400).json({error:'range_id required'});
  if(!db.get('SELECT id FROM ranges WHERE id=?',[rangeId])) return res.status(404).json({error:'Range not found'});
  const daily=Math.max(0,parseInt(b.daily_limit||0,10));
  const per=Math.max(0,parseInt(b.per_number_limit||0,10));
  db.run("DELETE FROM daily_limit_rules WHERE limit_type IN ('range','range_number') AND range_id=?",[rangeId]);
  if(daily>0) db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,daily_limit,active) VALUES ('range',?,?,1)`,[rangeId,daily]);
  if(per>0) db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,daily_limit,active) VALUES ('range_number',?,?,1)`,[rangeId,per]);
  logAction(req,'save_range_daily_limits','limit_management',{rangeId,daily,per});
  res.json({ok:true});
});
app.post('/api/limit-management/cli', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const cli=String(b.cli||'').trim();
  const daily=Math.max(0,parseInt(b.daily_limit||0,10));
  if(!cli) return res.status(400).json({error:'cli required'});
  db.run("DELETE FROM daily_limit_rules WHERE limit_type='cli' AND LOWER(cli)=LOWER(?)",[cli]);
  if(daily>0) db.run(`INSERT INTO daily_limit_rules (limit_type,cli,daily_limit,active) VALUES ('cli',?,?,1)`,[cli,daily]);
  logAction(req,'save_cli_daily_limit','limit_management',{cli,daily});
  res.json({ok:true});
});
app.delete('/api/limit-management/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id;
  db.run('DELETE FROM daily_limit_rules WHERE id=?',[id]);
  logAction(req,'delete_daily_limit','limit_management',{id});
  res.json({ok:true});
});



/* ============ PANEL SHARING (Admin-only external panel allocation) ============ */
function sharingPublic(row){ return row ? {...row, password: undefined, password_hash: undefined} : row; }
function sharingUserByAgent(agentId){ return db.get('SELECT * FROM sharing_users WHERE agent_user_id=? AND active=1', [agentId]); }
function sharingAgentUser(row){ return db.get('SELECT * FROM users WHERE id=?', [row.agent_user_id]); }
app.get('/api/panel-sharing/dashboard', authRequired, requireRole('admin'), (req,res)=>{
  const users=db.get('SELECT COUNT(*) c FROM sharing_users WHERE active=1')?.c||0;
  const shared=db.get(`SELECT COUNT(*) c FROM numbers n JOIN sharing_users su ON su.agent_user_id=n.agent_id WHERE su.active=1`)?.c||0;
  const otps=db.get(`SELECT COUNT(*) c FROM sms_records s JOIN sharing_users su ON su.agent_user_id=s.agent_id WHERE COALESCE(s.is_test,0)=0`)?.c||0;
  res.json({total_sharing_users:users,total_shared_numbers:shared,total_otp_received:otps});
});
app.get('/api/panel-sharing/users', authRequired, requireRole('admin'), (req,res)=>{
  const rows=db.all(`SELECT su.*, u.active AS user_active FROM sharing_users su JOIN users u ON u.id=su.agent_user_id ORDER BY su.id DESC`);
  res.json(rows.map(sharingPublic));
});
app.post('/api/panel-sharing/users', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{}; const panel=String(b.panel_name||'').trim(); const username=String(b.username||'').trim(); const password=String(b.password||'');
  if(!panel||!username||!password) return res.status(400).json({error:'panel_name, username and password required'});
  if(db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE',[username])) return res.status(409).json({error:'Username already exists'});
  try{ db.beginBatch&&db.beginBatch();
    const ins=db.run(`INSERT INTO users (username,password,role,name,email,whatsapp,contact,skype,parent_id,active,payment_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [username,bcrypt.hashSync(password,10),'agent',String(b.user_name||panel),b.email||'',b.whatsapp||'',b.contact||'',b.skype||'',req.user.id,b.active===false?0:1,'weekly']);
    db.run('INSERT INTO sharing_users (agent_user_id,panel_name,user_name,username,attribute_url,active,created_by) VALUES (?,?,?,?,?,?,?)',[ins.lastInsertRowid,panel,String(b.user_name||''),username,String(b.attribute_url||''),b.active===false?0:1,req.user.id]);
    logAction(req,'create_sharing_user','panel_sharing',{panel_name:panel,username});
    res.json({ok:true,id:ins.lastInsertRowid});
  } finally { try{db.endBatch&&db.endBatch()}catch(e){} }
});
app.put('/api/panel-sharing/users/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const row=db.get('SELECT * FROM sharing_users WHERE id=?',[id]); if(!row) return res.status(404).json({error:'Sharing user not found'});
  const b=req.body||{}; const panel=String(b.panel_name||row.panel_name).trim(); const username=String(b.username||row.username).trim();
  const other=db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?',[username,row.agent_user_id]); if(other) return res.status(409).json({error:'Username already exists'});
  try{ db.beginBatch&&db.beginBatch();
    db.run('UPDATE sharing_users SET panel_name=?,user_name=?,username=?,attribute_url=?,active=?,updated_at=datetime(\'now\') WHERE id=?',[panel,String(b.user_name||''),username,String(b.attribute_url||''),b.active===false?0:1,id]);
    db.run('UPDATE users SET username=?,name=?,active=? WHERE id=?',[username,String(b.user_name||panel),b.active===false?0:1,row.agent_user_id]);
    if(b.password) db.run('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(String(b.password),10),row.agent_user_id]);
    logAction(req,'update_sharing_user','panel_sharing',{id,panel_name:panel});
    res.json({ok:true});
  } finally { try{db.endBatch&&db.endBatch()}catch(e){} }
});
app.delete('/api/panel-sharing/users/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const row=db.get('SELECT * FROM sharing_users WHERE id=?',[id]); if(!row) return res.status(404).json({error:'Sharing user not found'});
  db.run('UPDATE sharing_users SET active=0,updated_at=datetime(\'now\') WHERE id=?',[id]);
  db.run('UPDATE users SET active=0 WHERE id=?',[row.agent_user_id]);
  logAction(req,'disable_sharing_user','panel_sharing',{id});
  res.json({ok:true});
});
app.get('/api/panel-sharing/numbers', authRequired, requireRole('admin'), (req,res)=>cachedJson(req,res,1500,()=>{
  const q=String(req.query.search||'').trim(); const range=String(req.query.range||'').trim();
  const where=['n.manager_id IS NULL','n.agent_id IS NULL','n.client_id IS NULL',"COALESCE(r.deleted_at,'')=''"], params=[];
  if(q){where.push('(LOWER(n.number) LIKE ? OR LOWER(r.name) LIKE ?)'); params.push('%'+String(q).toLowerCase()+'%','%'+String(q).toLowerCase()+'%');}
  if(range){where.push('r.name=?'); params.push(range);}
  const total=db.get(`SELECT COUNT(*) c FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE ${where.join(' AND ')}`,params)?.c||0;
  const limitRaw=String(req.query.limit||25); const limit=limitRaw.toLowerCase()==='all'?Math.min(total||1,100000):Math.min(Math.max(parseInt(limitRaw)||25,1),1000);
  const totalPages=Math.max(1,Math.ceil(total/limit)); const page=Math.min(Math.max(parseInt(req.query.page||1)||1,1),totalPages); const offset=(page-1)*limit;
  const rows=db.all(`SELECT n.id,n.number,n.range_id,r.name AS range_name FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE ${where.join(' AND ')} ORDER BY r.name COLLATE NOCASE,n.number LIMIT ? OFFSET ?`,[...params,limit,offset]);
  return {rows,total,page,limit,totalPages};
}));
app.post('/api/panel-sharing/allocate', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{}; const userId=+b.sharing_user_id; const ids=(Array.isArray(b.ids)?b.ids:[]).map(x=>parseInt(x,10)).filter(x=>x>0);
  const su=db.get('SELECT * FROM sharing_users WHERE id=? AND active=1',[userId]); if(!su) return res.status(404).json({error:'Sharing user not found'});
  if(!ids.length) return res.status(400).json({error:'ids[] required'});
  const ph=ids.map(()=>'?').join(',');
  const rows=db.all(`SELECT n.id,n.number,r.name AS range_name FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE n.id IN (${ph}) AND n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL`, ids);
  if(!rows.length) return res.status(404).json({error:'No unallocated numbers found'});
  try{ db.beginBatch&&db.beginBatch();
    const rowIds=rows.map(r=>r.id); const ph2=rowIds.map(()=>'?').join(',');
    db.run(`UPDATE numbers SET agent_id=?, manager_id=NULL, client_id=NULL, payout='0', rate='', payterm='weekly' WHERE id IN (${ph2})`, [su.agent_user_id,...rowIds]);
    rows.forEach(nr=>logNumberHistory(req,nr,'allocated','',su.panel_name,{target_role:'sharing_agent',sharing_user_id:su.id}));
    logAction(req,'allocate_panel_sharing_numbers','panel_sharing',{count:rows.length,panel_name:su.panel_name});
    bumpNumbersVer();
    res.json({ok:true,count:rows.length,panel_name:su.panel_name,rows:rows.map(r=>({range_name:r.range_name||'',number:r.number||''}))});
  } finally { try{db.endBatch&&db.endBatch()}catch(e){} }
});
app.get('/api/panel-sharing/forward-logs', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all(`SELECT l.*, su.panel_name FROM sharing_forward_logs l LEFT JOIN sharing_users su ON su.id=l.sharing_user_id ORDER BY l.id DESC LIMIT 500`));
});
function forwardSharingOtpIfNeeded(savedId, smsRow){
  if(!savedId || !smsRow || !smsRow.agent_id) return;
  const su=sharingUserByAgent(smsRow.agent_id); if(!su || !su.attribute_url) return;
  setImmediate(async()=>{
    let status='failed', error='', preview='';
    try{
      const rangeName=db.get('SELECT name FROM ranges WHERE id=?',[smsRow.range_id])?.name||'';
      const payload={number:smsRow.number,cli:smsRow.cli,message:smsRow.message,otp_code:smsRow.otp_code,range_name:rangeName,received_at:new Date().toISOString(),panel_name:su.panel_name};
      const resp=await fetch(su.attribute_url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout?AbortSignal.timeout(10000):undefined});
      preview=(await resp.text()).slice(0,250); status=resp.ok?'success':'failed'; if(!resp.ok) error='HTTP '+resp.status;
    }catch(e){ error=e.message||String(e); }
    try{ db.run('INSERT INTO sharing_forward_logs (sharing_user_id,sms_record_id,url,status,error,response_preview) VALUES (?,?,?,?,?,?)',[su.id,savedId,su.attribute_url,status,error,preview]); }catch(e){}
  });
}


/* ============ CARRIER INTEGRATION SETTINGS ============ */
function getCarrierSettings(){
  let row = db.get('SELECT * FROM carrier_settings ORDER BY id ASC LIMIT 1');
  if(!row){
    db.run(`INSERT INTO carrier_settings (integration_status,carrier_ip,http_callback_url,notes) VALUES ('disabled','','/api/incoming-sms','HTTP integration ready')`);
    row = db.get('SELECT * FROM carrier_settings ORDER BY id ASC LIMIT 1');
  }
  return row;
}
function publicCallbackUrl(req){
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:4000';
  return `${proto}://${host}/api/incoming-sms`;
}
function cleanIp(ip){ return String(ip||'').replace(/^::ffff:/,'').replace(/^::1$/,'127.0.0.1').trim(); }
function getClientIp(req){
  const cf = req.headers['cf-connecting-ip'];
  const xr = req.headers['x-real-ip'];
  const xf = req.headers['x-forwarded-for'];
  const raw = cf || xr || (xf ? String(xf).split(',')[0].trim() : '') || req.ip || req.socket?.remoteAddress || '';
  return cleanIp(raw);
}
function carrierIpAllowed(config, ip){
  const allowed = String(config.carrier_ip||'').split(/[\s,;]+/).map(cleanIp).filter(Boolean);
  try { // GALAXY: Activity Integration entries (Provider Name + IP) bhi allowlist ka hissa
    for (const r of db.all('SELECT ip FROM activity_ips WHERE enabled=1')) allowed.push(cleanIp(r.ip));
  } catch(e) {}
  return allowed.includes(cleanIp(ip));
}
function cleanupWebhookLogs(days){
  const d = Math.max(1, parseInt(days || 30));
  db.run(`DELETE FROM webhook_logs WHERE datetime(created_at) < datetime('now','-${d} days')`);
}
function getCarrierLockPassword(){
  let row = db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1');
  if(!row){ db.run("INSERT INTO system_security (admin_security_code,carrier_lock_password) VALUES ('Dawood','Dawood')"); row=db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1'); }
  return row.carrier_lock_password || process.env.CARRIER_LOCK_PASSWORD || 'Dawood';
}
function carrierLockPassword(){ return getCarrierLockPassword(); }
function carrierLockOk(req){
  const q = req.query || {};
  const b = req.body || {};
  const provided = req.headers['x-carrier-lock'] || q.carrier_lock || q.carrier_lock_password || b.carrier_lock || b.carrier_lock_password || '';
  return String(provided) === carrierLockPassword();
}
function requireCarrierLock(req, res){
  if (carrierLockOk(req)) return true;
  res.status(423).json({ error: 'Carrier Integration is locked', locked: true });
  return false;
}
function carrierRuntimeStatus(){
  const lastSuccess = db.get(`SELECT created_at, source_ip FROM webhook_logs WHERE status='success' ORDER BY id DESC LIMIT 1`);
  const last = db.get(`SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 1`);
  let lastStatus = 'NO REQUESTS';
  if(last){
    if(last.status === 'success') lastStatus = 'SUCCESS';
    else if((last.error||'').includes('IP not allowed')) lastStatus = 'REJECTED (IP NOT ALLOWED)';
    else if((last.error||'').includes('disabled')) lastStatus = 'INTEGRATION DISABLED';
    else if((last.error||'').includes('number/to')) lastStatus = 'INVALID PAYLOAD';
    else lastStatus = 'FAILED';
  }
  return {
    last_sms_received: lastSuccess ? lastSuccess.created_at : '',
    last_success_ip: lastSuccess ? (lastSuccess.source_ip || '') : '',
    last_carrier_ip: last ? (last.source_ip || '') : '',
    last_request_status: lastStatus,
    last_error: last ? (last.error || '') : ''
  };
}
/* ===== GALAXY: Activity Integration IPs (Provider Name + IP) ===== */
app.get('/api/activity-ips', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM activity_ips ORDER BY id DESC'));
});
app.post('/api/activity-ips', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const ip = cleanIp(b.ip || '');
  if (!ip) return res.status(400).json({ error: 'Valid IP address required' });
  const name = String(b.provider_name || '').trim();
  try {
    db.run('INSERT INTO activity_ips (provider_name,ip,enabled) VALUES (?,?,?)', [name, ip, b.enabled === false ? 0 : 1]);
    logAction(req, 'activity_ip_add', 'activity_ips', { provider: name, ip });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/activity-ips/:id', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  db.run('UPDATE activity_ips SET provider_name=?, ip=?, enabled=? WHERE id=?',
    [String(b.provider_name||'').trim(), cleanIp(b.ip||''), b.enabled === false ? 0 : 1, +req.params.id]);
  logAction(req, 'activity_ip_update', 'activity_ips', { id: +req.params.id });
  res.json({ ok: true });
});
app.delete('/api/activity-ips/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run('DELETE FROM activity_ips WHERE id=?', [+req.params.id]);
  logAction(req, 'activity_ip_delete', 'activity_ips', { id: +req.params.id });
  res.json({ ok: true });
});

/* ===== GALAXY: Provider registry (relationship/payment/reporting) ===== */
/* ===== GALAXY P7: Provider Management (manual-only, accounting + partial settlements) ===== */
app.get('/api/providers-info', authRequired, requireRole('admin'), (req,res)=>{
  const provs = db.all('SELECT * FROM galaxy_providers ORDER BY name COLLATE NOCASE');
  const names = new Set(provs.map(p => p.name));
  const now = new Date();
  const dToday = now.toISOString().slice(0,10);
  const dowMon = (now.getUTCDay() + 6) % 7;
  const wkStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dowMon)).toISOString().slice(0,10);
  const pwStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dowMon - 7)).toISOString().slice(0,10);
  const mThis = dToday.slice(0,7);
  const pmDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const mPrev = pmDate.toISOString().slice(0,7);
  const m3 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0,10);
  const sumRange = (sel, extra="", params=[]) => db.get(`SELECT COALESCE(SUM(CAST(s.payout_amount AS REAL)),0) p FROM sms_records s JOIN ranges r ON r.id=s.range_id WHERE r.provider=? ${extra}`, [sel, ...params])?.p || 0;
  const cntRange = (sel, extra="", params=[]) => db.get(`SELECT COUNT(*) c FROM sms_records s JOIN ranges r ON r.id=s.range_id WHERE r.provider=? ${extra}`, [sel, ...params])?.c || 0;
  const out = [];
  for (const p of provs) {
    let conns = { api: 0, smpp: 0, ips: [] };
    try {
      conns.api = db.get('SELECT COUNT(*) c FROM sync_providers WHERE name=?', [p.name])?.c || 0;
      conns.smpp = db.get('SELECT COUNT(*) c FROM smpp_connections WHERE name=?', [p.name])?.c || 0;
      conns.ips = db.all('SELECT provider_name, ip, enabled FROM activity_ips WHERE provider_name=?', [p.name]);
    } catch(e) {}
    let stats = { ranges: 0, numbers: 0 };
    let totals = { msgs: 0, payout_lifetime: '0', payout_week: '0', payout_prev_week: '0', payout_month: '0', payout_prev_month: '0', payout_prev_3m: '0', paid_total: '0', payout_unpaid: '0', over_limit_msgs_7d: 0 };
    let last_payment = null;
    try {
      stats.ranges = db.get("SELECT COUNT(*) c FROM ranges WHERE provider=? AND COALESCE(deleted_at,'')=''", [p.name])?.c || 0;
      stats.numbers = db.get('SELECT COUNT(*) c FROM numbers n JOIN ranges r ON r.id=n.range_id WHERE r.provider=?', [p.name])?.c || 0;
      totals.msgs = cntRange(p.name);
      totals.payout_lifetime = normalizeDecimalString(sumRange(p.name)) || '0';
      totals.payout_week = normalizeDecimalString(sumRange(p.name, " AND strftime('%Y-%m-%d', s.received_at) BETWEEN ? AND ?", [wkStart, dToday])) || '0';
      totals.payout_prev_week = normalizeDecimalString(sumRange(p.name, " AND strftime('%Y-%m-%d', s.received_at) BETWEEN ? AND ?", [pwStart, wkStart])) || '0';
      totals.payout_month = normalizeDecimalString(sumRange(p.name, " AND strftime('%Y-%m', s.received_at) = ?", [mThis])) || '0';
      totals.payout_prev_month = normalizeDecimalString(sumRange(p.name, " AND strftime('%Y-%m', s.received_at) = ?", [mPrev])) || '0';
      totals.payout_prev_3m = normalizeDecimalString(sumRange(p.name, " AND strftime('%Y-%m-%d', s.received_at) >= ? AND strftime('%Y-%m', s.received_at) != ?", [m3, mThis])) || '0';
      totals.paid_total = normalizeDecimalString(db.get('SELECT COALESCE(SUM(CAST(amount AS REAL)),0) p FROM provider_payments WHERE provider_name=?', [p.name])?.p || 0) || '0';
      const unpaid = Math.max(0, (parseFloat(totals.payout_lifetime) || 0) - (parseFloat(totals.paid_total) || 0));
      totals.payout_unpaid = normalizeDecimalString(unpaid) || '0';
      totals.over_limit_msgs_7d = db.get(`SELECT COALESCE(SUM(x.c),0) c FROM (
          SELECT s.number_id nid, COUNT(*) c FROM sms_records s JOIN ranges r ON r.id=s.range_id
          WHERE s.received_at >= datetime('now','-7 days') AND s.number_id IS NOT NULL AND r.provider=?
          GROUP BY s.number_id
        ) x JOIN numbers n ON n.id=x.nid WHERE CAST(n.sd_limit AS INTEGER)>0 AND x.c>=CAST(n.sd_limit AS INTEGER)`, [p.name])?.c || 0;
      last_payment = db.get('SELECT amount, currency, paid_at, period FROM provider_payments WHERE provider_name=? ORDER BY paid_at DESC, id DESC LIMIT 1', [p.name]) || null;
    } catch(e) { console.error('P7 GET totals error:', e.message); }
    out.push({ id: p.id, name: p.name, conn_type: p.conn_type || '', payment_term: p.payment_term || '', currency: p.currency || 'USD', status: p.status || 'Active', notes: p.notes || '', connections: conns, stats, totals, last_payment });
  }
  let unlinked = [];
  try {
    unlinked = db.all("SELECT provider name, COUNT(*) ranges FROM ranges WHERE provider != '' AND COALESCE(deleted_at,'')='' AND provider NOT IN (SELECT name FROM galaxy_providers) GROUP BY provider ORDER BY ranges DESC LIMIT 10");
  } catch(e) {}
  res.json({ providers: out, unlinked });
});
app.post('/api/providers-info', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Provider name required' });
  try {
    db.run('INSERT INTO galaxy_providers (name,conn_type,payment_term,currency,status,notes) VALUES (?,?,?,?,?,?)',
      [name, String(b.conn_type||''), String(b.payment_term||''), String(b.currency||'USD'), (String(b.status||'Active')==='Inactive'?'Inactive':'Active'), String(b.notes||'')]);
    logAction(req, 'provider_add', 'galaxy_providers', { name, conn_type: b.conn_type||'', payment_term: b.payment_term||'' });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Provider already exists' : e.message }); }
});
app.put('/api/providers-info/:id', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const old = db.get('SELECT * FROM galaxy_providers WHERE id=?', [+req.params.id]);
  if (!old) return res.status(404).json({ error: 'Provider not found' });
  const name = String(b.name!==undefined ? b.name : old.name).trim();
  if (!name) return res.status(400).json({ error: 'Provider name required' });
  db.run("UPDATE galaxy_providers SET name=?,conn_type=?,payment_term=?,currency=?,status=?,notes=?,updated_at=datetime('now') WHERE id=?",
    [name,
     String(b.conn_type!==undefined ? b.conn_type : (old.conn_type||'')),
     String(b.payment_term!==undefined ? b.payment_term : (old.payment_term||'')),
     String(b.currency!==undefined ? b.currency : (old.currency||'USD')),
     (String(b.status!==undefined ? b.status : (old.status||'Active'))==='Inactive'?'Inactive':'Active'),
     String(b.notes!==undefined ? b.notes : (old.notes||'')),
     +req.params.id]);
  logAction(req, 'provider_update', 'galaxy_providers', { id: +req.params.id });
  res.json({ ok: true });
});
app.delete('/api/providers-info/:id', authRequired, requireRole('admin'), (req,res)=>{
  const row = db.get('SELECT name FROM galaxy_providers WHERE id=?', [+req.params.id]);
  db.run('DELETE FROM galaxy_providers WHERE id=?', [+req.params.id]);
  if (row) logAction(req, 'provider_delete', 'galaxy_providers', { id: +req.params.id, name: row.name });
  res.json({ ok: true });
});
/* Settlement: full ya PARTIAL payment; unpaid = lifetime - paid (accrual hamesha sahi) */
app.post('/api/providers-info/:id/payments', authRequired, requireRole('admin'), (req,res)=>{
  const p = db.get('SELECT * FROM galaxy_providers WHERE id=?', [+req.params.id]);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const lifetime = parseFloat(db.get(`SELECT COALESCE(SUM(CAST(s.payout_amount AS REAL)),0) p FROM sms_records s JOIN ranges r ON r.id=s.range_id WHERE r.provider=?`, [p.name])?.p || 0) || 0;
  const paid = parseFloat(db.get('SELECT COALESCE(SUM(CAST(amount AS REAL)),0) p FROM provider_payments WHERE provider_name=?', [p.name])?.p || 0) || 0;
  const unpaid = Math.max(0, lifetime - paid);
  const amtRaw = String((req.body||{}).amount ?? '').replace(/[$,\s]/g,'');
  const mm = amtRaw.match(/-?\d+(?:\.\d+)?/);
  if (!mm) return res.status(400).json({ error: 'Valid payment amount required' });
  const amount = parseFloat(mm[0]);
  if (!(amount > 0)) return res.status(400).json({ error: 'Payment amount must be > 0' });
  if (amount > unpaid + 0.0001) return res.status(400).json({ error: 'Amount exceeds unpaid payout ($ ' + (normalizeDecimalString(unpaid) || '0') + ')' });
  const remaining = Math.max(0, unpaid - amount);
  db.run('INSERT INTO provider_payments (provider_id,provider_name,amount,currency,paid_at,created_by,notes,prev_unpaid,remaining_unpaid,period) VALUES (?,?,?,?,datetime(\'now\'),?,?,?,?,?)',
    [p.id, p.name, normalizeDecimalString(amount) || '0', String(p.currency||'USD'), String(req.user?.username||'admin'), String((req.body||{}).notes||''), normalizeDecimalString(unpaid) || '0', normalizeDecimalString(remaining) || '0', String((req.body||{}).period||'')]);
  logAction(req, 'provider_payment', 'provider_payments', { provider: p.name, amount: normalizeDecimalString(amount), remaining: normalizeDecimalString(remaining) });
  res.json({ ok: true, amount: normalizeDecimalString(amount), prev_unpaid: normalizeDecimalString(unpaid), remaining: normalizeDecimalString(remaining), provider: p.name });
});
app.get('/api/providers-info/:id/payments', authRequired, requireRole('admin'), (req,res)=>{
  const p = db.get('SELECT name FROM galaxy_providers WHERE id=?', [+req.params.id]);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  res.json(db.all('SELECT id, amount, currency, paid_at, created_by, notes, prev_unpaid, remaining_unpaid, period FROM provider_payments WHERE provider_name=? ORDER BY paid_at DESC, id DESC LIMIT 200', [p.name]));
});
app.post('/api/providers-info/assign-range', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const provider = String(b.provider || '').trim();
  let range = null;
  if (b.range_id) range = db.get('SELECT id, name FROM ranges WHERE id=?', [+b.range_id]);
  else if (b.range_name) range = db.get('SELECT id, name FROM ranges WHERE name=?', [String(b.range_name)]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  db.run('UPDATE ranges SET provider=? WHERE id=?', [provider, range.id]);
  logAction(req, 'assign_range_provider', 'ranges', { range: range.name, provider });
  res.json({ ok: true, range: range.name, provider });
});

/* Import-time provider association (range-level link; number rows duplicate nahi hote) */
app.post('/api/providers-info/assign-range', authRequired, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const provider = String(b.provider || '').trim();
  let range = null;
  if (b.range_id) range = db.get('SELECT id, name FROM ranges WHERE id=?', [+b.range_id]);
  else if (b.range_name) range = db.get('SELECT id, name FROM ranges WHERE name=?', [String(b.range_name)]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  db.run('UPDATE ranges SET provider=? WHERE id=?', [provider, range.id]);
  logAction(req, 'assign_range_provider', 'ranges', { range: range.name, provider });
  res.json({ ok: true, range: range.name, provider });
});

app.get('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const c=getCarrierSettings();
  res.json({ ...c, ...carrierRuntimeStatus(), integration_mode: 'HTTP', generated_callback_url: publicCallbackUrl(req), endpoint_path:'/api/incoming-sms' });
});
app.put('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const b=req.body||{};
  const c=getCarrierSettings();
  db.run(`UPDATE carrier_settings SET integration_status=?,carrier_ip=?,http_callback_url=?,api_key=?,auth_token=?,notes=?,retention_days=?,updated_at=datetime('now') WHERE id=?`,
    [b.integration_status==='enabled'?'enabled':'disabled', b.carrier_ip||'', b.http_callback_url||'/api/incoming-sms', b.api_key||'', b.auth_token||'', b.notes||'', parseInt(b.retention_days||30), c.id]);
  cleanupWebhookLogs(b.retention_days||30);
  logAction(req,'update_carrier_settings','carrier_integration',{carrier_ip:b.carrier_ip,status:b.integration_status,mode:'HTTP_ONLY'});
  res.json({ ok:true, settings:{...getCarrierSettings(), ...carrierRuntimeStatus()}, generated_callback_url: publicCallbackUrl(req) });
});




app.post('/api/carrier-test', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const c=getCarrierSettings();
  const callback = publicCallbackUrl(req);
  logAction(req,'test_carrier_endpoint','carrier_integration',{callback,status:c.integration_status,carrier_ip:c.carrier_ip});
  res.json({ ok:true, reachable:true, endpoint:callback, integration_status:c.integration_status, allowed_ips:String(c.carrier_ip||'').split(/[\s,;]+/).filter(Boolean), note:'Endpoint is available. Carrier requests will still be IP-checked at /api/incoming-sms.' });
});


app.get('/api/carrier-webhook-logs', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const limit = Math.min(1000, parseInt(req.query.limit || '500'));
  res.json(db.all(`SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ${limit}`));
});
app.delete('/api/carrier-webhook-logs', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const count = db.get('SELECT COUNT(*) c FROM webhook_logs')?.c || 0;
  db.run('DELETE FROM webhook_logs');
  logAction(req,'clear_carrier_webhook_logs','carrier_integration',{count});
  res.json({ok:true,deleted:count});
});



/* ============ LOGS / FAILED QUEUE ============ */
app.get('/api/logs/activity', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500'));
});
app.get('/api/logs/number-history', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM number_history ORDER BY id DESC LIMIT 500'));
});
app.get('/api/logs/webhooks', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 500'));
});
app.get('/api/failed-sms', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM failed_sms_queue ORDER BY id DESC LIMIT 500'));
});
app.post('/api/failed-sms/:id/retry', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id;
  const f=db.get('SELECT * FROM failed_sms_queue WHERE id=?',[id]);
  if(!f) return res.status(404).json({ error:'Failed SMS not found' });
  const n=findNumber(f.number);
  if(!n){ db.run(`UPDATE failed_sms_queue SET retry_count=retry_count+1, updated_at=datetime('now') WHERE id=?`,[id]); return res.status(404).json({ error:'Number still not found' }); }
  const rangeForRetry=db.get('SELECT * FROM ranges WHERE id=?',[n.range_id])||{};
  const retryPaymentCycle=assignedPaymentCycleForNumber(n, rangeForRetry);
  const retryPaymentType=normalizePaymentType(retryPaymentCycle);
  const retryRate=payoutRateForPaymentCycle({...rangeForRetry, number_rate:n.rate, number_payout:n.payout}, retryPaymentCycle);
  const retrySenderType=classifySender(f.cli||'');
  const retryOtpCode=extractOtpCode(f.message||'');
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,payout_rate,payout_amount,payment_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id,n.number,n.range_id,f.cli||'',retrySenderType,f.message||'',retryOtpCode,n.client_id,n.agent_id,n.manager_id,retryRate,retryRate,retryPaymentType]);
  const retrySaved=db.get('SELECT id FROM sms_records ORDER BY id DESC LIMIT 1');
  if(retrySaved){ try{ recordPaymentLedgerForSms(retrySaved.id); }catch(e){ console.warn('[PAYMENT_V2] retry ledger failed:', e.message); } }
  try { recordSmsStats({ m: n.manager_id, a: n.agent_id, c: n.client_id, cli: f.cli || '', payout: retryRate, ts: '' }); } catch (_) {}
  const smsRow={number_id:n.id,number:n.number,range_id:n.range_id,cli:f.cli||'',sender_type:retrySenderType,message:f.message||'',otp_code:retryOtpCode,client_id:n.client_id,agent_id:n.agent_id,manager_id:n.manager_id};
  db.run(`UPDATE failed_sms_queue SET status='Retried',retry_count=retry_count+1,updated_at=datetime('now') WHERE id=?`,[id]);
  logAction(req,'retry_failed_sms','failed_sms_queue',{id,number:n.number});
  res.json({ ok:true });
});
app.delete('/api/failed-sms/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run(`UPDATE failed_sms_queue SET status='Ignored',updated_at=datetime('now') WHERE id=?`,[+req.params.id]);
  logAction(req,'ignore_failed_sms','failed_sms_queue',{id:+req.params.id});
  res.json({ ok:true });
});





/* ============ SMS WEBHOOK (incoming SMS from carrier/provider) ============ */
// Carrier/provider hits this endpoint. It supports our generic JSON and common provider field names.
function firstVal(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  return '';
}

function normalizeIncomingPayload(req) {
  let body = req.body || {};
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try { body = JSON.parse(raw); }
      catch (_) {
        body = {};
        raw.split('&').forEach(part => {
          const [k, ...rest] = part.split('=');
          if (!k) return;
          body[decodeURIComponent(k)] = decodeURIComponent(rest.join('=') || '');
        });
      }
    }
  }
  return { ...(req.query || {}), ...(body || {}) };
}
/**
 * Parse a provider-supplied timestamp into the "YYYY-MM-DD HH:MM:SS" UTC form
 * that sms_records.received_at uses everywhere else.
 *
 * Callback providers send a variety of shapes. IKANGOO documents
 * "{date} = Date (Y-m-d H:i:s)" with no timezone, which is treated as UTC -
 * the same assumption the provider-pull path already makes in providerSync.js.
 *
 * Returns '' when the value cannot be trusted, so the caller falls back to
 * server time rather than writing a garbage date into reporting.
 */
function parseIncomingDate(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  // epoch seconds / milliseconds
  if (/^\d{10}$/.test(raw))  return new Date(Number(raw) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  if (/^\d{13}$/.test(raw))  return new Date(Number(raw)).toISOString().slice(0, 19).replace('T', ' ');

  // "Y-m-d H:i:s" / "Y-m-d\tH:i:s" / "Y-m-dTH:i:s" with no zone -> treat as UTC
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, Y, Mo, D, H, Mi, S] = m;
    const d = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0)));
    if (isNaN(d.getTime())) return '';
    // reject an impossible date such as 2026-02-31 silently rolling over
    if (d.getUTCMonth() !== +Mo - 1 || d.getUTCDate() !== +D) return '';
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  // date only
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + ' 00:00:00';

  // anything with an explicit zone (ISO 8601 etc.)
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    if (y < 2000 || y > 2100) return '';        // clearly wrong -> use server time
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  return '';
}
function cleanPhone(v) { return String(v || '').trim().replace(/[^0-9]/g, ''); }
function classifySender(cli) {
  const s = String(cli || '').trim();
  if (!s) return 'unknown';
  const digits = s.replace(/[^0-9]/g, '');
  if (/^[A-Za-z][A-Za-z0-9 _.-]{1,20}$/.test(s) && /[A-Za-z]/.test(s)) return 'alphanumeric_sender';
  if (/^\+?\d{10,15}$/.test(s)) return 'phone_number';
  if (/^\d{3,8}$/.test(digits) && digits.length === s.replace(/^\+/, '').length) return 'shortcode';
  return 'unknown';
}
function extractOtpCode(message) {
  const text = String(message || '');
  const digit = text.match(/\b\d{4,8}\b/);
  if (digit) return digit[0];
  const alphaNum = text.match(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,12}\b/);
  return alphaNum ? alphaNum[0] : '';
}
function incomingHasZeroPayout(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const raw = firstVal(payload, ['payout','Payout','payout_amount','payoutAmount','rate_payout']);
  return raw !== '' && normalizeDecimalString(raw) === '0';
}
function countTodayUk(whereSql, params=[]) {
  return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND ${whereSql}`, params)?.c || 0;
}
function activeLimitRules(type) {
  return db.all('SELECT * FROM daily_limit_rules WHERE active=1 AND limit_type=? ORDER BY id ASC', [type]);
}
function evaluateDailyPayoutLimits(n, cli) {
  const reasons = [];
  const cleanN = cleanPhone(n.number);
  if (n.range_id) {
    for (const rule of activeLimitRules('range').filter(r => Number(r.range_id) === Number(n.range_id))) {
      const used = countTodayUk('s.range_id=?', [n.range_id]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`range:${n.range_id}:${used}/${rule.daily_limit}`);
    }
    for (const rule of activeLimitRules('range_number').filter(r => Number(r.range_id) === Number(n.range_id))) {
      const used = countTodayUk(`s.range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [n.range_id, cleanN]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`range_number:${n.range_id}:${n.number}:${used}/${rule.daily_limit}`);
    }
  }
  if (cleanN) {
    for (const rule of activeLimitRules('number')) {
      if (cleanPhone(rule.number) !== cleanN) continue;
      const used = countTodayUk(`REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [cleanN]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`number:${n.number}:${used}/${rule.daily_limit}`);
    }
  }
  const cliVal = String(cli || '').trim();
  if (cliVal) {
    for (const rule of activeLimitRules('cli')) {
      if (String(rule.cli || '').trim().toLowerCase() !== cliVal.toLowerCase()) continue;
      const used = countTodayUk('LOWER(s.cli)=LOWER(?)', [cliVal]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`cli:${cliVal}:${used}/${rule.daily_limit}`);
    }
  }
  return { exceeded: reasons.length > 0, reason: reasons.join('; ') };
}
function findNumber(rawNumber) {
  const exact = String(rawNumber || '').trim();
  let n = db.get('SELECT * FROM numbers WHERE number=?', [exact]);
  if (n) return n;
  const cleaned = cleanPhone(exact);
  if (!cleaned) return null;
  return db.get(
    `SELECT * FROM numbers
     WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`,
    [cleaned]
  );
}
function findTestNumber(rawNumber) {
  const cleaned = cleanPhone(rawNumber);
  if (!cleaned) return null;
  return db.get(`SELECT t.*, t.test_number AS number, r.name AS range_name
    FROM range_test_numbers t
    LEFT JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1 AND REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
}
function processIncomingSmsPayload(req, payload, sourceIp='', opts={}) {
  const b = payload || {};
  // Generic: {number, cli, message}
  // Twilio-like: {To, From, Body}
  // Other providers: {to, from, text}, {msisdn, sender, content}, etc.
  const number = firstVal(b, ['number', 'to', 'To', 'recipient', 'destination', 'msisdn', 'receiver', 'called']);
  const cli = firstVal(b, ['cli', 'from', 'From', 'sender', 'originator', 'source', 'shortcode', 'service']);
  const message = firstVal(b, ['message', 'text', 'Text', 'body', 'Body', 'sms', 'content', 'msg']);
  const senderType = classifySender(cli);
  const otpCode = extractOtpCode(message);

  /* ---------------------------------------------------------------------
   * Callback/postback providers (IKANGOO-style) send the ORIGINAL time of
   * the SMS as {date}, and a unique {id} that "can't be duplicated".
   *
   * Without the two blocks below, both were silently ignored:
   *   - {date} was dropped, so a message delayed or replayed by the provider
   *     was filed under "now" instead of when it actually arrived. That moves
   *     an SMS into the wrong reporting day and the wrong payment cycle.
   *   - {id} was dropped, so a provider retry (very common - they retry until
   *     they get HTTP 200) inserted the SAME SMS again. Verified: 4 identical
   *     callbacks produced 4 paid rows.
   *
   * Both are opt-in by payload: a carrier that sends neither behaves exactly
   * as before.
   * ------------------------------------------------------------------- */
  // Provider-supplied timestamp. opts.received_at (API pull path) still wins.
  let providerReceivedAt = opts.received_at || '';
  if (!providerReceivedAt) {
    const rawDate = firstVal(b, ['date', 'Date', 'datetime', 'date_time', 'timestamp', 'time', 'dt', 'api_dt', 'received_at', 'sent_at', 'created_at']);
    if (rawDate) {
      const parsed = parseIncomingDate(rawDate);
      if (parsed) providerReceivedAt = parsed;
      else console.warn('[INCOMING_SMS] unparseable date, using server time:', String(rawDate).slice(0, 40));
    }
  }
  if (providerReceivedAt) opts = { ...opts, received_at: providerReceivedAt };

  // Provider-supplied unique id -> reject a repeat of the SAME message.
  const providerMsgId = String(firstVal(b, ['sms_id', 'id', 'message_id', 'msg_id', 'msgid', 'api_message_id', 'unique_id', 'uid'])).trim();
  if (providerMsgId) {
    const dupKey = `cb:${providerMsgId}`;
    const already = db.get('SELECT sms_record_id FROM api_integration_seen WHERE duplicate_key=?', [dupKey]);
    if (already) {
      // Answer 200 on purpose: a callback provider retries on any non-2xx, so
      // returning an error here would make it retry this duplicate forever.
      console.log('[INCOMING_SMS] duplicate ignored', { provider_msg_id: providerMsgId, sourceIp });
      return { status: 200, body: { ok: true, duplicate: true, id: already.sms_record_id || null, provider_msg_id: providerMsgId } };
    }
    opts = { ...opts, providerMsgId, duplicateKey: dupKey };
  }

  if (!number) {
    console.warn('[INCOMING_SMS] failed: number/to field required', { sourceIp, cli, payload: b });
    logWebhook('failed', b, '', '', cli, message, 'number/to field required', sourceIp);
    addFailedSms(b, '', cli, message, 'number/to field required');
    return { status: 400, body: { error: 'number/to field required' } };
  }
  let n = findNumber(number);
  let matchedTest = null;
  if (!n) {
    matchedTest = findTestNumber(number);
    if (matchedTest) {
      n = { id: null, number: matchedTest.test_number, range_id: matchedTest.range_id, rate: '', payout: '0', manager_id: null, agent_id: null, client_id: null };
      opts = { ...opts, isTest: 1, source: opts.source || 'carrier_test_number' };
    }
  }
  if (!n) {
    console.warn('[INCOMING_SMS] failed: number not found/allocated', { sourceIp, number, cli });
    logWebhook('failed', b, number, '', cli, message, 'Number not found/allocated in system', sourceIp);
    addFailedSms(b, number, cli, message, 'Number not found/allocated in system');
    return { status: 404, body: { error: 'Number not found/allocated in system', number } };
  }

  const rangeForSms=db.get('SELECT * FROM ranges WHERE id=?',[n.range_id])||{};
  const assignedPaymentCycle = assignedPaymentCycleForNumber(n, rangeForSms);
  const assignedPaymentType = normalizePaymentType(assignedPaymentCycle);
  let smsPayoutRate=payoutRateForPaymentCycle({...rangeForSms, number_rate:n.rate, number_payout:n.payout}, assignedPaymentCycle);
  let limitReason = '';
  if (incomingHasZeroPayout(b)) {
    smsPayoutRate = '0';
    limitReason = 'external_payout_zero';
  } else if (!opts.isTest) {
    const limitStatus = evaluateDailyPayoutLimits(n, cli || '');
    if (limitStatus.exceeded) { smsPayoutRate = '0'; limitReason = limitStatus.reason; }
  }
    /* Provider rule: if the provider explicitly reports payout 0, the SMS is
     non-payable and Power X must show 0 regardless of the configured rate card.
     Any other provider payout (or none at all) is IGNORED for display - the
     panel always calculates payout from its own rate cards. */
  if (opts.forceZeroPayout) { smsPayoutRate = '0'; if (!limitReason) limitReason = 'provider_payout_zero'; }
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,limit_reason,payment_type,received_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(NULLIF(?,''),datetime('now')))`,
    [n.id, n.number, n.range_id, cli || '', senderType, message || '', otpCode, n.client_id, n.agent_id, n.manager_id, opts.isTest?1:0, opts.testBatchId||'', opts.source||'carrier', smsPayoutRate, smsPayoutRate, limitReason, assignedPaymentType, opts.received_at || '']);
  const saved = db.get('SELECT id, received_at FROM sms_records ORDER BY id DESC LIMIT 1');
  if (!opts.isTest) { try { recordSmsStats({ m: n.manager_id, a: n.agent_id, c: n.client_id, cli, payout: smsPayoutRate, ts: saved?.received_at }); } catch (_) {} }
  // Remember the provider's unique id so a retry of this exact callback is
  // recognised as a duplicate instead of being paid for twice.
  if (saved && opts.duplicateKey) {
    try {
      db.run('INSERT OR IGNORE INTO api_integration_seen (integration_id,duplicate_key,provider_message_id,sms_record_id) VALUES (?,?,?,?)',
        [null, opts.duplicateKey, opts.providerMsgId || '', saved.id]);
    } catch (e) { console.warn('[INCOMING_SMS] dedup ledger write failed:', e.message); }
  }
  if(saved && !opts.isTest) { try { recordPaymentLedgerForSms(saved.id, false); } catch(e) { console.warn('[PAYMENT_V2] ledger insert failed:', e.message); } }
  const smsRow = { number_id:n.id, number:n.number, range_id:n.range_id, cli:cli||'', sender_type:senderType, message:message||'', otp_code:otpCode, client_id:n.client_id, agent_id:n.agent_id, manager_id:n.manager_id, is_test: opts.isTest?1:0 };
  logWebhook('success', b, number, n.number, cli, message, '', sourceIp);
  console.log('[INCOMING_SMS] saved', { id: saved ? saved.id : null, number: n.number, cli: cli || '', sender_type: senderType, otp_detected: !!otpCode, source: opts.source || 'carrier', manager_id: n.manager_id || null, agent_id: n.agent_id || null, client_id: n.client_id || null });
  forwardSharingOtpIfNeeded(saved ? saved.id : null, smsRow);
  return { status: 200, body: { ok: true, id: saved ? saved.id : null, received_at: saved ? saved.received_at : null, matched_number: n.number, sender_type: senderType, otp_detected: !!otpCode } };
}

// Internal/testing webhook. This stays open for local panel testing.
app.post('/api/webhook/sms', upload.none(), (req, res) => {
  const payload = normalizeIncomingPayload(req);
  const result = processIncomingSmsPayload(req, payload, getClientIp(req));
  res.status(result.status).json(result.body);
});

function handleCarrierIncoming(req, res, payload) {
  const settings = getCarrierSettings();
  const clientIp = getClientIp(req);
  if ((settings.integration_status || 'disabled') !== 'enabled') {
    console.warn('[INCOMING_SMS] rejected: carrier integration disabled', { clientIp });
    logWebhook('failed', payload || {}, '', '', '', '', 'Carrier integration disabled', clientIp);
    return res.status(403).json({ error: 'Carrier integration is disabled' });
  }
  if (!settings.carrier_ip || !carrierIpAllowed(settings, clientIp)) {
    console.warn('[INCOMING_SMS] rejected: IP not allowed', { clientIp, allowed: settings.carrier_ip || '' });
    logWebhook('failed', payload || {}, '', '', '', '', `IP not allowed: ${clientIp}`, clientIp);
    return res.status(403).json({ error: 'IP not allowed', ip: clientIp });
  }
  const result = processIncomingSmsPayload(req, payload || {}, clientIp);
  cleanupWebhookLogs(settings.retention_days||30);
  return res.status(result.status).json(result.body);
}

// Carrier HTTP callback endpoint. Main production method: POST /api/incoming-sms
app.post('/api/incoming-sms', smsIngestLimit, upload.none(), (req, res) => {
  const payload = normalizeIncomingPayload(req);
  return handleCarrierIncoming(req, res, payload);
});

// Optional GET support for carrier/browser diagnostics and carriers that test URLs via GET.
app.get('/api/incoming-sms', smsIngestLimit, (req, res) => {
  const hasPayload = Object.keys(req.query || {}).some(k => ['number','to','To','recipient','destination','msisdn','receiver','called','message','text','body','Body','sms','content','msg'].includes(k));
  if (!hasPayload) {
    const settings = getCarrierSettings();
    return res.json({ ok: true, service: 'Galaxy SMS incoming SMS endpoint', method: 'POST preferred', path: '/api/incoming-sms', integration_status: settings.integration_status, accepted_content_types: ['application/json','application/x-www-form-urlencoded','multipart/form-data'] });
  }
  return handleCarrierIncoming(req, res, normalizeIncomingPayload(req));
});

/* ============ API INTEGRATION POLLING (incoming API pull channel) ============ */
let apiPollTimer = null;
const apiPollInProgress = new Set();
let lastApiIntegrationCleanupAt = 0;
function apiIntegrationLogLimit(){ return Math.max(1000, parseInt(process.env.API_INTEGRATION_LOG_LIMIT || '20000', 10) || 20000); }
function cleanupApiIntegrationTables(){
  const now=Date.now();
  if(now-lastApiIntegrationCleanupAt < 10*60*1000) return;
  lastApiIntegrationCleanupAt=now;
  const limit=apiIntegrationLogLimit();
  try{
    db.runNoSave(`DELETE FROM api_integration_logs WHERE id NOT IN (SELECT id FROM api_integration_logs ORDER BY id DESC LIMIT ${limit})`);
    db.runNoSave(`DELETE FROM api_integration_seen WHERE id NOT IN (SELECT id FROM api_integration_seen ORDER BY id DESC LIMIT ${Math.max(limit*2, 50000)})`);
  }catch(e){ console.warn('[API_INTEGRATION] cleanup failed:', e.message); }
}
async function withBackgroundDbBatch(fn){
  try{ db.beginBatch && db.beginBatch(); }catch(_){ }
  try{ return await fn(); }
  finally{ try{ db.endBatch && db.endBatch(); }catch(e){ console.warn('[DB_BATCH] background save failed:', e.message); } }
}
function maskToken(t){ t=String(t||''); if(!t) return ''; return t.length<=8 ? '********' : t.slice(0,4)+'********'+t.slice(-4); }
function publicApiIntegration(row){ if(!row) return row; return {...row, token: undefined, token_masked: maskToken(row.token)}; }
function ukDateStringJs(d=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function buildApiIntegrationRequest(row){
  const url = new URL(row.base_url);
  const today = ukDateStringJs();
  const dt1 = `${today} 00:00:00`;
  const dt2 = `${today} 23:59:59`;
  if(row.auth_type === 'query_token' && row.token) url.searchParams.set(row.token_param || 'token', row.token);
  if(row.dt1_param) url.searchParams.set(row.dt1_param, dt1);
  if(row.dt2_param) url.searchParams.set(row.dt2_param, dt2);
  if(row.records_param) url.searchParams.set(row.records_param, String(row.records_limit || 100));
  const headers = { 'Accept': 'application/json,text/plain,text/html,*/*' };
  if(row.auth_type === 'bearer' && row.token) headers.Authorization = 'Bearer ' + row.token;
  if(row.auth_type === 'header' && row.token) headers[row.token_header || 'X-API-Key'] = row.token;
  return { url: url.toString(), headers, dt1, dt2 };
}
function stripHtml(v){ return String(v||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim(); }
function parseDelimited(text){
  const lines=String(text||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<2) return [];
  const delim=['|',',',';','\t'].sort((a,b)=>(lines[0].split(b).length-lines[0].split(a).length))[0];
  const headers=lines[0].split(delim).map(h=>stripHtml(h).toLowerCase());
  return lines.slice(1).map(line=>{ const vals=line.split(delim); const o={}; headers.forEach((h,i)=>o[h]=stripHtml(vals[i]||'')); return o; });
}
function parseHtmlTable(text){
  const rows=[...String(text||'').matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m=>m[0]);
  if(!rows.length) return [];
  const parsed=rows.map(r=>[...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>stripHtml(c[1]))).filter(r=>r.length);
  if(parsed.length<2) return [];
  const headers=parsed[0].map(h=>h.toLowerCase());
  return parsed.slice(1).map(vals=>{const o={};headers.forEach((h,i)=>o[h]=vals[i]||'');return o;});
}
function extractArrayFromJson(j){
  if(Array.isArray(j)) return j;
  if(!j || typeof j!=='object') return [];
  for(const k of ['data','records','rows','result','results','messages','sms','items']) if(Array.isArray(j[k])) return j[k];
  return [j];
}
function parseApiResponse(text, contentType=''){
  const raw=String(text||'').trim();
  if(!raw) return [];
  if(contentType.includes('json') || raw.startsWith('{') || raw.startsWith('[')) {
    try { return extractArrayFromJson(JSON.parse(raw)); } catch(_) {}
  }
  if(raw.includes('<table') || /<tr[\s\S]*?<\/tr>/i.test(raw)) return parseHtmlTable(raw);
  return parseDelimited(raw);
}
function valAny(obj, keys){
  if(!obj || typeof obj!=='object') return '';
  const lower={}; Object.keys(obj).forEach(k=>lower[k.toLowerCase().replace(/[\s_-]+/g,'')]=obj[k]);
  for(const k of keys){ const key=k.toLowerCase().replace(/[\s_-]+/g,''); if(lower[key]!==undefined && lower[key]!==null && String(lower[key]).trim()!=='') return lower[key]; }
  return '';
}
function normalizeApiSmsRecord(r){
  const id=valAny(r,['id','message_id','messageid','msgid','smsid','uuid','record_id']);
  const dt=valAny(r,['dt','date','datetime','time','timestamp','received_at','receivedat']);
  const number=valAny(r,['number','to','destination','destination_addr','msisdn','receiver','recipient','called']);
  const cli=valAny(r,['cli','sender','from','source','source_addr','originator','shortcode','service']);
  const message=valAny(r,['message','text','body','sms','content','msg','short_message']);
  return { provider_message_id:String(id||''), dt:String(dt||''), number:String(number||'').trim(), cli:String(cli||'').trim(), message:String(message||'').trim(), raw:r };
}
function apiDuplicateKey(integrationId, rec){
  const base = rec.provider_message_id ? `${integrationId}:id:${rec.provider_message_id}` : `${integrationId}:hash:${rec.number}|${rec.cli}|${rec.message}|${rec.dt}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}
function apiLog(row, status, reason, rec={}, smsId=null){
  try{ db.run(`INSERT INTO api_integration_logs (integration_id,integration_name,status,reason,number,cli,message,provider_message_id,duplicate_key,raw_json,sms_record_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [row.id,row.name,status,reason||'',rec.number||'',rec.cli||'',rec.message||'',rec.provider_message_id||'',rec.duplicate_key||'',safeJson(rec.raw||{}),smsId]); }
  catch(e){ console.warn('[API_INTEGRATION] log failed:', e.message); }
}
function apiSeen(key){ return !!db.get('SELECT id FROM api_integration_seen WHERE duplicate_key=?',[key]); }
function markApiSeen(row, rec){ try{ db.run('INSERT OR IGNORE INTO api_integration_seen (integration_id,duplicate_key,provider_message_id) VALUES (?,?,?)',[row.id,rec.duplicate_key,rec.provider_message_id||'']); }catch(e){} }
async function processApiIntegrationRow(row, rec){
  rec.duplicate_key=apiDuplicateKey(row.id,rec);
  if(apiSeen(rec.duplicate_key)) return {duplicate:1};
  if(!rec.number || !rec.message){ markApiSeen(row,rec); apiLog(row,'failed','Invalid data',rec); return {failed:1}; }
  if(!findNumber(rec.number) && !findTestNumber(rec.number)){ markApiSeen(row,rec); apiLog(row,'failed','Number not found',rec); return {failed:1}; }
  const result=processIncomingSmsPayload({ip:'API_PULL', api_integration:row.name}, {number:rec.number, cli:rec.cli, message:rec.message, api_dt:rec.dt, api_message_id:rec.provider_message_id}, 'API_PULL', {source:'api_integration'});
  markApiSeen(row,rec);
  if(result.status===200){ apiLog(row,'success','Saved',rec,result.body?.id||null); return {success:1}; }
  apiLog(row,'failed',result.body?.error||'Processing failed',rec); return {failed:1};
}
async function fetchApiIntegration(row, manual=false){
  if(apiPollInProgress.has(row.id)) return {ok:false, skipped:true, reason:'Already running'};
  apiPollInProgress.add(row.id);
  let summary={ok:true,total:0,received:0,success:0,failed:0,duplicate:0};
  const started=Date.now();
  try{
    const reqInfo=buildApiIntegrationRequest(row);
    // Avoid db.run() full-save here. The processing batch below persists once.
    db.runNoSave("UPDATE api_integrations SET last_poll_at=datetime('now') WHERE id=?",[row.id]);
    const resp=await fetch(reqInfo.url,{method:row.method||'GET',headers:reqInfo.headers,signal:AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined});
    const text=await resp.text();
    if(!resp.ok) throw new Error('HTTP '+resp.status+' '+text.slice(0,120));
    const allParsed=parseApiResponse(text, resp.headers.get('content-type')||'');
    const maxRecords=Math.max(1, Math.min(1000, parseInt(row.records_limit||100,10)||100));
    const parsed=allParsed.slice(0,maxRecords);
    summary.received=allParsed.length;
    summary.total=parsed.length;
    await withBackgroundDbBatch(async()=>{
      cleanupApiIntegrationTables();
      let dupLogged=0;
      let processed=0;
      for(const raw of parsed){
        const rec=normalizeApiSmsRecord(raw);
        const r=await processApiIntegrationRow(row,rec);
        summary.success+=r.success||0; summary.failed+=r.failed||0; summary.duplicate+=r.duplicate||0;
        if(r.duplicate && dupLogged<3){ rec.duplicate_key=apiDuplicateKey(row.id,rec); apiLog(row,'duplicate','Duplicate message',rec); dupLogged++; }
        processed++;
        if(processed % 25 === 0) await new Promise(resolve=>setImmediate(resolve));
      }
      db.runNoSave("UPDATE api_integrations SET last_success_at=datetime('now'), last_error='' WHERE id=?",[row.id]);
    });
    return summary;
  }catch(e){
    await withBackgroundDbBatch(async()=>{
      db.runNoSave("UPDATE api_integrations SET last_error=? WHERE id=?",[e.message,row.id]);
      apiLog(row,'failed',e.message,{});
      cleanupApiIntegrationTables();
    });
    return {ok:false,error:e.message};
  }finally{
    apiPollInProgress.delete(row.id);
    const took=Date.now()-started;
    if(took>10000) console.warn('[API_INTEGRATION] slow poll', {id:row.id,name:row.name,took_ms:took,total:summary.total,received:summary.received,success:summary.success,failed:summary.failed,duplicate:summary.duplicate});
  }
}

async function pollApiIntegrations(){
  const rows=db.all('SELECT * FROM api_integrations WHERE enabled=1 ORDER BY id ASC');
  const now=Date.now();
  for(const row of rows){
    const interval=Math.max(5,parseInt(row.poll_interval_sec||5,10));
    const last=row.last_poll_at ? new Date(row.last_poll_at.replace(' ','T')+'Z').getTime() : 0;
    if(!last || now-last >= interval*1000) fetchApiIntegration(row,false).catch(e=>console.warn('[API_INTEGRATION] poll failed:',e.message));
  }
}
function startApiIntegrationPoller(){ if(apiPollTimer) return; apiPollTimer=setInterval(()=>pollApiIntegrations().catch(()=>{}),5000); if(apiPollTimer.unref) apiPollTimer.unref(); }

app.use('/api/api-integrations', authRequired, requireRole('admin'), (req,res)=>res.status(410).json({error:'API Integration module removed. HTTP incoming integration remains active.'}));
app.use('/api/api-integration-logs', authRequired, requireRole('admin'), (req,res)=>res.status(410).json({error:'API Integration module removed. HTTP incoming integration remains active.'}));
// API Integration module removed from UI/runtime; old route definitions below are shadowed by the 410 handlers above.
app.get('/api/api-integrations', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM api_integrations ORDER BY id DESC').map(publicApiIntegration));
});
app.post('/api/api-integrations', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{}; if(!b.name||!b.base_url) return res.status(400).json({error:'name and base_url required'});
  db.run(`INSERT INTO api_integrations (name,base_url,enabled,method,auth_type,token,token_param,token_header,dt1_param,dt2_param,records_param,records_limit,poll_interval_sec,response_format)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [b.name,b.base_url,b.enabled?1:0,b.method||'GET',b.auth_type||'query_token',b.token||'',b.token_param||'token',b.token_header||'Authorization',b.dt1_param||'dt1',b.dt2_param||'dt2',b.records_param||'records',parseInt(b.records_limit||100,10),Math.max(5,parseInt(b.poll_interval_sec||5,10)),b.response_format||'auto']);
  logAction(req,'create_api_integration','api_integration',{name:b.name});
  res.json({ok:true});
});
app.put('/api/api-integrations/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const old=db.get('SELECT * FROM api_integrations WHERE id=?',[id]); if(!old) return res.status(404).json({error:'API integration not found'});
  const b=req.body||{}; const token=(b.token===undefined||b.token==='')?old.token:b.token;
  db.run(`UPDATE api_integrations SET name=?,base_url=?,enabled=?,method=?,auth_type=?,token=?,token_param=?,token_header=?,dt1_param=?,dt2_param=?,records_param=?,records_limit=?,poll_interval_sec=?,response_format=?,updated_at=datetime('now') WHERE id=?`,
    [b.name||old.name,b.base_url||old.base_url,b.enabled?1:0,b.method||old.method,b.auth_type||old.auth_type,token,b.token_param||old.token_param,b.token_header||old.token_header,b.dt1_param||old.dt1_param,b.dt2_param||old.dt2_param,b.records_param||old.records_param,parseInt(b.records_limit||old.records_limit||100,10),Math.max(5,parseInt(b.poll_interval_sec||old.poll_interval_sec||5,10)),b.response_format||old.response_format,id]);
  res.json({ok:true});
});
app.delete('/api/api-integrations/:id', authRequired, requireRole('admin'), (req,res)=>{ db.run('DELETE FROM api_integrations WHERE id=?',[+req.params.id]); res.json({ok:true}); });
app.post('/api/api-integrations/:id/fetch', authRequired, requireRole('admin'), async (req,res)=>{
  const row=db.get('SELECT * FROM api_integrations WHERE id=?',[+req.params.id]); if(!row) return res.status(404).json({error:'API integration not found'});
  res.json(await fetchApiIntegration(row,true));
});
app.get('/api/api-integration-logs', authRequired, requireRole('admin'), (req,res)=>{
  const limit=Math.min(1000,parseInt(req.query.limit||500,10));
  res.json(db.all(`SELECT * FROM api_integration_logs ORDER BY id DESC LIMIT ${limit}`));
});




function getAdminSecurityCode(){
  let row = db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1');
  if(!row){ db.run("INSERT INTO system_security (admin_security_code) VALUES ('Dawood')"); row=db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1'); }
  return row.admin_security_code || 'Dawood';
}



/* ============ DATABASE BACKUPS ============ */
app.get('/api/backups', authRequired, requireRole('admin'), (req, res) => {
  try {
    res.json({ backups: backup.listBackups(db), backup_dir: backup.getBackupDir(db), db_file: db.getDbFile ? db.getDbFile() : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/backups/create', authRequired, requireRole('admin'), (req, res) => {
  try {
    const b = backup.createBackup(db, 'manual');
    backup.cleanupOldBackups(db);
    logAction(req, 'create_database_backup', 'backup', b.file);
    res.json({ ok: true, backup: b });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backups/latest/download', authRequired, requireRole('admin'), (req, res) => {
  try {
    const latest = backup.getLatestBackup(db) || backup.createBackup(db, 'manual-latest');
    const filePath = backup.backupPath(db, latest.file);
    res.download(filePath, latest.file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backups/:file/download', authRequired, requireRole('admin'), (req, res) => {
  try {
    const filePath = backup.backupPath(db, req.params.file);
    res.download(filePath, req.params.file);
  } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/backups/:file/restore', authRequired, requireRole('admin'), (req, res) => {
  try {
    const result = backup.restoreBackup(db, req.params.file);
    createTables();
    seed();
    logAction(req, 'restore_database_backup', 'backup', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/backups/:file', authRequired, requireRole('admin'), (req, res) => {
  try {
    backup.deleteBackup(db, req.params.file);
    logAction(req, 'delete_database_backup', 'backup', req.params.file);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

/* ============ PROFILE / ACTIVITY ============ */
app.get('/api/profile', authRequired, (req, res) => {
  const u = db.get('SELECT id, username, role, name, email, whatsapp, contact, skype, active, created_at FROM users WHERE id=?', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

app.put('/api/profile', authRequired, (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Profile editing is not available for clients' });
  const b = req.body || {};
  const current = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!current) return res.status(404).json({ error: 'User not found' });

  const newUsername = String(b.username || current.username).trim();
  if (!newUsername) return res.status(400).json({ error: 'Username is required' });
  const exists = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?', [newUsername, req.user.id]);
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  const newPassword = String(b.new_password || '');
  const confirmPassword = String(b.confirm_password || '');
  if (newPassword || confirmPassword) {
    if (!b.current_password) return res.status(400).json({ error: 'Current password is required' });
    if (!bcrypt.compareSync(String(b.current_password), current.password)) return res.status(400).json({ error: 'Current password is incorrect' });
    if (req.user.role === 'admin') {
      if (!b.admin_security_code) return res.status(400).json({ error: 'Admin security code is required to change password' });
      if (String(b.admin_security_code) !== getAdminSecurityCode()) return res.status(400).json({ error: 'Invalid admin security code' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New password and confirmation do not match' });
    db.run('UPDATE users SET username=?, password=? WHERE id=?', [newUsername, bcrypt.hashSync(newPassword, 10), req.user.id]);
  } else {
    db.run('UPDATE users SET username=? WHERE id=?', [newUsername, req.user.id]);
  }
  const updated = db.get('SELECT id, username, role, name, email, whatsapp, contact, skype FROM users WHERE id=?', [req.user.id]);
  logAction(req, 'update_own_profile', 'profile', { username: newUsername, password_changed: !!newPassword });
  res.json({ ok: true, user: updated, token: sign(updated) });
});


app.put('/api/admin-security-code', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const oldCode=String(b.old_security_code||'');
  const newCode=String(b.new_security_code||'').trim();
  const confirm=String(b.confirm_security_code||'').trim();
  if(!oldCode) return res.status(400).json({error:'Old security code is required'});
  if(oldCode !== getAdminSecurityCode()) return res.status(400).json({error:'Old security code is incorrect'});
  if(!newCode || newCode.length < 3) return res.status(400).json({error:'New security code must be at least 3 characters'});
  if(newCode !== confirm) return res.status(400).json({error:'New security code and confirmation do not match'});
  const row=db.get('SELECT id FROM system_security ORDER BY id ASC LIMIT 1');
  if(row) db.run('UPDATE system_security SET admin_security_code=?, updated_at=datetime(\'now\') WHERE id=?',[newCode,row.id]);
  else db.run('INSERT INTO system_security (admin_security_code) VALUES (?)',[newCode]);
  logAction(req,'update_admin_security_code','security','Admin security code changed');
  res.json({ok:true});
});

app.put('/api/carrier-lock-password', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const securityCode=String(b.admin_security_code||'');
  const newPass=String(b.new_password||'').trim();
  const confirm=String(b.confirm_password||'').trim();
  if(!securityCode) return res.status(400).json({error:'Admin security code is required'});
  if(securityCode !== getAdminSecurityCode()) return res.status(400).json({error:'Invalid admin security code'});
  if(!newPass || newPass.length < 3) return res.status(400).json({error:'New carrier password must be at least 3 characters'});
  if(newPass !== confirm) return res.status(400).json({error:'New carrier password and confirmation do not match'});
  const row=db.get('SELECT id FROM system_security ORDER BY id ASC LIMIT 1');
  if(row) db.run('UPDATE system_security SET carrier_lock_password=?, updated_at=datetime(\'now\') WHERE id=?',[newPass,row.id]);
  else db.run('INSERT INTO system_security (admin_security_code,carrier_lock_password) VALUES (?,?)',[getAdminSecurityCode(),newPass]);
  logAction(req,'update_carrier_lock_password','security','Carrier integration password changed');
  res.json({ok:true});
});

app.post('/api/logout', authRequired, (req, res) => {
  logAction(req, 'logout', 'auth', 'User logged out');
  res.json({ ok: true });
});

app.get('/api/activity-log', authRequired, (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Activity log is not available for clients' });
  const own = db.all("SELECT id, user_id, username, role, action, module, details, ip, created_at FROM audit_logs WHERE user_id=? AND action IN ('login','logout') ORDER BY id DESC LIMIT 200", [req.user.id]);
  let childRole = null;
  if (req.user.role === 'admin') childRole = 'manager';
  if (req.user.role === 'manager') childRole = 'agent';
  if (req.user.role === 'agent') childRole = 'client';
  let child = [];
  if (childRole) {
    const children = db.all('SELECT id FROM users WHERE role=? AND parent_id=?', [childRole, req.user.id]).map(x => x.id);
    // Admin managers are direct children of admin in this project. If some old data has null parent_id, include all managers for admin.
    let ids = children;
    if (req.user.role === 'admin') ids = db.all("SELECT id FROM users WHERE role='manager'").map(x => x.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      child = db.all(`SELECT id, user_id, username, role, action, module, details, ip, created_at FROM audit_logs WHERE user_id IN (${ph}) AND action IN ('login','logout') ORDER BY id DESC LIMIT 500`, ids);
    }
  }
  res.json({ own, child_role: childRole, child });
});

/* ============ START ============ */
const PORT = process.env.PORT || 4000;
(async () => {
  await db.init();
  createTables();
  seed();
  // PHASE-2 optional process split: POWERX_ROLE=api runs web-only (no timers);
  // POWERX_ROLE=sync runs only timers (2nd process). Default (unset/'all') = everything.
  const POWERX_ROLE = (process.env.POWERX_ROLE || 'all').toLowerCase();
  // PHASE-3: optional FTS5 trigram index over SMS messages (POWERX_FTS=1).
  // Default off = zero change. Indexes new SMS via triggers; history backfills
  // in background; /api/sms/paged search switches to the index once ready.
  if (smsFts.enabled() && ['all', 'api'].includes(POWERX_ROLE)) {
    try {
      smsFts.init(db);
      smsFts.startBackfill(db, console);
      console.log('• SMS FTS5 (trigram) enabled: triggers active, history backfill running');
    } catch (e) { console.error('[FTS] init failed:', e.message); }
  }
  if (['all', 'sync'].includes(POWERX_ROLE)) {
    if (backup && backup.startAutomaticBackups) backup.startAutomaticBackups(db, console);
    // Background provider sync: the ONLY component that talks to external APIs.
    try {
      providerSync.start({
        log: console,
        processIncomingSmsPayload,
        clearApiReadCache,
      });
    } catch (e) { console.warn('[SYNC] start failed:', e.message); }
  } else {
    console.log('• POWERX_ROLE=' + POWERX_ROLE + ': backup + provider-sync timers skipped (run a second process with POWERX_ROLE=sync)');
  }
  // SMPP channel. Independent of the HTTP integrations above: if it cannot
  // start (missing library, bad config, port in use) it reports the problem
  // and the rest of the panel carries on exactly as before.
  // POWERX_ROLE=sync (timers-only process) skips SMPP + HTTP listen — the api
  // process owns those ports. Without this, split mode crash-loops on EADDRINUSE.
  if (POWERX_ROLE === 'sync') {
    console.log('• POWERX_ROLE=sync: timers-only process — HTTP listen + SMPP skipped (api process owns them)');
    return;
  }
  try {
    smppService.start({
      log: console,
      processIncomingSmsPayload,
      clearApiReadCache,
    });
  } catch (e) { console.warn('[SMPP] start failed:', e.message); }
  if (String(process.env.PAYMENT_LEDGER_BACKFILL_ON_STARTUP || 'false').toLowerCase() === 'true') {
    try { backfillPaymentLedger(); } catch(e) { console.warn('[PAYMENT_V2] backfill failed:', e.message); }
  } else {
    console.log('• Payment ledger startup backfill disabled (new OTPs are recorded normally)');
  }
  console.log('• API Integration poller disabled (HTTP incoming only)');
  /* P12: AI Assistant (independent limits, ASSISTANT_ENABLED kill-switch) */
  try { require('./assistant').register(app, { allocate: handleAllocate }); console.log('• AI Assistant registered (agent panel)'); } catch (e) { console.error('[ASSISTANT] register failed:', e.message); }
  app.listen(PORT, () => console.log(`\n✅ Galaxy SMS backend running: http://localhost:${PORT}\n`));
})();
