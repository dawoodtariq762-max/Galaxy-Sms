'use strict';
/* pwbench lib/guard.js — SAFETY: token, target lock, caps, STOP kill-switch */
const fs = require('fs'), path = require('path');
const ROOT = __dirname + '/..';

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench.config.json'), 'utf8'));
  return cfg;
}
function assertToken(cfg, supplied) {
  if (!supplied || String(supplied).trim() !== String(cfg.TOKEN)) { console.error('✗ REFUSED: token missing/wrong (--token sirf hex string, poori quick-start line nahi)'); process.exit(2); }
}
function isPrivateHost(h) { return h === '127.0.0.1' || h === 'localhost' || /^::1$/.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h); }
function assertTarget(cfg, host) {
  if (!isPrivateHost(host)) { console.error('✗ REFUSED: target sirf loopback/private ho sakta hai (authorization design)'); process.exit(2); }
  if (host !== '127.0.0.1' && host !== 'localhost' && !cfg.ALLOW_PROD_TARGET) { console.error('✗ REFUSED: non-loopback target requires ALLOW_PROD_TARGET in config'); process.exit(2); }
}
function checkStop() { try { return fs.existsSync(path.join(ROOT, 'STOP')); } catch (_) { return false; } }
function assertCaps(cfg, { durationMin = 0, messages = 0, workers = 0, allocBatch = 0 } = {}) {
  if (durationMin > cfg.MAX_DURATION_MIN) { console.error(`✗ REFUSED: duration ${durationMin}m > cap ${cfg.MAX_DURATION_MIN}m`); process.exit(2); }
  if (messages > cfg.MAX_SYNTHETIC_MESSAGES) { console.error(`✗ REFUSED: messages ${messages} > cap ${cfg.MAX_SYNTHETIC_MESSAGES}`); process.exit(2); }
  if (workers > cfg.MAX_WORKERS) { console.error(`✗ REFUSED: workers ${workers} > cap ${cfg.MAX_WORKERS}`); process.exit(2); }
  if (allocBatch > cfg.MAX_ALLOC_BATCH) { console.error(`✗ REFUSED: alloc batch ${allocBatch} > cap ${cfg.MAX_ALLOC_BATCH}`); process.exit(2); }
}
function stopReason() { return checkStop() ? 'STOP file detected' : null; }
function clearStop() { try { fs.unlinkSync(path.join(ROOT, 'STOP')); } catch (_) {} }
module.exports = { loadConfig, assertToken, assertTarget, assertCaps, checkStop, stopReason, clearStop, ROOT };
