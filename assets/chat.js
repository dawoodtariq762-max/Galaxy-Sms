/**
 * assets/chat.js — GALAXY SMS COMPLAINTS & TICKETING SYSTEM
 * (The separate Chat System / Chat App has been discontinued and removed).
 */
(function () {
  'use strict';
  if (window.GXChat) return;

  function jwtPayload() { try { const t = localStorage.getItem('ms_token') || sessionStorage.getItem('ms_token') || ''; const p = t.split('.')[1]; return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } }
  const ME = Object.assign({ id: 0, role: 'client' }, jwtPayload());
  const IS_ADMIN = ME.role === 'admin';
  const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', agent: 'Agent', client: 'Client' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtDay(dt) { return (window.API && API.ukDate) ? API.ukDate(dt) : String(dt || '').slice(0, 10); }
  function fmtTime(dt) { return (window.API && API.ukTime) ? API.ukTime(dt) : String(dt || '').slice(11, 16); }

  const S = {
    complaints: [],
    cFilter: '',
    lastUnread: null
  };

  const CSS = `
  .gx-comp{height:calc(100vh - 132px);height:calc(100dvh - 132px);min-height:420px;display:flex;flex-direction:column}
  .gxc-citem{cursor:pointer;transition:background .15s}
  .gxc-citem:hover td{background:rgba(201,206,214,.08)!important}
  .gxc-cstatus{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase}
  .gxc-cstatus.Open{background:rgba(48,171,237,.15);color:#30ABED;border:1px solid rgba(48,171,237,.35)}
  .gxc-cstatus.InProgress{background:rgba(255,180,67,.15);color:#FFB443;border:1px solid rgba(255,180,67,.35)}
  .gxc-cstatus.Resolved{background:rgba(37,217,164,.15);color:#25D9A4;border:1px solid rgba(37,217,164,.35)}
  .gxc-cmsg{padding:10px 14px;border-radius:12px;margin-bottom:8px;font-size:13px;line-height:1.5}
  .gxc-cmsg.admin{background:rgba(48,171,237,.12);border:1px solid rgba(48,171,237,.25);color:var(--text,#fff)}
  .gxc-cmsg.user{background:rgba(255,255,255,.05);border:1px solid var(--border,rgba(255,255,255,.1));color:var(--text,#fff)}
  .gxc-cmsg-head{display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;color:var(--muted,#94a3b8)}
  .gxc-role{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.1);margin-left:4px}
  `;

  function ensureStyle() {
    if (!$('gx-complaints-style')) {
      const st = document.createElement('style');
      st.id = 'gx-complaints-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
  }

  function setBadge(id, n) {
    const el = $(id); if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? 'inline-block' : 'none';
  }

  function ovRemove(id) {
    const el = $(id);
    if (el) el.remove();
  }

  /* ================= COMPLAINTS PAGE ================= */
  function buildComplaintsPage() {
    const page = $('page-complaints'); if (!page) return;
    ensureStyle();
    if (page.dataset.built) return; page.dataset.built = '1';
    page.innerHTML = `
    <div class="page-head"><div><h2>Complaints & Support Tickets</h2><div class="breadcrumb"><b>Communication</b> › ${IS_ADMIN ? 'All Complaints' : 'My Complaints'}</div></div>
      <div class="head-actions">
        ${IS_ADMIN ? `<select id="gxcCFilter" style="width:auto"><option value="">All Status</option><option>Open</option><option>In Progress</option><option>Resolved</option></select>` : ''}
        ${IS_ADMIN ? '' : `<button class="btn btn-blue" id="gxcCNew">+ New Complaint</button>`}
      </div></div>
    <div class="gx-comp"><div class="table-wrap"><div class="tscroll"><table>
      <thead><tr><th>ID</th><th>Subject</th>${IS_ADMIN ? '<th>From</th>' : ''}<th>Status</th><th>Created</th><th>Updated</th></tr></thead>
      <tbody id="gxcCBody"></tbody></table></div><div class="table-foot"><div class="info" id="gxcCInfo"></div></div></div></div>`;
    if (IS_ADMIN) {
      const f = $('gxcCFilter');
      if (f) f.addEventListener('change', () => { S.cFilter = f.value; renderComplaints(); });
    } else {
      const n = $('gxcCNew');
      if (n) n.addEventListener('click', newComplaintModal);
    }
  }

  async function loadComplaints() {
    try { S.complaints = await API.get('/complaints') || []; renderComplaints(); } catch (e) { S.complaints = []; }
  }

  function renderComplaints() {
    const body = $('gxcCBody'); if (!body) return;
    let rows = S.complaints;
    if (S.cFilter) rows = rows.filter(c => c.status === S.cFilter);
    body.innerHTML = rows.length ? '' : `<tr><td colspan="${IS_ADMIN ? 6 : 5}" class="muted" style="text-align:center;padding:24px">No complaints found</td></tr>`;
    rows.forEach(c => {
      const tr = document.createElement('tr'); tr.className = 'gxc-citem';
      tr.innerHTML = `<td class="mono">#${c.id}</td><td><b>${esc(c.subject)}</b></td>
        ${IS_ADMIN ? `<td><span class="gxc-role">${esc(c.sender.name)}</span> <span class="muted">${esc(c.sender.role_label)}</span></td>` : ''}
        <td><span class="gxc-cstatus ${c.status === 'In Progress' ? 'InProgress' : c.status}">${esc(c.status)}</span></td>
        <td class="muted">${esc(fmtDay(c.created_at))} ${esc(fmtTime(c.created_at))}</td><td class="muted">${esc(fmtDay(c.updated_at))} ${esc(fmtTime(c.updated_at))}</td>`;
      tr.addEventListener('click', () => openComplaint(c.id));
      body.appendChild(tr);
    });
    const info = $('gxcCInfo');
    if (info) info.textContent = rows.length + ' complaint(s)';
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
      try {
        const r = await API.post('/complaints', { subject, body });
        ov.remove();
        alert('✅ Complaint #' + r.id + ' submitted — it has been forwarded to the Admin team.');
        loadComplaints();
        refreshBadges();
      } catch (e) {
        alert('❌ ' + e.message);
      }
    });
  }

  async function openComplaint(id) {
    let c; try { c = await API.get('/complaints/' + id); } catch (e) { alert('❌ ' + e.message); return; }
    ovRemove('gxcCompModal');
    const ov = document.createElement('div'); ov.className = 'modal-overlay show'; ov.id = 'gxcCompModal';
    ov.innerHTML = `<div class="modal" style="max-width:560px">
      <div class="modal-head"><h3>Complaint #${c.id}</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <div class="gxc-top" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
          <span style="font-weight:700">${esc(c.sender.name)}</span>
          <span class="gxc-role">${esc(c.sender.role_label)}</span>
          <span class="gxc-cstatus ${c.status === 'In Progress' ? 'InProgress' : c.status}">${esc(c.status)}</span>
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:10px">Created ${esc(fmtDay(c.created_at))} ${esc(fmtTime(c.created_at))}${c.status_updated_at ? ` · Status updated by ${esc(c.status_updated_by)} at ${esc(fmtDay(c.status_updated_at))} ${esc(fmtTime(c.status_updated_at))}` : ''}</div>
        <div class="form-group"><label>Subject</label><div><b>${esc(c.subject)}</b></div></div>
        <div class="form-group"><label>Complaint</label><div style="white-space:pre-wrap;background:rgba(255,255,255,.03);padding:10px;border-radius:8px">${esc(c.body)}</div></div>
        <div class="form-group"><label>Replies</label><div id="gxcCReplies" style="display:flex;flex-direction:column;gap:8px"></div></div>
        ${IS_ADMIN ? `<div class="form-group"><label>Update Status</label><div style="display:flex;gap:8px">
          <select id="gxcCStatus" style="width:auto"><option ${c.status==='Open'?'selected':''}>Open</option><option ${c.status==='In Progress'?'selected':''}>In Progress</option><option ${c.status==='Resolved'?'selected':''}>Resolved</option></select>
          <button class="btn btn-blue" id="gxcCStatusBtn">Update Status</button></div></div>` : ''}
        <div class="form-group"><label>Reply</label><textarea id="gxcCReply" rows="3" maxlength="4000" style="width:100%" placeholder="Write your reply..."></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" id="gxcCClose2">Close</button><button class="btn btn-blue" id="gxcCReplyBtn">Send Reply</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    $('gxcCClose2').addEventListener('click', () => ov.remove());

    const repBox = $('gxcCReplies');
    if (!c.replies || !c.replies.length) {
      repBox.innerHTML = '<div class="muted" style="font-size:12px">No replies yet.</div>';
    } else {
      repBox.innerHTML = c.replies.map(r => `
        <div class="gxc-cmsg ${r.sender.role === 'admin' ? 'admin' : 'user'}">
          <div class="gxc-cmsg-head">
            <b>${esc(r.sender.name)} <span class="gxc-role">${esc(r.sender.role_label)}</span></b>
            <span>${esc(fmtDay(r.created_at))} ${esc(fmtTime(r.created_at))}</span>
          </div>
          <div style="white-space:pre-wrap">${esc(r.body)}</div>
        </div>
      `).join('');
    }

    if (IS_ADMIN && $('gxcCStatusBtn')) {
      $('gxcCStatusBtn').addEventListener('click', async () => {
        const st = $('gxcCStatus').value;
        try {
          await API.post(`/complaints/${c.id}/status`, { status: st });
          alert('✅ Status updated to ' + st);
          openComplaint(c.id);
          loadComplaints();
          refreshBadges();
        } catch (e) {
          alert('❌ ' + e.message);
        }
      });
    }

    $('gxcCReplyBtn').addEventListener('click', async () => {
      const body = $('gxcCReply').value.trim();
      if (!body) { alert('Please enter a reply.'); return; }
      try {
        await API.post(`/complaints/${c.id}/replies`, { body });
        openComplaint(c.id);
        loadComplaints();
      } catch (e) {
        alert('❌ ' + e.message);
      }
    });
  }

  async function refreshBadges() {
    try {
      const b = await API.get('/chat/unread-count');
      setBadge('gxCompBadge', b.complaints);
    } catch (_) {}
  }

  window.GXChat = {
    open(page) {
      if (page === 'complaints') {
        buildComplaintsPage();
        refreshBadges();
        loadComplaints();
      }
    },
    refreshBadges,
    refresh: () => { refreshBadges(); },
    _state: S,
  };

  function initComplaints() {
    if (!ME.id) return;
    refreshBadges();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initComplaints);
  else initComplaints();
})();
