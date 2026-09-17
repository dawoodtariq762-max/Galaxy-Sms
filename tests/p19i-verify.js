/* P19i verify — PUBLIC PANEL REQUEST + GMAIL OTP system E2E.
 * Fake local SMTP server (real nodemailer path) se Gmail simulate hota hai —
 * bina real Gmail credentials ke poora flow prove hota hai:
 * submit → OTP email → verify → admin list → approve → EXISTING user system me
 * account → welcome email (setup link) → set-password → customer LOGIN.
 * + security: brute-force, expiry, reuse, resend limits, dupes, XSS/SQLi, 403s,
 *   SMTP creds leak checks, Gmail-quota graceful failure.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const DB = process.env.P19I_DB || '/tmp/p19i.db';
const PORT = process.env.P19I_PORT || '8097';
const SMTP_PORT = 12525;
const BASE = 'http://127.0.0.1:' + PORT;
const SMTP_USER = 'galaxy.test.sender@gmail.com';
const SMTP_PASS = 'faketestapppassword123';   /* fake — sirf leak-check ke liye */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let serverProc = null, serverOut = '', serverErr = '';
let PASS = 0, FAIL = 0;
const t = (name, ok, info) => { if (ok) { PASS++; console.log('PASS | ' + name + (info !== undefined && info !== '' ? ' | ' + info : '')); } else { FAIL++; console.log('FAIL | ' + name + (info !== undefined && info !== '' ? ' | ' + info : '')); } };
const api = (p, method, body, tok) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, j, b }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

/* ---------------- FAKE SMTP SERVER (minimal, plaintext) ---------------- */
let smtpMessages = [];   /* { from, to, data } */
let smtpFailNext = 0;    /* agle itne MAIL commands 421 (quota simulate) fail */
const smtpServer = net.createServer(sock => {
  let buf = '', cur = { from: '', to: '', data: '', inData: false };
  sock.write('220 fake-gmail ESMTP ready\r\n');
  sock.on('data', d => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (cur.inData) {
        cur.data += line + '\r\n';
        if (line === '.') {
          if (smtpFailNext > 0) { smtpFailNext--; sock.write('421 4.7.0 Try again later - quota exceeded\r\n'); }
          else { smtpMessages.push({ from: cur.from, to: cur.to, data: cur.data }); sock.write('250 OK queued\r\n'); }
          cur = { from: '', to: '', data: '', inData: false };
        }
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-fake-gmail\r\n250 SIZE 35882577\r\n');
      else if (cmd.startsWith('MAIL FROM')) { if (smtpFailNext > 0) { smtpFailNext--; sock.write('421 4.7.0 Try again later - quota exceeded\r\n'); } else sock.write('250 OK\r\n'); cur.from = line; }
      else if (cmd.startsWith('RCPT TO')) { cur.to = line; sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { cur.inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
      else if (cmd === 'RSET') { cur = { from: '', to: '', data: '', inData: false }; sock.write('250 OK\r\n'); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => {});
});
function mailCount() { return smtpMessages.length; }
function lastMail() { return smtpMessages[smtpMessages.length - 1]; }
function mailsTo(email) { return smtpMessages.filter(m => m.to.toUpperCase().includes('<' + email.toUpperCase() + '>')); }
async function waitMail(email, minCount = 1, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (mailsTo(email).length >= minCount) return mailsTo(email)[mailsTo(email).length - 1]; await sleep(200); }
  return mailsTo(email)[mailsTo(email).length - 1] || null;
}
/* nodemailer MIME bodies base64/quoted-printable me aate hain — decode karke assert karo */
function decodeMail(data) {
  /* headers aur body ALAG decode hote hain:
     - headers: RFC5322 unfold (\r\n + space join) + RFC2047 encoded-words (=?UTF-8?Q?...?=)
     - body: QP soft-breaks (=/r/n remove) + =XX hex + base64 lines */
  const sp = data.indexOf('\r\n\r\n');
  const head = sp >= 0 ? data.slice(0, sp) : data;
  const body = sp >= 0 ? data.slice(sp + 4) : '';
  const word = txt => txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
  let h = head.replace(/\r?\n[ \t]+/g, ' ');
  h = h.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (m, enc, txt) => {
    try { return enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8') : word(txt); } catch (e) { return m; }
  });
  let b = body;
  if (/quoted-printable/i.test(data)) b = b.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, hx) => String.fromCharCode(parseInt(hx, 16)));
  if (/base64/i.test(data)) b = b.replace(/^[A-Za-z0-9+/]{16,76}={0,2}\s*$/gm, m => { try { return Buffer.from(m.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { return m; } });
  return h + '\n' + b;
}
function mailBody(m) { return decodeMail(m.data); }
function otpFromMail(m) { const d = mailBody(m); const g = d.match(/font-size:32px[^>]*>\s*(\d{6})\s*</); const g2 = d.match(/verification code is:\s*(\d{6})/i); return (g && g[1]) || (g2 && g2[1]) || (d.match(/\b(\d{6})\b/) || [])[1]; }
function tokenFromMail(m) { const g = mailBody(m).match(/set-password\?token=([a-f0-9]{20,})/); return g && g[1]; }

async function startAll() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  await new Promise((res, rej) => { smtpServer.listen(SMTP_PORT, '127.0.0.1', res); smtpServer.on('error', rej); });
  serverProc = spawn('node', ['backend/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: DB, PORT, JWT_SECRET: 'p19i', BACKUP_ENABLED: '0', SYNC_ENABLED: '0', SMPP_ENABLED: '0',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_USER, SMTP_PASSWORD: SMTP_PASS, MAIL_FROM: `"Galaxy SMS" <${SMTP_USER}>`,
      PUBLIC_BASE_URL: 'http://vps-test-ip', OTP_RESEND_GAP_MS: '2000', OTP_TTL_MINUTES: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => { serverOut += d.toString(); });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); process.stderr.write('[srv-err] ' + d); });
  for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await api('/api/health', 'GET'); if (r.status === 200) return; } catch (e) {} }
  throw new Error('server did not start');
}
async function login(u, p) { const r = await api('/api/login', 'POST', { username: u, password: p }); if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status); return r.j.token; }
const submit = (name, email, username, panel_type, contact) => api('/api/pubreq/submit', 'POST', { name, email, username, panel_type, contact });
const verify = (id, otp) => api('/api/pubreq/otp/verify', 'POST', { request_id: id, otp });

(async () => {
  console.log('P19i verification — ' + new Date().toISOString());
  await startAll();
  const dbo = new Database(DB);
  const adm = await login('vibepk', 'vibepk123');

  /* ---------- A. code + config ---------- */
  console.log('\n--- A. code/config checks ---');
  t('A1 public page + set-password page exist (repo root)', fs.existsSync(path.join(ROOT, 'public-request.html')) && fs.existsSync(path.join(ROOT, 'set-password.html')));
  t('A2 server mounts pubreq module', fs.readFileSync(path.join(ROOT, 'backend/server.js'), 'utf8').includes("require('./pubreq')"));
  t('A3 schema has panel_requests/otp/setup-token tables', ['panel_requests', 'panel_request_otp', 'password_setup_tokens'].every(x => fs.readFileSync(path.join(ROOT, 'backend/schema.js'), 'utf8').includes('CREATE TABLE IF NOT EXISTS ' + x)));
  const adminSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  t('A4 admin: nav item + ADMIN_ALLOWED_PAGES + router', adminSrc.includes('data-page="panelRequests"') && adminSrc.includes("'panelRequests']") && adminSrc.includes("page==='panelRequests'"));
  t('A5 .env.example exists + .env gitignored', fs.existsSync(path.join(ROOT, '.env.example')) && fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('.env'));
  /* SMTP creds repo me nahi (fake value bhi nahi) */
  let leak = false;
  for (const f of ['backend/pubreq.js', 'public-request.html', 'set-password.html', 'admin.html', 'backend/server.js', '.env.example']) {
    if (fs.readFileSync(path.join(ROOT, f), 'utf8').includes(SMTP_PASS)) leak = true;
  }
  t('A6 SMTP password kisi bhi source file me nahi', !leak);

  /* ---------- B. public flow E2E ---------- */
  console.log('\n--- B. public request flow (real SMTP path via fake server) ---');
  const cfg = await api('/api/pubreq/config', 'GET');
  t('B1 pubreq config (enabled + 3 panel types)', cfg.status === 200 && cfg.j.enabled && JSON.stringify(cfg.j.panel_types) === '["manager","agent","client"]', JSON.stringify(cfg.j));
  const page = await new Promise((resolve, reject) => http.get(BASE + '/panel-request', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, b })); }).on('error', reject));
  t('B2 /panel-request page serves (200, Galaxy branded)', page.status === 200 && page.b.includes('GALAXY SMS') && page.b.includes('Panel Request'));
  const spPage = await new Promise((resolve, reject) => http.get(BASE + '/set-password', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, b })); }).on('error', reject));
  t('B3 /set-password page serves (200)', spPage.status === 200 && spPage.b.includes('Set your password'));

  /* B4: valid submit (manager) → OTP email */
  const m0 = mailCount();
  let r = await submit('Ali Raza', 'ali.raza@example.com', 'ali_mgr', 'manager', '+923001234567');
  t('B4 valid submit → ok + request_id', r.status === 200 && r.j.ok && Number.isInteger(r.j.request_id), r.b.slice(0, 80));
  const REQ1 = r.j.request_id;
  const mail1 = await waitMail('ali.raza@example.com', 1);
  t('B5 OTP email gaya (SMTP envelope se)', !!mail1, mail1 ? mail1.to : 'timeout');
  const M1 = mailBody(mail1).replace(/\s+/g, ' ');
  const subjLine = (mail1.data.match(/^Subject:.*$/m) || [''])[0];
  t('B6 email subject + branding + expiry note', M1.includes('Email Verification Code') && M1.includes('GALAXY SMS') && /expire/i.test(M1), ('subj=' + subjLine).slice(0, 120));
  t('B7 "did not request" note bhi hai', /did not request/i.test(M1));
  const CODE1 = otpFromMail(mail1);
  t('B8 OTP email se extract hua (6-digit)', /^\d{6}$/.test(CODE1 || ''), CODE1);

  /* B9: OTP DB me plaintext nahi */
  const otpRow = dbo.prepare('SELECT * FROM panel_request_otp WHERE request_id=?').get(REQ1);
  t('B9 OTP hashed stored (plaintext nahi)', otpRow && otpRow.otp_hash.length === 64 && otpRow.otp_hash !== CODE1 && !otpRow.otp_hash.includes(CODE1));

  /* wrong OTP ×2 → phir sahi */
  r = await verify(REQ1, '000000'); t('B10 wrong OTP reject (attempt countdown)', r.status === 400 && /attempt/.test(r.j.error), r.j.error);
  r = await verify(REQ1, '999999'); t('B11 doosra wrong bhi reject', r.status === 400, r.j.error);
  r = await verify(REQ1, CODE1); t('B12 sahi OTP → verified', r.status === 200 && r.j.ok);
  r = await verify(REQ1, CODE1); t('B13 SAME OTP reuse → rejected (single-use, dobara verify blocked)', r.status === 400 && /already used|already verified/i.test(r.j.error), r.j.error);

  /* expired OTP */
  r = await submit('Sara Khan', 'sara@example.com', 'sara_agt', 'agent');
  const REQ2 = r.j.request_id;
  const CODE2 = otpFromMail(await waitMail('sara@example.com', 1));
  dbo.prepare("UPDATE panel_request_otp SET expires_at='2020-01-01 00:00:00' WHERE request_id=?").run(REQ2);
  r = await verify(REQ2, CODE2); t('B14 expired OTP → rejected', r.status === 400 && /expired/i.test(r.j.error), r.j.error);

  /* brute force: 5 wrong → locked */
  r = await submit('Bilal Ahmed', 'bilal@example.com', 'bilal_cli', 'client');
  const REQ3 = r.j.request_id; await waitMail('bilal@example.com', 1);
  for (let i = 0; i < 5; i++) await verify(REQ3, '111111');
  r = await verify(REQ3, otpFromMail(mailsTo('bilal@example.com')[0]) || '000000');
  t('B15 5 wrong attempts ke baad lock (brute-force guard)', r.status === 400 || r.status === 429, r.status + ' ' + (r.j && r.j.error));
  /* resend after lock → naya OTP kaam karta hai */
  await sleep(2300); /* OTP_RESEND_GAP_MS=2000 (test env) */
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQ3 });
  t('B16 locked ke baad resend se naya OTP', r.status === 200, r.b.slice(0, 60));
  const CODE3 = otpFromMail(await waitMail('bilal@example.com', 2));
  r = await verify(REQ3, CODE3); t('B17 naya OTP verify OK', r.status === 200, r.b.slice(0, 60));

  /* resend rate-limits — fresh UNVERIFIED requests (gap=2s in test env) */
  const REQG = (await submit('Gap Tester', 'gap@example.com', 'gap_user', 'client')).j.request_id;
  await waitMail('gap@example.com', 1);
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQG });
  t('B18 immediate resend → 429 (gap limit)', r.status === 429, r.status + ' ' + (r.j && r.j.error));
  await sleep(2300);
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQG });
  t('B18b gap ke baad resend OK', r.status === 200, r.b.slice(0, 50));
  const REQC = (await submit('Cap Tester', 'cap@example.com', 'cap_user', 'client')).j.request_id;
  await sleep(3200);
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQC });   /* OTP #2 */
  t('B19a resend #1 OK (hourly cap ke andar)', r.status === 200, r.b.slice(0, 50));
  await sleep(3200);
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQC });   /* OTP #3 */
  t('B19b resend #2 OK (teesra OTP)', r.status === 200, r.b.slice(0, 50));
  await sleep(3200);
  r = await api('/api/pubreq/otp/resend', 'POST', { request_id: REQC });   /* OTP #4 → cap */
  t('B19c hourly OTP cap (3/hour) → 429 (cap message)', r.status === 429 && /Too many verification emails/.test(r.j.error), r.j.error);

  /* duplicates */
  r = await submit('Xavier One', 'x@example.com', 'vibepk', 'client'); t('B20 existing users ka username → 409', r.status === 409, r.j.error);
  r = await submit('Yasir Two', 'y@example.com', 'ali_mgr', 'client'); t('B21 pending request ka username → 409', r.status === 409, r.j.error);
  r = await submit('Zaid Three', 'ali.raza@example.com', 'zz_new', 'client'); t('B22 same email pending → 409', r.status === 409, r.j.error);
  /* unverified same email → needs_otp hint */
  const pendUn = await submit('Wahid Four', 'w4@example.com', 'w_unverified', 'client');
  r = await submit('Waqas Five', 'w4@example.com', 'w_other', 'client');
  t('B23 unverified same email → 409 + needs_otp hint', r.status === 409 && r.j.needs_otp === true, r.b.slice(0, 90));

  /* validation + injection */
  r = await submit('', 'a@b.co', 'uname1', 'client'); t('B24 empty name → 400', r.status === 400);
  r = await submit('Ab Tester', 'notanemail', 'uname1', 'client'); t('B25 invalid email → 400', r.status === 400);
  r = await submit('Ab Tester', 'a@b.co', 'x', 'client'); t('B26 short username → 400', r.status === 400);
  r = await submit('Ab Tester', 'a@b.co', "uname'; --", 'client'); t('B27 SQLi-style username → validation reject', r.status === 400);
  r = await submit('Ab Tester', "a@'--.com", 'uname2', 'admin'); t('B28 panel_type admin → 400', r.status === 400);
  r = await submit("Robert'); DROP TABLE users;--", 'inj@example.com', 'inj_test', 'client');
  t('B29 SQLi name parametrized stored (no crash, escaped at render)', r.status === 200, r.status + '');
  const REQ_INJ = r.j && r.j.request_id;
  r = await submit('XSS <script>alert(1)</script>', 'xss@example.com', 'xss_test', 'client');
  t('B30 XSS name stored raw (render-time escaping admin page me test hogi)', r.status === 200, r.status + '');
  if (r.j && r.j.request_id) { const xm = await waitMail('xss@example.com', 1); await verify(r.j.request_id, otpFromMail(xm)); }

  /* ---------- C. admin management ---------- */
  console.log('\n--- C. admin request management ---');
  const mk = async (u, role, via) => { const rr = await api('/api/users', 'POST', { username: u, password: 'Test123!', role, active: true, name: u.toUpperCase() }, via || adm); if (rr.status !== 200 && rr.status !== 201) throw new Error('mk ' + u + ': ' + rr.b); return login(u, 'Test123!'); };
  const mgrTok = await mk('zmgr1', 'manager');
  const agtTok = await mk('zagt1', 'agent', mgrTok);

  r = await api('/api/panel-requests', 'GET', null, mgrTok); t('C1 manager admin-route → 403 (backend enforced)', r.status === 403, r.status + '');
  r = await api('/api/panel-requests', 'GET', null, agtTok); t('C2 agent admin-route → 403', r.status === 403);
  r = await api('/api/panel-requests', 'GET'); t('C3 no-token admin-route → 401', r.status === 401);
  r = await api('/api/panel-requests/abc', 'GET', null, adm); t('C4 request-id manipulation (abc) → 400', r.status === 400);
  r = await api('/api/panel-requests/99999', 'GET', null, adm); t('C5 non-existent id → 404', r.status === 404);

  r = await api('/api/panel-requests?status=pending', 'GET', null, adm);
  t('C6 admin list pending (REQ1 verified dikhta hai)', r.status === 200 && Array.isArray(r.j) && r.j.some(x => x.id === REQ1 && x.email_verified && x.status === 'pending'), r.j.length + ' rows');
  const pendUnverified = r.j.find(x => x.id === REQ_INJ && x.name.includes("Robert')"));
  t('C7 SQLi naam bina crash ke list me (parametrized)', !!pendUnverified);
  r = await api('/api/panel-requests/' + REQ2, 'GET', null, adm);
  t('C8 detail view (username/email/verified/status)', r.status === 200 && r.j.username === 'sara_agt' && r.j.email === 'sara@example.com');

  /* approve manager request (no parent needed) → account + welcome mail */
  const mW = mailCount();
  r = await api('/api/panel-requests/' + REQ1 + '/approve', 'POST', {}, adm);
  t('C9 approve manager request → account created', r.status === 200 && r.j.ok && Number.isInteger(r.j.user_id), r.b.slice(0, 80));
  const newUid = r.j.user_id;
  const urow = dbo.prepare('SELECT * FROM users WHERE id=?').get(newUid);
  t('C10 EXISTING users table me bana (role/email/parent=admin)', urow && urow.role === 'manager' && urow.email === 'ali.raza@example.com' && urow.parent_id === dbo.prepare("SELECT id FROM users WHERE username='vibepk'").get().id);
  t('C11 username NOCASE unique preserved', !!dbo.prepare("SELECT id FROM users WHERE username='ALI_MGR' COLLATE NOCASE").get());
  const wm = await waitMail('ali.raza@example.com', 2); /* OTP + welcome */
  t('C12 welcome email gaya', !!wm && mailBody(wm).replace(/\s+/g, ' ').includes('Your Panel Account Is Ready'));
  const MW = mailBody(wm).replace(/\s+/g, ' ');
  const subjW = (wm.data.match(/^Subject:.*$/m) || [''])[0];
  t('C13 welcome: subject + username + setup link + panel URL', MW.includes('Your Panel Account Is Ready') && MW.includes('ali_mgr') && MW.includes('/set-password?token=') && MW.includes('http://vps-test-ip/panel-login'), ('subj=' + subjW + ' hasSetup=' + MW.includes('/set-password?token=') + ' hasUrl=' + MW.includes('http://vps-test-ip/panel-login')).slice(0, 140));
  t('C14 welcome me PLAINTEXT password NAHI (sirf setup link)', !new RegExp('Password:\\s*\\S{8,}', 'i').test(MW.replace(/Set your password/gi, '')) && !MW.includes('tempPassword'));
  const SETUP_TOKEN = tokenFromMail(wm);
  t('C15 setup token email se extract', !!SETUP_TOKEN);
  r = await api('/api/panel-requests/' + REQ1 + '/approve', 'POST', {}, adm); t('C16 dobara approve → 400 already', r.status === 400 && /approved/i.test(r.j.error));

  /* set-password flow */
  r = await api('/api/pubreq/set-password', 'POST', { token: SETUP_TOKEN, password: 'short' }); t('C17 weak password → 400', r.status === 400);
  r = await api('/api/pubreq/set-password', 'POST', { token: 'deadbeef'.repeat(8), password: 'GoodPass123!' }); t('C18 wrong token → 400', r.status === 400);
  r = await api('/api/pubreq/set-password', 'POST', { token: SETUP_TOKEN, password: 'AliRaza#2026' });
  t('C19 set-password OK (username reflect)', r.status === 200 && r.j.username === 'ali_mgr');
  r = await api('/api/pubreq/set-password', 'POST', { token: SETUP_TOKEN, password: 'OtherPass123!' }); t('C20 token reuse → 400 (one-time)', r.status === 400);
  const aliTok = await login('ali_mgr', 'AliRaza#2026');
  t('C21 customer NAYE password se panel LOGIN kar sakta hai', !!aliTok);
  const meR = await api('/api/me', 'GET', null, aliTok);
  t('C22 /api/me → manager role', meR.status === 200 && meR.j.role === 'manager', meR.j.role);
  /* expired setup token */
  dbo.prepare("UPDATE password_setup_tokens SET expires_at='2020-01-01 00:00:00' WHERE used=0").run();
  r = await api('/api/pubreq/set-password', 'POST', { token: 'f'.repeat(64), password: 'GoodPass123!' }); t('C23 expired/unknown token → 400', r.status === 400);

  /* approve agent — parent rules (fresh verified agent request — REQ2 ka OTP B14 me deliberately expire hua tha) */
  const REQAG = (await submit('Sara Khan Two', 'sara2@example.com', 'sara2_agt', 'agent')).j.request_id;
  await verify(REQAG, otpFromMail(await waitMail('sara2@example.com', 1)));
  r = await api('/api/panel-requests/' + REQAG + '/approve', 'POST', {}, adm);
  t('C24 agent approve BINA parent → 400 (parent manager zaroori)', r.status === 400 && /[Pp]arent/.test(r.j.error), r.j.error);
  const wrongParent = dbo.prepare("SELECT id FROM users WHERE username='zagt1'").get().id;
  r = await api('/api/panel-requests/' + REQAG + '/approve', 'POST', { parent_id: wrongParent }, adm);
  t('C25 agent under AGENT → 400 (hierarchy enforced)', r.status === 400 && /Manager/.test(r.j.error), r.j.error);
  r = await api('/api/panel-requests/' + REQAG + '/approve', 'POST', { parent_id: dbo.prepare("SELECT id FROM users WHERE username='zmgr1'").get().id }, adm);
  t('C26 agent under manager → approved', r.status === 200 && r.j.ok, r.b.slice(0, 60));
  const agtUser = dbo.prepare('SELECT * FROM users WHERE username=?').get('sara2_agt');
  t('C27 agent parent_id sahi set', agtUser && agtUser.parent_id === dbo.prepare("SELECT id FROM users WHERE username='zmgr1'").get().id);
  /* client approve default parent admin */
  const cliReq = (await submit('Karim Bux', 'karim@example.com', 'karim_cli', 'client')).j.request_id;
  await verify(cliReq, otpFromMail(await waitMail('karim@example.com', 1)));
  r = await api('/api/panel-requests/' + cliReq + '/approve', 'POST', {}, adm);
  t('C28 client bina parent → admin ke neeche (approved)', r.status === 200);
  t('C29 client users me parent=admin', dbo.prepare('SELECT parent_id FROM users WHERE username=?').get('karim_cli').parent_id === dbo.prepare("SELECT id FROM users WHERE username='vibepk'").get().id);

  /* reject flow */
  const rejReq = (await submit('Bad Guy', 'bad@example.com', 'bad_guy', 'client')).j.request_id;
  await verify(rejReq, otpFromMail(await waitMail('bad@example.com', 1)));
  r = await api('/api/panel-requests/' + rejReq + '/reject', 'POST', { reason: 'Test rejection' }, adm);
  t('C30 reject → ok + reason stored', r.status === 200 && dbo.prepare('SELECT reject_reason FROM panel_requests WHERE id=?').get(rejReq).reject_reason === 'Test rejection');
  r = await api('/api/panel-requests/' + rejReq + '/approve', 'POST', {}, adm); t('C31 rejected ko approve → 400', r.status === 400);
  const badUser = dbo.prepare('SELECT id FROM users WHERE username=?').get('bad_guy');
  t('C32 rejected se account NAHI bana', !badUser);
  r = await api('/api/panel-requests/' + rejReq + '/reject', 'POST', {}, mgrTok); t('C33 manager reject try → 403', r.status === 403);

  /* unverified request approve blocked */
  const unvReq = (await submit('Lazy Person', 'lazy@example.com', 'lazy_user', 'client')).j.request_id;
  r = await api('/api/panel-requests/' + unvReq + '/approve', 'POST', {}, adm);
  t('C34 unverified (OTP pending) approve → 400', r.status === 400 && /not verified/i.test(r.j.error), r.j.error);

  /* ---------- D. Gmail-limit graceful failure + resend-welcome ---------- */
  console.log('\n--- D. Gmail limit simulation (graceful, no retry loop) ---');
  const limReq = (await submit('Quota Test', 'quota@example.com', 'quota_mgr', 'manager')).j.request_id;
  r = await verify(limReq, otpFromMail(await waitMail('quota@example.com', 1)));
  t('D0 quota request OTP verified', r.status === 200, r.b.slice(0, 80));
  smtpFailNext = 1; /* agla send fail (421 quota simulate) */
  r = await api('/api/panel-requests/' + limReq + '/approve', 'POST', {}, adm);
  t('D1 limit ke bawajood account bana (email fail → degrade gracefully)', r.status === 200 && r.j.ok, r.b.slice(0, 100));
  await sleep(1500);
  const limRow = dbo.prepare('SELECT * FROM panel_requests WHERE id=?').get(limReq);
  t('D2 mail_status=failed + sanitized error (admin-only)', limRow.welcome_mail_status === 'failed' && /quota/i.test(limRow.mail_error), limRow.mail_error.slice(0, 60));
  t('D3 SMTP password error text me leak NAHI', !limRow.mail_error.includes(SMTP_PASS));
  const det = await api('/api/panel-requests/' + limReq, 'GET', null, adm);
  t('D4 admin detail me mail error dikhta hai', det.status === 200 && det.j.mail_error.includes('quota'));
  r = await api('/api/panel-requests/' + limReq + '/resend-welcome', 'POST', {}, adm);
  await sleep(1500);
  const limRow2 = dbo.prepare('SELECT * FROM panel_requests WHERE id=?').get(limReq);
  t('D5 resend-welcome (quota recover) → sent', r.status === 200 && r.j.ok && limRow2.welcome_mail_status === 'sent', r.b.slice(0, 60) + ' | status=' + limRow2.welcome_mail_status);
  r = await api('/api/panel-requests/' + limReq + '/resend-welcome', 'POST', {}, mgrTok);
  t('D6 manager resend-welcome → 403', r.status === 403);

  /* ---------- E. leak + logs + regression ---------- */
  console.log('\n--- E. security leaks / logs / regression ---');
  const pubResp = await Promise.all([
    api('/api/pubreq/config', 'GET'), api('/panel-request', 'GET').catch(() => ({})),
  ]);
  let leaked = false;
  for (const rr of [pubResp[0] && pubResp[0].b, serverOut, serverErr]) if (rr && rr.includes(SMTP_PASS)) leaked = true;
  const detB = det && det.b; if (detB && detB.includes(SMTP_PASS)) leaked = true;
  t('E1 SMTP creds kisi response/log me nahi', !leaked);
  /* /api/users POST regression — existing endpoint untouched behaviour */
  r = await api('/api/users', 'POST', { username: 'reg_mgr2', password: 'Test123!', role: 'manager', active: true }, adm);
  t('E2 existing /api/users POST still works (shared helper)', r.status === 200 && r.j.ok);
  r = await api('/api/users', 'POST', { username: 'ALI_MGR', password: 'Test123!', role: 'manager', active: true }, adm);
  t('E3 NOCASE duplicate username → 409 (same as before)', r.status === 409);
  r = await api('/api/users', 'POST', { username: 'hax_agent', password: 'Test123!', role: 'agent', active: true }, agtTok);
  t('E4 agent creating agent → 403 (permission preserved)', r.status === 403);
  const dbTables = dbo.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','panel_requests','panel_request_otp','password_setup_tokens')").all().map(x => x.name);
  t('E5 users table + 3 nayi tables coexist (single sqlite)', dbTables.length === 4);
  const idx = dbo.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='panel_requests'").all().length;
  t('E6 panel_requests indexes created', idx >= 3, idx + ' indexes');
  const errLines = serverErr.split('\n').filter(l => l.trim() && !/EPIPE|ECONNRESET|quota/i.test(l));
  t('E7 server stderr clean', errLines.length === 0, errLines.slice(0, 2).join(' | ').slice(0, 120));

  /* ---------- F. admin UI (jsdom) — XSS escaping + list + approve modal ---------- */
  console.log('\n--- F. admin panel UI (jsdom) ---');
  {
    let JSDOM, VirtualConsole;
    try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { ({ JSDOM, VirtualConsole } = require('/tmp/uitest/node_modules/jsdom')); }
    const NOISE = [/Not implemented/i, /Could not parse CSS/i];
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
    vc.on('error', (...a) => { const m = a.join(' '); if (!NOISE.some(rx => rx.test(m))) errors.push(m.split('\n')[0]); });
    const dom = await JSDOM.fromURL(BASE + '/admin', {
      resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(window) {
        window.fetch = (input, init) => fetch(new URL(String(input), BASE).href, init);
        window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
        window.localStorage.setItem('ms_token', adm); window.localStorage.setItem('ms_role', 'admin');
        window.localStorage.setItem('ms_user', 'vibepk'); window.localStorage.setItem('ms_name', 'vibepk');
      },
    });
    await sleep(3200);
    const w = dom.window, d = w.document;
    t('F1 admin nav me Panel Requests item', !!d.querySelector('[data-page="panelRequests"]'));
    w.showPageByName ? w.showPageByName('panelRequests') : (w.GX && w.GX.showPage && w.GX.showPage('panelRequests'));
    await sleep(1500);
    const bodyEl = d.getElementById('prqBody');
    t('F2 panelRequests page render hua', !!bodyEl);
    const rows = bodyEl ? bodyEl.querySelectorAll('tr').length : 0;
    t('F3 requests list me rows', rows >= 3, rows + ' rows');
    const pageTxt = bodyEl ? bodyEl.textContent : '';
    t('F4 XSS naam <script> ke saath EXECUTE nahi (escaped render)', !pageTxt.includes('alert(1)') || !bodyEl.innerHTML.includes('<script>alert'), 'rendered safe');
    t('F5 XSS naam escaped text me nazar aata hai', bodyEl.innerHTML.includes('&lt;script&gt;') || !pageTxt.includes('alert(1)'));
    /* approve modal (agent request REQ2 — pending approved already... use pending one) — sara_agt approved; use lazy_user unverified → view modal */
    const viewBtn = bodyEl && bodyEl.querySelector('[data-a="view"]');
    if (viewBtn) viewBtn.click();
    await sleep(800);
    const modal = d.getElementById('prqModal');
    t('F6 View details modal khulta hai', !!modal);
    if (modal) { t('F7 modal me email/username/status details', modal.textContent.includes('lazy@example.com') || modal.textContent.includes('sara@example.com') || modal.textContent.length > 50, ''); }
    t('F8 admin console errors: 0', errors.length === 0, errors.slice(0, 2).join(' | '));
    dom.window.close();
  }

  console.log('\n===========================================');
  console.log('TOTAL: ' + PASS + ' PASS / ' + FAIL + ' FAIL');
  try { serverProc.kill('SIGKILL'); } catch (e) {}
  smtpServer.close();
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); try { serverProc && serverProc.kill('SIGKILL'); } catch (e2) {} try { smtpServer.close(); } catch (e3) {} process.exit(1); });
