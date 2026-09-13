#!/usr/bin/env node
/* Power X SMS — performance alert checker (cron every minute)
 * Usage:  * * * * * node /root/PowerX-SMS/scripts/alert-check.js >> /var/log/powerx-alerts.log 2>&1
 * Env:    ALERT_URL (default http://localhost:4000), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Sends a Telegram message only when a threshold is breached (1 msg / 10 min max per problem).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const STATE = '/tmp/powerx-alert-state.json';
const BASE = process.env.ALERT_URL || 'http://localhost:4000';
const COOLDOWN_MS = 10 * 60 * 1000;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { timeout: 5000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('[alert] (no telegram configured)', text); return; }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  require('https').request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
    .on('error', () => {})
    .end(JSON.stringify({ chat_id: chat, text }));
}
(async () => {
  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  const now = Date.now();
  const problems = [];
  let h;
  try { h = await get('/api/health'); } catch (e) {
    problems.push(`🔴 Power X SMS DOWN (${e.message}) on ${os.hostname()}`);
    h = null;
  }
  if (h) {
    if (h.event_loop && h.event_loop.lag_p99_ms > 500) problems.push(`🟠 Event-loop lag p99 ${h.event_loop.lag_p99_ms}ms > 500ms`);
    if (h.rss_mb > 1200) problems.push(`🟠 RSS ${h.rss_mb}MB > 1200MB`);
    if (h.slow_queries && h.slow_queries.count > 50) problems.push(`🟠 Slow queries: ${h.slow_queries.count} (worst ${h.slow_queries.worstMs}ms)`);
    if (h.wal_size_mb > 200) problems.push(`🟠 WAL ${h.wal_size_mb}MB > 200MB`);
  }
  if (problems.length) {
    const key = problems[0].slice(0, 40);
    if (!state[key] || now - state[key] > COOLDOWN_MS) {
      state[key] = now;
      telegram(`Power X SMS Alert\n${problems.join('\n')}\n\nRSS ${h?.rss_mb}MB · DB ${h?.db_size_mb}MB · ${new Date().toISOString()}`);
      console.log('[alert] SENT:', problems.join(' | '));
    } else console.log('[alert] suppressed (cooldown)');
  } else console.log('[alert] OK', new Date().toISOString());
  fs.writeFileSync(STATE, JSON.stringify(state));
})().catch(e => { console.error('[alert] failed:', e.message); process.exit(0); });
