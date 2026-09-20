/**
 * assets/chat.js — P19e INTERNAL CHAT + COMPLAINTS (shared by all 4 panels).
 * Load: <script src="/assets/chat.js?v=gxchat1"></script> after /api.js.
 * Open: GXChat.open('chat') | GXChat.open('complaints')   (panels ke page-router se)
 *
 * - WhatsApp-style layout, Galaxy branding/theme (CSS vars of existing theme + fallbacks).
 * - Real-time: SSE (one-time ticket — JWT kabhi URL me nahi jata). EventSource na ho ya
 *   fail ho to visible-tab polling fallback (9s; open conversation 3s — P19g). Heavy polling
 *   kabhi nahi; SSE zombie/buffered streams heartbeat watchdog se pakre jate hain (P19g).
 * - P19g: naya INCOMING message open conversation me turant render + subtle WebAudio ding
 *   (no audio file, no library; autoplay unlock pehle user-gesture par).
 * - Sab user text textContent/esc() se render hota hai (XSS-safe). No voice/audio/calls.
 */
(function () {
  'use strict';
  if (window.GXChat) return;

  /* ---------- identity ---------- */
  function jwtPayload() { try { const t = localStorage.getItem('ms_token') || ''; const p = t.split('.')[1]; return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } }
  const ME = Object.assign({ id: 0, role: 'client' }, jwtPayload());
  const IS_ADMIN = ME.role === 'admin';
  const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', agent: 'Agent', client: 'Client' };

  /* ---------- state ---------- */
  const S = { convs: [], convId: null, other: null, oldest: null, hasOlder: false, scope: 'mine', q: '', started: false, es: null, pollTimer: null, lastMsgId: {}, readTimer: null, cFilter: '', complaints: [], lastEvt: 0, monitor: null, sseRetryTimer: null, connecting: false, convsTimer: null, lastDingAt: 0, sounded: {}, soundedOrder: [], lastUnread: null, audioUnlocked: false };
  const EMOJI = ('😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🤔 🤗 🤫 🤭 😐 😑 😶 😏 🙄 😬 😮 😯 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 👍 👎 👌 ✌️ 🤞 🤟 🤘 👏 🙌 🤝 🙏 💪 👋 🖐 ✋ 🤙 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ⭐ 🌟 ✨ ⚡ 🔥 💥 💯 ✅ ❌ ❗ ❓ 💤 🎉 🎊 🎁 🏆 ⏰ 📌 📎 🔒 🔑 💡 📱 💻').split(' ');

  /* ---------- tiny DOM helpers ---------- */
  const $ = (id) => document.getElementById(id);
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(ts) { const d = new Date(String(ts).replace(' ', 'T') + 'Z'); if (isNaN(d)) return ''; return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(ts) { const d = new Date(String(ts).replace(' ', 'T') + 'Z'); if (isNaN(d)) return ''; const today = new Date(); const yst = new Date(Date.now() - 864e5); const same = (a, b) => a.toDateString() === b.toDateString(); return same(d, today) ? 'Today' : (same(d, yst) ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })); }
  function fmtListTime(ts) { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + 'Z'); if (isNaN(d)) return ''; const today = new Date(); return d.toDateString() === today.toDateString() ? fmtTime(ts) : d.toLocaleDateString([], { day: '2-digit', month: 'short' }); }

  /* ================= CSS (scoped, Galaxy theme) ================= */
  const CSS = `
/* P19k #1 (responsive): dvh (dynamic viewport) + tuned offsets.
   Purane values: desktop calc(100vh - 132px), mobile calc(100vh - 118px) — mobile par
   topbar 2-line wrap (P14 date row) + page-head ke saath ~150-170px hota hai, to chat
   grid viewport se bahar jata tha aur input bar fold ke neeche chhup jati thi.
   dvh = mobile browser URL-bar ke saath sahi; purane browsers ko vh fallback milta hai. */
#page-chat .gx-chat,#page-complaints .gx-comp{height:calc(100vh - 132px);height:calc(100dvh - 132px);min-height:420px}
#page-chat .gx-chat{display:grid;grid-template-columns:330px 1fr;gap:14px}
.gxc-side{display:flex;flex-direction:column;border:1px solid var(--px-border,rgba(120,140,190,.25));border-radius:16px;background:var(--px-surface,#0D142C);overflow:hidden}
.gxc-tabs{display:flex;gap:6px;padding:10px 10px 0}
.gxc-tab{flex:1;text-align:center;padding:8px 4px;border-radius:10px;font-weight:600;font-size:12.5px;cursor:pointer;background:transparent;color:var(--px-muted,#9BA3C9);border:1px solid transparent}
.gxc-tab.on{background:var(--px-accent-soft,rgba(48,171,237,.14));color:var(--px-accent,#30ABED);border-color:var(--px-accent-line,rgba(48,171,237,.34))}
.gxc-search{display:flex;gap:8px;padding:10px}
.gxc-search input{flex:1;min-width:0}
.gxc-newbtn{width:auto;white-space:nowrap}
.gxc-list{flex:1;overflow-y:auto;padding:4px 6px 10px}
.gxc-item{display:flex;gap:10px;align-items:center;padding:10px;border-radius:12px;cursor:pointer;margin-bottom:2px}
.gxc-item:hover{background:var(--px-accent-soft,rgba(48,171,237,.08))}
.gxc-item.on{background:var(--px-accent-soft,rgba(48,171,237,.14))}
.gxc-av{width:38px;height:38px;min-width:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px;background:linear-gradient(135deg,var(--px-accent,#30ABED),#7F18B3)}
.gxc-av.a-admin{background:linear-gradient(135deg,#F59E0B,#EF4444)}
.gxc-av.a-manager{background:linear-gradient(135deg,#8B5CF6,#6366F1)}
.gxc-av.a-agent{background:linear-gradient(135deg,#30ABED,#2563EB)}
.gxc-av.a-client{background:linear-gradient(135deg,#10B981,#059669)}
.gxc-imid{flex:1;min-width:0}
.gxc-top{display:flex;align-items:center;gap:6px}
.gxc-nm{font-weight:650;font-size:13.5px;color:var(--px-text,#E7EAF8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gxc-role{font-size:10px;padding:1.5px 7px;border-radius:99px;background:var(--px-accent-soft,rgba(48,171,237,.14));color:var(--px-accent,#30ABED);font-weight:700;letter-spacing:.03em}
.gxc-last{font-size:12px;color:var(--px-muted,#9BA3C9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.gxc-meta{text-align:right;min-width:44px}
.gxc-time{font-size:10.5px;color:var(--px-dim,#7A83A8)}
.gxc-badge{margin-top:4px;display:inline-block;min-width:19px;padding:1px 6px;border-radius:99px;background:#EF4444;color:#fff;font-size:10.5px;font-weight:700}
.gxc-main{display:flex;flex-direction:column;border:1px solid var(--px-border,rgba(120,140,190,.25));border-radius:16px;background:var(--px-surface,#0D142C);overflow:hidden}
.gxc-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--px-border,rgba(120,140,190,.25))}
.gxc-back{display:none;width:32px;height:32px;border-radius:9px;border:1px solid var(--px-border,rgba(120,140,190,.25));background:transparent;color:var(--px-muted,#9BA3C9);cursor:pointer;font-size:16px}
.gxc-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.gxc-day{align-self:center;font-size:10.5px;color:var(--px-dim,#7A83A8);background:var(--px-surface-2,#131C3E);padding:3px 12px;border-radius:99px;margin:6px 0}
.gxc-row{max-width:78%;display:flex;flex-direction:column}
.gxc-row.mine{align-self:flex-end;align-items:flex-end}
.gxc-row.theirs{align-self:flex-start;align-items:flex-start}
.gxc-sender{font-size:10.5px;font-weight:700;color:var(--px-accent,#30ABED);margin:0 4px 2px}
.gxc-bubble{padding:8px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:break-word;white-space:pre-wrap;max-width:100%}
/* P19k #1: pathological long unbroken strings (URLs/keys) — bubble width ke andar hi wrap */
.gxc-bubble{overflow-wrap:anywhere}
.gxc-bubble.deleted{font-style:italic;opacity:.68;background:rgba(255,255,255,.04)!important;border:1px dashed rgba(255,255,255,.2)!important}
.gxc-msg-acts{display:none;position:absolute;top:-8px;right:0;background:var(--px-surface-2,#131C3E);border:1px solid var(--px-border,rgba(120,140,190,.25));border-radius:8px;padding:2px;gap:4px;z-index:10}
.gxc-row:hover .gxc-msg-acts{display:flex}
.gxc-act-btn{background:none;border:none;color:var(--px-muted,#9BA3C9);font-size:11px;cursor:pointer;padding:2px 6px;border-radius:4px}
.gxc-act-btn:hover{color:#fff;background:rgba(255,255,255,.1)}
.gxc-act-btn.danger:hover{color:#FF5C7A}
.gxc-row.mine .gxc-bubble{background:linear-gradient(135deg,rgba(48,171,237,.22),rgba(127,24,179,.20));border:1px solid rgba(48,171,237,.30);border-bottom-right-radius:4px;color:var(--px-text,#E7EAF8)}
.gxc-row.theirs .gxc-bubble{background:var(--px-surface-2,#131C3E);border:1px solid var(--px-border,rgba(120,140,190,.25));border-bottom-left-radius:4px;color:var(--px-text,#E7EAF8)}
.gxc-mmeta{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--px-dim,#7A83A8);margin:2px 4px 0}
.gxc-ticks{color:var(--px-dim,#7A83A8);letter-spacing:-2px}
.gxc-ticks.read{color:var(--px-accent,#30ABED)}
.gxc-older{align-self:center;margin:2px 0 8px}
.gxc-inputbar{display:flex;gap:8px;align-items:flex-end;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--px-border,rgba(120,140,190,.25));position:sticky;bottom:0;background:var(--px-surface,#0D142C)}
.gxc-emojibtn{width:38px;height:38px;min-width:38px;border-radius:10px;border:1px solid var(--px-border,rgba(120,140,190,.25));background:transparent;font-size:18px;cursor:pointer;color:var(--px-text,#E7EAF8)}
.gxc-input{flex:1;min-width:0;resize:none;max-height:110px;min-height:40px;border-radius:12px;padding:9px 12px;font-size:13.5px;font-family:inherit;background:var(--px-surface-2,#131C3E);border:1px solid var(--px-border,rgba(120,140,190,.25));color:var(--px-text,#E7EAF8)}
.gxc-send{height:40px;min-width:40px;padding:0 16px;border-radius:12px;border:none;cursor:pointer;font-weight:700;font-size:13px;color:#fff;background:linear-gradient(96deg,var(--px-accent,#30ABED),#7F18B3)}
.gxc-send:disabled{opacity:.5;cursor:not-allowed}
.gxc-emoji-pop{position:absolute;bottom:64px;left:12px;right:12px;max-width:340px;background:var(--px-surface-2,#131C3E);border:1px solid var(--px-border,rgba(120,140,190,.25));border-radius:14px;padding:10px;display:none;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));gap:2px;max-height:220px;overflow-y:auto;box-shadow:var(--px-shadow-sm,0 8px 24px rgba(0,0,0,.42));z-index:30}
.gxc-emoji-pop.show{display:grid}
.gxc-emoji-pop button{background:transparent;border:none;font-size:19px;cursor:pointer;padding:4px;border-radius:8px}
.gxc-emoji-pop button:hover{background:var(--px-accent-soft,rgba(48,171,237,.14))}
.gxc-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--px-dim,#7A83A8);font-size:13px;text-align:center;padding:30px}
.gxc-contacts{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;margin-top:10px}
.gxc-contact{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:12px;cursor:pointer;border:1px solid var(--px-border,rgba(120,140,190,.25))}
.gxc-contact:hover{background:var(--px-accent-soft,rgba(48,171,237,.08))}
.gx-nav-badge{display:inline-block;min-width:18px;padding:1px 5px;border-radius:99px;background:#EF4444;color:#fff;font-size:10px;font-weight:700;margin-left:6px;vertical-align:middle}
/* complaints */
.gxc-cstatus{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:99px}
.gxc-cstatus.Open{background:rgba(255,180,67,.16);color:#FFB443}
.gxc-cstatus.InProgress{background:rgba(48,171,237,.16);color:#30ABED}
.gxc-cstatus.Resolved{background:rgba(37,217,164,.16);color:#25D9A4}
.gxc-citem{cursor:pointer}
.gx-comp{display:flex;flex-direction:column;gap:12px}
@media(max-width:900px){
  /* P19k #1: 78+16+62+12 ≈ 168px header stack (wrapped topbar + page-head + paddings) */
  #page-chat .gx-chat,#page-complaints .gx-comp{height:calc(100vh - 170px);height:calc(100dvh - 170px);min-height:300px}
  #page-chat .gx-chat{grid-template-columns:1fr;height:calc(100vh - 170px);height:calc(100dvh - 170px)}
  .gxc-main{display:none}
  .gxc-side{height:100%}
  #page-chat .gx-chat.conv-open .gxc-main{display:flex;position:fixed;inset:0;z-index:1200;border-radius:0;height:100%}
  #page-chat .gx-chat.conv-open .gxc-side{display:none}
  .gxc-back{display:flex;align-items:center;justify-content:center}
  .gxc-row{max-width:88%}
  .gxc-emoji-pop{left:8px;right:8px;bottom:70px}
}
/* P19k #1: short landscape phones/tablets — min-height 420 yahan layout todta tha
   (page fold ke neeche input), ab compact aur scroll-free */
@media(max-width:900px) and (max-height:560px){
  #page-chat .gx-chat,#page-complaints .gx-comp{height:calc(100vh - 140px);height:calc(100dvh - 140px);min-height:220px}
  .gxc-av{width:30px;height:30px;min-width:30px;font-size:12px}
  .gxc-item{padding:7px 9px}
  .gxc-msgs{padding:8px}
  .gxc-input{min-height:34px;font-size:12.5px;padding:6px 10px}
  .gxc-send{height:34px;min-width:34px;padding:0 10px;font-size:12px}
  .gxc-emojibtn{width:32px;height:32px;min-width:32px}
  .gxc-head{padding:6px 10px}
}
@media(max-width:480px){
  .gxc-row{max-width:92%}
  .gxc-search{padding:8px}
  .gxc-list{padding:2px 4px 8px}
}`;

  function ensureStyle() { if (!$('gx-chat-style')) { const st = document.createElement('style'); st.id = 'gx-chat-style'; st.textContent = CSS; document.head.appendChild(st); } }

  /* ================= CHAT PAGE ================= */
  function buildChatPage() {
    const page = $('page-chat'); if (!page) return;
    ensureStyle();
    if (page.dataset.built) return; page.dataset.built = '1';
    page.innerHTML = `
    <div class="page-head"><div><h2>Internal Chat</h2><div class="breadcrumb"><b>Communication</b> › Chat</div></div></div>
    <div class="gx-chat" id="gxcRoot">
      <div class="gxc-side">
        ${IS_ADMIN ? `<div class="gxc-tabs"><div class="gxc-tab on" id="gxcTabMine">My Chats</div><div class="gxc-tab" id="gxcTabAll">All Chats</div></div>` : ''}
        <div class="gxc-search">
          <input type="text" id="gxcSearch" placeholder="Search chats..." style="flex:1;min-width:0"/>
          <button class="gxc-send gxc-newbtn" id="gxcNew" title="New chat">+ New</button>
        </div>
        <div class="gxc-list" id="gxcList"></div>
      </div>
      <div class="gxc-main" id="gxcMain">
        <div class="gxc-empty">No conversation is open yet — select one from the list or start a new one with <b>+ New</b>.</div>
      </div>
    </div>
    <div class="gxc-emoji-pop" id="gxcEmojiPop"></div>`;
    $('gxcSearch').addEventListener('input', e => { S.q = e.target.value.trim().toLowerCase(); renderConvList(); });
    $('gxcNew').addEventListener('click', openContactsModal);
    if (IS_ADMIN) {
      $('gxcTabMine').addEventListener('click', () => setScope('mine'));
      $('gxcTabAll').addEventListener('click', () => setScope('all'));
    }
    const pop = $('gxcEmojiPop');
    EMOJI.forEach(em => { const b = document.createElement('button'); b.type = 'button'; b.textContent = em; b.addEventListener('click', () => insertEmoji(em)); pop.appendChild(b); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#gxcEmojiPop') && !e.target.closest('#gxcEmojibtn')) pop.classList.remove('show'); });
  }

  function setScope(sc) { S.scope = sc; $('gxcTabMine').classList.toggle('on', sc === 'mine'); $('gxcTabAll').classList.toggle('on', sc === 'all'); loadConvs(); }
  function insertEmoji(em) {
    const inp = $('gxcInput'); if (!inp) return;
    const p = inp.selectionStart || inp.value.length;
    inp.value = inp.value.slice(0, p) + em + inp.value.slice(inp.selectionEnd || p);
    inp.focus(); inp.selectionStart = inp.selectionEnd = p + em.length;
    inp.dispatchEvent(new Event('input', { bubbles: true })); /* send-button state update ho */
  }

  async function loadConvs() {
    try {
      const url = '/chat/conversations' + (S.scope === 'all' ? '?scope=all' : '');
      S.convs = await API.get(url) || [];
      detectNewInList(S.convs);
      renderConvList();
    } catch (e) { /* offline — list purani */ }
  }
  /* P19g: degraded/poll mode me dusri convs ke naye messages ka reliable detection —
     badge-delta (refreshBadges) ek race me miss ho sakta hai (ek conv read hote hi
     doosri ka naya message count mask kar deta hai). Convs list jo waise bhi fetch
     hoti hai usi ka snapshot compare karte hain — ZERO extra request. SSE mode me
     per-message dingOnce pehle hi chuka hota hai (2s throttle double rok deta hai). */
  function detectNewInList(convs) {
    if (S.scope !== 'mine' || !Array.isArray(convs)) return;
    const next = {}; let fresh = false;
    convs.forEach(c => {
      next[c.id] = (c.last_message_at || '') + '|' + (c.unread || 0);
      if (S.listSnap && S.convId !== c.id && S.listSnap[c.id] !== undefined && next[c.id] !== S.listSnap[c.id] && (c.unread || 0) > 0) fresh = true;
    });
    const had = S.listSnap; S.listSnap = next;
    if (!had) return; /* pehli load = baseline, koi ding nahi */
    if (fresh) playDing();
  }

  function renderConvList() {
    const el = $('gxcList'); if (!el) return;
    let rows = S.convs;
    if (S.q) rows = rows.filter(c => {
      const names = S.scope === 'all' ? [c.user_a, c.user_b] : [c.other];
      return names.some(u => u && (u.name.toLowerCase().includes(S.q) || u.username.toLowerCase().includes(S.q))) || (c.last_message_text || '').toLowerCase().includes(S.q);
    });
    el.innerHTML = rows.length ? '' : '<div class="gxc-empty">No chats found.</div>';
    rows.forEach(c => {
      const who = S.scope === 'all' ? null : c.other;
      const title = who ? who.name : `${c.user_a.name} ↔ ${c.user_b.name}`;
      const roles = who ? who.role_label : `${c.user_a.role_label} ↔ ${c.user_b.role_label}`;
      const av = who ? who.role : 'agent';
      const div = document.createElement('div');
      div.className = 'gxc-item' + (c.id === S.convId ? ' on' : '');
      div.innerHTML = `<div class="gxc-av a-${esc(av)}">${esc((title || '?').charAt(0).toUpperCase())}</div>
        <div class="gxc-imid"><div class="gxc-top"><span class="gxc-nm">${esc(title)}</span><span class="gxc-role">${esc(roles)}</span></div>
        <div class="gxc-last">${esc(c.last_message_text || 'No messages yet')}</div></div>
        <div class="gxc-meta"><div class="gxc-time">${esc(fmtListTime(c.last_message_at))}</div>${(S.scope === 'mine' && c.unread) ? `<span class="gxc-badge">${c.unread}</span>` : ''}</div>`;
      div.addEventListener('click', () => openConv(c, S.scope === 'all'));
      el.appendChild(div);
    });
  }

  /* ---------- contacts modal (permitted users only — server list) ---------- */
  function openContactsModal() {
    closeModalIfAny('gxcContactModal');
    const ov = document.createElement('div');
    ov.className = 'modal-overlay show'; ov.id = 'gxcContactModal';
    ov.innerHTML = `<div class="modal" style="max-width:440px">
      <div class="modal-head"><h3>New Chat</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <input type="text" id="gxcContactSearch" placeholder="Search users..." style="width:100%"/>
        <div class="gxc-contacts" id="gxcContactList"><div class="gxc-empty">Loading...</div></div>
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    const search = ov.querySelector('#gxcContactSearch');
    search.addEventListener('input', () => fillContacts(search.value));
    fillContacts('');
    search.focus();
  }
  async function fillContacts(q) {
    const list = $('gxcContactList'); if (!list) return;
    try {
      const users = await API.get('/chat/contacts?q=' + encodeURIComponent(q || '')) || [];
      list.innerHTML = users.length ? '' : '<div class="gxc-empty">No permitted users found.</div>';
      users.forEach(u => {
        const d = document.createElement('div'); d.className = 'gxc-contact';
        d.innerHTML = `<div class="gxc-av a-${esc(u.role)}">${esc(u.name.charAt(0).toUpperCase())}</div>
          <div class="gxc-imid"><div class="gxc-top"><span class="gxc-nm">${esc(u.name)}</span><span class="gxc-role">${esc(u.role_label)}</span></div>
          <div class="gxc-last">@${esc(u.username)}</div></div>`;
        d.addEventListener('click', async () => {
          try { const r = await API.post('/chat/conversations', { user_id: u.id }); ovRemove('gxcContactModal'); await loadConvs(); const conv = (S.convs.find(c => c.id === r.conversation_id)); openConv(conv || { id: r.conversation_id, other: u }); }
          catch (e) { alert('❌ ' + e.message); }
        });
        list.appendChild(d);
      });
    } catch (e) { list.innerHTML = '<div class="gxc-empty">Contacts could not be loaded.</div>'; }
  }
  function ovRemove(id) { const el = $(id); if (el) el.remove(); }
  function closeModalIfAny(id) { ovRemove(id); }

  /* ---------- conversation ---------- */
  async function openConv(conv, isAdminAllView) {
    S.convId = conv.id; S.other = conv.other || null; S.isAdminAll = !!isAdminAllView;
    const root = $('gxcRoot'); if (root) root.classList.add('conv-open');
    updateFabVisibility();
    const main = $('gxcMain');
    const who = S.other ? S.other : (conv.user_a && conv.user_b ? (conv.user_a.id === ME.id ? conv.user_b : conv.user_a) : null);
    const title = (S.isAdminAll && conv.user_a && conv.user_b) ? (conv.user_a.name + ' ↔ ' + conv.user_b.name) : (who ? who.name : 'Conversation #' + conv.id);
    const sub = (S.isAdminAll && conv.user_a) ? (conv.user_a.role_label + ' ↔ ' + conv.user_b.role_label) : (who ? who.role_label : '');
    main.innerHTML = `
      <div class="gxc-head">
        <button class="gxc-back" id="gxcBack" title="Back">‹</button>
        <div class="gxc-av a-${esc(who ? who.role : 'agent')}" style="width:34px;height:34px;min-width:34px;font-size:13px">${esc((who ? who.name : '?').charAt(0).toUpperCase())}</div>
        <div style="flex:1;min-width:0"><div class="gxc-nm">${esc(title)}</div>
        <div class="gxc-last">${esc(sub)}${S.isAdminAll ? ' · All Chats view' : ''}</div></div>
      </div>
      <div class="gxc-msgs" id="gxcMsgs"></div>
      <div class="gxc-inputbar">
        <button class="gxc-emojibtn" id="gxcEmojibtn" type="button" title="Emoji">🙂</button>
        <textarea class="gxc-input" id="gxcInput" rows="1" maxlength="2000" placeholder="Type a message..."></textarea>
        <button class="gxc-send" id="gxcSend" type="button">Send</button>
      </div>`;
    $('gxcBack').addEventListener('click', () => { root.classList.remove('conv-open'); S.convId = null; updateFabVisibility(); renderConvList(); });
    $('gxcEmojibtn').addEventListener('click', (e) => { e.stopPropagation(); $('gxcEmojiPop').classList.toggle('show'); });
    const inp = $('gxcInput');
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 110) + 'px'; $('gxcSend').disabled = !inp.value.trim(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); } });
    $('gxcSend').addEventListener('click', sendCurrent);
    if (window.visualViewport) visualViewport.addEventListener('resize', () => { const m = $('gxcMsgs'); if (m) m.scrollTop = m.scrollHeight; });
    $('gxcSend').disabled = true;
    await loadHistory(true);
    markReadSoon();
    /* P19g: conversation open hote hi (agar fallback poll chal raha hai) usse turant
       3s fast interval par re-schedule karo — pehla naya message 9s tak intezar na kare */
    if (S.pollTimer) { stopPolling(); startPolling(); }
  }

  async function loadHistory(fresh) {
    const msgsEl = $('gxcMsgs'); if (!msgsEl) return;
    try {
      const data = await API.get(`/chat/messages/${S.convId}?limit=30`);
      S.oldest = data.messages.length ? data.messages[0].id : null;
      S.hasOlder = !!data.has_older;
      S.lastMsgId[S.convId] = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
      renderMsgs(data.messages, fresh);
    } catch (e) { msgsEl.innerHTML = `<div class="gxc-empty">❌ ${esc(e.message)}</div>`; }
  }

  function renderMsgs(msgs, fresh) {
    const el = $('gxcMsgs'); if (!el) return;
    const stick = fresh || (el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    el.innerHTML = '';
    if (S.hasOlder) {
      const b = document.createElement('button'); b.className = 'btn btn-ghost gxc-older'; b.textContent = 'Load older messages';
      b.addEventListener('click', loadOlder); el.appendChild(b);
    }
    if (!msgs.length && fresh) { el.innerHTML += '<div class="gxc-empty">No messages yet — send the first message.</div>'; return; }
    let lastDay = '';
    msgs.forEach(m => {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) { const d = document.createElement('div'); d.className = 'gxc-day'; d.textContent = day; el.appendChild(d); lastDay = day; }
      el.appendChild(renderMsg(m));
    });
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function renderMsg(m) {
    const mine = m.sender_id === ME.id;
    const isDeleted = (m.is_deleted === true || m.deleted_for_everyone === 1);
    const div = document.createElement('div');
    div.className = 'gxc-row ' + (mine ? 'mine' : 'theirs');
    div.dataset.mid = m.id;
    div.style.position = 'relative';

    const msgAgeMinutes = (Date.now() - new Date(String(m.created_at).replace(' ', 'T') + 'Z').getTime()) / 60000;
    const canDeleteEveryone = !isDeleted && (IS_ADMIN || (mine && msgAgeMinutes <= 15));

    div.innerHTML = `${!mine ? `<div class="gxc-sender">${esc(m.sender_name)} · ${esc(m.sender_role)}</div>` : ''}
      <div class="gxc-bubble${isDeleted ? ' deleted' : ''}"></div>
      <div class="gxc-mmeta"><span>${esc(fmtTime(m.created_at))}</span>${mine && !isDeleted ? `<span class="gxc-ticks${m.read_at ? ' read' : ''}" title="${m.read_at ? 'Read' : 'Sent'}">${m.read_at ? '✓✓' : '✓'}</span>` : ''}</div>
      ${!isDeleted ? `<div class="gxc-msg-acts">
        <button type="button" class="gxc-act-btn btn-del-me" title="Delete for me">🗑️ Me</button>
        ${canDeleteEveryone ? `<button type="button" class="gxc-act-btn danger btn-del-all" title="Delete for everyone">🚫 All</button>` : ''}
      </div>` : ''}`;

    div.querySelector('.gxc-bubble').textContent = isDeleted ? 'This message was deleted' : m.body;

    const delMeBtn = div.querySelector('.btn-del-me');
    if (delMeBtn) {
      delMeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await API.post(`/chat/messages/${m.id}/delete-for-me`, {});
          div.remove();
        } catch (err) { alert('❌ ' + err.message); }
      });
    }

    const delAllBtn = div.querySelector('.btn-del-all');
    if (delAllBtn) {
      delAllBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this message for everyone?')) return;
        try {
          await API.post(`/chat/messages/${m.id}/delete-for-everyone`, {});
          const b = div.querySelector('.gxc-bubble');
          if (b) { b.textContent = 'This message was deleted'; b.classList.add('deleted'); }
          const acts = div.querySelector('.gxc-msg-acts');
          if (acts) acts.remove();
        } catch (err) { alert('❌ ' + err.message); }
      });
    }

    return div;
  }

  async function loadOlder() {
    try {
      const data = await API.get(`/chat/messages/${S.convId}?before_id=${S.oldest}&limit=30`);
      S.hasOlder = !!data.has_older;
      if (data.messages.length) S.oldest = data.messages[0].id;
      const el = $('gxcMsgs');
      const prevH = el.scrollHeight;
      /* older messages prepend */
      const frag = document.createDocumentFragment();
      let lastDay = '';
      data.messages.forEach(m => {
        const day = fmtDay(m.created_at);
        if (day !== lastDay) { const d = document.createElement('div'); d.className = 'gxc-day'; d.textContent = day; frag.appendChild(d); lastDay = day; }
        frag.appendChild(renderMsg(m));
      });
      const olderBtn = el.querySelector('.gxc-older');
      if (S.hasOlder && olderBtn) el.insertBefore(frag, olderBtn.nextSibling); else el.insertBefore(frag, el.firstChild);
      el.scrollTop = el.scrollHeight - prevH;
    } catch (e) { alert('❌ ' + e.message); }
  }

  async function sendCurrent() {
    const inp = $('gxcInput'); if (!inp) return;
    const body = inp.value.trim();
    if (!body) return; /* empty rejection (UI side) */
    inp.value = ''; inp.style.height = 'auto'; $('gxcSend').disabled = true;
    try {
      const r = await API.post(`/chat/messages/${S.convId}`, { body });
      appendMsg(r.message);
      loadConvs();
    } catch (e) { inp.value = body; alert('❌ ' + e.message); }
  }

  function appendMsg(m) {
    const el = $('gxcMsgs'); if (!el || !S.convId || m.conversation_id !== S.convId) return;
    if (el.querySelector(`[data-mid="${m.id}"]`)) return; /* SSE + optimistic dedupe */
    const empty = el.querySelector('.gxc-empty'); if (empty) empty.remove();
    el.appendChild(renderMsg(m));
    el.scrollTop = el.scrollHeight;
    S.lastMsgId[S.convId] = Math.max(S.lastMsgId[S.convId] || 0, m.id);
    if (m.sender_id !== ME.id) { dingOnce(m); markReadSoon(); }
  }

  let readPending = 0;
  function markReadSoon() { clearTimeout(S.readTimer); S.readTimer = setTimeout(markReadNow, 400); }
  async function markReadNow() {
    if (!S.convId || document.visibilityState === 'hidden') return;
    try { await API.post(`/chat/messages/${S.convId}/read`, {}); } catch (e) {}
    void readPending;
  }

  /* ---------- real-time: SSE (ticket) → polling fallback ---------- */
  /* P19g FIX (owner: open conversation me naya message live dikhna chahiye + subtle sound).
   * ROOT CAUSE (pehle kya toota tha): SSE ka PEHLA error hi stream ko permanently close kar
   * deta tha (EventSource ka native auto-reconnect khud bandh kar 9s polling par chale jate
   * the — phir kabhi SSE wapas NAHI aata tha), aur silently buffered/dead stream (reverse
   * proxy buffering) par koi error aata hi nahi tha — open conversation me naya message
   * reopen ke bina nahi dikhta tha.
   * AB: (1) transient error par EventSource reconnect karne diya jata hai, (2) server ka
   * 25s heartbeat (event: hb) stream-liveness dikhata hai — 40s+koi event nahi = zombie
   * stream -> close + poll fallback, (3) fallback me OPEN conversation 3s after_id catch-up
   * (pehle 9s tha — isi existing mechanism ka reuse, koi naya system nahi), (4) 60s baad
   * SSE khud retry (self-heal) — healthy hone par poll bandh, (5) tab visible hone par
   * instant catch-up, (6) naye INCOMING message par subtle WebAudio ding (no file/lib).
   * SSE healthy = bilkul zero polling (pehle jaisa hi). Rollback: ye pura block purane
   * startRealtime/onLiveMsg/startPolling se replace karo + panels me ?v=gxchat1. */
  async function startRealtime() {
    if (S.started) return; S.started = true;
    S.lastEvt = Date.now();
    unlockAudioOnGesture();
    document.addEventListener('visibilitychange', onVisChange);
    connectSSE();
    S.monitor = setInterval(sseMonitor, 15000);
  }
  async function connectSSE() {
    if (S.es || S.connecting) return;
    if (typeof EventSource === 'undefined') { startPolling(); return; }
    S.connecting = true;
    try {
      const { ticket } = await API.post('/chat/ticket', {});
      const es = new EventSource('/api/chat/stream?ticket=' + encodeURIComponent(ticket));
      S.es = es; touchSse();
      es.addEventListener('ready', () => { touchSse(); if (S.convId) catchUpOpenConv(); /* reconnect gap ke messages */ });
      es.addEventListener('hb', touchSse);
      es.addEventListener('msg', (ev) => { try { const d = JSON.parse(ev.data); touchSse(); onLiveMsg(d.c, d.m); } catch (e) {} });
      es.addEventListener('msg_deleted', (ev) => { try { const d = JSON.parse(ev.data); touchSse(); onLiveDeleted(d.c, d.message_id); } catch (e) {} });
      es.addEventListener('read', (ev) => { try { touchSse(); onLiveRead(JSON.parse(ev.data)); } catch (e) {} });
      es.onerror = () => {
        if (!S.es) { startPolling(); scheduleSseRetry(); return; }
        const rs = S.es.readyState;
        if (rs === 2) { /* CLOSED — final: poll bridge + 60s retry */
          try { S.es.close(); } catch (e) {} S.es = null; startPolling(); scheduleSseRetry();
        }
        /* rs === 0 (CONNECTING): browser khud reconnect kar raha hai — interference nahi.
           Agar reconnect kaam nahi karega to sseMonitor 40s me zombie pakar lega. */
      };
      /* stream khula par pehla event (ready) 8s+ na aaye (proxy buffering) -> poll bridge */
      setTimeout(() => { if (S.es && !S.pollTimer && Date.now() - S.lastEvt > 8000) startPolling(); }, 8500);
    } catch (e) { /* ticket fail (network) -> poll + retry */ startPolling(); scheduleSseRetry(); }
    S.connecting = false;
  }
  function touchSse() {
    S.lastEvt = Date.now();
    if (S.pollTimer) stopPolling(); /* SSE ne liveness PROVE kar di — polling bandh (no unnecessary requests) */
  }
  function sseMonitor() {
    if (!S.es) { scheduleSseRetry(); return; }
    if (Date.now() - S.lastEvt > 40000) { /* zombie/buffered stream — heartbeat (25s) bhi nahi aaya */
      try { S.es.close(); } catch (e) {} S.es = null; startPolling(); scheduleSseRetry();
    }
  }
  function scheduleSseRetry() {
    if (S.sseRetryTimer) return;
    S.sseRetryTimer = setTimeout(() => { S.sseRetryTimer = null; if (!S.es) connectSSE(); }, 60000);
  }
  function onVisChange() {
    if (document.visibilityState !== 'visible' || !S.convId) return;
    /* tab wapas visible hua -> open conv ka instant catch-up (jo messages hidden phase me aaye) */
    catchUpOpenConv();
  }
  async function catchUpOpenConv() {
    if (!S.convId) return;
    try {
      const after = S.lastMsgId[S.convId] || 0;
      const data = await API.get(`/chat/messages/${S.convId}?after_id=${after}`);
      (data.messages || []).forEach(m => appendMsg(m));
    } catch (e) {}
    if (S.convId) markReadSoon();
  }
  function onLiveMsg(convId, m) {
    if (S.convId === convId && document.visibilityState === 'visible') {
      appendMsg(m);
      loadConvsSoon(); /* read-mark hone ke BAAD list refresh — open conv ka phantom unread na dikhe */
    } else {
      refreshBadges(); loadConvs();
      dingOnce(m); /* dusri/hidden conv ka naya incoming message */
    }
  }
  function loadConvsSoon() { clearTimeout(S.convsTimer); S.convsTimer = setTimeout(() => { loadConvs(); refreshBadges(); }, 700); }
  function onLiveRead(d) {
    if (S.convId !== d.c) return;
    document.querySelectorAll('#gxcMsgs .gxc-row.mine .gxc-ticks').forEach(t => { t.classList.add('read'); t.textContent = '✓✓'; });
  }
  function onLiveDeleted(convId, msgId) {
    if (S.convId === convId) {
      const row = $('gxcMsgs') && $('gxcMsgs').querySelector(`[data-mid="${msgId}"]`);
      if (row) {
        const bubble = row.querySelector('.gxc-bubble');
        if (bubble) {
          bubble.textContent = 'This message was deleted';
          bubble.classList.add('deleted');
        }
        const acts = row.querySelector('.gxc-msg-acts');
        if (acts) acts.remove();
      }
    }
    loadConvsSoon();
  }
  function startPolling() {
    if (S.pollTimer) return;
    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      refreshBadges();
      if (S.convId) { try { await catchUpOpenConv(); } catch (e) {} }
      if ($('page-chat') && $('page-chat').classList.contains('active')) loadConvs();
    };
    const sched = () => {
      /* P19g: open conversation + chat page active -> 3s (immediate feel), warna 9s.
         Same after_id catch-up mechanism — koi doosra system nahi. SSE healthy hone
         par poll chalta hi nahi (touchSse stopPolling karta hai). */
      const iv = (S.convId && $('page-chat') && $('page-chat').classList.contains('active')) ? 3000 : 9000;
      S.pollTimer = setTimeout(() => { tick().catch(() => {}).then(sched); }, iv);
    };
    tick().catch(() => {}); /* fallback ON hote hi ek instant catch-up */
    sched();
  }
  function stopPolling() { if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; } }
  async function refreshBadges() {
    try {
      const b = await API.get('/chat/unread-count');
      const prev = S.lastUnread; S.lastUnread = b.chat;
      /* poll mode: kisi AUR conv me naya message aya (unread badha) — subtle ding.
         (SSE mode me per-message dingOnce pehle hi ho chuka hota hai; 2s throttle double ko rokta hai.) */
      if (prev !== null && b.chat > prev) playDing();
      setBadge('gxChatBadge', b.chat); setBadge('gxCompBadge', b.complaints);
      /* P19j: floating Chat shortcut badge — same numbers as the sidebar badge (no separate tracking) */
      const fb = $('gxChatFabBadge');
      if (fb) { fb.textContent = b.chat > 99 ? '99+' : String(b.chat); fb.classList.toggle('show', b.chat > 0); }
    } catch (e) {}
  }

  /* ---------- P19g: subtle notification sound (WebAudio — no audio file, no library) ---------- */
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx !== null) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = AC ? new AC() : false;
    } catch (e) { audioCtx = false; }
    return audioCtx;
  }
  function unlockAudioOnGesture() {
    if (S.audioUnlocked) return;
    const unlock = () => {
      S.audioUnlocked = true;
      const ctx = ensureAudio();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    /* browser autoplay policy: pehle user-interaction ke baad hi sound allowed —
       chat interface ka koi bhi pehla click/keypress audio unlock kar deta hai */
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }
  const DING_GAP = 2000; /* burst me machine-gun nahi — max ek ding per 2s */
  function playDing() {
    const now = Date.now();
    if (now - (S.lastDingAt || 0) < DING_GAP) return;
    S.lastDingAt = now;
    const ctx = ensureAudio();
    if (!ctx) return; /* AudioContext available nahi (very old browser) — chup-chaap skip */
    if (ctx.state === 'suspended') { try { ctx.resume().catch(() => {}); } catch (e) {} if (ctx.state === 'suspended') return; }
    try {
      const t0 = ctx.currentTime;
      const note = (freq, start, dur, vol) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + start); o.stop(t0 + start + dur + 0.03);
      };
      note(987.77, 0, 0.12, 0.06);     /* B5 — soft "ding" */
      note(1318.51, 0.09, 0.16, 0.05); /* E6 — gentle tail */
    } catch (e) {}
  }
  function dingOnce(m) {
    /* sirf genuinely NAYA incoming message — apne bheje messages, history-load aur
       duplicate deliveries (SSE+poll/catch-up overlap) par sound NAHI */
    if (!m || m.sender_id === ME.id) return;
    const k = String(m.id);
    if (S.sounded[k]) return;
    S.sounded[k] = 1; S.soundedOrder.push(k);
    if (S.soundedOrder.length > 300) delete S.sounded[S.soundedOrder.shift()];
    playDing();
  }
  function setBadge(id, n) {
    const el = $(id); if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? 'inline-block' : 'none';
  }

  /* ================= COMPLAINTS PAGE ================= */
  function buildComplaintsPage() {
    const page = $('page-complaints'); if (!page) return;
    ensureStyle();
    if (page.dataset.built) return; page.dataset.built = '1';
    page.innerHTML = `
    <div class="page-head"><div><h2>Complaints</h2><div class="breadcrumb"><b>Communication</b> › ${IS_ADMIN ? 'All Complaints' : 'My Complaints'}</div></div>
      <div class="head-actions">
        ${IS_ADMIN ? `<select id="gxcCFilter" style="width:auto"><option value="">All Status</option><option>Open</option><option>In Progress</option><option>Resolved</option></select>` : ''}
        ${IS_ADMIN ? '' : `<button class="btn btn-blue" id="gxcCNew">+ New Complaint</button>`}
      </div></div>
    <div class="gx-comp"><div class="table-wrap"><div class="tscroll"><table>
      <thead><tr><th>ID</th><th>Subject</th>${IS_ADMIN ? '<th>From</th>' : ''}<th>Status</th><th>Created</th><th>Updated</th></tr></thead>
      <tbody id="gxcCBody"></tbody></table></div><div class="table-foot"><div class="info" id="gxcCInfo"></div></div></div></div>`;
    if (IS_ADMIN) $('gxcCFilter').addEventListener('change', () => { S.cFilter = $('gxcCFilter').value; renderComplaints(); });
    else $('gxcCNew').addEventListener('click', newComplaintModal);
  }
  async function loadComplaints() {
    try { S.complaints = await API.get('/complaints') || []; renderComplaints(); } catch (e) { S.complaints = []; }
  }
  function renderComplaints() {
    const body = $('gxcCBody'); if (!body) return;
    let rows = S.complaints;
    if (S.cFilter) rows = rows.filter(c => c.status === S.cFilter);
    body.innerHTML = rows.length ? '' : `<tr><td colspan="${IS_ADMIN ? 6 : 5}" class="muted" style="text-align:center;padding:24px">No complaints yet</td></tr>`;
    rows.forEach(c => {
      const tr = document.createElement('tr'); tr.className = 'gxc-citem';
      tr.innerHTML = `<td class="mono">#${c.id}</td><td><b>${esc(c.subject)}</b></td>
        ${IS_ADMIN ? `<td><span class="gxc-role">${esc(c.sender.name)}</span> <span class="muted">${esc(c.sender.role_label)}</span></td>` : ''}
        <td><span class="gxc-cstatus ${c.status === 'In Progress' ? 'InProgress' : c.status}">${esc(c.status)}</span></td>
        <td class="muted">${esc(fmtDay(c.created_at))} ${esc(fmtTime(c.created_at))}</td><td class="muted">${esc(fmtDay(c.updated_at))} ${esc(fmtTime(c.updated_at))}</td>`;
      tr.addEventListener('click', () => openComplaint(c.id));
      body.appendChild(tr);
    });
    $('gxcCInfo').textContent = rows.length + ' complaint(s)';
  }
  function newComplaintModal() {
    ovRemove('gxcCompModal');
    const ov = document.createElement('div'); ov.className = 'modal-overlay show'; ov.id = 'gxcCompModal';
    ov.innerHTML = `<div class="modal" style="max-width:480px">
      <div class="modal-head"><h3>New Complaint</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <div class="form-group"><label>Subject *</label><input type="text" id="gxcCSubject" maxlength="200" placeholder="Short subject"/></div>
        <div class="form-group"><label>Complaint *</label><textarea id="gxcCBody" rows="5" maxlength="4000" style="width:100%" placeholder="Describe your issue in detail..."></textarea></div>
        <div class="hint">Complaints go directly to the Admin team. Range/number/rate requests are NOT handled here — please use the relevant pages in your panel.</div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" id="gxcCCancel">Cancel</button><button class="btn btn-blue" id="gxcCSend">Submit Complaint</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    $('gxcCCancel').addEventListener('click', () => ov.remove());
    $('gxcCSend').addEventListener('click', async () => {
      const subject = $('gxcCSubject').value.trim(), body = $('gxcCBody').value.trim();
      if (!subject || !body) { alert('Both a subject and a message are required.'); return; }
      try { const r = await API.post('/complaints', { subject, body }); ov.remove(); alert('✅ Complaint #' + r.id + ' submitted — it has been forwarded to the Admin team.'); loadComplaints(); refreshBadges(); }
      catch (e) { alert('❌ ' + e.message); }
    });
  }
  async function openComplaint(id) {
    let c; try { c = await API.get('/complaints/' + id); } catch (e) { alert('❌ ' + e.message); return; }
    ovRemove('gxcCompModal');
    const ov = document.createElement('div'); ov.className = 'modal-overlay show'; ov.id = 'gxcCompModal';
    ov.innerHTML = `<div class="modal" style="max-width:560px">
      <div class="modal-head"><h3>Complaint #${c.id}</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <div class="gxc-top" style="margin-bottom:8px"><span class="gxc-nm">${esc(c.sender.name)}</span><span class="gxc-role">${esc(c.sender.role_label)}</span>
        <span class="gxc-cstatus ${c.status === 'In Progress' ? 'InProgress' : c.status}">${esc(c.status)}</span></div>
        <div class="muted" style="font-size:11px;margin-bottom:10px">Created ${esc(fmtDay(c.created_at))} ${esc(fmtTime(c.created_at))}${c.status_updated_at ? ` · Status updated by ${esc(c.status_updated_by)} at ${esc(fmtDay(c.status_updated_at))} ${esc(fmtTime(c.status_updated_at))}` : ''}</div>
        <div class="form-group"><label>Subject</label><div><b>${esc(c.subject)}</b></div></div>
        <div class="form-group"><label>Complaint</label><div style="white-space:pre-wrap">${esc(c.body)}</div></div>
        <div class="form-group"><label>Replies</label><div id="gxcCReplies" style="display:flex;flex-direction:column;gap:8px"></div></div>
        ${IS_ADMIN ? `<div class="form-group"><label>Update Status</label><div style="display:flex;gap:8px">
          <select id="gxcCStatus" style="width:auto"><option>Open</option><option>In Progress</option><option>Resolved</option></select>
          <button class="btn btn-blue" id="gxcCStatusBtn">Update Status</button></div></div>` : ''}
        <div class="form-group"><label>Reply</label><textarea id="gxcCReply" rows="3" maxlength="4000" style="width:100%" placeholder="Write your reply..."></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" id="gxcCClose2">Close</button><button class="btn btn-blue" id="gxcCReplyBtn">Send Reply</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    $('gxcCClose2').addEventListener('click', () => { ov.remove(); loadComplaints(); });
    const rep = $('gxcCReplies');
    (c.replies || []).forEach(r => {
      const d = document.createElement('div');
      d.innerHTML = `<div class="gxc-sender">${esc(r.sender_name)} · ${esc(r.sender_role)} <span class="muted" style="font-weight:400">${esc(fmtDay(r.created_at))} ${esc(fmtTime(r.created_at))}</span></div>
        <div class="gxc-bubble" style="max-width:100%"></div>`;
      d.querySelector('.gxc-bubble').textContent = r.body;
      d.className = 'gxc-row theirs'; d.style.maxWidth = '100%';
      rep.appendChild(d);
    });
    if (!(c.replies || []).length) rep.innerHTML = '<div class="muted">No replies yet.</div>';
    $('gxcCReplyBtn').addEventListener('click', async () => {
      const body = $('gxcCReply').value.trim();
      if (!body) { alert('Your reply is empty.'); return; }
      try { await API.post(`/complaints/${c.id}/replies`, { body }); alert('✅ Reply sent'); openComplaint(c.id); }
      catch (e) { alert('❌ ' + e.message); }
    });
    if (IS_ADMIN) {
      $('gxcCStatus').value = c.status;
      $('gxcCStatusBtn').addEventListener('click', async () => {
        try { await API.post(`/complaints/${c.id}/status`, { status: $('gxcCStatus').value }); alert('✅ Status updated'); openComplaint(c.id); }
        catch (e) { alert('❌ ' + e.message); }
      });
    }
  }

  /* ================= P19j: floating Chat shortcut (bottom-right, stacked above the AI assistant button) =================
     - Opens the EXISTING chat system (clicks the panel's own [data-page="chat"] nav item -> GXChat.open('chat')).
     - Role permissions unchanged (server already enforces them); sidebar chat unchanged.
     - Unread badge uses the EXISTING /chat/unread-count tracking (refreshBadges / SSE), not a second system. */
  function positionChatFab() {
    const fab = $('gxChatFab'); if (!fab) return;
    const ai = document.getElementById('gxAssistantBtn');
    const aiVisible = ai && window.getComputedStyle && window.getComputedStyle(ai).display !== 'none';
    if (aiVisible) fab.classList.remove('gx-fab-solo'); else fab.classList.add('gx-fab-solo');
  }
  /* P19k #1 (responsive): FAB ko hide karo jab chat/complaints page ACTIVE ho ya mobile par
     fullscreen conversation khula ho. Pehle FAB (z 9998) open conversation (z 1200) ke UPAR
     float karta tha aur chat page par input/send area ke upar baitha rehta tha.
     Panel-agnostic: .page.active class changes par MutationObserver (kisi bhi panel ke
     apne router par depend nahi). Rollback: observer disconnect + CSS class hatayein. */
  function chatPageActive() {
    const pg = document.querySelector('.page.active');
    if (!pg) return false;
    const id = (pg.id || '').toLowerCase();
    return id === 'page-chat' || id === 'page-complaints';
  }
  function updateFabVisibility() {
    const fab = $('gxChatFab'); if (!fab) return;
    const root = $('gxcRoot');
    const hide = chatPageActive() || !!(root && root.classList.contains('conv-open'));
    fab.classList.toggle('gx-fab-hidden', hide);
  }
  let fabObserverStarted = false;
  function startFabVisibilityObserver() {
    if (fabObserverStarted) return; fabObserverStarted = true;
    try {
      const mo = new MutationObserver(() => updateFabVisibility());
      mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
      updateFabVisibility();
    } catch (e) { /* jsdom/purane engines — fallback: sirf open/close par update */ }
  }
  function ensureChatFab() {
    if ($('gxChatFab')) return;
    if (!document.querySelector('[data-page="chat"]')) return; /* panel without chat nav -> no shortcut */
    const st = document.createElement('style');
    st.id = 'gxChatFabCss';
    st.textContent = '#gxChatFab{position:fixed;right:18px;bottom:82px;z-index:9998;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#25D9A4,#0EA5E9);color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease}'
      + '#gxChatFab:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.42)}'
      + '#gxChatFab:focus-visible{outline:2px solid #30ABED;outline-offset:2px}'
      + '#gxChatFab svg{width:24px;height:24px}'
      + '#gxChatFab.gx-fab-solo{bottom:18px}'
      + '#gxChatFab.gx-fab-hidden{display:none}'
      + '#gxChatFabBadge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#FF5C7A;color:#fff;font-size:11.5px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid rgba(7,13,31,.9)}'
      + '#gxChatFabBadge.show{display:flex}'
      + '@media(max-width:480px){#gxChatFab{right:12px;bottom:78px}#gxChatFab.gx-fab-solo{bottom:12px}}';
    document.head.appendChild(st);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'gxChatFab'; btn.title = 'Chats'; btn.setAttribute('aria-label', 'Open chats');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span id="gxChatFabBadge"></span>';
    btn.addEventListener('click', () => {
      const nav = document.querySelector('[data-page="chat"]');
      if (nav) nav.click(); /* panel's own router -> showPage('chat') -> GXChat.open('chat') */
      else if (window.GXChat) GXChat.open('chat');
    });
    document.body.appendChild(btn);
    positionChatFab();
    startFabVisibilityObserver();
    /* AI assistant button (api.js) appears async after /assistant/status — re-check stacking */
    setTimeout(positionChatFab, 1500); setTimeout(positionChatFab, 4000);
  }

  /* ================= public API ================= */
  window.GXChat = {
    open(page) {
      if (page === 'chat') { buildChatPage(); startRealtime(); refreshBadges(); loadConvs(); }
      else if (page === 'complaints') { buildComplaintsPage(); startRealtime(); refreshBadges(); loadComplaints(); }
    },
    refreshBadges,
    refresh: () => { refreshBadges(); loadConvs(); },
    _state: S,
  };

  /* P19j: floating Chat shortcut + live unread badge on every page (existing engine only).
     startRealtime() is the EXISTING SSE/poll engine (guarded by S.started) — starting it on load
     keeps the sidebar badge AND the floating badge live everywhere, exactly like after a chat visit.
     Rollback: remove this block and bump ?v= back — nothing else depends on it. */
  function fabInit() {
    if (!ME.id) return; /* not logged in — api.js guard handles redirect */
    ensureChatFab();
    startRealtime();
    refreshBadges();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fabInit);
  else fabInit();
})();
