/* Galaxy / Lamix-inspired presentation. No writes, storage, auth changes or financial calculations.
 * Core input is the existing role-scoped /api/dashboard response, supplied by each
 * existing loadDashboard handler AFTER its original updates. Financial values
 * retain their backend meaning; provider cost is never relabelled as earning. */
(function () {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons = {
    volume: '<path d="M4 20V12h3v8M10 20V7h3v13M16 20V3h3v17"/>',
    numbers: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    clients: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>',
    report: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 16v-3M12 16v-6M16 16v-4"/>',
    ranges: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
    credit: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2zM8 7h8M8 11h8M8 15h5"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 6v12"/>'
  };
  const svg = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[key] || icons.volume) + '</svg>';
  const count = value => value == null ? '—' : Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
  // Presentation only: do not subtract costs, infer currency, or calculate earnings.
  const money = value => value == null ? '—' : '$ ' + (typeof window.pay3 === 'function' ? window.pay3(value) : String(value));
  function node(tag, className, html) {
    const n = document.createElement(tag); n.className = className;
    if (html) n.innerHTML = html;
    return n;
  }
  function shortcuts(root, role) {
    const nav = root.querySelector('.gx-shortcuts');
    if (!nav || nav.dataset.lmReady) return;
    nav.dataset.lmReady = 'true';
    // Existing destinations only. Preserve additional role-specific shortcuts.
    if (role === 'manager') {
      const agents = nav.querySelector('a[href="/manager/agents"]');
      if (agents) {
        const extra = node('div', 'lm-related'); extra.append(agents); nav.after(extra);
      }
      const a = node('a', 'gx-shortcut', svg('credit') + '<span>Credit Notes</span>');
      a.href = '/manager/creditNotes'; nav.append(a);
    }
    if (role === 'client') {
      const test = nav.querySelector('a[href="/client/test"]');
      if (test) { const extra = node('div', 'lm-related'); extra.append(test); nav.after(extra); }
      const allowed = [...nav.children]; nav.replaceChildren();
      for (const label of ['Self Allocate', 'My Numbers', 'My Clients', 'Detailed Reports', 'Credit Notes']) {
        const a = allowed.find(el => el.textContent.trim() === label);
        if (a) nav.append(a);
        else {
          const unavailable = node('div', 'gx-shortcut lm-unavailable', svg(label === 'My Clients' ? 'clients' : label === 'Credit Notes' ? 'credit' : 'ranges') + '<span>' + label + '</span><small>Not available for Client</small>');
          unavailable.setAttribute('aria-disabled', 'true');
          unavailable.title = 'This function is not available under existing Client permissions.';
          nav.append(unavailable);
        }
      }
    }
    root.querySelectorAll('.gx-shortcut[href]').forEach(a => {
      const route = a.getAttribute('href');
      const key = /numbers$/.test(route) ? 'numbers' : /clients$|agents$|managers$/.test(route) ? 'clients' : /smsDetail$|stats$/.test(route) ? 'report' : /creditNotes$/.test(route) ? 'credit' : 'ranges';
      const old = a.querySelector('svg'); if (old) old.outerHTML = svg(key);
    });
  }
  function mount(root, role) {
    if (root.dataset.lmReady) return;
    root.dataset.lmReady = 'true'; root.classList.add('lm-dashboard');
    shortcuts(root, role);
    const status = node('div', 'lm-dashboard-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const anchor = root.querySelector('.lm-related') || root.querySelector('.gx-shortcuts') || root.querySelector('.page-head'); if (anchor) anchor.after(status); else root.prepend(status);
    const chart = root.querySelector('#wk, #weekChart');
    const card = chart && chart.closest('.card');
    const lower = root.querySelector('.dash-row');
    if (card && lower) {
      const primary = node('div', 'lm-volume-row');
      const summary = node('aside', 'lm-summaries');
      summary.setAttribute('aria-label', 'Dashboard summary');
      lower.before(primary); primary.append(card, summary);
      card.classList.add('lm-volume-card');
      const title = card.querySelector('h3'); if (title) title.textContent = 'Volume · Last 7 Days';
      const sub = card.querySelector('.sub'); if (sub) sub.textContent = 'Received SMS · Europe/London reporting days';
      lower.classList.add('lm-secondary-row');
      const pay = root.querySelector('#gxPayRow');
      const costs = root.querySelector('#gxProvCostRow');
      if (pay) primary.after(pay);
      if (costs) (pay || primary).after(costs);
    }
    if (role === 'admin') {
      const earning = node('section', 'lm-earning-state');
      earning.setAttribute('aria-label', 'Real earning availability');
      earning.innerHTML = '<div class="lm-earning-cards">' + ['Daily Real Earning','This Week Real Earning','This Month Real Earning'].map(label => '<div class="lm-earning-card"><span>' + label + '</span><strong>Unavailable</strong><small>No earning value supplied by the existing API</small></div>').join('') + '</div><p>Provider cost and payout are shown separately below. The current API does not supply net earning; no new earning formula has been applied.</p>';
      const grid = root.querySelector('#gxDashCards'); if (grid) grid.after(earning);
    }
  }
  function drawVolume(container, data) {
    const rows = Array.isArray(data.daily7) ? data.daily7 : [];
    if (!rows.length) { container.innerHTML = '<p class="lm-chart-empty">No volume data available.</p>'; return; }
    const valid = rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) && Number.isFinite(Number(r.count)) && Number(r.count) >= 0);
    if (!valid) { container.innerHTML = '<p class="lm-chart-empty">Volume data could not be displayed.</p>'; return; }
    const w = 720, h = 280, left = 54, right = 20, top = 18, bottom = 38;
    const max = Math.max(4, Math.ceil(Math.max(...rows.map(r => Number(r.count))) / 4) * 4);
    const x = i => left + i * (w-left-right) / Math.max(1,rows.length-1);
    const y = n => h-bottom - Number(n)*(h-top-bottom)/max;
    const points = rows.map((r,i) => x(i)+','+y(r.count)).join(' ');
    let grid = '';
    for(let i=0;i<5;i++) { const value = max*i/4, yy=y(value); grid += '<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#ddd"/><text x="'+(left-10)+'" y="'+(yy+4)+'" text-anchor="end">'+esc(Number(value.toFixed(2)).toLocaleString())+'</text>'; }
    const dots = rows.map((r,i) => '<g><line x1="'+x(i)+'" x2="'+x(i)+'" y1="'+top+'" y2="'+(h-bottom)+'" stroke="#eee"/><circle cx="'+x(i)+'" cy="'+y(r.count)+'" r="4" fill="#348eae" tabindex="0" role="img" aria-label="'+esc(r.date+': '+count(r.count)+' SMS')+'"><title>'+esc(r.date+' · '+count(r.count)+' SMS')+'</title></circle><text x="'+x(i)+'" y="'+(h-12)+'" text-anchor="middle">'+esc(r.date.slice(5))+'</text></g>').join('');
    container.innerHTML = '<div class="lm-volume-total"><strong>'+esc(count(data.sms_7d))+'</strong> SMS · rolling 7 days</div><svg class="lm-volume-svg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="SMS volume for the last seven reporting days"><title>Received SMS volume; daily values listed below</title>'+grid+'<polygon points="'+left+','+(h-bottom)+' '+points+' '+x(rows.length-1)+','+(h-bottom)+'" fill="#348eae" fill-opacity=".12"/><polyline points="'+points+'" fill="none" stroke="#348eae" stroke-width="2.5"/>'+dots+'</svg><details class="lm-chart-values"><summary>View daily counts</summary><table><thead><tr><th>Date (UK)</th><th>SMS</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.date)+'</td><td>'+esc(count(r.count))+'</td></tr>').join('')+'</tbody></table></details>';
  }
  function render(data, role) {
    const root = document.getElementById('page-dashboard');
    if (!root || !['admin','manager','agent','client'].includes(role)) return;
    mount(root, role);
    const status = root.querySelector('.lm-dashboard-status');
    status.classList.remove('is-error');
    status.textContent = '● Live dashboard · UK reporting time  |  '+count(data.numbers)+' numbers'+(role !== 'client' ? ' · '+count(data.clients)+' clients' : '');
    const summaries = [
      ['volume','SMS yesterday',count(data.sms_yesterday),'Previous reporting day','sms_yesterday'],
      ['money','Payout this week',money(data.payout_week),'Monday-start UK week','payout_week'],
      ['money','Monthly payout',money(data.payout_month),'Month to date','payout_month'],
      ['numbers','My numbers',count(data.numbers),role === 'admin' ? 'Total inventory' : 'Within your existing scope','numbers'],
      role === 'client' ? ['volume','SMS this month',count(data.sms_month),'Month to date','sms_month'] : ['clients','My clients',count(data.clients),role === 'agent' ? 'Your clients' : 'Within your hierarchy','clients']
    ];
    const summary = root.querySelector('.lm-summaries');
    if (summary) summary.innerHTML = summaries.map(([icon,label,value,note,key])=>'<div class="lm-summary" data-source="'+key+'"><span class="lm-summary-icon">'+svg(icon)+'</span><div><strong>'+esc(value)+'</strong><span>'+label+'</span><small>'+note+'</small></div></div>').join('');
    const chart = root.querySelector('#wk, #weekChart'); if (chart) drawVolume(chart, data);
    root.querySelectorAll('.dash-metric .dash-go').forEach((el,i)=> { el.innerHTML = svg(/payout/i.test(el.closest('.dash-metric').querySelector('.stat-info p')?.textContent || '') ? 'money' : 'volume'); });
  }
  // Additional approved dashboard views reuse existing scoped GET endpoints.
  // The 30-day date window is a UI filter, not a new aggregation/calculation.
  function refreshExtras(role) {
    const root = document.getElementById('page-dashboard');
    if (!root || !window.API || !['admin','manager','agent','client'].includes(role)) return;
    let group = root.querySelector('.lm-rankings');
    if (!group) { group = node('div', 'lm-rankings'); root.querySelector('.lm-secondary-row').before(group); }
    const to = API.ukToday();
    const start = new Date(to+'T00:00:00Z'); start.setUTCDate(start.getUTCDate()-29);
    const from = start.toISOString().slice(0,10);
    const dimensions = role === 'client' ? ['range'] : ['client','range'];
    for (const dim of dimensions) {
      let card = group.querySelector('[data-dimension="'+dim+'"]');
      if (!card) {
        card = node('section', 'card lm-ranking'); card.dataset.dimension = dim;
        const report = role === 'client' ? 'stats' : dim === 'client' ? 'clientStats' : 'rangeStats';
        card.innerHTML = '<div class="card-head"><div><h3>Top '+(dim==='client'?'Clients':'Ranges')+' · 30 Days</h3><div class="sub">Top five by SMS · payout, not net earning</div></div><a class="lm-report-link" href="/'+role+'/'+report+'">View report →</a></div><div class="tscroll"><table><thead><tr><th>'+(dim==='client'?'Client':'Range')+'</th><th>SMS</th><th>Payout</th></tr></thead><tbody><tr><td colspan="3">Loading…</td></tr></tbody></table></div>';
        group.append(card);
      }
      card.querySelector('.sub').textContent = from+' – '+to+' · UK · top five by SMS';
      API.get('/stats-summary/'+dim+'?'+new URLSearchParams({from,to,sort:'sms',dir:'desc'})).then(result=>{
        const rows = Array.isArray(result.rows) ? result.rows.slice(0,5) : [];
        card.querySelector('tbody').innerHTML = rows.map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+esc(count(r.sms))+'</td><td title="'+esc(r.payment)+'">'+esc(money(r.payment))+'</td></tr>').join('') || '<tr><td colspan="3" class="lm-empty">No SMS in this reporting period.</td></tr>';
      }).catch(()=>{card.querySelector('tbody').innerHTML='<tr><td colspan="3" class="lm-empty">Could not load this summary. Use View report to retry.</td></tr>';});
    }
    if (role === 'admin') {
      let card = root.querySelector('.lm-batches');
      if (!card) {
        card = node('section','card lm-batches');
        card.innerHTML='<div class="card-head"><div><h3>Recent Import Batches</h3><div class="sub">Latest five · existing import history</div></div><a class="lm-report-link" href="/management/import">Manage imports →</a></div><div class="tscroll"><table><thead><tr><th>Batch</th><th>Range</th><th>Inserted</th><th>Skipped</th><th>Status</th></tr></thead><tbody><tr><td colspan="5">Loading…</td></tr></tbody></table></div>';
        root.querySelector('.lm-secondary-row').append(card);
      }
      API.get('/number-import-batches').then(rows=>{
        card.querySelector('tbody').innerHTML=(Array.isArray(rows)?rows.slice(0,5):[]).map(r=>'<tr><td>'+esc(r.batch_id)+'</td><td>'+esc(r.range_name)+'</td><td>'+esc(count(r.inserted))+'</td><td>'+esc(count(r.skipped))+'</td><td>'+esc(r.status)+'</td></tr>').join('') || '<tr><td colspan="5" class="lm-empty">No import batches found.</td></tr>';
      }).catch(()=>{card.querySelector('tbody').innerHTML='<tr><td colspan="5" class="lm-empty">Import history could not be loaded.</td></tr>';});
    }
  }
  function error() {
    const root = document.getElementById('page-dashboard'); if (!root) return;
    let status = root.querySelector('.lm-dashboard-status');
    if (!status) { status = node('div','lm-dashboard-status'); root.prepend(status); }
    if (!root.dataset.lmReady) root.querySelectorAll('.stat-info h3').forEach(el => { el.textContent = '—'; });
    status.classList.add('is-error'); status.setAttribute('role','alert');
    status.textContent = 'Dashboard data could not be refreshed. Previously displayed values may be out of date. Reload to retry.';
  }
  window.GXDashboard = Object.freeze({render, refreshExtras, error});
})();
