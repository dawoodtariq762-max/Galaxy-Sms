/* P19g diagnostic — owner scenario A/B live reproduction.
 * A (manager, panel in jsdom) opens conversation with B (agent).
 * B sends message via API. Does it appear in A's OPEN conversation
 *   (a) with real SSE (EventSource polyfill connected to live stream)
 *   (b) with polling only (no EventSource, like p19e jsdom)
 * WITHOUT any reopen/click?
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const DB = process.env.P19G_DB || '/tmp/p19g-repro.db';
const PORT = process.env.P19G_PORT || '8098';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let serverProc = null;
const log = (...a) => console.log(...a);

function api(p, method, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, j, b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function startServer() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  serverProc = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19g', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
  for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await api('/api/health', 'GET'); if (r.status === 200) return; } catch (e) {} }
  throw new Error('server did not start');
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status + ' ' + r.b); return r.j.token; }

/* Minimal REAL EventSource polyfill: connects to the actual live SSE stream
 * and dispatches events exactly like a browser (this is what jsdom lacks). */
function installEventSource(window) {
  const NodeHttp = http;
  class ES extends window.EventTarget {
    constructor(url) {
      super();
      this.readyState = 0; // CONNECTING
      const req = NodeHttp.get(new URL(String(url), BASE).href, { headers: { Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { const e = new window.Event('error'); this.dispatchEvent(e); try { req.destroy(); } catch (e2) {} return; }
        this.readyState = 1; this.dispatchEvent(new window.Event('open'));
        let buf = '';
        res.on('data', d => {
          buf += d.toString();
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            let evName = 'message', datas = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) evName = line.slice(6).trim();
              else if (line.startsWith('data:')) datas.push(line.slice(5).replace(/^ /, ''));
            }
            if (datas.length) {
              const ev = new window.MessageEvent(evName, { data: datas.join('\n') });
              this.dispatchEvent(ev);
            }
          }
        });
        res.on('end', () => { if (this.readyState !== 2) { this.readyState = 2; this.dispatchEvent(new window.Event('error')); } });
      });
      req.on('error', () => { this.readyState = 2; this.dispatchEvent(new window.Event('error')); });
      this._req = req;
    }
    close() { this.readyState = 2; try { this._req.destroy(); } catch (e) {} }
  }
  window.EventSource = ES;
}

async function bootPanel(page, tok, user, withSSE) {
  let JSDOM, VirtualConsole;
  try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { ({ JSDOM, VirtualConsole } = require('/tmp/uitest/node_modules/jsdom')); }
  const NOISE = [/Not implemented/i, /Could not parse CSS/i];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
  vc.on('error', (...a) => { const m = a.join(' '); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
  const dom = await JSDOM.fromURL(BASE + '/' + page, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(String(input), BASE).href, init);
      window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.localStorage.setItem('ms_token', tok); window.localStorage.setItem('ms_role', page);
      window.localStorage.setItem('ms_user', user); window.localStorage.setItem('ms_name', user);
      if (withSSE) installEventSource(window);
    },
  });
  await sleep(2600);
  return { dom, errors };
}

(async () => {
  log('P19g REPRO — ' + new Date().toISOString());
  await startServer();
  const dbo = new Database(DB);
  const adm = await login('vibepk', 'vibepk123');
  const mk = async (u, role) => { await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() + ' Name' }, adm); return login(u, 'Test123!'); };
  const mTok = await mk('rm1', 'manager');
  const mkc = async (u, role, tok) => { const r = await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() + ' Name' }, tok); if (r.status !== 200 && r.status !== 201) throw new Error('mk ' + u + ': ' + r.status + ' ' + r.b); return login(u, 'Test123!'); };
  const aTok = await mkc('ra1', 'agent', mTok);
  const idOf = u => dbo.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  const convR = await api('/api/chat/conversations', 'POST', { user_id: idOf('ra1') }, mTok);
  if (!convR.j || !convR.j.conversation_id) throw new Error('conv create: ' + convR.status + ' ' + convR.b);
  const conv = convR.j.conversation_id;
  await api('/api/chat/messages/' + conv, 'POST', { body: 'seed message from manager' }, mTok);
  await api('/api/chat/messages/' + conv, 'POST', { body: 'seed reply from agent' }, aTok);
  log('conv=' + conv);

  for (const MODE of [{ name: 'SSE (EventSource polyfill → real stream)', sse: true }, { name: 'POLLING (no EventSource — 9s fallback)', sse: false }]) {
    log('\n================ MODE: ' + MODE.name + ' ================');
    const P = await bootPanel('manager.html', mTok, 'rm1', MODE.sse);
    const w = P.dom.window, d = w.document;
    w.GXChat.open('chat');
    await sleep(1200);
    const item = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('RA1'));
    if (!item) { log('  !! conversation item not found in list'); }
    else {
      item.click();
      await sleep(1500);
      const before = d.querySelectorAll('#gxcMsgs .gxc-row').length;
      log('  conv OPEN, rows=' + before + ', S.convId=' + w.GXChat._state.convId + ', es=' + (w.GXChat._state.es ? 'CONNECTED' : 'null') + ', poll=' + (w.GXChat._state.pollTimer ? 'ON' : 'off'));

      /* --- B sends 3 messages, A just watches (NO clicks) --- */
      await api('/api/chat/messages/' + conv, 'POST', { body: 'LIVE-1 ' + Date.now() }, aTok);
      await sleep(700);
      await api('/api/chat/messages/' + conv, 'POST', { body: 'LIVE-2 ' + Date.now() }, aTok);
      await sleep(300);
      let seenAt = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 13000) {
        await sleep(500);
        const txt = d.getElementById('gxcMsgs') ? d.getElementById('gxcMsgs').textContent : '';
        if (txt.includes('LIVE-1') && txt.includes('LIVE-2')) { seenAt = Date.now() - t0; break; }
      }
      const after = d.querySelectorAll('#gxcMsgs .gxc-row').length;
      const txt = d.getElementById('gxcMsgs') ? d.getElementById('gxcMsgs').textContent : '';
      log('  B sent LIVE-1 + LIVE-2 → A open conv rows: ' + before + ' → ' + after + (seenAt !== null ? ' | APPEARED after ' + seenAt + 'ms (NO click)' : ' | NOT SEEN in 13s'));
      const dup = (txt.match(/LIVE-1/g) || []).length;
      log('  LIVE-1 occurrences=' + dup + (dup > 1 ? '  ← DUPLICATE!' : ' (no dup)'));
      /* SSE event arrival proof */
      if (MODE.sse) {
        const ls = w.GXChat._state;
        log('  SSE still connected: ' + (ls.es ? 'yes' : 'NO (fell back to poll ' + (ls.pollTimer ? 'ON' : 'off') + ')'));
      }
      /* another conversation message → list preview/badge path */
      const cTok = await (async () => { await api('/api/users', 'POST', { username: 'rc2', password: 'Test123!', role: 'agent', active: true, name: 'RC2 Name' }, adm); return login('rc2', 'Test123!'); })();
      const conv2 = (await api('/api/chat/conversations', 'POST', { user_id: idOf('rc2') }, mTok)).j.conversation_id;
      await api('/api/chat/messages/' + conv2, 'POST', { body: 'OTHER-CONV ' + Date.now() }, mTok); // m sends there first so conv exists in list
      await api('/api/chat/messages/' + conv2, 'POST', { body: 'OTHER-CONV-NEW ' + Date.now() }, cTok);
      let otherSeen = null; const t1 = Date.now();
      while (Date.now() - t1 < 12000) { await sleep(500); const lt = d.getElementById('gxcList') ? d.getElementById('gxcList').textContent : ''; if (lt.includes('OTHER-CONV-NEW')) { otherSeen = Date.now() - t1; break; } }
      log('  msg from ANOTHER conv → list preview updated: ' + (otherSeen !== null ? 'yes after ' + otherSeen + 'ms' : 'NO in 12s'));
      log('  jsdom errors: ' + (P.errors.length ? JSON.stringify(P.errors.slice(0, 3)) : 'none'));
      if (w.GXChat._state.es) { try { w.GXChat._state.es.close(); } catch (e) {} }
    }
    P.dom.window.close();
    await sleep(400);
  }
  try { serverProc.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('SUITE ERROR:', e); try { serverProc && serverProc.kill('SIGKILL'); } catch (e2) {} process.exit(1); });
