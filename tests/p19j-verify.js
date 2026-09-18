#!/usr/bin/env node
/**
 * tests/p19j-verify.js — P19j THREE-CHANGE VERIFICATION
 *   1) Language: ALL user-visible panel text professional English (automated Roman-Urdu sweep)
 *   2) Payment: wallet address -> Binance UID (agent save/request, validation, admin review,
 *      legacy TRC20 records preserved, calculations/approval flow unchanged)
 *   3) Chat floating shortcut button (bottom-right, above AI assistant, existing chat system,
 *      existing unread badge, all 4 panels incl. client, sidebar chat unchanged)
 *
 * Run: node tests/p19j-verify.js   (repo root; jsdom needed for UI part -> /tmp/uitest fallback)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB = '/tmp/p19j.db';
const PORT = process.env.P19J_PORT || '8099';
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
/* multipart POST (admin pay endpoint — screenshot optional, txid only here) */
function apiMultipart(p, tok, fields) {
  const B = '----p19j' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push('--' + B + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n');
  }
  parts.push('--' + B + '--\r\n');
  const body = Buffer.from(parts.join(''));
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + B, Authorization: 'Bearer ' + tok, 'Content-Length': body.length } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, j, b }); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function startServer() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  serverProc = spawn('node', ['backend/server.js'], { cwd: ROOT, env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19j', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); process.stderr.write('[srv-err] ' + d); });
  for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await api('/api/health', 'GET'); if (r.status === 200) return; } catch (e) {} }
  throw new Error('server did not start');
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status); return r.j.token; }

/* real EventSource polyfill (SSE) for jsdom — same as p19g */
function installEventSource(window) {
  class ES extends window.EventTarget {
    constructor(url) {
      super(); this.readyState = 0;
      const req = http.get(new URL(String(url), BASE).href, { headers: { Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { this.readyState = 2; this.dispatchEvent(new window.Event('error')); try { req.destroy(); } catch (e) {} return; }
        this.readyState = 1; let buf = '';
        res.on('data', d => {
          buf += d.toString(); let idx;
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
function installAudioStub(window) {
  window.__gxdings = 0;
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { const o = { type: '', frequency: { value: 0 }, connect() {}, start() { window.__gxdings++; }, stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
}
async function bootPanel(page, tok, user, opts = {}) {
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
      window.__p19jCalls = [];
      window.fetch = (input, init) => { try { window.__p19jCalls.push({ url: String(input), method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' }); } catch (e) {} return fetch(new URL(String(input), BASE).href, init); };
      window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.localStorage.setItem('ms_token', tok); window.localStorage.setItem('ms_role', page.replace('.html', ''));
      window.localStorage.setItem('ms_user', user); window.localStorage.setItem('ms_name', user);
      if (opts.sse) installEventSource(window);
      installAudioStub(window);
    },
  });
  await sleep(opts.wait || 3000);
  return { dom, errors };
}

(async () => {
  console.log('P19j verification — ' + new Date().toISOString());
  await startServer();
  const dbo = new Database(DB);
  const adm = await login('vibepk', 'vibepk123');
  const mk = async (u, role, viaTok) => { const r = await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() + ' Name' }, viaTok || adm); if (r.status !== 200 && r.status !== 201) throw new Error('mk ' + u + ': ' + r.status + ' ' + r.b); return login(u, 'Test123!'); };
  const mTok = await mk('jm1', 'manager');
  const aTok = await mk('ja1', 'agent', mTok);
  const a2Tok = await mk('ja2', 'agent', mTok); /* legacy-wallet agent */
  const cTok = await mk('jc1', 'client', aTok);
  const idOf = u => dbo.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  const A1 = idOf('ja1'), A2 = idOf('ja2');
  const UID1 = '12345678', UID1B = '123456789012';

  /* ================= A. code-level markers ================= */
  console.log('\n--- A. code markers (schema/server/panels/chat.js) ---');
  const schemaSrc = fs.readFileSync(path.join(ROOT, 'backend/schema.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(ROOT, 'backend/server.js'), 'utf8');
  const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.html'), 'utf8');
  const adminSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'assets/chat.js'), 'utf8');
  t('A1 schema.js: additive binance_uid columns (agent_wallets + payment_requests_v2)', schemaSrc.includes("ensureColumn('agent_wallets', 'binance_uid'") && schemaSrc.includes("ensureColumn('payment_requests_v2', 'binance_uid'"));
  t('A2 schema.js: wallet_address columns NOT dropped (history preserved)', schemaSrc.includes('wallet_address TEXT DEFAULT') || schemaSrc.includes('wallet_address TEXT NOT NULL'));
  t('A3 server.js: binanceUidValid (8-12 digits) + PUT wallet stores binance_uid', srvSrc.includes('function binanceUidValid(v){ return /^\\d{8,12}$/') && srvSrc.includes('binance_uid=?,network=\'BINANCE_UID\''));
  t('A4 server.js: agent request requires Binance UID (was walletValid)', srvSrc.includes('binanceUidValid(wallet.binance_uid)') && srvSrc.includes('Save your Binance UID first'));
  t('A5 server.js: request INSERT stores binance_uid; wallet_address kept for schema compat', srvSrc.includes('INSERT INTO payment_requests_v2 (agent_id,manager_id,payment_type,amount,wallet_address,binance_uid,status)'));
  t('A6 agent.html: Binance UID label + placeholder + save button + warning', agentSrc.includes('<label>Binance UID</label>') && agentSrc.includes('placeholder="Enter your Binance UID"') && agentSrc.includes('Save Binance UID') && /Warning: Payments are sent to the Binance UID/.test(agentSrc));
  t('A7 agent.html: help modal 4 steps + web method', agentSrc.includes('How to find your Binance UID') && agentSrc.includes('Step 4') && agentSrc.includes('binance.com'));
  t('A8 agent.html: history table header Binance UID + legacy wallet fallback tag', agentSrc.includes('<th>Binance UID</th>') && agentSrc.includes('legacy wallet'));
  t('A9 agent.html: old Wallet Address UI gone from active flow', !agentSrc.includes('<h3>USDT (TRC20) Wallet</h3>') && !agentSrc.includes('<label>Wallet Address</label>') && !agentSrc.includes('Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  t('A10 admin.html: Payment Requests review card + Binance UID column + legacy fallback', adminSrc.includes('Payment Requests</h3>') && adminSrc.includes('<th>Binance UID</th>') && adminSrc.includes('legacy wallet'));
  t('A11 admin.html: mark-paid (multipart, existing endpoint) + reject wired', adminSrc.includes("API.upload('/payment-v2/admin/requests/'+id+'/pay'") && adminSrc.includes("API.post('/payment-v2/admin/requests/'+id+'/reject'"));
  let verOk = true;
  for (const f of ['admin.html', 'manager.html', 'agent.html', 'client.html']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!s.includes('/assets/chat.js?v=gxchat4')) verOk = false;
  }
  t('A12 all 4 panels bumped ?v=gxchat4 (P19k responsive update)', verOk);
  t('A13 chat.js: floating shortcut exists, opens EXISTING chat via panel nav router', chatSrc.includes('gxChatFab') && chatSrc.includes('nav.click()'));
  t('A14 chat.js: FAB badge fed by EXISTING unread tracking (no second system)', chatSrc.includes("setBadge('gxChatBadge', b.chat)") && chatSrc.includes('gxChatFabBadge') && !/unread-count-fab|fab-unread/.test(chatSrc));
  t('A15 chat.js: responsive rule + stacked above AI assistant button', chatSrc.includes('@media(max-width:480px){#gxChatFab') && chatSrc.includes('gxAssistantBtn'));

  /* ================= B. Binance UID save + validation (server-side) ================= */
  console.log('\n--- B. Binance UID validation + save (agent ja1) ---');
  let r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '' }, aTok);
  t('B1 empty UID rejected (400)', r.status === 400, r.status + ' ' + r.b.slice(0, 60));
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '   ' }, aTok);
  t('B2 whitespace-only rejected (trim + required)', r.status === 400, r.status + ' ' + r.b.slice(0, 60));
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: 'abcd1234' }, aTok);
  t('B3 non-numeric rejected', r.status === 400, r.status);
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '1234567' }, aTok);
  t('B4 7 digits rejected', r.status === 400, r.status);
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '1234567890123' }, aTok);
  t('B5 13 digits rejected (not overly restrictive but numeric 8-12)', r.status === 400, r.status);
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: UID1 }, aTok);
  t('B6 valid 8-digit UID saved', r.status === 200 && r.j && r.j.binance_uid === UID1, r.b.slice(0, 80));
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '  ' + UID1B + ' ' }, aTok);
  t('B7 12-digit boundary + trim works', r.status === 200 && r.j && r.j.binance_uid === UID1B, r.b.slice(0, 80));
  r = await api('/api/payment-v2/agent/summary', 'GET', null, aTok);
  t('B8 summary returns saved binance_uid', r.status === 200 && r.j.wallet && r.j.wallet.binance_uid === UID1B, JSON.stringify(r.j.wallet || {}).slice(0, 80));
  const dbUid = dbo.prepare('SELECT binance_uid, wallet_address FROM agent_wallets WHERE agent_id=?').get(A1);
  t('B9 DB row: binance_uid stored; wallet_address empty (new flow), network BINANCE_UID', dbUid && dbUid.binance_uid === UID1B && (dbUid.wallet_address === '' || dbUid.wallet_address == null), JSON.stringify(dbUid));

  /* ================= C. legacy TRC20 records safety (no data loss) ================= */
  console.log('\n--- C. legacy wallet records preserved ---');
  dbo.prepare("INSERT INTO agent_wallets (agent_id,wallet_address,network) VALUES (?,?,?)").run(A2, 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ', 'USDT_TRC20');
  r = await api('/api/payment-v2/agent/wallet', 'GET', null, a2Tok);
  t('C1 legacy row read intact (wallet_address + network preserved)', r.status === 200 && r.j.wallet_address === 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ' && r.j.network === 'USDT_TRC20' && r.j.binance_uid === '', JSON.stringify(r.j).slice(0, 90));
  /* legacy agent without UID cannot request */
  addLedger(A2, 'daily', '7.500');
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'daily' }, a2Tok);
  t('C2 legacy-wallet agent (no UID) CANNOT request — must save UID first', r.status === 400 && /Binance UID first/.test(r.j.error || ''), r.b.slice(0, 70));
  r = await api('/api/payment-v2/agent/wallet', 'PUT', { binance_uid: '987654321' }, a2Tok);
  t('C3 legacy agent saves UID (200)', r.status === 200, r.status);
  const dbA2 = dbo.prepare('SELECT binance_uid, wallet_address FROM agent_wallets WHERE agent_id=?').get(A2);
  t('C4 legacy wallet_address NOT deleted/overwritten after UID save', dbA2.binance_uid === '987654321' && dbA2.wallet_address === 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ', JSON.stringify(dbA2));
  /* old-style request row in history stays intact */
  dbo.prepare("INSERT INTO payment_requests_v2 (agent_id,manager_id,payment_type,amount,wallet_address,binance_uid,status) VALUES (?,?,?,?,?,?,'Paid')").run(A2, idOf('jm1'), 'daily', '3.000', 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ', '');
  r = await api('/api/payment-v2/agent/requests', 'GET', null, a2Tok);
  const legacyRow = (r.j || []).find(x => x.wallet_address === 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ');
  t('C5 old wallet-based request row still in agent history (untouched)', !!legacyRow && legacyRow.binance_uid === '', JSON.stringify(legacyRow || {}).slice(0, 80));

  function addLedger(agentId, type, amount) {
    dbo.prepare("INSERT INTO payment_ledger (sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status) VALUES (NULL,?,?,NULL,?,?,?,?,?, 'open')")
      .run(agentId, idOf('jm1'), type, amount, '2026-09-01 10:00:00', 'p19j', '2026-09-02 00:00:00');
  }

  /* ================= D. request flow (calculations/approval unchanged) ================= */
  console.log('\n--- D. payment request + admin review flow ---');
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'daily' }, aTok);
  t('D1 request without balance/ledger rejected (eligibility rules unchanged)', r.status === 400, r.status + ' ' + r.b.slice(0, 60));
  addLedger(A1, 'daily', '5.500');
  addLedger(A1, 'daily', '4.500');
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'daily' }, aTok);
  t('D2 request with eligible balance OK; amount = ledger sum (calculations unchanged: $10)', r.status === 200 && r.j.amount === '10', r.b.slice(0, 90));
  const reqId = r.j.id;
  const reqRow = dbo.prepare('SELECT * FROM payment_requests_v2 WHERE id=?').get(reqId);
  t('D3 request row stores binance_uid, wallet_address empty', reqRow.binance_uid === UID1B && reqRow.wallet_address === '', JSON.stringify({ b: reqRow.binance_uid, w: reqRow.wallet_address }));
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'daily' }, aTok);
  t('D4 pending duplicate still 409 (unchanged rule)', r.status === 409, r.status);
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'weekly' }, aTok);
  t('D5 no-balance type still rejected (per-type min/eligibility unchanged)', r.status === 400, r.status + ' ' + r.b.slice(0, 60));
  /* admin review */
  r = await api('/api/payment-v2/admin/requests?status=Pending', 'GET', null, adm);
  const seen = (r.j || []).find(x => x.id === reqId);
  t('D6 admin request list shows the Binance UID', !!seen && seen.binance_uid === UID1B, JSON.stringify(seen || {}).slice(0, 90));
  const rAll = await api('/api/payment-v2/admin/requests', 'GET', null, adm);
  const legacySeen = (rAll.j || []).find(x => x.wallet_address === 'TQ5nRc9aYWx4mB2cDzLmNoPqRsTuVwXyZ');
  t('D7 admin list: legacy wallet row still visible with wallet_address intact', !!legacySeen && legacySeen.binance_uid === '', '');
  t('D8 admin list: agent/manager/processed names still joined (unchanged query)', !!seen && seen.agent_name === 'ja1' && seen.manager_name === 'jm1', JSON.stringify({ a: seen && seen.agent_name, m: seen && seen.manager_name }));
  /* reject -> ledger reopens (existing rule) */
  r = await api('/api/payment-v2/admin/requests/' + reqId + '/reject', 'POST', { reason: 'p19j test' }, adm);
  t('D9 reject works (200)', r.status === 200, r.status);
  const ledStat = dbo.prepare("SELECT status FROM payment_ledger WHERE agent_id=? AND payment_type='daily'").all(A1).map(x => x.status);
  t('D10 reject returns ledger to open (approval flow unchanged)', ledStat.every(s => s === 'open'), JSON.stringify(ledStat));
  /* re-request then pay */
  r = await api('/api/payment-v2/agent/request', 'POST', { payment_type: 'daily' }, aTok);
  t('D11 re-request after reject OK (unchanged)', r.status === 200, r.status + ' ' + r.b.slice(0, 60));
  const reqId2 = r.j.id;
  r = await apiMultipart('/api/payment-v2/admin/requests/' + reqId2 + '/pay', adm, { txid: 'BNB-PAY-123456', notes: 'p19j paid' });
  t('D12 admin mark-paid (multipart, screenshot optional) works', r.status === 200, r.status + ' ' + r.b.slice(0, 80));
  const paidRow = dbo.prepare('SELECT status,txid,binance_uid FROM payment_requests_v2 WHERE id=?').get(reqId2);
  t('D13 paid row: status Paid + txid + binance_uid intact', paidRow.status === 'Paid' && paidRow.txid === 'BNB-PAY-123456' && paidRow.binance_uid === UID1B, JSON.stringify(paidRow));
  const auditRow = dbo.prepare("SELECT details FROM payment_audit_logs WHERE action='request_submitted' AND request_id=? ORDER BY id DESC LIMIT 1").get(reqId2);
  t('D14 audit log records binance_uid in details JSON', !!auditRow && /binance_uid/.test(auditRow.details) && auditRow.details.includes(UID1B), auditRow && auditRow.details.slice(0, 90));
  const notif = dbo.prepare("SELECT message FROM payment_notifications_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 1").get(A1);
  t('D15 agent notification sent (existing notify flow)', !!notif && /payment sent/.test(notif.message || ''), notif && notif.message);

  /* ================= E. agent panel UI (jsdom) ================= */
  console.log('\n--- E. agent panel: Binance UID UI (jsdom, real server) ---');
  const P = await bootPanel('agent.html', aTok, 'ja1', { sse: true, wait: 3200 });
  const w = P.dom.window, d = w.document;
  const inp = d.getElementById('agtWallet');
  t('E1 agent panel: Binance UID input rendered with placeholder', !!inp && inp.placeholder === 'Enter your Binance UID', inp && inp.placeholder);
  const payNav = d.querySelector('[data-page="payment"]');
  if (payNav) { payNav.click(); await sleep(1000); }
  t('E2 saved UID pre-filled from server (payment page load)', inp && inp.value === UID1B, 'value=' + (inp && inp.value));
  const walletCard = d.querySelector('#page-payment, .page.active') || d.body;
  t('E3 card shows "Binance UID" heading + warning text', d.body.textContent.includes('Binance UID') && /double-check your UID/.test(d.body.textContent), '');
  /* save flow: PUT with binance_uid body */
  if (inp) { inp.value = '555000111'; }
  await w.saveAgentWallet();
  await sleep(900);
  const putCall = (w.__p19jCalls || []).reverse().find(c => c.method === 'PUT' && String(c.url).includes('/payment-v2/agent/wallet'));
  t('E4 Save sends {binance_uid} (no wallet_address field)', !!putCall && /"binance_uid"\s*:\s*"555000111"/.test(putCall.body) && !/wallet_address/.test(putCall.body), putCall && putCall.body);
  const updUid = dbo.prepare('SELECT binance_uid FROM agent_wallets WHERE agent_id=?').get(A1);
  t('E5 UID persisted from panel save', updUid && updUid.binance_uid === '555000111', JSON.stringify(updUid));
  w.openWalletHelp();
  const modal = d.getElementById('walletHelpModal');
  t('E6 help modal: 4 steps + web method + warning', !!modal && modal.textContent.includes('Step 4') && modal.textContent.includes('binance.com') && /double-check your UID/.test(modal.textContent), '');
  /* history table shows Binance UID column */
  const headTxt = (d.getElementById('agtPayBody') || {}).textContent || '';
  t('E7 payment history table renders (Binance UID column present in thead)', d.body.innerHTML.includes('<th>Binance UID</th>'), '');
  t('E8 panel jsdom errors clean', P.errors.length === 0, P.errors.slice(0, 2).join(' | '));

  /* ================= F. chat floating shortcut (jsdom) ================= */
  console.log('\n--- F. floating Chat shortcut (existing chat system, 4 panels) ---');
  /* agent panel already booted with SSE */
  const fab = d.getElementById('gxChatFab');
  t('F1 agent panel: floating Chat button exists', !!fab, '');
  const fabCss = d.getElementById('gxChatFabCss');
  t('F2 fixed bottom-right positioning + responsive rule', !!fabCss && /#gxChatFab\{position:fixed;right:18px;bottom:82px/.test(fabCss.textContent) && fabCss.textContent.includes('@media(max-width:480px)'), '');
  const aiBtn = d.getElementById('gxAssistantBtn');
  t('F3 AI assistant button present on agent panel (existing)', !!aiBtn, '');
  t('F4 Chat FAB stacked ABOVE assistant (no solo class when assistant visible)', aiBtn ? !fab.classList.contains('gx-fab-solo') : true, 'ai=' + !!aiBtn);
  /* click FAB -> existing chat page opens */
  fab.click();
  await sleep(1200);
  t('F5 FAB click opens EXISTING chat page (page-chat active, chat UI mounted)', d.getElementById('page-chat') && d.getElementById('page-chat').classList.contains('active') && !!d.getElementById('gxcList'), '');
  /* unread badge: manager sends messages while agent elsewhere (dashboard) */
  const navDash = d.querySelector('[data-page="dashboard"]') || d.querySelector('.ritem');
  if (navDash) { navDash.click(); await sleep(600); }
  const convR = await api('/api/chat/conversations', 'POST', { user_id: A1 }, mTok);
  const convId = convR.j && convR.j.conversation_id;
  await api('/api/chat/messages/' + convId, 'POST', { body: 'p19j unread 1' }, mTok);
  await api('/api/chat/messages/' + convId, 'POST', { body: 'p19j unread 2' }, mTok);
  let fabBadgeTxt = null; const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await sleep(250);
    const fb = d.getElementById('gxChatFabBadge');
    if (fb && fb.classList.contains('show') && fb.textContent === '2') { fabBadgeTxt = fb.textContent; break; }
  }
  t('F6 FAB badge shows live unread (2) via EXISTING tracking', fabBadgeTxt === '2', 'badge=' + fabBadgeTxt);
  const sideBadge = d.getElementById('gxChatBadge');
  t('F7 sidebar chat badge shows the same count (single source of truth)', sideBadge && sideBadge.style.display !== 'none' && sideBadge.textContent === '2', sideBadge && sideBadge.textContent);
  /* F5b: open the conversation from the chat page — full existing chat works via FAB */
  if (fab) { fab.click(); await sleep(700); }
  const convItem = [...d.querySelectorAll('#gxcList .gxc-item')].find(x => /p19j unread/i.test(x.textContent) || /jm1/i.test(x.textContent));
  if (convItem) { convItem.click(); await sleep(1200); }
  t('F5b conversation opens from chat page; messages render (existing engine)', !!d.getElementById('gxcMsgs') && d.getElementById('gxcMsgs').textContent.includes('p19j unread 1'), '');

  /* client panel: FAB without assistant button */
  const C = await bootPanel('client.html', cTok, 'jc1', { sse: true, wait: 3200 });
  const wc = C.dom.window, dc = wc.document;
  const fabC = dc.getElementById('gxChatFab');
  t('F8 client panel: FAB exists (client has chat)', !!fabC, '');
  t('F9 client panel: NO AI assistant button -> FAB drops to bottom (solo)', !!fabC && fabC.classList.contains('gx-fab-solo') && !dc.getElementById('gxAssistantBtn'), '');
  if (fabC) { fabC.click(); await sleep(1200); }
  t('F10 client FAB opens chat page (permissions unchanged — client chat works)', dc.getElementById('page-chat') && dc.getElementById('page-chat').classList.contains('active') && !!dc.getElementById('gxcList'), '');
  t('F11 no overlap: FAB z-index below assistant window layer', !fabC || /z-index:9998/.test((dc.getElementById('gxChatFabCss') || { textContent: '' }).textContent), '');
  t('F12 client panel jsdom errors clean', C.errors.length === 0, C.errors.slice(0, 2).join(' | '));

  /* ================= G. language sweep (automated Roman-Urdu audit) ================= */
  console.log('\n--- G. language audit: zero visible Roman-Urdu left ---');
  const URDU = ['nahi','nahin','nhi','karo','karein','kariye','karna','karne','karke','karta','karti','gaya','gayi','gaye','hoga','hogi','honge','hua','hui','hue','hain','milega','milegi','mila','mili','milen','diya','dijiye','dena','dega','degi','liye','aap','aapka','aapne','apna','apni','apne','chahiye','zaroori','galat','sahi','pehle','baad','likhen','likhein','likha','poochein','pooche','batayega','bata','bolega','bolenge','kaam','kaafi','thoda','thori','zyada','hatana','dekh','dikh','banega','banaye','bana','bhejo','bheja','bhej','jata','jaye','aana','aayega','achha','theek','jaldi','abhi','phir','yaad','rakhen','shuru','khatam','poora','poori','saare','kuch','kisi','iski','uski','iska','uska','isme','usme','wahan','yahan','kahan','kyun','kaise','hota','hoti','hote','hoon','raha','rahi','sakta','sakti','sakte','lenge','mera','meri','shukriya','taraf','saath','waqt','ghanta','darmiyan','dair','jawab','sirf','bilkul','bharein','bhara','mangne','foran','bhai'];
  const AUDIT_FILES = ['admin.html','manager.html','agent.html','client.html','public-request.html','set-password.html','assets/chat.js','assets/galaxy.js','api.js','backend/pubreq.js','backend/chat.js','backend/assistant.js','backend/server.js'];
  /* assistant.js input-understanding lines (YES/CANCEL/intent regexes) — Urdu INPUT parsing is a feature, not visible text */
  const INPUT_PARSE = /CANCEL|YES = Set|mojood|chahiye\?|mangwa|kitne number|kitni numbers|numbers hain|numbers hai|kitna|kitne paisa|kon sa|konse range|range naam|kya ranges|payment kab|kab milenge|kab milte|kya haal|kaise ho|rozana|mahina|mahine|hafta|numbers chahiye|number chahiye|mujhe numbers|batao|confirm karo|kar do|kardo|haan|mat karo|ruk jao|band kar|bandkro|chhoro|nahi chahiye/;
  function stripComments(x) {
    return x.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"\\\w)])\/\/[^\n]*/g, '$1');
  }
  function scanText(x) { for (const wd of URDU) { const re = new RegExp('(^|[^a-zA-Z])' + wd + '([^a-zA-Z]|$)'); if (re.test(x)) return wd; } return null; }
  const hits = [];
  for (const f of AUDIT_FILES) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    src.split('\n').forEach((ln, i) => {
      const re = /(['"`])((?:\\.|(?!\1)[^\n])*)\1/g; let m;
      while ((m = re.exec(ln))) { const s2 = m[2]; if (s2.length >= 2 && /[a-zA-Z]/.test(s2)) { const wd = scanText(s2); if (wd) hits.push(f + ':' + (i + 1) + ' [' + wd + '] ' + s2.trim().slice(0, 70)); } }
      const tn = ln.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (tn && /[a-zA-Z]/.test(tn) && !/^\s*(?:const|let|var|if|for|while|function|return|await|try|catch|else|async)\b/.test(tn)) { const wd = scanText(tn); if (wd) hits.push(f + ':' + (i + 1) + ' [' + wd + '] ' + tn.slice(0, 70)); }
    });
  }
  const visible = hits.filter(h => !(h.startsWith('backend/assistant.js:') && INPUT_PARSE.test(h)));
  t('G1 zero user-visible Roman-Urdu strings across panels/assets/backend (' + AUDIT_FILES.length + ' files)', visible.length === 0, visible.slice(0, 6).join(' || '));
  const prq = fs.readFileSync(path.join(ROOT, 'public-request.html'), 'utf8');
  const spw = fs.readFileSync(path.join(ROOT, 'set-password.html'), 'utf8');
  const pub = fs.readFileSync(path.join(ROOT, 'backend/pubreq.js'), 'utf8');
  t('G2 public pages + emails fully English (spot checks)', /Fill in your details/.test(prq) && /one-time secure link/.test(spw) && /please ignore this email/.test(pub), '');
  t('G3 pubreq Urdu error strings replaced (comments excluded)', !/zaroori|nahi karte/.test(stripComments(pub)), '');

  /* ================= finish ================= */
  console.log('\n--- H. server health ---');
  t('H1 server stderr clean', serverErr.split('\n').filter(Boolean).length === 0, serverErr.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  try { dbo.close(); } catch (e) {}
  serverProc.kill();
  console.log('\n==============================');
  console.log('P19j RESULT: ' + PASS + ' PASS, ' + FAIL + ' FAIL');
  console.log('==============================');
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); try { serverProc && serverProc.kill(); } catch (_) {} process.exit(2); });
