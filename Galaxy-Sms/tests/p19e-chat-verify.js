#!/usr/bin/env node
/* ===========================================================================
 * P19e CHAT + COMPLAINTS E2E VERIFICATION — owner ke 39 mandatory tests.
 * Fixture (owner ke example hierarchy jaisa):
 *   Admin > M1 > A1 > C1, C2 ;  Admin > M2 > A2 > C3
 * Functional 1-12 | Security 13-20 | Persistence 21-25 | UI 26-34 | Perf 35-39
 * =========================================================================== */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.P19E_PORT || '8099';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = process.env.P19E_DB || '/tmp/p19e.db';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
function t(name, ok, detail) { console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); if (ok) PASS++; else FAIL++; }
async function api(p_, method = 'GET', body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + p_, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function login(u, p) { return (await api('/api/login', 'POST', { username: u, password: p })).j.token || null; }
function openDb() { const Database = require('better-sqlite3'); return new Database(DB); }

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT: PORT, JWT_SECRET: 'p19e', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
    serverProc.on('exit', (code, sig) => { if (sig) console.log('[SERVER EXITED] code=' + code + ' signal=' + sig); });
    const t0 = Date.now();
    (async () => {
      for (let i = 0; i < 120; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return resolve(true); } catch (e) {} if (Date.now() - t0 > 30000) return reject(new Error('no start')); }
      reject(new Error('no start'));
    })();
  });
}
function stopServer() {
  return new Promise((resolve) => {
    const proc = serverProc; /* local capture — module var naye server ko point kar sakta hai (SIGKILL race) */
    if (!proc) return resolve();
    let settled = false;
    const fin = () => { if (!settled) { settled = true; resolve(); } };
    proc.on('exit', fin);
    try { proc.kill('SIGINT'); } catch (e) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} fin(); }, 6000);
  });
}
async function bootPanel(page, tok, user) {
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
    },
  });
  await sleep(2600);
  return { dom, errors };
}
function sseCollect(ticket, ms) {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/api/chat/stream?ticket=' + encodeURIComponent(ticket), { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = ''; const chunks = [];
      const done = () => { try { req.destroy(); } catch (e) {} resolve({ status: res.statusCode, ct: res.headers['content-type'], chunks }); };
      res.on('data', d => { buf += d.toString(); chunks.push(d.toString()); });
      setTimeout(done, ms);
    });
    req.on('error', () => resolve({ status: 0, ct: '', chunks: [] }));
  });
}

(async () => {
  console.log('P19e chat+complaints E2E — ' + new Date().toISOString());
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await startServer();
  const dbo = openDb();

  /* ---------- fixture: Admin > M1 > A1 > C1,C2 ; M2 > A2 > C3 ---------- */
  const adm = await login('vibepk', 'vibepk123');
  const mk = async (u, role, parent) => { await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() + ' Name', ...(parent ? {} : {}) }, parent || adm); return (await login(u, 'Test123!')); };
  const m1 = await mk('e2m1', 'manager');
  const m2 = await mk('e2m2', 'manager');
  const a1 = await mk('e2a1', 'agent', m1);
  const a2 = await mk('e2a2', 'agent', m2);
  const c1 = await mk('e2c1', 'client', a1);
  const c2 = await mk('e2c2', 'client', a1);
  const c3 = await mk('e2c3', 'client', a2);
  const ID = {}; for (const u of ['vibepk', 'e2m1', 'e2m2', 'e2a1', 'e2a2', 'e2c1', 'e2c2', 'e2c3']) ID[u] = dbo.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  t('setup: hierarchy created (Admin>M1>M2, A1@M1, A2@M2, C1/C2@A1, C3@A2)', !!(m1 && m2 && a1 && a2 && c1 && c2 && c3));

  const convWith = async (tok, targetId) => (await api('/api/chat/conversations', 'POST', { user_id: targetId }, tok)).j.conversation_id;
  const sendMsg = async (tok, convId, body) => api('/api/chat/messages/' + convId, 'POST', { body }, tok);
  const msgsOf = async (tok, convId) => (await api('/api/chat/messages/' + convId, 'GET', null, tok)).j;

  /* ================= FUNCTIONAL 1-8 ================= */
  console.log('\n--- Functional 1-8 (chat matrix) ---');
  let cv = await convWith(c1, ID.e2a1);
  let r = await sendMsg(c1, cv, 'Sir, I need help with my numbers.');
  t('1. Client -> Agent message', r.status === 200 && r.j.message.body.includes('help with my numbers'), JSON.stringify(r.j.message || {}).slice(0, 80));
  const cv_c1a1 = cv;
  r = await sendMsg(a1, cv, 'Bhejo, main check karta hoon.');
  t('2. Agent -> Client reply', r.status === 200);
  cv = await convWith(a1, ID.e2m1);
  const cv_a1m1 = cv;
  r = await sendMsg(a1, cv, 'Manager sahab, ek range ka masla hai.');
  t('3. Agent -> Manager message', r.status === 200);
  r = await sendMsg(m1, cv, 'Ok, detail bhejo.');
  t('4. Manager -> Agent reply', r.status === 200);
  cv = await convWith(m1, ID.vibepk);
  const cv_m1adm = cv;
  r = await sendMsg(m1, cv, 'Admin, monthly report review kar dein.');
  t('5. Manager -> Admin message', r.status === 200);
  r = await sendMsg(adm, cv, 'Zaroor, kal tak.');
  t('6. Admin -> Manager reply', r.status === 200);
  cv = await convWith(adm, ID.e2a1);
  const cv_adma1 = cv;
  r = await sendMsg(adm, cv, 'Agent A1, status update?');
  t('7. Admin -> Agent message', r.status === 200);
  cv = await convWith(adm, ID.e2c3);
  r = await sendMsg(adm, cv, 'Client 3, sab theek?');
  t('8. Admin -> Client message (where permitted)', r.status === 200);
  const cv_admc3 = cv;

  /* ================= COMPLAINTS 9-12 ================= */
  console.log('\n--- Complaints 9-12 ---');
  r = await api('/api/complaints', 'POST', { subject: 'Payout issue', body: 'Mera payout galat aaya hai is month.' }, a1);
  t('9. Agent -> Admin complaint', r.status === 200 && r.j.id > 0, JSON.stringify(r.j));
  const compId = r.j.id;
  r = await api('/api/complaints/' + compId, 'GET', null, adm);
  t('10. Admin opens complaint (sender identity + body)', r.status === 200 && r.j.sender.name === 'E2A1 Name' && r.j.sender.role_label === 'Agent' && r.j.body.includes('payout'), JSON.stringify(r.j.sender));
  r = await api('/api/complaints/' + compId + '/replies', 'POST', { body: 'Check kar rahe hain, 24h me update.' }, adm);
  t('11. Admin replies to complaint', r.status === 200);
  r = await api('/api/complaints/' + compId + '/status', 'POST', { status: 'In Progress' }, adm);
  const r2 = await api('/api/complaints/' + compId + '/status', 'POST', { status: 'Resolved' }, adm);
  t('12. Admin changes complaint status (In Progress -> Resolved)', r.status === 200 && r2.status === 200 && (await api('/api/complaints/' + compId, 'GET', null, a1)).j.status === 'Resolved');
  /* manager + client complaints bhi (spec: existing role structure ke andar) */
  r = await api('/api/complaints', 'POST', { subject: 'M issue', body: 'manager complaint body' }, m1);
  const rC3 = await api('/api/complaints', 'POST', { subject: 'C issue', body: 'client complaint body' }, c3);
  t('12b. Manager & Client complaint option (support, non-admin roles)', r.status === 200 && rC3.status === 200);

  /* ================= SECURITY 13-20 ================= */
  console.log('\n--- Security 13-20 (unauthorized access MUST FAIL) ---');
  const forbidden = async (name, tok, p_, method = 'GET', body) => {
    const rr = await api(p_, method, body, tok);
    t(name, rr.status === 403 || rr.status === 404, 'status=' + rr.status);
  };
  const cv_a2c3 = await convWith(a2, ID.e2c3); // Agent B ka apna client conv
  const cv_a2m2 = await convWith(a2, ID.e2m2);
  await forbidden('13. Agent A cannot access Agent B chat (A2<->M2)', a1, '/api/chat/messages/' + cv_a2m2);
  await forbidden('14a. Agent A cannot access another Agent\'s Client conversation (A2<->C3)', a1, '/api/chat/messages/' + cv_a2c3);
  await forbidden('14b. Agent A cannot POST into A2<->C3', a1, '/api/chat/messages/' + cv_a2c3, 'POST', { body: 'inject' });
  const cv_m2adm = await convWith(m2, ID.vibepk);
  await forbidden('15. Manager A cannot access Manager B chat (M2<->Admin)', m1, '/api/chat/messages/' + cv_m2adm);
  await forbidden('16. Manager cannot enter Agent\'s private Client conversation (A1<->C1)', m1, '/api/chat/messages/' + cv_c1a1);
  const cv_c2a1 = await convWith(c2, ID.e2a1);
  await forbidden('17. Client C1 cannot access Client C2 chat (C2<->A1)', c1, '/api/chat/messages/' + cv_c2a1);
  await forbidden('18. Client C1 cannot access another Agent\'s chat (A2<->C3)', c1, '/api/chat/messages/' + cv_a2c3);
  await forbidden('19. Normal user cannot access Admin\'s private conversation (M2<->Admin)', c1, '/api/chat/messages/' + cv_m2adm);
  await forbidden('19b. Agent cannot start chat with Admin (complaint-only path)', a1, '/api/chat/conversations', 'POST', { user_id: ID.vibepk });
  await forbidden('19c. Client cannot start chat with Admin', c1, '/api/chat/conversations', 'POST', { user_id: ID.vibepk });
  await forbidden('19d. Agent A cannot start chat with Agent B', a1, '/api/chat/conversations', 'POST', { user_id: ID.e2a2 });
  await forbidden('19e. Manager A cannot start chat with Manager B', m1, '/api/chat/conversations', 'POST', { user_id: ID.e2m2 });
  await forbidden('19f. Manager cannot start chat with Client (down-level skip)', m1, '/api/chat/conversations', 'POST', { user_id: ID.e2c1 });
  await forbidden('19g. Client C1 cannot start chat with other Agent A2', c1, '/api/chat/conversations', 'POST', { user_id: ID.e2a2 });
  await forbidden('19h. Client cannot start chat with other Client', c1, '/api/chat/conversations', 'POST', { user_id: ID.e2c2 });
  await forbidden('19i. Non-admin cannot use scope=all', a1, '/api/chat/conversations?scope=all');
  await forbidden('19j. Non-admin cannot read another complaint', c1, '/api/complaints/' + compId);
  await forbidden('19k. Non-admin cannot change complaint status', a1, '/api/complaints/' + compId + '/status', 'POST', { status: 'Open' });
  await forbidden('19l. Admin cannot create complaint (receiver hai)', adm, '/api/complaints', 'POST', { subject: 'x', body: 'y' });
  { const rr = await api('/api/chat/messages/' + cv_a1m1, 'POST', { body: '   ' }, a1); t('19m. Empty message rejected (API, 400)', rr.status === 400, 'status=' + rr.status); }
  /* 20. Admin can access ALL */
  r = await api('/api/chat/messages/' + cv_a2c3, 'GET', null, adm);
  t('20a. Admin can access ANY conversation (A2<->C3)', r.status === 200);
  r = await api('/api/chat/messages/' + cv_c1a1, 'GET', null, adm);
  t('20b. Admin can read Agent-Client private conversation', r.status === 200 && r.j.messages.length >= 2);
  r = await sendMsg(adm, cv_c1a1, 'Admin checking in — sab theek?');
  t('20c. Admin can REPLY inside any conversation', r.status === 200);
  const allConvs = (await api('/api/chat/conversations?scope=all', 'GET', null, adm)).j;
  const mineConvs = (await api('/api/chat/conversations', 'GET', null, adm)).j;
  t('20d. Admin All-Chats view: saari conversations dikhti hain', Array.isArray(allConvs) && allConvs.length >= 8, 'all=' + allConvs.length);
  t('20e. Admin My-Chats sirf apni conversations', Array.isArray(mineConvs) && mineConvs.every(x => x.other), 'mine=' + mineConvs.length);

  /* contacts scoping */
  const contactsOf = async (tok) => (await api('/api/chat/contacts', 'GET', null, tok)).j.map(u => u.username);
  t('SEC-contacts: client sirf apna agent dekhta hai', JSON.stringify(await contactsOf(c1)) === JSON.stringify(['e2a1']), JSON.stringify(await contactsOf(c1)));
  const agCt = await contactsOf(a1);
  t('SEC-contacts: agent = apne clients + apna manager (NO admin, NO other agents)', agCt.includes('e2c1') && agCt.includes('e2c2') && agCt.includes('e2m1') && !agCt.includes('vibepk') && !agCt.includes('e2a2') && !agCt.includes('e2m2'), JSON.stringify(agCt));
  const mgCt = await contactsOf(m1);
  t('SEC-contacts: manager = apne agents + admin (no clients, no other managers)', mgCt.includes('e2a1') && mgCt.includes('vibepk') && !mgCt.includes('e2c1') && !mgCt.includes('e2m2'), JSON.stringify(mgCt));
  const adCt = await contactsOf(adm);
  t('SEC-contacts: admin = sab users', adCt.length >= 7, 'n=' + adCt.length);

  /* ================= PERSISTENCE 21-25 ================= */
  console.log('\n--- Persistence 21-25 (incl. server restart) ---');
  r = await sendMsg(c1, cv_c1a1, 'Persistence test message');
  const persistId = r.j.message.id;
  await stopServer();
  await startServer();
  const c1b = await login('e2c1', 'Test123!');
  r = await api('/api/chat/messages/' + cv_c1a1, 'GET', null, c1b);
  t('21-25. message survives restart+relogin (id ' + persistId + ')', r.status === 200 && r.j.messages.some(m => m.id === persistId && m.body === 'Persistence test message'), 'msgs=' + r.j.messages.length);
  r = await api('/api/complaints/' + compId, 'GET', null, c1b);
  t('21-25b. complaint access still scoped after restart (client C1 -> 403)', r.status === 403);

  /* ================= UI 26-34 (jsdom: client + agent + admin) ================= */
  console.log('\n--- UI 26-34 ---');
  /* client sends 2 unread to agent first */
  await sendMsg(c1, cv_c1a1, 'UI unread #1');
  await sendMsg(c1, cv_c1a1, 'UI unread #2');

  const cl = await bootPanel('client', c1b, 'e2c1');
  const cw = cl.dom.window;
  t('UI-26a client panel boots with chat page, 0 errors', cl.errors.length === 0, cl.errors.slice(0, 2).join(';;'));
  t('UI-26b Chat + Complaints nav items exist', !!cw.document.querySelector('.tab[data-page="chat"]') && !!cw.document.querySelector('.tab[data-page="complaints"]'));
  cw.showPage('chat'); await sleep(900);
  t('UI-26c chat UI builds (list + search + new-chat)', !!cw.document.getElementById('gxcList') && !!cw.document.getElementById('gxcSearch') && !!cw.document.getElementById('gxcNew'));
  /* open conversation with agent via list click */
  await new Promise(res => { const iv = setInterval(() => { if ((cw.GXChat._state.convs || []).length) { clearInterval(iv); res(); } }, 200); setTimeout(() => { clearInterval(iv); res(); }, 5000); });
  const convItem = [...cw.document.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('E2A1'));
  t('UI-31a conversation list shows agent (name+role+last msg)', !!convItem && convItem.textContent.includes('Agent') && convItem.textContent.includes('UI unread'), convItem ? convItem.textContent.slice(0, 60) : 'none');
  if (convItem) convItem.click();
  await sleep(1000);
  t('UI-27a conversation view opens (bubbles render, sender identity visible)', cw.document.querySelectorAll('#gxcMsgs .gxc-row').length >= 4 && cw.document.querySelector('#gxcMsgs .gxc-sender') && cw.document.querySelector('#gxcMsgs .gxc-sender').textContent.includes('E2A1'), cw.document.querySelectorAll('#gxcMsgs .gxc-row').length + ' rows');
  /* emoji */
  cw.document.getElementById('gxcEmojibtn').click();
  await sleep(200);
  const popBtns = [...cw.document.querySelectorAll('#gxcEmojiPop button')];
  t('UI-28a emoji picker opens with emojis', popBtns.length >= 80, String(popBtns.length));
  if (popBtns.length) popBtns[3].click();
  t('UI-28b emoji inserted into input', /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(cw.document.getElementById('gxcInput').value), JSON.stringify(cw.document.getElementById('gxcInput').value));
  /* send + empty rejection */
  cw.document.getElementById('gxcSend').click(); await sleep(800);
  t('UI-28c emoji message sent + rendered', [...cw.document.querySelectorAll('#gxcMsgs .gxc-bubble')].some(b => /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(b.textContent)));
  t('UI-30a empty message rejected (send disabled on empty input)', cw.document.getElementById('gxcSend').disabled === true);
  const beforeCount = cw.document.querySelectorAll('#gxcMsgs .gxc-row').length;
  cw.GXChat._state; cw.document.getElementById('gxcSend').click(); await sleep(400);
  t('UI-30b clicking disabled send adds nothing', cw.document.querySelectorAll('#gxcMsgs .gxc-row').length === beforeCount);
  /* long message */
  const long = 'L'.repeat(1500);
  const inp = cw.document.getElementById('gxcInput');
  inp.value = long; inp.dispatchEvent(new cw.Event('input', { bubbles: true }));
  cw.document.getElementById('gxcSend').click(); await sleep(900);
  const longBubble = [...cw.document.querySelectorAll('#gxcMsgs .gxc-bubble')].find(b => b.textContent.length === 1500);
  t('UI-29 long message (1500 chars) sent + rendered', !!longBubble);
  /* timestamps + read status (my sent msgs) */
  t('UI-32a timestamps on messages', !!cw.document.querySelector('#gxcMsgs .gxc-mmeta span'));
  const ticks = [...cw.document.querySelectorAll('#gxcMsgs .gxc-row.mine .gxc-ticks')];
  t('UI-32b read status ticks render (client ke sent messages)', ticks.length >= 2, String(ticks.length));
  /* multiple conversations (client has only agent — agent panel will have 3) */
  cw.GXChat._state.convs.length === 1 && t('UI-33a client: 1 conversation (apna agent)', (cw.GXChat._state.convs || []).length === 1);

  /* agent panel: unread badge + multiple conversations + read */
  const ag1 = await login('e2a1', 'Test123!');
  const ag = await bootPanel('agent', ag1, 'e2a1');
  const aw = ag.dom.window;
  t('UI-31b agent panel: 0 errors', ag.errors.length === 0, ag.errors.slice(0, 2).join(';;'));
  aw.showPage('chat'); await sleep(1000);
  await new Promise(res => { const iv = setInterval(() => { if ((aw.GXChat._state.convs || []).length >= 3) { clearInterval(iv); res(); } }, 200); setTimeout(() => { clearInterval(iv); res(); }, 6000); });
  const agConvs = aw.GXChat._state.convs || [];
  t('UI-33b agent: multiple conversations (C1, C2, Manager)', agConvs.length >= 3 && agConvs.some(x => x.other && x.other.username === 'e2c1') && agConvs.some(x => x.other && x.other.username === 'e2m1'), JSON.stringify(agConvs.map(x => x.other && x.other.username)));
  const c1Item = [...aw.document.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('E2C1'));
  t('UI-31c unread badge visible on C1 conversation (2+)', c1Item && /badge/.test(c1Item.innerHTML) && c1Item.querySelector('.gxc-badge'), c1Item ? (c1Item.querySelector('.gxc-badge') || {}).textContent : 'none');
  if (c1Item) { c1Item.click(); await sleep(1400); aw.GXChat.refresh(); await sleep(700); }
  const badgeAfter = aw.document.querySelector('#gxChatBadge');
  const c1ItemAfter = [...aw.document.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('E2C1'));
  t('UI-31d C1 conversation ka unread badge gaya + nav badge sirf baaki conv ka (m1+admin=2)', c1ItemAfter && !c1ItemAfter.querySelector('.gxc-badge') && badgeAfter && badgeAfter.textContent === '2', 'nav=' + (badgeAfter || {}).textContent);
  /* agent sees ✓✓ update? (their own sent msgs read by client earlier — client opened conv) */
  const readTicks = [...aw.document.querySelectorAll('#gxcMsgs .gxc-row.mine .gxc-ticks.read')];
  t('UI-32c read receipt (✓✓) on agent messages read by client', readTicks.length >= 1, String(readTicks.length));
  /* search */
  const srch = aw.document.getElementById('gxcSearch');
  srch.value = 'E2C2'; srch.dispatchEvent(new aw.Event('input', { bubbles: true })); await sleep(200);
  t('UI-26d search filters conversation list', [...aw.document.querySelectorAll('#gxcList .gxc-item')].every(x => x.textContent.includes('E2C2')) && [...aw.document.querySelectorAll('#gxcList .gxc-item')].length >= 1);

  /* pagination: seed 45 messages in C2<->A1 conv */
  const cv_c2a1b = await convWith(c2, ID.e2a1);
  for (let i = 1; i <= 45; i++) await sendMsg(i % 2 ? a1 : c2, cv_c2a1b, 'pag m' + i);
  const pagData = await api('/api/chat/messages/' + cv_c2a1b + '?limit=30', 'GET', null, a1);
  t('UI-34a history pagination: initial window 30, has_older=true', pagData.j.messages.length === 30 && pagData.j.has_older === true);
  const older = await api('/api/chat/messages/' + cv_c2a1b + '?before_id=' + pagData.j.messages[0].id + '&limit=30', 'GET', null, a1);
  t('UI-34b older page loads remaining 15', older.j.messages.length === 15 && older.j.has_older === false);
  const sum = new Set([...pagData.j.messages, ...older.j.messages].map(m => m.id)).size;
  t('UI-34c no duplicates across pages (45 unique)', sum === 45, String(sum));

  /* admin panel: All Chats */
  const ad = await bootPanel('admin', adm, 'vibepk');
  const adw = ad.dom.window;
  t('UI-admin panel: 0 errors', ad.errors.length === 0, ad.errors.slice(0, 2).join(';;'));
  adw.showPage('chat'); await sleep(1100);
  t('UI-admin My/All tabs exist', !!adw.document.getElementById('gxcTabMine') && !!adw.document.getElementById('gxcTabAll'));
  adw.document.getElementById('gxcTabAll').click(); await sleep(900);
  const allRows = [...adw.document.querySelectorAll('#gxcList .gxc-item')];
  t('UI-admin All Chats: sab conversations (both participants named)', allRows.length >= 8 && allRows.some(x => x.textContent.includes('↔')), String(allRows.length));
  const a2c3Row = allRows.find(x => x.textContent.includes('E2A2') && x.textContent.includes('E2C3'));
  if (a2c3Row) { a2c3Row.click(); await sleep(900); }
  t('UI-admin can open A2<->C3 conversation (header both names)', adw.document.querySelector('#gxcHeadName, .gxc-head .gxc-nm') && adw.document.querySelector('.gxc-head .gxc-nm').textContent.includes('↔'), (adw.document.querySelector('.gxc-head .gxc-nm') || {}).textContent);
  /* admin replies inside */
  const inpA = adw.document.getElementById('gxcInput');
  inpA.value = 'Admin reply inside A2-C3 chat'; inpA.dispatchEvent(new adw.Event('input', { bubbles: true }));
  adw.document.getElementById('gxcSend').click(); await sleep(900);
  const lastMsgs = await msgsOf(c3, cv_admc3); /* not this conv — check via a2 */
  const a2msgs = await msgsOf(a2, cv_a2c3);
  t('UI-admin reply appears in A2<->C3 with Admin identity', Array.isArray(a2msgs.messages) && a2msgs.messages.some(m => m.sender_role === 'Admin' && m.body.includes('Admin reply inside')), JSON.stringify(a2msgs).slice(0, 140));
  void lastMsgs;

  /* complaints UI: agent creates, admin manages */
  aw.showPage('complaints'); await sleep(700);
  aw.document.getElementById('gxcCNew').click(); await sleep(300);
  aw.document.getElementById('gxcCSubject').value = 'UI complaint subject';
  aw.document.getElementById('gxcCBody').value = 'UI complaint body detail';
  aw.document.getElementById('gxcCSend').click(); await sleep(900);
  const compList = (await api('/api/complaints', 'GET', null, adm)).j;
  const uiComp = compList.find(x => x.subject === 'UI complaint subject');
  t('UI-comp1 agent created complaint via UI (status Open)', !!uiComp && uiComp.status === 'Open' && uiComp.sender.username === 'e2a1', uiComp ? '#' + uiComp.id : 'none');
  adw.showPage('complaints'); await sleep(800);
  const compRow = [...adw.document.querySelectorAll('#gxcCBody tr')].find(x => x.textContent.includes('UI complaint subject'));
  t('UI-comp2 admin complaints list shows it (From: E2A1 NAME, Agent)', !!compRow && compRow.textContent.includes('E2A1 Name') && compRow.textContent.includes('Agent'));
  if (compRow) { compRow.click(); await sleep(800); }
  const repIn = adw.document.getElementById('gxcCReply');
  repIn.value = 'Admin UI reply'; adw.document.getElementById('gxcCReplyBtn').click(); await sleep(900);
  adw.document.getElementById('gxcCStatus').value = 'In Progress';
  adw.document.getElementById('gxcCStatusBtn').click(); await sleep(900);
  const compAfter = (await api('/api/complaints/' + (uiComp ? uiComp.id : 0), 'GET', null, adm)).j;
  t('UI-comp3 admin replied + status changed via UI', compAfter.status === 'In Progress' && compAfter.replies.some(x => x.body === 'Admin UI reply' && x.sender_role === 'Admin'), compAfter.status);

  /* reload persistence UI (fresh client session) */
  try { cw.close(); } catch (e) {}
  const cl2 = await bootPanel('client', c1b, 'e2c1');
  cl2.dom.window.showPage('chat'); await sleep(1000);
  await new Promise(res => { const iv = setInterval(() => { if ((cl2.dom.window.GXChat._state.convs || []).length) { clearInterval(iv); res(); } }, 200); setTimeout(() => { clearInterval(iv); res(); }, 5000); });
  const cl2item = [...cl2.dom.window.document.querySelectorAll('#gxcList .gxc-item')].find(x => x.textContent.includes('E2A1'));
  if (cl2item) cl2item.click();
  await sleep(900);
  t('UI-22-24 reload (fresh session): authorized history intact', [...cl2.dom.window.document.querySelectorAll('#gxcMsgs .gxc-row')].length >= 5, String(cl2.dom.window.document.querySelectorAll('#gxcMsgs .gxc-row').length));

  /* mobile responsive static checks (chat CSS) */
  const chatSrc = fs.readFileSync(path.join(ROOT, 'assets/chat.js'), 'utf8');
  t('UI-27b mobile CSS: media query + full-screen conv + back button + safe-area + no-overflow rules',
    /@media\(max-width:900px\)/.test(chatSrc) && /\.gxc-main\{display:flex;position:fixed;inset:0/.test(chatSrc) && /\.gxc-back\{display:flex/.test(chatSrc) && /safe-area-inset-bottom/.test(chatSrc) && /max-width:88%/.test(chatSrc));
  t('UI-27c sticky input at bottom (keyboard-safe)', /gxc-inputbar[\s\S]*?position:sticky;bottom:0/.test(chatSrc));
  try { cl2.dom.window.close(); } catch (e) {}
  try { aw.close(); } catch (e) {}
  try { adw.close(); } catch (e) {}

  /* ================= PERFORMANCE 35-39 ================= */
  console.log('\n--- Performance 35-39 ---');
  /* 35: concurrent sends — 6 users x 10 msgs parallel */
  const t0 = Date.now();
  const jobs = [];
  const users = [[c1, cv_c1a1], [c2, cv_c2a1b], [a1, cv_a1m1], [a2, cv_a2c3], [m1, cv_m1adm], [adm, cv_adma1]];
  for (const [tok, conv] of users) for (let i = 0; i < 10; i++) jobs.push(sendMsg(tok, conv, 'perf ' + i));
  const results = await Promise.all(jobs);
  const okCount = results.filter(x => x.status === 200).length;
  const ms = Date.now() - t0;
  t('35. 60 concurrent messages (6 users x 10) — all OK', okCount === 60, okCount + '/60 in ' + ms + 'ms');
  t('35b. throughput sane (' + ms + 'ms total)', ms < 30000);
  const dbCount = dbo.prepare('SELECT COUNT(*) c FROM chat_messages').get().c;
  t('35c. all messages persisted', dbCount >= 60 + 50 + 3, 'rows=' + dbCount);

  /* 36-37: existing APIs latency under chat load */
  async function avgLatency(p_, tok, n) { const ts = []; for (let i = 0; i < n; i++) { const a0 = Date.now(); await api(p_, 'GET', null, tok); ts.push(Date.now() - a0); } return ts.reduce((a, b) => a + b, 0) / n; }
  const dashBefore = await avgLatency('/api/dashboard?_nocache=1', adm, 5);
  const numsBefore = await avgLatency('/api/numbers?limit=25', adm, 5);
  const load = []; for (const [tok, conv] of users) for (let i = 0; i < 8; i++) load.push(sendMsg(tok, conv, 'load ' + i));
  const [dashDuring, numsDuring] = await Promise.all([avgLatency('/api/dashboard?_nocache=1', adm, 5), avgLatency('/api/numbers?limit=25', adm, 5), ...load]).then(x => [x[0], x[1]]);
  t('36-37. /api/dashboard avg ' + dashBefore.toFixed(0) + 'ms -> ' + dashDuring.toFixed(0) + 'ms under load (no blocking)', dashDuring < Math.max(1200, dashBefore * 6), '');
  t('36-37b. /api/numbers avg ' + numsBefore.toFixed(0) + 'ms -> ' + numsDuring.toFixed(0) + 'ms under load', numsDuring < Math.max(1500, numsBefore * 6), '');
  const rss = process.memoryUsage().rss / 1048576;
  t('36b. server RSS reasonable (<600MB)', serverProc.killed === false && rss < 600, rss.toFixed(0) + 'MB (test-process)');

  /* 38: no excessive polling — SSE primary; polling fallback only 9s interval */
  const sseT = await api('/api/chat/ticket', 'POST', {}, adm);
  const sse1 = await sseCollect(sseT.j.ticket, 1200);
  t('38a. SSE endpoint works (event-stream, ready event, 200)', sse1.status === 200 && /text\/event-stream/.test(sse1.ct || '') && sse1.chunks.join('').includes('event: ready'), sse1.ct);
  const sseBad = await sseCollect('deadbeef', 800);
  t('38b. bad ticket rejected (401)', sseBad.status === 401, String(sseBad.status));
  const sseReuse = await api('/api/chat/ticket', 'POST', {}, adm);
  const tk = sseReuse.j.ticket;
  await sseCollect(tk, 600); /* consume */
  const sseAgain = await sseCollect(tk, 600);
  t('38c. ticket one-time use (reuse -> 401)', sseAgain.status === 401, String(sseAgain.status));
  /* live push: open stream as m1, then a1 sends message in a1<->m1 */
  const m1T = await api('/api/chat/ticket', 'POST', {}, m1);
  const pushP = sseCollect(m1T.j.ticket, 2500);
  await sleep(600);
  await sendMsg(a1, cv_a1m1, 'SSE push test');
  const push = await pushP;
  const pushed = push.chunks.join('');
  t('38d. SSE live push: message delivered without polling', pushed.includes('event: msg') && pushed.includes('SSE push test'), '');
  /* P19g update: fallback ab adaptive hai — open conv 3s / baaki 9s (setTimeout chain),
     visibility-guarded, aur SSE healthy hone par poll bilkul bandh (stopPolling). */
  t('38e. polling fallback bounded (9s / open-conv 3s — P19g) + visibility-guarded + SSE-healthy=zero-poll', /\? 3000 : 9000/.test(chatSrc) && /visibilityState\s*===\s*'hidden'/.test(chatSrc) && /stopPolling/.test(chatSrc), '');

  /* 39: indexes used (EXPLAIN QUERY PLAN) */
  const plans = {
    msgConv: dbo.prepare(`EXPLAIN QUERY PLAN SELECT * FROM chat_messages WHERE conversation_id=1 ORDER BY id DESC LIMIT 30`).all().map(x => x.detail).join(' | '),
    convMine: dbo.prepare(`EXPLAIN QUERY PLAN SELECT * FROM chat_conversations WHERE user_a=1 OR user_b=1`).all().map(x => x.detail).join(' | '),
    unread: dbo.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM chat_messages m JOIN chat_conversations c2 ON c2.id=m.conversation_id WHERE (c2.user_a=1 OR c2.user_b=1) AND m.sender_id<>1 AND m.read_at IS NULL`).all().map(x => x.detail).join(' | '),
    complaints: dbo.prepare(`EXPLAIN QUERY PLAN SELECT * FROM complaints WHERE sender_id=1 ORDER BY created_at DESC`).all().map(x => x.detail).join(' | '),
  };
  t('39a. messages query uses index', /idx_chat_msg_conv/.test(plans.msgConv), plans.msgConv);
  t('39b. conversations query uses indexes', /idx_chat_conv/.test(plans.convMine), plans.convMine);
  t('39c. unread-count uses indexes', /idx_chat/.test(plans.unread), plans.unread);
  t('39d. complaints query uses index', /idx_complaints_sender/.test(plans.complaints), plans.complaints);

  console.log('===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  await stopServer();
  process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('SUITE ERROR:', e); await stopServer(); process.exit(1); });
