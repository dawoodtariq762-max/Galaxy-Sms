/**
 * backend/pubreq.js — P19i: PUBLIC PANEL REQUEST + EMAIL VERIFICATION (zero-cost).
 *
 * Kya hai: public form (/panel-request) → Gmail SMTP se OTP email → OTP verify →
 * Admin panel me request → Admin APPROVE → EXISTING users table me account (same
 * insert logic jo /api/users POST use karta hai) → welcome email (one-time
 * password-setup link /set-password).
 *
 * Zero-cost: koi paid service nahi. Gmail (owner ka bana hua account) + App Password
 * (official Google method — 2-Step Verification required). SMTP creds sirf env/.env se
 * (repo me kabhi nahi, responses me kabhi nahi, logs me kabhi nahi).
 *
 * Security: OTP HMAC-hash (pepper SECRET) + TTL + single-use + max 5 attempts;
 * resend rate-limited (60s gap, 3/hour/email); IP rate limits; server-side validation;
 * admin-only management (requireRole('admin')); parametrized SQL; setup-token
 * hashed + 24h + single-use. Gmail daily limit (free ~500/day) cross hone par error
 * store hota hai (admin-only) — koi auto-retry nahi.
 *
 * Rollback: server.js me is module ki require line hata do — koi existing behaviour
 * touch nahi hota (sab additive).
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('./db');

const OTP_TTL_MIN = Math.max(1, parseInt(process.env.OTP_TTL_MINUTES || '10', 10) || 10);   // configurable expiry
const SETUP_TTL_MIN = Math.max(5, parseInt(process.env.PASSWORD_SETUP_TTL_MINUTES || '1440', 10) || 1440); // 24h default
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_GAP_MS = Math.max(1000, parseInt(process.env.OTP_RESEND_GAP_MS || '60000', 10) || 60000); // do OTP ke beech min gap
const OTP_MAX_PER_HOUR = Math.max(1, parseInt(process.env.OTP_MAX_PER_HOUR || '3', 10) || 3);  // per email/hour
const PUBREQ_ENABLED = process.env.PUBREQ_ENABLED !== '0';

/* ---------------- tiny IP rate limiter (existing server pattern jaisa) ---------------- */
const _buckets = new Map();
function pubLimit(name, max, windowMs) {
  return function (req, res, next) {
    const now = Date.now();
    const key = `pubreq:${name}:` + (req.ip || 'unknown'); /* har limiter apni bucket rakhta hai */
    let b = _buckets.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _buckets.set(key, b); }
    b.count++;
    if (_buckets.size > 10000) for (const [k, bb] of _buckets) if (now > bb.resetAt) _buckets.delete(k);
    if (b.count > max) { res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000)); return res.status(429).json({ error: 'Too many requests — please try again later' }); }
    next();
  };
}

/* ---------------- validation helpers ---------------- */
const RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RE_USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;
function cleanStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function validName(n) { const s = cleanStr(n, 80); return s.length >= 2 && s.length <= 80 ? s : null; }
function validEmail(e) { const s = cleanStr(e, 190).toLowerCase(); return RE_EMAIL.test(s) ? s : null; }
function validUsername(u) { const s = cleanStr(u, 32); return RE_USERNAME.test(s) ? s : null; }
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 72; }
function intId(v) { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n > 0 && String(n) === String(parseInt(String(v), 10)) ? n : null; }

/* ---------------- OTP / token hashing (peppered HMAC — plain value DB me kabhi nahi) ---------------- */
let PEPPER = '';
function otpHash(value) { return crypto.createHmac('sha256', PEPPER).update(String(value)).digest('hex'); }
function genOtp() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function nowPlusMin(min) { return new Date(Date.now() + min * 60000).toISOString().slice(0, 19).replace('T', ' '); }
function sqlNow() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function expired(ts) { return !ts || String(ts) < sqlNow(); }

/* ---------------- mailer: Gmail SMTP via nodemailer (App Password) — ya dry-run ----------------
 * Env: SMTP_HOST (smtp.gmail.com), SMTP_PORT (587 STARTTLS | 465 SSL), SMTP_USER,
 * SMTP_PASSWORD (16-char Google App Password), MAIL_FROM (optional).
 * Configured nahi → mode 'log' (email nahi jata, mail_status='not_configured' — sandbox/test).
 * Gmail sending limit (free: ~500/day) cross → sendMail error return hota hai, admin
 * panel me dikhta hai, koi auto-retry nahi. */
let transporter = null, mailMode = 'log';
function initMailer() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10) || 587;
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASSWORD || '';
  if (!user || !pass) { mailMode = 'log'; transporter = null; return; }
  try {
    // lazy require — dep sirf tab load hoti hai jab actually send karna ho
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 15000, socketTimeout: 20000,
      pool: true, maxConnections: 2, maxMessages: 50,
    });
    mailMode = 'smtp';
  } catch (e) { mailMode = 'log'; transporter = null; }
}
function mailFrom() {
  const u = process.env.SMTP_USER || 'galaxy@example.com';
  return process.env.MAIL_FROM || `"Galaxy SMS" <${u}>`;
}
/* error sanitize — SMTP password kabhi error text me leak na ho */
function sanitizeErr(e) {
  const secret = process.env.SMTP_PASSWORD || '';
  let msg = String((e && e.message) || e || 'unknown mail error');
  if (secret) msg = msg.split(secret).join('***');
  return msg.slice(0, 300);
}
async function sendMail(to, subject, html, text) {
  if (mailMode !== 'smtp' || !transporter) {
    console.log(`[pubreq:mail-dryrun] to=${to} subject="${subject}" (SMTP not configured — email not sent)`);
    return { ok: false, status: 'not_configured', error: 'SMTP not configured (set SMTP_USER/SMTP_PASSWORD in .env)' };
  }
  try {
    await transporter.sendMail({ from: mailFrom(), to, subject, html, text });
    return { ok: true, status: 'sent' };
  } catch (e) {
    // Gmail quota/limit ya auth fail — retry nahi karte; admin ko error dikhega
    return { ok: false, status: 'failed', error: sanitizeErr(e) };
  }
}

/* ---------------- branded email templates (login.html theme colors) ---------------- */
function emailShell(inner, footerNote) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4eaf3;border-radius:18px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:26px 32px;color:#ffffff;">
<div style="font-size:22px;font-weight:bold;letter-spacing:1px;">GALAXY SMS</div>
<div style="font-size:11px;letter-spacing:3px;opacity:.85;margin-top:4px;">PREMIUM SMS PANEL</div></td></tr>
<tr><td style="padding:32px;color:#0f2454;font-size:15px;line-height:1.6;">${inner}</td></tr>
<tr><td style="padding:18px 32px;background:#f8fbff;border-top:1px solid #e4eaf3;color:#64748b;font-size:12px;line-height:1.5;">${footerNote || ''}<br/>Galaxy SMS · This is an automated message.</td></tr>
</table></td></tr></table></body></html>`;
}
function otpEmailHtml(code, minutes) {
  return emailShell(`
    <div style="font-weight:bold;font-size:17px;margin-bottom:10px;">Email Verification</div>
    <p style="margin:0 0 14px;">You have requested a Galaxy SMS panel account. Please enter your verification code:</p>
    <div style="text-align:center;margin:22px 0;"><div style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:14px 28px;font-size:32px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${code}</div></div>
    <p style="margin:0 0 8px;">This code will expire in <b>${minutes} minutes</b> and can be used <b>only once</b>.</p>
    <p style="margin:0;color:#64748b;font-size:13px;">If you did NOT make this request, please ignore this email.</p>`,
    'Verification codes are for one-time use only.');
}
function welcomeEmailHtml(baseUrl, username, setupUrl, ttlHours, chatPassword) {
  const chatSection = chatPassword ? `
    <div style="margin-top:20px;padding:16px;background:#0d152d;border-radius:12px;border:1px solid rgba(48,171,237,0.3);color:#f8fafc;">
      <div style="font-weight:bold;font-size:15px;color:#30abed;margin-bottom:8px;">📱 Galaxy Chat Mobile App Access</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:13.5px;color:#e2e8f0;">
        <tr><td style="padding:4px 0;color:#94a3b8;width:130px;">Chat Username</td><td style="padding:4px 0;"><b>${username}</b></td></tr>
        <tr><td style="padding:4px 0;color:#94a3b8;">Chat Password</td><td style="padding:4px 0;"><code style="font-size:16px;letter-spacing:2px;font-weight:bold;color:#30abed;background:rgba(48,171,237,0.15);padding:2px 10px;border-radius:6px;">${chatPassword}</code></td></tr>
      </table>
      <div style="font-size:11.5px;color:#94a3b8;margin-top:10px;">* This dedicated 6-digit password is for your Galaxy Chat Android App and is completely separate from your web panel password.</div>
    </div>` : '';

  return emailShell(`
    <div style="font-weight:bold;font-size:17px;margin-bottom:10px;">Welcome to Galaxy SMS! 🎉</div>
    <p style="margin:0 0 14px;">Your panel account is ready. Here are your details:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;margin-bottom:18px;">
      <tr><td style="padding:6px 0;color:#64748b;width:130px;">Panel URL</td><td style="padding:6px 0;"><b>${baseUrl}/panel-login</b></td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Username</td><td style="padding:6px 0;"><b>${username}</b></td></tr>
    </table>
    <p style="margin:0 0 14px;">First step — set your panel password (one-time secure link):</p>
    <div style="text-align:center;margin:20px 0;"><a href="${setupUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:12px;padding:13px 30px;font-weight:bold;font-size:15px;">Set My Password</a></div>
    <p style="margin:0 0 6px;font-size:13px;color:#64748b;">This link is valid for <b>${ttlHours} hours</b> and can be used only once.</p>
    ${chatSection}
    <p style="margin:16px 0 0;font-size:12.5px;color:#64748b;">If the button does not work, copy this link:<br/><span style="word-break:break-all;">${setupUrl}</span></p>`,
    'If you did not request this account, please ignore this email.');
}

/* ---------------- helpers ---------------- */
function baseUrlFrom(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const host = (req && req.headers && req.headers.host) || 'localhost';
  return `http://${host}`;
}
function requestSummary(r) {
  return { id: r.id, name: r.name, email: r.email, username: r.username, panel_type: r.panel_type,
    contact: r.contact, email_verified: !!r.email_verified, status: r.status,
    created_at: r.created_at, updated_at: r.updated_at, decided_at: r.decided_at,
    reject_reason: r.reject_reason || '', created_user_id: r.created_user_id || null,
    otp_mail_status: r.otp_mail_status || '', welcome_mail_status: r.welcome_mail_status || '' };
}
function getReq(id) { return db.get('SELECT * FROM panel_requests WHERE id=?', [id]); }
const _lastOtpSend = new Map();   /* email -> last OTP send (ms) — second-resolution DB timestamps se precise gap */
function otpCountLastHour(email) {
  return db.get(`SELECT COUNT(*) c FROM panel_request_otp o JOIN panel_requests r ON r.id=o.request_id
    WHERE r.email=? AND o.created_at > datetime('now','-1 hour')`, [email]).c;
}
function latestOtp(requestId) {
  return db.get('SELECT * FROM panel_request_otp WHERE request_id=? AND used=0 ORDER BY id DESC LIMIT 1', [requestId]);
}
function issueOtp(req_, request) {
  const code = genOtp();
  db.run('UPDATE panel_request_otp SET used=1 WHERE request_id=? AND used=0', [request.id]); // purane invalidate
  db.run('INSERT INTO panel_request_otp (request_id, otp_hash, expires_at) VALUES (?,?,?)', [request.id, otpHash(code), nowPlusMin(OTP_TTL_MIN)]);
  _lastOtpSend.set(request.email, Date.now());
  return code;
}
async function sendOtpMail(req_, request) {
  const code = issueOtp(req_, request);
  const r = await sendMail(request.email, 'Galaxy SMS — Email Verification Code', otpEmailHtml(code, OTP_TTL_MIN), `Your Galaxy SMS verification code is: ${code} (valid ${OTP_TTL_MIN} minutes). If you did not request this, ignore this email.`);
  db.run('UPDATE panel_requests SET otp_mail_status=?, mail_error=?, updated_at=? WHERE id=?', [r.status, r.ok ? '' : (r.error || ''), sqlNow(), request.id]);
  return r;
}

/* housekeeping: purane unverified requests / otp / tokens (additive, unref'd timer) */
const sweeper = setInterval(() => {
  try {
    db.run(`DELETE FROM panel_requests WHERE email_verified=0 AND status='pending' AND created_at < datetime('now','-1 day')`);
    db.run(`DELETE FROM panel_request_otp WHERE (used=1 OR expires_at < datetime('now','-1 hour')) AND created_at < datetime('now','-1 hour')`);
    db.run(`DELETE FROM password_setup_tokens WHERE (used=1 OR expires_at < datetime('now')) AND created_at < datetime('now','-2 days')`);
  } catch (e) { /* non-fatal */ }
}, 30 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

/* =======================================================================
 * MODULE MOUNT
 * ======================================================================= */
module.exports = function mountPubreq(app, deps) {
  const { authRequired, requireRole, logAction, SECRET, insertUserAccount } = deps;
  PEPPER = SECRET || 'pubreq-pepper';

  initMailer();
  const reinitTimer = setInterval(() => { /* .env baad me configure ho to pickup ho jaye */
    if (mailMode === 'log' && (process.env.SMTP_USER && process.env.SMTP_PASSWORD)) initMailer();
  }, 60 * 1000);
  if (reinitTimer.unref) reinitTimer.unref();

  /* ---------- public pages ---------- */
  app.get('/panel-request', (req, res) => res.sendFile(path.join(__dirname, '..', 'public-request.html')));
  app.get('/set-password', (req, res) => res.sendFile(path.join(__dirname, '..', 'set-password.html')));

  const pubLimiter = pubLimit('pub', 30, 60 * 1000);   /* 30 req/min/IP — form + set-password (real brute-guard OTP ke 5-attempt cap me hai) */
  const otpLimiter = pubLimit('otp', 30, 60 * 1000);   /* OTP verify/resend */

  /* ---------- public: submit request ---------- */
  app.post('/api/pubreq/submit', pubLimiter, (req, res) => {
    if (!PUBREQ_ENABLED) return res.status(503).json({ error: 'Panel requests are currently closed' });
    const name = validName(req.body && req.body.name);
    const email = validEmail(req.body && req.body.email);
    const username = validUsername(req.body && req.body.username);
    const contact = cleanStr(req.body && req.body.contact, 60);
    const panel_type = cleanStr(req.body && req.body.panel_type, 10);
    if (!name) return res.status(400).json({ error: 'Please enter your full name (2–80 characters)' });
    if (!email) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (!username) return res.status(400).json({ error: 'Username 3–32 characters (letters, numbers, . _ -)' });
    if (!['manager', 'agent', 'client'].includes(panel_type)) return res.status(400).json({ error: 'Panel type must be Manager, Agent or Client' });

    /* duplicate username — existing users me (NOCASE, same rule jo /api/users use karta hai) + kisi bhi active request me */
    if (db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [username])) return res.status(409).json({ error: 'This username is already taken' });
    if (db.get(`SELECT id FROM panel_requests WHERE username=? COLLATE NOCASE AND status='pending'`, [username])) return res.status(409).json({ error: 'This username is already requested — please choose another' });

    /* duplicate email: pending YA approved request wale email dobara request nahi kar sakte
       (rejected hone par dobara apply kar sakte hain) */
    const pend = db.get(`SELECT * FROM panel_requests WHERE email=? AND status IN ('pending','approved')`, [email]);
    if (pend) {
      if (!pend.email_verified) {
        /* unverified request already hai — OTP dobara send karne ka option do (rate-limited) */
        return res.status(409).json({ error: 'A request with this email is already awaiting verification', request_id: pend.id, needs_otp: true });
      }
      return res.status(409).json({ error: 'A request with this email is already pending review or approved' });
    }

    /* recent email abuse: ghante me 3 se zyada OTP waste nahi */
    if (otpCountLastHour(email) >= OTP_MAX_PER_HOUR) return res.status(429).json({ error: 'Too many verification emails — please try again after some time' });

    const info = db.run(`INSERT INTO panel_requests (name,email,username,panel_type,contact,ip) VALUES (?,?,?,?,?,?)`,
      [name, email, username, panel_type, contact, req.ip || '']);
    const id = Number(info.lastInsertRowid);
    sendOtpMail(req, getReq(id)).then(() => {}); /* async fire — status row me record hota hai */
    res.json({ ok: true, request_id: id, ttl_minutes: OTP_TTL_MIN });
  });

  /* ---------- public: OTP resend ---------- */
  app.post('/api/pubreq/otp/resend', otpLimiter, (req, res) => {
    const id = intId(req.body && req.body.request_id);
    if (!id) return res.status(400).json({ error: 'Invalid request' });
    const r = getReq(id);
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
    if (r.email_verified) return res.status(400).json({ error: 'Email already verified' });
    /* brute/abuse guards: per-email hourly cap + min gap (ms-precise in-memory, DB fallback) */
    const lastSendMs = _lastOtpSend.get(r.email) || 0;
    const last = latestOtp(id);
    const lastDbMs = last ? Date.parse(String(last.created_at).replace(' ', 'T') + 'Z') : 0;
    if (Math.max(lastSendMs, lastDbMs) > Date.now() - OTP_RESEND_GAP_MS)
      return res.status(429).json({ error: `Please wait ${Math.ceil(OTP_RESEND_GAP_MS / 1000)} seconds before requesting a new code` });
    if (otpCountLastHour(r.email) >= OTP_MAX_PER_HOUR) return res.status(429).json({ error: 'Too many verification emails — please try again after some time' });
    sendOtpMail(req, r).then(mr => {
      if (!mr.ok && mr.status === 'not_configured') return res.status(503).json({ error: 'Email service is not configured yet — please contact support' });
      if (!mr.ok) return res.status(502).json({ error: 'Could not send verification email — please try again later' });
      res.json({ ok: true, ttl_minutes: OTP_TTL_MIN });
    });
  });

  /* ---------- public: OTP verify (brute-force guarded) ---------- */
  app.post('/api/pubreq/otp/verify', otpLimiter, (req, res) => {
    const id = intId(req.body && req.body.request_id);
    const otp = cleanStr(req.body && req.body.otp, 6);
    if (!id || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Invalid request' });
    const r = getReq(id);
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
    if (r.email_verified) return res.status(400).json({ error: 'Email already verified' });
    /* latest OTP row — active ya consumed (reuse pakarne ke liye) */
    const o = db.get('SELECT * FROM panel_request_otp WHERE request_id=? ORDER BY id DESC LIMIT 1', [id]);
    if (!o) return res.status(400).json({ error: 'No active code — please request a new one' });
    if (o.used) return res.status(400).json({ error: 'Code already used — please request a new one' }); /* single-use strict */
    if (expired(o.expires_at)) { db.run('UPDATE panel_request_otp SET used=1 WHERE id=?', [o.id]); return res.status(400).json({ error: 'Code expired — please request a new one' }); }
    if (o.attempts >= OTP_MAX_ATTEMPTS) { db.run('UPDATE panel_request_otp SET used=1 WHERE id=?', [o.id]); return res.status(429).json({ error: 'Too many wrong attempts — please request a new code' }); }
    if (otpHash(otp) !== o.otp_hash) {
      db.run('UPDATE panel_request_otp SET attempts=attempts+1 WHERE id=?', [o.id]);
      const left = OTP_MAX_ATTEMPTS - (o.attempts + 1);
      return res.status(400).json({ error: left > 0 ? `Incorrect code — ${left} attempt(s) left` : 'Too many wrong attempts — please request a new code' });
    }
    /* single-use: pehla consumption jeet gaya */
    const upd = db.run('UPDATE panel_request_otp SET used=1 WHERE id=? AND used=0', [o.id]);
    if (!upd.changes) return res.status(400).json({ error: 'Code already used — please request a new one' });
    db.run('UPDATE panel_requests SET email_verified=1, updated_at=? WHERE id=?', [sqlNow(), id]);
    logAction({ ip: req.ip }, 'panel_request_verified', 'panel_requests', { id, email: r.email });
    res.json({ ok: true });
  });

  /* ---------- public: password setup (approval email ke one-time link se) ---------- */
  app.post('/api/pubreq/set-password', pubLimiter, (req, res) => {
    const token = cleanStr(req.body && req.body.token, 128);
    const password = req.body && req.body.password;
    if (!token || !validPassword(password)) return res.status(400).json({ error: 'Password must be 8–72 characters' });
    const row = db.get('SELECT * FROM password_setup_tokens WHERE token_hash=? AND used=0 ORDER BY id DESC LIMIT 1', [otpHash(token)]);
    if (!row) return res.status(400).json({ error: 'Invalid or already-used link' });
    if (expired(row.expires_at)) return res.status(400).json({ error: 'This link has expired — please contact support' });
    const user = db.get('SELECT id, username FROM users WHERE id=?', [row.user_id]);
    if (!user) return res.status(400).json({ error: 'Account not found' });
    const upd = db.run('UPDATE password_setup_tokens SET used=1 WHERE id=? AND used=0', [row.id]);
    if (!upd.changes) return res.status(400).json({ error: 'Invalid or already-used link' });

    const hash = bcrypt.hashSync(String(password), 10);
    if (row.token_purpose === 'chat_password') {
      const existing = db.get('SELECT user_id FROM chat_credentials WHERE user_id=?', [user.id]);
      if (existing) {
        db.run(`UPDATE chat_credentials SET chat_password_hash=?, chat_enabled=1, failed_attempts=0, locked_until=NULL, password_set_at=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [hash, user.id]);
      } else {
        db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [user.id, hash]);
      }
      logAction({ ip: req.ip }, 'chat_password_setup_completed', 'chat', { id: user.id, username: user.username });
      return res.json({ ok: true, username: user.username, purpose: 'chat_password' });
    }

    db.run('UPDATE users SET password=? WHERE id=?', [hash, user.id]);
    logAction({ ip: req.ip }, 'password_setup_completed', 'users', { id: user.id, username: user.username });
    res.json({ ok: true, username: user.username, purpose: 'panel_password' });
  });

  app.get('/api/pubreq/token-info', pubLimiter, (req, res) => {
    const token = cleanStr(req.query.token, 128);
    if (!token) return res.status(400).json({ error: 'Token required' });
    const row = db.get('SELECT * FROM password_setup_tokens WHERE token_hash=? AND used=0 ORDER BY id DESC LIMIT 1', [otpHash(token)]);
    if (!row || expired(row.expires_at)) return res.json({ valid: false });
    const user = db.get('SELECT username FROM users WHERE id=?', [row.user_id]);
    res.json({ valid: true, username: user ? user.username : '', purpose: row.token_purpose || 'panel_password' });
  });

  /* ---------- ADMIN: request management (sirf admin — backend enforced) ---------- */
  app.get('/api/panel-requests', authRequired, requireRole('admin'), (req, res) => {
    const status = cleanStr(req.query.status, 10);
    const rows = (status && ['pending', 'approved', 'rejected'].includes(status))
      ? db.all(`SELECT * FROM panel_requests WHERE status=? ORDER BY id DESC LIMIT 500`, [status])
      : db.all(`SELECT * FROM panel_requests ORDER BY id DESC LIMIT 500`);
    res.json(rows.map(requestSummary));
  });

  app.get('/api/panel-requests/:id', authRequired, requireRole('admin'), (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const r = getReq(id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const out = requestSummary(r);
    out.mail_error = r.mail_error || ''; /* admin-only — customer ko kabhi nahi jata */
    if (r.decided_by) {
      const dec = db.get('SELECT username FROM users WHERE id=?', [r.decided_by]);
      out.decided_by = dec ? dec.username : r.decided_by;
    }
    res.json(out);
  });

  /* ---------- ADMIN: approve → EXISTING user architecture se account create ---------- */
  app.post('/api/panel-requests/:id/approve', authRequired, requireRole('admin'), (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const r = getReq(id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'pending') return res.status(400).json({ error: `Request already ${r.status}` });
    if (!r.email_verified) return res.status(400).json({ error: 'Email not verified yet (OTP pending)' });

    const role = r.panel_type;
    if (!['manager', 'agent', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid panel type' });

    /* parent placement — existing hierarchy rules ke mutabiq:
       manager → admin ke neeche; agent → kisi manager ke neeche; client → agent ya manager ke neeche */
    let parentId = req.user.id;
    const wanted = intId(req.body && req.body.parent_id);
    if (role !== 'manager') {
      if (wanted) {
        const p = db.get('SELECT id, role, active FROM users WHERE id=?', [wanted]);
        if (!p || !p.active) return res.status(400).json({ error: 'Selected parent user not found/inactive' });
        if (role === 'agent' && p.role !== 'manager') return res.status(400).json({ error: 'Agent must be placed under a Manager' });
        if (role === 'client' && !['agent', 'manager'].includes(p.role)) return res.status(400).json({ error: 'Client must be placed under an Agent or Manager' });
        parentId = wanted;
      } else if (role === 'agent') {
        return res.status(400).json({ error: 'A parent Manager must be selected for an Agent' });
      }
      /* client bina parent ke admin ke neeche chalega (manager jaisa) */
    } else if (wanted) {
      return res.status(400).json({ error: 'A parent must not be selected for a Manager request' });
    }

    /* random strong password — customer apna password setup-link se khud set karega */
    const tempPassword = crypto.randomBytes(18).toString('base64url');
    const created = insertUserAccount({
      username: r.username, password: tempPassword, role, name: r.name, email: r.email,
      contact: r.contact, active: true, parentId,
    });
    if (!created.ok) return res.status(created.status || 400).json({ error: created.error });

    /* P21: Dedicated chat credentials (isolated from panel password) — automatic 6-digit numeric chat password */
    const generatedChatPw = String(crypto.randomInt(100000, 999999));
    db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [created.id, bcrypt.hashSync(generatedChatPw, 10)]);

    /* one-time setup token (hashed, 24h) + welcome email */
    const token = genToken();
    db.run('INSERT INTO password_setup_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)', [created.id, otpHash(token), nowPlusMin(SETUP_TTL_MIN)]);
    const base = baseUrlFrom(req);
    const setupUrl = `${base}/set-password?token=${token}`;
    const ttlHours = Math.round(SETUP_TTL_MIN / 60);

    db.run(`UPDATE panel_requests SET status='approved', decided_by=?, decided_at=?, created_user_id=?, updated_at=? WHERE id=?`,
      [req.user.id, sqlNow(), created.id, sqlNow(), id]);
    logAction(req, 'panel_request_approved', 'panel_requests', { id, username: r.username, role, user_id: created.id });

    sendMail(r.email, 'Galaxy SMS — Your Panel & Chat Account Is Ready', welcomeEmailHtml(base, r.username, setupUrl, ttlHours, generatedChatPw),
      `Welcome to Galaxy SMS!\n\nPanel URL: ${base}/panel-login\nUsername: ${r.username}\nSet your panel password (valid ${ttlHours} hours): ${setupUrl}\n\nGalaxy Chat App Credentials:\nUsername: ${r.username}\nChat Password: ${generatedChatPw} (dedicated 6-digit mobile password)`)
      .then(mr => {
        db.run('UPDATE panel_requests SET welcome_mail_status=?, mail_error=? WHERE id=?', [mr.status, mr.ok ? '' : (mr.error || ''), id]);
      });
    res.json({ ok: true, user_id: created.id, username: r.username, chat_password: generatedChatPw });
  });

  /* ---------- ADMIN: reject ---------- */
  app.post('/api/panel-requests/:id/reject', authRequired, requireRole('admin'), (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const r = getReq(id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'pending') return res.status(400).json({ error: `Request already ${r.status}` });
    const reason = cleanStr(req.body && req.body.reason, 200);
    db.run(`UPDATE panel_requests SET status='rejected', reject_reason=?, decided_by=?, decided_at=?, updated_at=? WHERE id=?`,
      [reason, req.user.id, sqlNow(), sqlNow(), id]);
    logAction(req, 'panel_request_rejected', 'panel_requests', { id, username: r.username, reason });
    res.json({ ok: true });
  });

  /* ---------- ADMIN: welcome email dobara bhejo (agar Gmail limit/auth fail hua ho) ---------- */
  app.post('/api/panel-requests/:id/resend-welcome', authRequired, requireRole('admin'), (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const r = getReq(id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'approved' || !r.created_user_id) return res.status(400).json({ error: 'Only approved requests' });
    const tok = genToken();
    db.run('INSERT INTO password_setup_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)', [r.created_user_id, otpHash(tok), nowPlusMin(SETUP_TTL_MIN)]);
    const base = baseUrlFrom(req);
    const ttlHours = Math.round(SETUP_TTL_MIN / 60);
    sendMail(r.email, 'Galaxy SMS — Your Panel Account Is Ready', welcomeEmailHtml(base, r.username, `${base}/set-password?token=${tok}`, ttlHours),
      `Welcome to Galaxy SMS!\n\nPanel URL: ${base}/panel-login\nUsername: ${r.username}\nSet your password (one-time link, valid ${ttlHours} hours): ${base}/set-password?token=${tok}`)
      .then(mr => {
        db.run('UPDATE panel_requests SET welcome_mail_status=?, mail_error=? WHERE id=?', [mr.status, mr.ok ? '' : (mr.error || ''), id]);
        res.json({ ok: mr.ok, mail_status: mr.status, mail_error: mr.ok ? '' : (mr.error || '') });
      });
  });

  /* ---------- public: page config (panel types + open/closed) ---------- */
  app.get('/api/pubreq/config', pubLimiter, (req, res) => {
    res.json({ enabled: PUBREQ_ENABLED, panel_types: ['manager', 'agent', 'client'], ttl_minutes: OTP_TTL_MIN });
  });
};
