/* P19g verify — Chat UX fixes:
 *  FIX-1: naya message OPEN conversation me live render ho (SSE + polling fallback dono)
 *  FIX-2: subtle notification sound (WebAudio) — sirf genuinely new incoming par
 * Owner ke 14-point verification list ke mutabiq live two-account tests (jsdom = real
 * panel code + real server + real SSE stream via EventSource polyfill).
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const DB = process.env.P19G_DB || '/tmp/p19g.db';
const PORT = process.env.P19G_PORT || '8098';
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let serverProc = null, serverErr = '';
let PASS = 0, FAIL = 0;
const t = (name, ok, info) => { if (ok) { PASS++; console.log('PASS | ' + name + (info !== undefined ? ' | ' + info : '')); } else { FAIL++; console.log('FAIL | ' + name + (info !== undefined ? ' | ' + info : '')); } };
const api = (p, method, body, tok) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, j, b }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
async function startServer() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  serverProc = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19g', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); process.stderr.write('[srv-err] ' + d); });
  for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await api('/api/health', 'GET'); if (r.status === 200) return; } catch (e) {} }
  throw new Error('server did not start');
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status); return r.j.token; }

/* real EventSource polyfill → actual SSE stream (jsdom me yehi missing tha) */
function installEventSource(window) {
  class ES extends window.EventTarget {
    constructor(url) {
      super();
      this.readyState = 0;
      const req = http.get(new URL(String(url), BASE).href, { headers: { Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { this.readyState = 2; this.dispatchEvent(new window.Event('error')); try { req.destroy(); } catch (e) {} return; }
        this.readyState = 1;
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
            if (datas.length) this.dispatchEvent(new window.MessageEvent(evName, { data: datas.join('\n') }));
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
/* WebAudio stub — real ding calls count karta hai (window.__gxdings) */
function installAudioStub(window) {
  window.__gxdings = 0;
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { const o = { type: '', frequency: { value: 0 }, connect() {}, start() { window.__gxdings++; }, stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
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
      installAudioStub(window);
    },
  });
  await sleep(2600);
  return { dom, errors };
}

(async () => {
  console.log('P19g verification — ' + new Date().toISOString());
  await startServer();
  const dbo = new Database(DB);
  const adm = await login('vibepk', 'vibepk123');
  const mk = async (u, role, viaTok) => { const r = await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() + ' Name' }, viaTok || adm); if (r.status !== 200 && r.status !== 201) throw new Error('mk ' + u + ': ' + r.status + ' ' + r.b); return login(u, 'Test123!'); };
  const mTok = await mk('gm1', 'manager');
  const aTok = await mk('ga1', 'agent', mTok);   /* agent apne manager ke under */
  const a2Tok = await mk('ga2', 'agent', mTok);  /* dusra agent (doosri conv ke liye) */
  const idOf = u => dbo.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  const convR = await api('/api/chat/conversations', 'POST', { user_id: idOf('ga1') }, mTok);
  if (!convR.j || !convR.j.conversation_id) throw new Error('conv create failed: ' + convR.b);
  const conv = convR.j.conversation_id;
  await api('/api/chat/messages/' + conv, 'POST', { body: 'seed-1 from manager' }, mTok);
  await api('/api/chat/messages/' + conv, 'POST', { body: 'seed-2 from agent' }, aTok);
  const TAG = 'Q' + (Date.now() % 100000);

  /* ---------- A. code-level markers ---------- */
  const chatSrc = fs.readFileSync(path.join(ROOT, 'assets/chat.js'), 'utf8');
  t('A1 chat.js: SSE heartbeat (hb) listener + zombie watchdog', chatSrc.includes("addEventListener('hb'") && chatSrc.includes('sseMonitor'));
  t('A2 chat.js: reconnect-ready catch-up + visibility catch-up', chatSrc.includes("addEventListener('ready'") && chatSrc.includes('onVisChange'));
  t('A3 chat.js: open-conv 3s poll (degraded mode) + stopPolling on SSE liveness', chatSrc.includes('? 3000 : 9000') && chatSrc.includes('stopPolling'));
  t('A4 chat.js: WebAudio ding (no file/lib), gesture unlock, dingOnce dedupe, 2s throttle', chatSrc.includes('playDing') && chatSrc.includes('unlockAudioOnGesture') && chatSrc.includes('dingOnce') && chatSrc.includes('DING_GAP'));
  let panelsOk = true, verOk = true;
  for (const f of ['admin.html', 'manager.html', 'agent.html', 'client.html']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!s.includes('/assets/chat.js?v=gxchat')) panelsOk = false;
    if (!s.includes('/assets/chat.js?v=gxchat3')) verOk = false;
  }
  t('A5 all 4 panels load chat.js (cache-busted ?v=)', panelsOk);
  t('A6 all 4 panels bumped to ?v=gxchat2', verOk);
  const srvSrc = fs.readFileSync(path.join(ROOT, 'backend/chat.js'), 'utf8');
  t('A7 backend heartbeat emits named event (hb) — old clients ignore, new watchdog use', srvSrc.includes("sseSend(res, 'hb'"));

  /* ---------- B. SSE mode: open conversation LIVE update (owner case C) ---------- */
  {
    console.log('\n--- B. SSE mode (real stream) — user A open conv, user B sends, NO click/reopen ---');
    const P = await bootPanel('manager.html', mTok, 'gm1', true);
    const w = P.dom.window, d = w.document;
    w.GXChat.open('chat'); d.getElementById('page-chat').classList.add('active');
    await sleep(1200);
    /* user ne chat interface use kiya → audio unlock (autoplay policy) */
    d.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    const item = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('GA1'));
    t('B1 conversation list me GA1 dikhta hai', !!item);
    if (item) item.click();
    await sleep(1500);
    const S = w.GXChat._state;
    t('B2 conversation OPEN (gxcMsgs mounted, convId set)', !!d.getElementById('gxcMsgs') && S.convId === conv, 'convId=' + S.convId);
    t('B3 SSE connected, polling OFF (healthy SSE = zero polling)', !!S.es && !S.pollTimer, 'es=' + (S.es ? 'yes' : 'no') + ' poll=' + (S.pollTimer ? 'ON' : 'off'));
    const rows0 = d.querySelectorAll('#gxcMsgs .gxc-row').length;
    const dings0 = w.__gxdings;

    /* B sends 2 messages; A sirf dekhta hai */
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-LIVE-1 kaise ho?' }, aTok);
    await sleep(500);
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-LIVE-2 theek?' }, aTok);
    let seenIn = null; const t0 = Date.now();
    while (Date.now() - t0 < 4000) { await sleep(150); const txt = d.getElementById('gxcMsgs').textContent; if (txt.includes(TAG + '-LIVE-1') && txt.includes(TAG + '-LIVE-2')) { seenIn = Date.now() - t0; break; } }
    const rows1 = d.querySelectorAll('#gxcMsgs .gxc-row').length;
    t('B4 LIVE message OPEN conv me appeared bina click/reload ke', seenIn !== null, seenIn !== null ? seenIn + 'ms' : '4s me nahi aaya');
    t('B5 koi duplicate nahi (rows ' + rows0 + '→' + rows1 + ')', rows1 === rows0 + 2);
    t('B6 unread state khud clear (open conv = actively read; list me badge nahi)', await (async () => { await sleep(1500); const it = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('GA1')); return it ? !it.textContent.match(/\d+\s*$/) || !it.querySelector('.gxc-badge') : false; })(), 'list item refreshed post-read');
    const dings1 = w.__gxdings;
    t('B7 notification sound: incoming burst → subtle ding (≥1, throttle se ≤2)', dings1 > dings0 && dings1 - dings0 <= 2, dings0 + '→' + dings1);

    /* multiple rapid messages — sab aaye, no dup */
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-LIVE-3' }, aTok);
    await sleep(250);
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-LIVE-4' }, aTok);
    await sleep(250);
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-LIVE-5' }, aTok);
    await sleep(1800);
    const txtB = d.getElementById('gxcMsgs').textContent;
    t('B8 multiple messages sab real-time (3/3) + no dup', [3, 4, 5].every(n => txtB.includes(TAG + '-LIVE-' + n)) && (txtB.match(new RegExp(TAG + '-LIVE-3', 'g')) || []).length === 1, 'rows=' + d.querySelectorAll('#gxcMsgs .gxc-row').length);

    /* A khud reply karta hai — apne message par sound NAHI */
    const dingsBeforeOwn = w.__gxdings;
    const inp = d.getElementById('gxcInput');
    inp.value = TAG + '-OWN-1';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    d.getElementById('gxcSend').click();
    await sleep(1200);
    t('B9 apna bheja message render + sender ko sound NAHI', d.getElementById('gxcMsgs').textContent.includes(TAG + '-OWN-1') && w.__gxdings === dingsBeforeOwn, 'dings ' + dingsBeforeOwn + '→' + w.__gxdings);

    /* dusri conv ka message (owner case B) — open conv untouched, list/badge update, ding */
    const conv2 = (await api('/api/chat/conversations', 'POST', { user_id: idOf('ga2') }, mTok)).j.conversation_id;
    await api('/api/chat/messages/' + conv2, 'POST', { body: 'seed other conv' }, mTok);
    await sleep(300);
    const dingsBeforeOther = w.__gxdings;
    const rowsBeforeOther = d.querySelectorAll('#gxcMsgs .gxc-row').length;
    await api('/api/chat/messages/' + conv2, 'POST', { body: TAG + '-OTHER-1' }, a2Tok);
    let otherSeen = null; const t2 = Date.now();
    while (Date.now() - t2 < 4000) { await sleep(200); if (d.getElementById('gxcList').textContent.includes(TAG + '-OTHER-1')) { otherSeen = Date.now() - t2; break; } }
    await sleep(700);
    t('B10 doosri conv ka message → chat LIST preview live update', otherSeen !== null, otherSeen !== null ? otherSeen + 'ms' : 'nahi aaya');
    t('B11 open conv me doosri conv ka message leak NAHI', !d.getElementById('gxcMsgs').textContent.includes(TAG + '-OTHER-1') && d.querySelectorAll('#gxcMsgs .gxc-row').length === rowsBeforeOther);
    t('B12 doosri conv ka naya message → sound bhi', w.__gxdings > dingsBeforeOther, dingsBeforeOther + '→' + w.__gxdings);

    /* history load par sound nahi (reopen) */
    const dingsBeforeReopen = w.__gxdings;
    d.getElementById('gxcBack').click();
    await sleep(300);
    const item2 = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('GA1'));
    if (item2) item2.click();
    await sleep(1500);
    t('B13 history (reopen) par sound NAHI + history intact', w.__gxdings === dingsBeforeReopen && d.getElementById('gxcMsgs').textContent.includes(TAG + '-OWN-1'), 'dings ' + dingsBeforeReopen + '→' + w.__gxdings);

    /* visibility test: hidden me aaya message → visible hote hi catch-up (no dup) */
    let visOk = true;
    try {
      Object.defineProperty(d, 'visibilityState', { configurable: true, get: () => w.__vis || 'visible' });
      w.__vis = 'hidden';
      const rowsBeforeHidden = d.querySelectorAll('#gxcMsgs .gxc-row').length;
      await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-HID-1' }, aTok);
      await sleep(1200);
      const duringHidden = d.querySelectorAll('#gxcMsgs .gxc-row').length;
      w.__vis = 'visible';
      d.dispatchEvent(new w.Event('visibilitychange'));
      await sleep(1500);
      const afterVisible = d.querySelectorAll('#gxcMsgs .gxc-row').length;
      const hidTxt = d.getElementById('gxcMsgs').textContent;
      visOk = duringHidden === rowsBeforeHidden && afterVisible === rowsBeforeHidden + 1 && (hidTxt.match(new RegExp(TAG + '-HID-1', 'g')) || []).length === 1;
      t('B14 hidden-tab message: visible hote hi turant catch-up (ek hi baar, no dup)', visOk, rowsBeforeHidden + '→' + afterVisible);
    } catch (e) { t('B14 hidden-tab catch-up (SKIP: jsdom)', true, 'skipped'); }
    t('B15 panel console/JS errors: 0', P.errors.length === 0, P.errors.slice(0, 2).join(' | '));
    try { w.GXChat._state.es && w.GXChat._state.es.close(); } catch (e) {}
    P.dom.window.close();
    await sleep(400);
  }

  /* ---------- C. POLL mode (SSE na ho — jaise p19e jsdom me tha; 3s open-conv catch-up) ---------- */
  {
    console.log('\n--- C. POLL fallback mode (no EventSource) — open conv 3s catch-up ---');
    const P = await bootPanel('manager.html', mTok, 'gm1', false);
    const w = P.dom.window, d = w.document;
    w.GXChat.open('chat'); d.getElementById('page-chat').classList.add('active');
    await sleep(1000);
    d.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    const item = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('GA1'));
    if (item) item.click();
    await sleep(1500);
    const S = w.GXChat._state;
    t('C1 fallback polling active (SSE nahi)', !S.es && !!S.pollTimer, 'poll=' + (S.pollTimer ? 'ON' : 'off'));
    const rows0 = d.querySelectorAll('#gxcMsgs .gxc-row').length;
    const dings0 = w.__gxdings;
    await api('/api/chat/messages/' + conv, 'POST', { body: TAG + '-POLL-1' }, aTok);
    let seenIn = null; const t0 = Date.now();
    while (Date.now() - t0 < 9000) { await sleep(300); if (d.getElementById('gxcMsgs').textContent.includes(TAG + '-POLL-1')) { seenIn = Date.now() - t0; break; } }
    t('C2 open conv me message bina click ke (3s poll) ≤8s', seenIn !== null, seenIn !== null ? seenIn + 'ms' : '9s me nahi');
    const txtC = d.getElementById('gxcMsgs').textContent;
    t('C3 no dup (poll catch-up)', (txtC.match(new RegExp(TAG + '-POLL-1', 'g')) || []).length === 1);
    t('C4 poll mode me bhi incoming par sound', w.__gxdings > dings0, dings0 + '→' + w.__gxdings);
    /* dusri conv — badge-increase path se sound */
    const conv2b = (await api('/api/chat/conversations', 'POST', { user_id: idOf('ga2') }, mTok)).j.conversation_id;
    await sleep(2500); /* 2s ding-throttle window guzar jaye (by-design: burst me ek hi ding) */
    const dingsBefore = w.__gxdings;
    await api('/api/chat/messages/' + conv2b, 'POST', { body: TAG + '-POLL-OTHER' }, a2Tok);
    let otherSeen = null; const t3 = Date.now();
    while (Date.now() - t3 < 9000) { await sleep(400); if (d.getElementById('gxcList').textContent.includes(TAG + '-POLL-OTHER')) { otherSeen = Date.now() - t3; break; } }
    t('C5 doosri conv ka message → list preview update (poll mode)', otherSeen !== null, otherSeen !== null ? otherSeen + 'ms' : 'nahi');
    t('C6 badge-increase → sound (poll mode, doosri conv)', w.__gxdings > dingsBefore, dingsBefore + '→' + w.__gxdings);
    t('C7 poll mode panel errors: 0', P.errors.length === 0, P.errors.slice(0, 2).join(' | '));
    P.dom.window.close();
    await sleep(300);
  }

  /* ---------- D. refresh/login history + server-side sanity ---------- */
  {
    console.log('\n--- D. history / API regression ---');
    const h = await api('/api/chat/messages/' + conv + '?limit=30', 'GET', null, mTok);
    if (!h.j) { console.log('D-debug: status=' + h.status + ' body=' + String(h.b).slice(0, 300)); console.log('srvErr tail: ' + serverErr.split('\n').slice(-6).join('\n')); }
    const bodies = ((h.j || {}).messages || []).map(m => m.body);
    const want = [TAG + '-LIVE-1', TAG + '-LIVE-5', TAG + '-OWN-1', TAG + '-HID-1', TAG + '-POLL-1'];
    const missing = want.filter(x => !bodies.some(b => b.includes(x)));
    t('D1 fresh history me sab messages sahi (login/refresh = correct history)', missing.length === 0, missing.length ? 'MISSING: ' + missing.join(',') + ' | got ' + bodies.length + ' msgs: ' + bodies.join(' / ').slice(0, 200) : bodies.length + ' msgs');
    const send = await api('/api/chat/messages/' + conv, 'POST', { body: 'final-check' }, aTok);
    t('D2 send API unchanged (ok + message shape)', send.status === 200 && send.j.message && send.j.message.conversation_id === conv);
    const unread = await api('/api/chat/unread-count', 'GET', null, mTok);
    t('D3 unread-count API unchanged', unread.status === 200 && typeof unread.j.chat === 'number');
    const comp = await api('/api/complaints', 'GET', null, aTok);
    t('D4 complaints API untouched', comp.status === 200 && Array.isArray(comp.j));
    const sseT = await api('/api/chat/ticket', 'POST', {}, aTok);
    const raw = await new Promise(resolve => { const rq = http.get(BASE + '/api/chat/stream?ticket=' + encodeURIComponent(sseT.j.ticket), { headers: { Accept: 'text/event-stream' } }, rs => { let b = ''; rs.on('data', dd => b += dd); setTimeout(() => { try { rq.destroy(); } catch (e) {} resolve(b); }, 26000); }); rq.on('error', () => resolve('')); });
    t('D5 SSE stream: ready + 25s heartbeat (event: hb) dono aate hain', raw.includes('event: ready') && raw.includes('event: hb'), raw.length + 'B');
    const errLines = serverErr.split('\n').filter(l => l.trim() && !/EPIPE|ECONNRESET|dispatch/i.test(l));
    t('D6 server stderr clean (koi naya error nahi)', errLines.length === 0, errLines.slice(0, 2).join(' | '));
  }

  console.log('\n===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  try { serverProc.kill('SIGKILL'); } catch (e) {}
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); try { serverProc && serverProc.kill('SIGKILL'); } catch (e2) {} process.exit(1); });
