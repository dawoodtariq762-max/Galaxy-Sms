/**
 * Shared frontend API helper for all panels.
 * Uses localStorage token, adds Authorization header, redirects on 401.
 */
(function () {
  const AUTH_KEYS = ['ms_token','ms_role','ms_user','ms_name'];
  function clearAuthStorage(){
    try{ AUTH_KEYS.forEach(k=>{ sessionStorage.removeItem(k); localStorage.removeItem(k); }); }catch(e){}
  }
  const STORE = (k) => sessionStorage.getItem(k) || localStorage.getItem(k);
  const TOKEN = () => STORE('ms_token');
  const ROLE = () => STORE('ms_role');

  function guard(expectedRole) {
    if (!TOKEN()) { location.href = '/panel-login'; return false; }
    if (expectedRole && ROLE() !== expectedRole) { location.href = '/panel-login'; return false; }
    return true;
  }

  async function req(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    const t = TOKEN();
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opt);
    if (r.status === 401) { clearAuthStorage(); location.href = '/panel-login'; throw new Error('Session expired'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // PHASE-2: multipart upload helper (large CSV imports without JSON body)
  async function upload(path, formData) {
    const opt = { method: 'POST', body: formData };
    const t = TOKEN();
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    const r = await fetch('/api' + path, opt);
    if (r.status === 401) { clearAuthStorage(); location.href = '/panel-login'; throw new Error('Session expired'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // Small client-side GET cache prevents duplicate heavy API calls during warmup + page click.
  const getCache = new Map();
  function isCacheableGet(path){
    return /^\/(sms|numbers|ranges|users\/|test-numbers|dashboard|stats\/|stats-summary\/|earnings-summary|cli-limits)(\?|$)/.test(String(path||''));
  }
  function getTtl(path){
    path=String(path||'');
    if(path.startsWith('/sms/paged')) return 2500;
    if(path.startsWith('/sms')) return 5000;
    if(path.startsWith('/stats-summary')) return 2500;
    if(path.startsWith('/numbers?') || path.startsWith('/numbers&')) return 2500;
    if(path.startsWith('/numbers')) return 5000;
    if(path.startsWith('/dashboard')) return 3000;
    return 6000;
  }
  async function cachedGet(path){
    if(!isCacheableGet(path)) return req('GET', path);
    const now=Date.now();
    const hit=getCache.get(path);
    if(hit && hit.expires>now) return hit.promise;
    const promise=req('GET', path).catch(e=>{ getCache.delete(path); throw e; });
    getCache.set(path,{promise,expires:now+getTtl(path)});
    return promise;
  }
  function clearGetCache(){ try{getCache.clear();}catch(e){} }


  // Global modal helpers used by all panel HTML onclick handlers.
  function closeModalGlobal(id){
    const el=document.getElementById(id);
    if(!el) return;
    el.classList.remove('show');
    el.style.display='';
  }
  function openModalGlobal(id){
    const el=document.getElementById(id);
    if(!el) return;
    el.classList.add('show');
  }
  window.closeModal = window.closeModal || closeModalGlobal;
  window.openModal = window.openModal || openModalGlobal;
  document.addEventListener('click', (e)=>{
    const overlay=e.target.closest('.modal-overlay');
    if(overlay && e.target===overlay) overlay.classList.remove('show');
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key==='Escape') document.querySelectorAll('.modal-overlay.show').forEach(m=>m.classList.remove('show'));
  });



  function ensureSettingsUI(){
    if(document.getElementById('msSettingsPanel')) return;
    const panel=document.createElement('div');
    panel.id='msSettingsPanel'; panel.className='ms-notif-panel'; panel.style.top='68px';
    panel.innerHTML=`<div class="ms-notif-head"><b>Panel Settings</b><div class="ms-notif-actions"><button id="msCloseSettings">×</button></div></div>
      <div class="ms-notif-list" style="padding:14px 16px">
        <label class="ms-switch" style="justify-content:space-between"><span>Dark mode</span><input type="checkbox" id="msSetDark"></label>
      </div>`;
    document.body.appendChild(panel);
    document.getElementById('msCloseSettings').onclick=()=>panel.classList.remove('show');
    document.getElementById('msSetDark').onchange=(e)=>setDarkMode(e.target.checked);
  }

  function setDarkMode(on){
    document.body.classList.toggle('ms-dark-mode', !!on);
    localStorage.setItem('ms_dark_mode', on?'1':'0');
  }
  function ensureThemeCSS(){
    if(document.getElementById('msThemeCss')) return;
    const st=document.createElement('style');st.id='msThemeCss';
    st.textContent=`
      /* Power X SMS — runtime UI polish (motion + injected widgets).
         Palette lives in /assets/powerx-theme.css; this only adds behaviour-level styling. */
      .page.active{animation:msPageFade .24s cubic-bezier(.22,.9,.3,1) both}.card,.table-wrap,.toolbar,.stat-card{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,background-color .18s ease}button,.btn,.tb-btn,.nav-item,.sub-item,.tab,.ritem,.rsubitem,.navtab,.dropitem{transition:transform .14s ease,box-shadow .14s ease,background-color .14s ease,color .14s ease,opacity .14s ease}button:active,.btn:active{transform:translateY(1px) scale(.99)}tbody tr{transition:background-color .14s ease}@keyframes msPageFade{from{opacity:.55;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      .ms-progress{position:fixed;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,#E8151A,#C9CED6,#8A9099);z-index:20000;transform-origin:left;animation:msProgress .7s ease both}.ms-working{box-shadow:0 0 0 4px rgba(232,21,26,.20)!important;filter:brightness(1.04)}@keyframes msProgress{0%{transform:scaleX(0)}70%{transform:scaleX(.82)}100%{transform:scaleX(1);opacity:0}}
      .ms-toast{position:fixed;right:22px;bottom:22px;background:linear-gradient(96deg,#141416,#1E1E22);border:1px solid rgba(232,21,26,.34);color:#fff;border-radius:12px;padding:11px 14px;font-weight:700;font-size:13px;box-shadow:0 20px 50px rgba(180,20,24,.28);z-index:20001;opacity:0;transform:translateY(8px);animation:msToast .95s ease both}@keyframes msToast{15%,80%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(8px)}}
      [data-page]{position:relative}.ms-page-link-overlay{position:absolute;inset:0;z-index:3;background:transparent!important;color:inherit!important;text-decoration:none!important}.ms-page-link-overlay:focus{outline:2px solid rgba(232,21,26,.55);outline-offset:2px;border-radius:inherit}
      /* Contrast Boost: optional higher-contrast variant of the Power X dark theme. */
      body.ms-dark-mode{background:#050506!important}
      body.ms-dark-mode .card,body.ms-dark-mode .toolbar,body.ms-dark-mode .table-wrap,body.ms-dark-mode .modal,body.ms-dark-mode .modal-box,body.ms-dark-mode .ms-modal,body.ms-dark-mode .ms-notif-panel,body.ms-dark-mode .ms-profile-menu{background:#0F0F11!important;border-color:rgba(190,195,205,.20)!important}
      body.ms-dark-mode .topbar,body.ms-dark-mode .tb1,body.ms-dark-mode .appbar{background:rgba(4,7,14,.92)!important}
      body.ms-dark-mode .sidebar,body.ms-dark-mode .rail{background:#03060C!important}
      body.ms-dark-mode table th{background:#050506!important}
      body.ms-dark-mode tbody tr:nth-child(even) td{background:rgba(190,195,205,.03)!important}
      body.ms-dark-mode input,body.ms-dark-mode select,body.ms-dark-mode textarea,body.ms-dark-mode .ms-field input{background:#050506!important}
    `
    document.head.appendChild(st);
  }
  async function openSettings(){
    ensureSettingsUI();
    document.getElementById('msSetDark').checked=localStorage.getItem('ms_dark_mode')==='1';
    document.getElementById('msSettingsPanel').classList.add('show');
  }


  function enhancePageSizeOptions(root=document){
    // Same dropdown everywhere, as requested: 25 / 50 / 100 / 500 / 1000 / 5000 / All.
    // Important: do not rewrite selects repeatedly; that caused UI lag.
    const wanted=['25','50','100','500','1000','5000','All'];
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('select').forEach(sel=>{
      const id=(sel.id||'').toLowerCase();
      if(!(id.includes('len') || id.includes('slen'))) return;
      const signature=wanted.join('|');
      if(sel.dataset.msLenOptions===signature) return;
      const current = wanted.includes(sel.value) ? sel.value : '25';
      sel.innerHTML=wanted.map(v=>`<option value="${v}" ${v===current?'selected':''}>${v}</option>`).join('');
      sel.dataset.msLenOptions=signature;
    });
  }

  function ensureProfileUI(){
    if(document.getElementById('msProfileMenu')) return;
    const css=document.createElement('style');
    css.textContent=`
      .ms-profile-menu{position:fixed;right:24px;top:60px;background:#fff;border:1px solid #E2E8F0;border-radius:14px;box-shadow:0 18px 48px rgba(15,23,42,.16);z-index:10000;display:none;min-width:190px;overflow:hidden}.ms-profile-menu.show{display:block}.ms-profile-item{padding:12px 14px;cursor:pointer;font-weight:700;color:#1E293B;border-bottom:1px solid #F1F5F9}.ms-profile-item:hover{background:#F8FAFC}.ms-profile-item:last-child{border-bottom:0}
      .ms-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:10001;display:none;align-items:center;justify-content:center;padding:18px}.ms-modal-backdrop.show{display:flex}.ms-modal{width:min(720px,96vw);max-height:86vh;overflow:auto;background:#fff;border-radius:18px;border:1px solid #E2E8F0;box-shadow:0 28px 80px rgba(15,23,42,.22)}.ms-modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #E2E8F0}.ms-modal-head h3{margin:0;color:#1E293B}.ms-modal-body{padding:18px}.ms-modal-foot{padding:14px 18px;border-top:1px solid #E2E8F0;display:flex;justify-content:flex-end;gap:10px}.ms-x{border:0;background:#F1F5F9;border-radius:9px;width:32px;height:32px;cursor:pointer}.ms-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ms-field{margin-bottom:14px}.ms-field label{display:block;font-weight:800;font-size:13px;color:#334155;margin-bottom:7px}.ms-field input{width:100%;height:42px;border:1px solid #CBD5E1;border-radius:10px;padding:0 12px}.ms-btn{border:0;border-radius:10px;min-height:38px;padding:8px 14px;font-weight:800;cursor:pointer}.ms-btn.primary{background:linear-gradient(135deg,#2563EB,#06B6D4);color:white}.ms-btn.ghost{background:#fff;color:#334155;border:1px solid #CBD5E1}.ms-activity-table{width:100%;border-collapse:separate;border-spacing:0 4px}.ms-activity-table th{background:#F1F5F9;color:#334155;text-align:left;padding:10px;font-size:12px}.ms-activity-table td{background:#fff;border-bottom:1px solid #F1F5F9;padding:10px;color:#1E293B;font-size:13px}`;
    document.head.appendChild(css);
    const menu=document.createElement('div');menu.id='msProfileMenu';menu.className='ms-profile-menu';menu.innerHTML=`<div class="ms-profile-item" id="msOpenProfile">Profile</div><div class="ms-profile-item" id="msOpenActivity">Activity Log</div>`;document.body.appendChild(menu);
    const modal=document.createElement('div');modal.id='msProfileModal';modal.className='ms-modal-backdrop';modal.innerHTML=`<div class="ms-modal"><div class="ms-modal-head"><h3>Profile</h3><button class="ms-x" id="msCloseProfile">×</button></div><div class="ms-modal-body"><div class="ms-form-grid"><div class="ms-field"><label>Username</label><input id="msProfileUsername"></div><div class="ms-field"><label>Current Password</label><input type="password" id="msProfileCurrent" placeholder="Required for password change"></div><div class="ms-field"><label>New Password</label><input type="password" id="msProfileNew"></div><div class="ms-field"><label>Confirm New Password</label><input type="password" id="msProfileConfirm"></div><div class="ms-field ms-admin-only"><label>Admin Security Code</label><input type="password" id="msProfileAdminCode" placeholder="Required for admin password change"></div></div><div id="msSecurityCodeBox" class="ms-admin-only" style="margin-top:16px;padding-top:14px;border-top:1px solid #E2E8F0"><h4 style="margin:0 0 10px;color:#1E293B">Change Admin Security Code</h4><div class="ms-form-grid"><div class="ms-field"><label>Old Security Code</label><input type="password" id="msOldSecCode"></div><div class="ms-field"><label>New Security Code</label><input type="password" id="msNewSecCode"></div><div class="ms-field"><label>Confirm New Security Code</label><input type="password" id="msConfirmSecCode"></div></div><button class="ms-btn primary" id="msChangeSecCode" type="button">Change Security Code</button></div><div id="msProfileMsg" style="font-size:13px;color:#64748B;margin-top:10px"></div></div><div class="ms-modal-foot"><button class="ms-btn ghost" id="msProfileCancel">Cancel</button><button class="ms-btn primary" id="msProfileSave">Save Profile</button></div></div>`;document.body.appendChild(modal);
    const act=document.createElement('div');act.id='msActivityModal';act.className='ms-modal-backdrop';act.innerHTML=`<div class="ms-modal"><div class="ms-modal-head"><h3>Activity Log</h3><button class="ms-x" id="msCloseActivity">×</button></div><div class="ms-modal-body" id="msActivityBody">Loading...</div><div class="ms-modal-foot"><button class="ms-btn ghost" id="msActivityClose">Close</button></div></div>`;document.body.appendChild(act);
    document.getElementById('msOpenProfile').onclick=()=>{menu.classList.remove('show');openProfileModal();};
    document.getElementById('msOpenActivity').onclick=()=>{menu.classList.remove('show');openActivityModal();};
    document.getElementById('msCloseProfile').onclick=document.getElementById('msProfileCancel').onclick=()=>modal.classList.remove('show');
    document.getElementById('msCloseActivity').onclick=document.getElementById('msActivityClose').onclick=()=>act.classList.remove('show');
    const secBox=document.getElementById('msSecurityCodeBox');
    if(secBox && !document.getElementById('msCarrierLockBox')) secBox.insertAdjacentHTML('afterend', `<div id="msCarrierLockBox" class="ms-admin-only" style="margin-top:16px;padding-top:14px;border-top:1px solid #E2E8F0"><h4 style="margin:0 0 10px;color:#1E293B">Change Carrier Integration Password</h4><div class="ms-form-grid"><div class="ms-field"><label>Admin Security Code</label><input type="password" id="msCarrierSecCode"></div><div class="ms-field"><label>New Carrier Password</label><input type="password" id="msCarrierNewPass"></div><div class="ms-field"><label>Confirm Carrier Password</label><input type="password" id="msCarrierConfirmPass"></div></div><button class="ms-btn primary" id="msChangeCarrierPass" type="button">Change Carrier Password</button></div>`);
    document.getElementById('msProfileSave').onclick=saveOwnProfile;
    document.getElementById('msChangeSecCode').onclick=changeAdminSecurityCode;
    document.getElementById('msChangeCarrierPass').onclick=changeCarrierLockPassword;
  }
  function openProfileMenu(){
    if(ROLE()==='client'){ return; }
    ensureProfileUI();
    const m=document.getElementById('msProfileMenu');
    m.classList.toggle('show');
  }
  async function openProfileModal(){
    ensureProfileUI();
    try{const p=await req('GET','/profile');document.getElementById('msProfileUsername').value=p.username||'';document.getElementById('msProfileCurrent').value='';document.getElementById('msProfileNew').value='';document.getElementById('msProfileConfirm').value='';document.getElementById('msProfileAdminCode').value='';document.getElementById('msOldSecCode').value='';document.getElementById('msNewSecCode').value='';document.getElementById('msConfirmSecCode').value='';if(document.getElementById('msCarrierSecCode')){document.getElementById('msCarrierSecCode').value='';document.getElementById('msCarrierNewPass').value='';document.getElementById('msCarrierConfirmPass').value='';}document.querySelectorAll('.ms-admin-only').forEach(el=>el.style.display=(ROLE()==='admin'?'block':'none'));document.getElementById('msProfileMsg').textContent=ROLE()==='admin'?'Admin password changes require the admin security code. Carrier Integration password can also be changed here.':'Change username, or enter current/new passwords to change password.';document.getElementById('msProfileModal').classList.add('show');}catch(e){alert(e.message)}
  }
  async function saveOwnProfile(){
    try{
      const body={username:document.getElementById('msProfileUsername').value.trim(),current_password:document.getElementById('msProfileCurrent').value,new_password:document.getElementById('msProfileNew').value,confirm_password:document.getElementById('msProfileConfirm').value,admin_security_code:document.getElementById('msProfileAdminCode')?document.getElementById('msProfileAdminCode').value:''};
      const r=await req('PUT','/profile',body);
      sessionStorage.setItem('ms_token',r.token);sessionStorage.setItem('ms_user',r.user.username);sessionStorage.setItem('ms_role',r.user.role);sessionStorage.setItem('ms_name',r.user.name||r.user.username);localStorage.setItem('ms_token',r.token);localStorage.setItem('ms_user',r.user.username);localStorage.setItem('ms_role',r.user.role);localStorage.setItem('ms_name',r.user.name||r.user.username);
      document.getElementById('msProfileMsg').textContent='Profile updated successfully.';
      setTimeout(()=>location.reload(),700);
    }catch(e){document.getElementById('msProfileMsg').textContent='Error: '+e.message;}
  }
  async function changeAdminSecurityCode(){
    try{
      const body={old_security_code:document.getElementById('msOldSecCode').value,new_security_code:document.getElementById('msNewSecCode').value,confirm_security_code:document.getElementById('msConfirmSecCode').value};
      await req('PUT','/admin-security-code',body);
      document.getElementById('msProfileMsg').textContent='Security code updated successfully.';
      document.getElementById('msOldSecCode').value='';document.getElementById('msNewSecCode').value='';document.getElementById('msConfirmSecCode').value='';
    }catch(e){document.getElementById('msProfileMsg').textContent='Error: '+e.message;}
  }
  async function changeCarrierLockPassword(){
    try{
      const body={admin_security_code:document.getElementById('msCarrierSecCode').value,new_password:document.getElementById('msCarrierNewPass').value,confirm_password:document.getElementById('msCarrierConfirmPass').value};
      await req('PUT','/carrier-lock-password',body);
      document.getElementById('msProfileMsg').textContent='Carrier Integration password updated successfully.';
      document.getElementById('msCarrierSecCode').value='';document.getElementById('msCarrierNewPass').value='';document.getElementById('msCarrierConfirmPass').value='';
    }catch(e){document.getElementById('msProfileMsg').textContent='Error: '+e.message;}
  }
  function renderActivityTable(title, rows){
    return `<h4 style="margin:14px 0 8px;color:#1E293B">${title}</h4><table class="ms-activity-table"><thead><tr><th>Date</th><th>User</th><th>Role</th><th>Action</th><th>IP</th></tr></thead><tbody>${(rows||[]).map(r=>`<tr><td>${(r.created_at||'').slice(0,19)}</td><td>${r.username||'—'}</td><td>${r.role||'—'}</td><td><b>${r.action}</b></td><td>${r.ip||'—'}</td></tr>`).join('')||'<tr><td colspan="5">No activity found</td></tr>'}</tbody></table>`;
  }
  async function openActivityModal(){
    if(ROLE()==='client') return;
    ensureProfileUI();
    document.getElementById('msActivityModal').classList.add('show');
    document.getElementById('msActivityBody').textContent='Loading...';
    try{const data=await req('GET','/activity-log');const role=ROLE();const childTitle=role==='admin'?'Manager Activity':(role==='manager'?'Agent Activity':'Client Activity');document.getElementById('msActivityBody').innerHTML=renderActivityTable('My Activity',data.own)+renderActivityTable(childTitle,data.child);}catch(e){document.getElementById('msActivityBody').textContent='Error: '+e.message;}
  }


  function drawServerPagination(container, state, rerender) {
    if(!container) return;
    const totalPages=Math.max(1, Number(state.totalPages||1));
    const page=Math.min(Math.max(1, Number(state.page||1)), totalPages);
    let start=Math.max(1, page-3), end=Math.min(totalPages, start+6); start=Math.max(1, end-6);
    let html='<button data-pg="prev" '+(page<=1?'disabled':'')+'>‹</button>';
    for(let i=start;i<=end;i++) html+=`<button data-pg="${i}" class="${i===page?'active':''}">${i}</button>`;
    html+='<button data-pg="next" '+(page>=totalPages?'disabled':'')+'>›</button>';
    container.innerHTML=html;
    container.querySelectorAll('button').forEach(btn=>{
      btn.onclick=()=>{
        const v=btn.dataset.pg;
        if(v==='prev') state.page=Math.max(1,page-1);
        else if(v==='next') state.page=Math.min(totalPages,page+1);
        else state.page=parseInt(v,10)||1;
        if(typeof rerender==='function') rerender();
      };
    });
  }
  window.drawServerPagination = window.drawServerPagination || drawServerPagination;

  /* ===== P11: ROLE-BASED PAGE-SIZE OPTIONS =====
     UI options per role (backend ROLE_PAGE_MAX independently enforces the real ceiling).
     Previous options (recorded): static <option> lists in HTML (mostly 25..1000/All). */
  var GX_ROLE_PAGE_OPTIONS = {
    client:  ['25', '50', '100', '500'],
    test:    ['25', '50', '100', '500'],
    agent:   ['25', '50', '100', '250', '500', '1000'],
    manager: ['25', '50', '100', '250', '500', '1000', '2500', '5000'],
    admin:   ['25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '20000', '30000', '50000', '100000', 'All']
  };
  function gxApplyRolePageOptions() {
    try {
      var role = (localStorage.getItem('ms_role') || '').toLowerCase();
      var opts = GX_ROLE_PAGE_OPTIONS[role];
      if (!opts) return;
      var want = '|' + opts.join('|') + '|';
      document.querySelectorAll('select[id$="Len"]').forEach(function(sel) {
        var curVals = '|' + Array.prototype.map.call(sel.options, function(o) { return o.value; }).join('|') + '|';
        if (curVals === want) return; /* already correct — idempotent */
        var cur = sel.value;
        sel.innerHTML = opts.map(function(o) { return '<option value="' + o + '"' + (cur === o ? ' selected' : '') + '>' + o + '</option>'; }).join('');
        if (opts.indexOf(cur) === -1) sel.value = '25';
      });
    } catch (e) { console.warn('role page options failed', e); }
  }
  window.gxApplyRolePageOptions = gxApplyRolePageOptions;
  /* re-apply twice: immediately + delayed (panel late-renders can rewrite selects) */
  gxApplyRolePageOptions();
  setTimeout(gxApplyRolePageOptions, 1500);
  document.addEventListener('DOMContentLoaded', function() { gxApplyRolePageOptions(); setTimeout(gxApplyRolePageOptions, 1500); });
  function paginateRows(key, rows, len, infoId, rerender) {
    rows = rows || [];
    const state = window.__pagerState || (window.__pagerState = {});
    const perPage = len === 'All' ? rows.length || 1 : Math.max(1, parseInt(len || '25'));
    const totalPages = len === 'All' ? 1 : Math.max(1, Math.ceil(rows.length / perPage));
    if (!state[key]) state[key] = { page: 1, signature: '' };
    const signature = rows.length + '|' + len;
    if (state[key].signature !== signature) { state[key].signature = signature; if (state[key].page > totalPages) state[key].page = 1; }
    if (state[key].page < 1) state[key].page = 1;
    if (state[key].page > totalPages) state[key].page = totalPages;
    const page = state[key].page;
    const sliced = len === 'All' ? rows : rows.slice((page - 1) * perPage, page * perPage);
    setTimeout(() => {
      const info = document.getElementById(infoId);
      if (!info) return;
      let foot = info.closest('.table-foot') || info.parentElement;
      if (!foot) return;
      let pag = foot.querySelector('.pagination');
      if (!pag) { pag = document.createElement('div'); pag.className = 'pagination'; foot.appendChild(pag); }
      const nums = [];
      const maxBtns = 7;
      let start = Math.max(1, page - 3), end = Math.min(totalPages, start + maxBtns - 1);
      start = Math.max(1, end - maxBtns + 1);
      for (let i = start; i <= end; i++) nums.push(i);
      pag.innerHTML = `<button data-pg="prev">‹</button>` + nums.map(n=>`<button data-pg="${n}" class="${n===page?'active':''}">${n}</button>`).join('') + `<button data-pg="next">›</button>`;
      pag.querySelectorAll('button').forEach(btn => btn.onclick = () => {
        const v = btn.dataset.pg;
        if (v === 'prev') state[key].page = Math.max(1, state[key].page - 1);
        else if (v === 'next') state[key].page = Math.min(totalPages, state[key].page + 1);
        else state[key].page = parseInt(v);
        if (typeof rerender === 'function') rerender();
      });
    }, 0);
    return { rows: sliced, total: rows.length, page, totalPages };
  }
  function basePathForRole(role=ROLE()){
    if(location.pathname.startsWith('/management')) return '/management';
    if(location.pathname.startsWith('/payment')) return '/payment';
    if(location.pathname.startsWith('/panel-sharing')) return '/panel-sharing';
    return {admin:'/admin',manager:'/manager',agent:'/agent',client:'/client',test:'/test'}[role] || '/panel-login';
  }
  function defaultPageForCurrentPanel(){ return location.pathname.startsWith('/management') ? 'rates' : 'dashboard'; }
  function pageUrl(page){ return basePathForRole() + '/' + encodeURIComponent(page || defaultPageForCurrentPanel()); }
  function panelKeyForStorage(){ if(location.pathname.startsWith('/management')) return 'management'; if(location.pathname.startsWith('/payment')) return 'payment'; if(location.pathname.startsWith('/panel-sharing')) return 'panelsharing'; return (ROLE()||''); }
  function pageFromUrl(){
    const base=basePathForRole();
    const path=location.pathname.replace(/\/+$/,'');
    if(path.startsWith(base + '/')) return decodeURIComponent(path.slice(base.length+1).split('/')[0] || 'dashboard');
    if(location.hash) return decodeURIComponent(location.hash.slice(1));
    return '';
  }
  function initPageLinks(){
    // PERF: exclude the overlay itself. It carries data-page, so the old
    // selector matched overlays too and every pass appended a new overlay
    // inside the previous one - unbounded DOM growth driven by the observer
    // below (measured: 495 overlays, 32 levels deep, for 15 real targets).
    document.querySelectorAll('[data-page]:not(.ms-page-link-overlay)').forEach(el=>{
      const page=el.dataset.page;
      if(!page || el.querySelector(':scope > a.ms-page-link-overlay')) return;
      el.style.position = el.style.position || 'relative';
      const a=document.createElement('a');
      a.className='ms-page-link-overlay';
      a.href=pageUrl(page);
      a.dataset.page=page;
      a.setAttribute('aria-label','Open '+page);
      el.appendChild(a);
    });
  }
  function initPageLinkClicks(){
    document.addEventListener('click',(e)=>{
      const a=e.target.closest('a.ms-page-link-overlay');
      if(!a) return;
      if(e.button!==0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); e.stopPropagation();
      const page=a.dataset.page || 'dashboard';
      activatePageFromHistory(page);
      try{ history.pushState({msPanel:true,page},'',pageUrl(page)); }catch(_){}
      closeAllSidebars();
    }, true);
  }

  function initRoutePersistence(){
    if(!TOKEN()) return;
    const key='ms_last_page_'+panelKeyForStorage();
    document.addEventListener('click', (e)=>{
      const el=e.target.closest('[data-page]');
      if(el && el.dataset && el.dataset.page) localStorage.setItem(key, el.dataset.page);
    }, true);
    setTimeout(()=>{
      const fromRoute = pageFromUrl();
      const page=fromRoute || localStorage.getItem(key) || defaultPageForCurrentPanel();
      if(!page || page==='dashboard'){document.documentElement.style.visibility='visible'; return;}
      activatePageFromHistory(page);
      document.documentElement.style.visibility='visible';
    }, 180);
  }
  function tableToMatrix(table){
    const rows=[];
    table.querySelectorAll('tr').forEach(tr=>{
      const cells=[...tr.children].filter(c=>!c.querySelector('input[type="checkbox"]'));
      const vals=cells.map(c=>String(c.innerText||c.textContent||'').replace(/\s+/g,' ').trim());
      if(vals.some(Boolean)) rows.push(vals);
    });
    return rows;
  }
  function csvEscape(v){ v=String(v??''); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
  function downloadText(filename, text, type){
    const blob=new Blob([text],{type:type||'text/plain;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},500);
  }
  function findExportTable(btn){
    const page=btn.closest('.page') || document;
    let wrap=btn.closest('.table-wrap');
    if(wrap){
      let n=wrap.nextElementSibling;
      while(n){ const t=n.querySelector&&n.querySelector('table'); if(t) return t; n=n.nextElementSibling; }
      const t=wrap.querySelector('table'); if(t) return t;
    }
    const card=btn.closest('.card');
    if(card){ const t=[...card.querySelectorAll('table')].find(x=>x.offsetParent!==null && x.querySelector('tbody')); if(t) return t; }
    const tables=[...page.querySelectorAll('table')].filter(t=>t.offsetParent!==null && t.querySelector('tbody'));
    return tables[0] || page.querySelector('table');
  }
  function exportTable(btn, mode){
    const table=findExportTable(btn); if(!table){ alert('No table found to export.'); return; }
    const data=tableToMatrix(table); if(!data.length){ alert('No rows to export.'); return; }
    const title=(document.querySelector('.page.active h2')?.textContent||document.title||'powerx-export').trim().replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'') || 'powerx-export';
    const csv=data.map(r=>r.map(csvEscape).join(',')).join('\n');
    if(mode==='copy'){
      const copyText=data.map(r=>r.join('\t')).join('\n');
      const done=()=>showToast('Copied table data');
      const syncCopy=()=>{
        const ta=document.createElement('textarea');
        ta.value=copyText;
        ta.setAttribute('readonly','');
        ta.style.position='fixed'; ta.style.left='0'; ta.style.top='0'; ta.style.opacity='0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        let ok=false;
        try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
        ta.remove();
        return ok;
      };
      if(syncCopy()){ done(); return; }
      if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(copyText).then(done).catch(()=>alert('Copy failed. Please allow clipboard access.')); }
      else alert('Copy failed. Please allow clipboard access.');
      return;
    }
    if(mode==='csv') return downloadText(title+'.csv', csv, 'text/csv;charset=utf-8');
    if(mode==='excel'){
      const html='<html><head><meta charset="utf-8"></head><body><table border="1">'+data.map(r=>'<tr>'+r.map(c=>'<td>'+String(c).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))+'</td>').join('')+'</tr>').join('')+'</table></body></html>';
      return downloadText(title+'.xls', html, 'application/vnd.ms-excel;charset=utf-8');
    }
    const w=window.open('','_blank');
    if(!w){ alert('Popup blocked. Please allow popups.'); return; }
    const safeTitle=title.replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    w.document.write('<!doctype html><html><head><title>'+safeTitle+'</title><style>body{font-family:Arial,sans-serif;padding:20px;color:#111}h2{margin:0 0 14px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:7px;text-align:left;vertical-align:top}th{background:#f1f5f9}</style></head><body><h2>'+safeTitle+'</h2>'+table.outerHTML+'</body></html>');
    w.document.close(); w.focus(); setTimeout(()=>w.print(),300);
  }
  async function waitNumberJob(jobId, initial={}){
    showToast('Background job started');
    let lastProgress=-1;
    for(;;){
      await new Promise(r=>setTimeout(r,600));
      const job=await req('GET','/number-jobs/'+encodeURIComponent(jobId));
      const p=Number(job.progress||0);
      if(p!==lastProgress && (p===100 || p%10===0)){ showToast('Processing: '+p+'%'); lastProgress=p; }
      if(job.status==='done') { showToast('Completed'); return {ok:true,total:job.total||job.processed||0,report:job.report||[],job_id:jobId,job}; }
      if(job.status==='failed') throw new Error(job.error||'Background job failed');
    }
  }
  function showToast(text){
    const old=document.querySelector('.ms-toast'); if(old) old.remove();
    const t=document.createElement('div'); t.className='ms-toast'; t.textContent=text; document.body.appendChild(t);
    setTimeout(()=>t.remove(),1100);
  }
  function showProgress(btn, text='Applied'){
    try{
      const old=document.querySelector('.ms-progress'); if(old) old.remove();
      const p=document.createElement('div'); p.className='ms-progress'; document.body.appendChild(p); setTimeout(()=>p.remove(),850);
      if(btn){ btn.classList.add('ms-working'); setTimeout(()=>btn.classList.remove('ms-working'),700); }
      if(text) showToast(text);
    }catch(e){}
  }
  function exportModeFromButton(btn){
    const label=(btn.textContent||btn.value||'').toLowerCase();
    if(label.includes('copy')) return 'copy';
    if(label.includes('csv')) return 'csv';
    if(label.includes('excel')) return 'excel';
    if(label.includes('pdf')) return 'pdf';
    if(label.includes('print')) return 'print';
    return '';
  }
  function removePdfPrintButtons(root=document){
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('.exp-btns button').forEach(btn=>{
      const label=(btn.textContent||'').trim().toLowerCase();
      if(label==='pdf' || label==='print') btn.remove();
    });
  }
  function bindExportButtons(){
    removePdfPrintButtons(document);
    document.querySelectorAll('.exp-btns button').forEach(btn=>{
      if(btn.dataset.msExportBound) return;
      btn.dataset.msExportBound='1';
      btn.type='button';
      btn.addEventListener('click',(e)=>{
        e.preventDefault(); e.stopPropagation();
        const mode=exportModeFromButton(btn);
        if(mode) exportTable(btn,mode);
      });
    });
  }
  function initExportButtons(){
    bindExportButtons();
    const mo=new MutationObserver(()=>{ clearTimeout(window.__msExportBindTimer); window.__msExportBindTimer=setTimeout(bindExportButtons,120); });
    mo.observe(document.body,{childList:true,subtree:true});
    document.addEventListener('click',(e)=>{
      const btn=e.target.closest('.exp-btns button'); if(!btn) return;
      e.preventDefault(); e.stopPropagation();
      const mode=exportModeFromButton(btn);
      if(mode) exportTable(btn,mode);
    }, true);
  }
  function initActionFeedback(){
    document.addEventListener('click',(e)=>{
      const btn=e.target.closest('button,.btn'); if(!btn || btn.closest('.exp-btns')) return;
      const label=(btn.textContent||btn.title||'').trim().toLowerCase();
      if(/\b(filter|apply|search|refresh|today|reset)\b/.test(label)) showProgress(btn, label.includes('reset')?'Reset applied':(label.includes('refresh')?'Refreshing...':'Filter applied'));
    }, true);
  }

  function closeAllSidebars(){
    try{
      document.getElementById('sidebar')?.classList.remove('show');
      document.getElementById('overlay')?.classList.remove('show');
      document.getElementById('sbOverlay')?.classList.remove('show');
      document.getElementById('rail')?.classList.remove('show');
      document.getElementById('mgrMobileOverlay')?.classList.remove('show');
      if(window.innerWidth <= 900) document.querySelector('.appbar')?.classList.remove('show');
      if(typeof window.closeManagerSidebar==='function' && window.innerWidth <= 900) window.closeManagerSidebar();
      if(typeof window.closeSidebar==='function' && window.innerWidth <= 900) window.closeSidebar();
      if(typeof window.closeSb==='function' && window.innerWidth <= 900) window.closeSb();
    }catch(e){}
  }

  function activatePageFromHistory(page){
    if(!page) page='dashboard';
    try{ localStorage.setItem('ms_last_page_'+panelKeyForStorage(), page); }catch(e){}
    if(typeof window.showPageByName==='function') { window.showPageByName(page); return; }
    const safePage=String(page).replace(/"/g,'\\"');
    const el=document.querySelector(`[data-page="${safePage}"]`);
    if(el){ window.__msHistoryNav=1; el.click(); setTimeout(()=>{window.__msHistoryNav=0;},0); return; }
    const target=document.getElementById('page-'+page);
    if(target){ document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); target.classList.add('active'); }
  }
  function currentPageName(){
    const active=document.querySelector('.page.active');
    return active && active.id ? active.id.replace(/^page-/,'') : 'dashboard';
  }
  function initPanelHistory(){
    if(!TOKEN() || location.pathname.includes('login')) return;
    initPageLinks(); initPageLinkClicks();
    // PERF: ignore mutations we caused ourselves, else the observer re-fires
    // on every overlay we insert and never settles.
    const linkMo=new MutationObserver((muts)=>{
      let relevant=false;
      for(const m of muts){
        for(const n of m.addedNodes){
          if(n.nodeType!==1) continue;
          if(n.classList && n.classList.contains('ms-page-link-overlay')) continue;
          relevant=true; break;
        }
        if(relevant) break;
      }
      if(!relevant) return;
      clearTimeout(window.__msPageLinkTimer);
      window.__msPageLinkTimer=setTimeout(initPageLinks,200);
    });
    linkMo.observe(document.body,{childList:true,subtree:true});
    const initialPage=pageFromUrl() || localStorage.getItem('ms_last_page_'+panelKeyForStorage()) || currentPageName() || defaultPageForCurrentPanel();
    try{ history.replaceState({msPanel:true,page:initialPage},'',pageUrl(initialPage)); }catch(e){}
    document.addEventListener('click',(e)=>{
      if(e.target.closest('a.ms-page-link-overlay')) return;
      const el=e.target.closest('[data-page]');
      if(!el || window.__msHistoryNav) return;
      const page=el.dataset.page; if(!page) return;
      setTimeout(()=>{ try{ history.pushState({msPanel:true,page},'',pageUrl(page)); }catch(_){ } closeAllSidebars(); },60);
    }, true);
    window.addEventListener('popstate',(e)=>{
      if(e.state && e.state.msPanel){ activatePageFromHistory(e.state.page || 'dashboard'); }
      else { const def=defaultPageForCurrentPanel(); try{ history.pushState({msPanel:true,page:def},'',location.pathname); }catch(_){} activatePageFromHistory(def); }
    });
  }
  function initIdleLogout(){
    if(!TOKEN() || location.pathname.includes('login')) return;
    const maxIdleMs = parseInt(localStorage.getItem('ms_idle_timeout_ms') || String(7*60*1000), 10);
    let timer=null;
    const stamp=()=>sessionStorage.setItem('ms_last_activity', String(Date.now()));
    const expired=()=>Date.now() - parseInt(sessionStorage.getItem('ms_last_activity') || String(Date.now()), 10) > maxIdleMs;
    const doLogout=()=>{ try{alert('Session expired due to inactivity. Please login again.');}catch(e){} API.logout(); };
    const check=()=>{ if(expired()) return doLogout(); clearTimeout(timer); timer=setTimeout(check, Math.min(maxIdleMs, 60000)); };
    const reset=()=>{ stamp(); clearTimeout(timer); timer=setTimeout(check, Math.min(maxIdleMs, 60000)); };
    // PERF: mousemove/scroll fire hundreds of times per second. Un-throttled this ran
    // a sessionStorage write + clearTimeout + setTimeout on EVERY event, the main
    // cause of "mouse interactions are not smooth". Throttle to 1s; idle detection
    // only needs second-level accuracy (the timeout itself is 7 minutes).
    let lastReset=0;
    const resetThrottled=()=>{ const n=Date.now(); if(n-lastReset<1000) return; lastReset=n; reset(); };
    ['click','keydown','touchstart','pointerdown'].forEach(ev=>document.addEventListener(ev, reset, {passive:true}));
    ['mousemove','scroll'].forEach(ev=>document.addEventListener(ev, resetThrottled, {passive:true}));
    ['focus','pageshow','visibilitychange'].forEach(ev=>window.addEventListener(ev, check));
    reset();
  }

  function dbDateToUtcDate(value){
    const s=String(value||'').trim();
    const m=s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})?\:?(\d{2})?(?::(\d{2}))?/);
    if(!m) return null;
    return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0)));
  }
  function ukPartsFromDate(d, withSeconds=true){
    return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:withSeconds?'2-digit':undefined}).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  }
  function ukDateString(value=new Date()){
    const d=value instanceof Date ? value : dbDateToUtcDate(value);
    if(!d) return '';
    const p=ukPartsFromDate(d,false);
    return `${p.year}-${p.month}-${p.day}`;
  }
  function formatLocalFromDb(value){
    const d=dbDateToUtcDate(value);
    if(!d) return '';
    // Display all panel timestamps in UK time (Europe/London), not browser local time.
    const p=ukPartsFromDate(d,true);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  function localizeTimes(root=document){
    const els=[...root.querySelectorAll?.('td,.t2,.ps,.last-sms,.ms-time')||[]];
    els.forEach(el=>{
      if(el.children.length) return;
      const raw=el.dataset.msUtc || el.textContent.trim();
      if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)) return;
      const local=formatLocalFromDb(raw);
      if(local){ el.dataset.msUtc=raw; el.textContent=local; el.title='UK time: '+local+' | Stored UTC: '+raw; }
    });
  }
  function initTimeLocalization(){
    localizeTimes(document);
    const mo=new MutationObserver(muts=>{ clearTimeout(window.__msTzTimer); window.__msTzTimer=setTimeout(()=>muts.forEach(m=>m.addedNodes.forEach(n=>{ if(n.nodeType===1) localizeTimes(n); })),80); });
    mo.observe(document.body,{childList:true,subtree:true});
  }

  function initTopbarControls(){
    ensureThemeCSS();
    if(localStorage.getItem('ms_dark_mode')==='1') document.body.classList.add('ms-dark-mode');
    const themeBtns=[...document.querySelectorAll('[title="Theme"]')];
    themeBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();setDarkMode(!document.body.classList.contains('ms-dark-mode'));});});
    const settingsBtns=[...document.querySelectorAll('[title="Settings"]')];
    settingsBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();openSettings();});});
    document.querySelectorAll('.avatar,.who').forEach(a=>a.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();openProfileMenu();}));
    document.querySelectorAll('[title="Fullscreen"]').forEach(b=>{if(!b.dataset.msFull){b.dataset.msFull='1';b.addEventListener('click',(e)=>{if(!document.fullscreenElement){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();}else{document.exitFullscreen&&document.exitFullscreen();}});}});
    document.querySelectorAll('[title="Logout"]').forEach(b=>{if(!b.dataset.msLogout){b.dataset.msLogout='1';/* GX fix: button ka apna confirm-wala logout() ho to doosra auto-logout handler NAHI lagana (warna Cancel par bhi logout ho jata tha) */const own=b.getAttribute('onclick')&&/logout\s*\(/i.test(b.getAttribute('onclick'));if(!own){b.addEventListener('click',()=>{window.API&&API.logout?API.logout():(clearAuthStorage(),location.href='/panel-login');});}}});
  }
  window.API = {
    guard,
    role: ROLE,
    user: () => STORE('ms_user'),
    name: () => STORE('ms_name'),
    ukDate: ukDateString,
    ukToday: () => ukDateString(new Date()),
    ukTimestamp: formatLocalFromDb,
    get: (p) => cachedGet(p),
    post: async (p, b) => { clearGetCache(); const data=await req('POST', p, b); if(data && data.background && data.job_id) return waitNumberJob(data.job_id, data); return data; },
    put: async (p, b) => { clearGetCache(); return req('PUT', p, b); },
    del: async (p) => { clearGetCache(); return req('DELETE', p); },
    logout: async () => { try{ await req('POST','/logout',{}); }catch(e){} clearAuthStorage(); location.href = '/panel-login'; },
    openSettings,
    openProfileMenu,
    paginateRows,
    waitNumberJob,
    upload,
  };
  function initLengthSelectObserver(){
    enhancePageSizeOptions(document);
    const mo=new MutationObserver(muts=>{ clearTimeout(window.__msLenOptTimer); window.__msLenOptTimer=setTimeout(()=>muts.forEach(m=>m.addedNodes.forEach(n=>{ if(n.nodeType===1){ enhancePageSizeOptions(n); removePdfPrintButtons(n); } })),120); });
    mo.observe(document.body,{childList:true,subtree:true});
  }
  document.addEventListener('DOMContentLoaded', ()=>{ initExportButtons(); initActionFeedback(); initPanelHistory(); initIdleLogout(); initTopbarControls(); initRoutePersistence(); initTimeLocalization(); initLengthSelectObserver(); });

  /* ============ P12: AI ASSISTANT WIDGET (admin/manager/agent; client par status 403 -> render nahi) ============ */
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
      if (document.getElementById('gxAssistantBtn')) return;
      try {
        const st = await req('GET', '/assistant/status');
        if (!st || !st.enabled || !st.can_use) return;
        const css = document.createElement('style');
        css.textContent = '#gxAssistantBtn{position:fixed;right:18px;bottom:18px;z-index:9999;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#6d5efc,#3ec6ff);color:#fff;font-size:22px;box-shadow:0 6px 18px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}#gxAssistantWin{position:fixed;right:18px;bottom:80px;z-index:9999;width:min(92vw,350px);max-height:min(70vh,520px);display:none;flex-direction:column;background:#101733;color:#e8ecff;border:1px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.45);font-family:inherit}#gxAssistantWin.open{display:flex}#gxHead{padding:10px 14px;background:rgba(255,255,255,.06);font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center}#gxHead button{background:none;border:none;color:#9fb0e8;font-size:18px;cursor:pointer}#gxMsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13.5px;line-height:1.45}.gxA{align-self:flex-start;background:rgba(110,94,252,.18);border:1px solid rgba(110,94,252,.35);padding:8px 11px;border-radius:10px 10px 10px 3px;max-width:85%;white-space:pre-wrap;word-wrap:break-word}.gxU{align-self:flex-end;background:linear-gradient(135deg,#6d5efc,#3ec6ff);padding:8px 11px;border-radius:10px 10px 3px 10px;max-width:85%;white-space:pre-wrap;word-wrap:break-word}#gxForm{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.1)}#gxIn{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#e8ecff;padding:8px 10px;font-size:13.5px;outline:none}#gxSend{background:linear-gradient(135deg,#6d5efc,#3ec6ff);border:none;border-radius:8px;color:#fff;padding:8px 14px;cursor:pointer;font-weight:600}@media(max-width:480px){#gxAssistantWin{right:10px;bottom:74px}}';
        document.head.appendChild(css);
        const btn = document.createElement('button');
        btn.id = 'gxAssistantBtn'; btn.type = 'button'; btn.title = 'Galaxy SMS Assistant'; btn.textContent = '\u{1F916}';
        const win = document.createElement('div'); win.id = 'gxAssistantWin';
        win.innerHTML = '<div id="gxHead"><span>Galaxy SMS Assistant</span><button type="button" id="gxClose">\u2715</button></div><div id="gxMsgs"></div><form id="gxForm"><input id="gxIn" autocomplete="off" placeholder="Message likhen..."><button type="submit" id="gxSend">Send</button></form>';
        document.body.appendChild(btn); document.body.appendChild(win);
        const msgs = win.querySelector('#gxMsgs');
        const add = (t, who) => { const d = document.createElement('div'); d.className = who === 'u' ? 'gxU' : 'gxA'; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; };
        btn.onclick = () => { win.classList.toggle('open'); if (win.classList.contains('open') && !msgs.children.length) add('Hello! How can I help you? Main Galaxy SMS assistant hoon \u2014 rates, ranges, ya numbers ke liye poochein.', 'a'); };
        win.querySelector('#gxClose').onclick = () => win.classList.remove('open');
        let busy = false;
        win.querySelector('#gxForm').onsubmit = async (e) => {
          e.preventDefault(); if (busy) return;
          const inp = win.querySelector('#gxIn'); const text = inp.value.trim(); if (!text) return;
          inp.value = ''; add(text, 'u'); busy = true;
          try { const r = await req('POST', '/assistant/message', { text }); add(r.reply || '...', 'a'); }
          catch (err) { add('\u26A0 ' + err.message, 'a'); }
          busy = false; msgs.scrollTop = msgs.scrollHeight;
        };
      } catch (_) { /* client role ya disabled \u2014 koi widget nahi */ }
    }, 400);
  });

})();
