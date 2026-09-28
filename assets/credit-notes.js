/* Live read-only Credit Notes view. No payment, allocation or ledger writes. */
(function(){
'use strict';
function init(){
 const root=document.getElementById('page-creditNotes');if(!root)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 root.innerHTML=`<div class="page-head"><div><h2>Credit Notes</h2><div class="breadcrumb">Finance › Live Settlement Statement</div></div></div>
 <div class="gx-statement-notice"><b>Read-only live statement</b> · These records describe existing ledger earnings. They are not issued documents and do not add credit or change payment eligibility.<br>Currency is not recorded on the historical ledger. Amounts below are ledger units; weekly terms are shown exactly as stored.</div>
 <form class="toolbar gx-statement-filters" id="cnFilters">
 <label>Cycle from<input id="cnFrom" type="date"></label><label>Cycle to<input id="cnTo" type="date"></label>
 <label>Payment type<select id="cnType"><option value="">All types</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly_30x45">Monthly (30x45)</option></select></label>
 <label>Maturity<select id="cnMaturity"><option value="">All</option><option value="matured">Matured</option><option value="upcoming">Upcoming</option><option value="unknown">Not recorded</option></select></label>
 <button class="btn btn-blue" type="submit">Show Report</button><button class="btn btn-ghost" type="reset">Reset</button></form>
 <div class="table-wrap"><div class="card-head"><h3>CREDIT NOTES · LIVE SETTLEMENTS</h3></div>
 <div class="table-controls"><div class="tc-left"><button class="btn btn-ghost" id="cnCsv" type="button" disabled>CSV · current page</button></div><div class="tc-right"><label for="cnSize">Show records</label> <select id="cnSize"><option>25</option><option>50</option><option>100</option></select></div></div>
 <div id="cnStatus" class="gx-statement-status" role="status" aria-live="polite"></div>
 <div class="tscroll"><table class="gx-statement-table"><thead><tr><th>Cycle start</th><th>Agent</th><th>Term</th><th>Currency</th><th>Ledger amount</th><th>CDRs</th><th>Eligible at (UTC)</th><th>Maturity</th><th>Open</th><th>Requested</th><th>Paid</th><th>Other</th><th>Request IDs</th></tr></thead><tbody id="cnBody"></tbody></table></div>
 <div class="table-foot"><span id="cnCount">No report loaded</span><div class="pagination"><button id="cnPrev" type="button" disabled>Previous</button><button id="cnNext" type="button" disabled>Next</button></div></div></div>
 <p class="hint" style="margin-top:12px">Matured does not mean paid or automatically withdrawable. Existing minimums, payment-request rules and Security PIN protection remain in effect. Date filters use stored cycle-start dates. CSV exports only the displayed page.</p>`;
 const el=id=>document.getElementById(id);let page=1,totalPages=1,rows=[],serial=0;
 async function load(){
  const own=++serial;rows=[];el('cnCsv').disabled=true;el('cnPrev').disabled=true;el('cnNext').disabled=true;el('cnBody').innerHTML='';el('cnStatus').textContent='Loading ledger statement…';
  const q=new URLSearchParams({page:String(page),limit:el('cnSize').value});
  for(const [k,id] of [['from','cnFrom'],['to','cnTo'],['payment_type','cnType'],['maturity','cnMaturity']])if(el(id).value)q.set(k,el(id).value);
  try{
   const data=await API.get('/payment-v2/credit-notes?'+q);if(own!==serial)return;
   rows=data.rows||[];page=data.page;totalPages=data.totalPages;
   el('cnBody').innerHTML=rows.map(r=>`<tr><td>${esc(r.cycle_key||'Not recorded')}</td><td>${esc(r.agent_name)}</td><td>${esc({daily:'Daily',weekly:'Weekly',monthly_30x45:'Monthly (30x45)'}[r.payment_type]||r.payment_type)}</td><td>Not recorded</td><td class="amount">${esc(r.total_amount)}</td><td>${r.cdr_count}</td><td>${esc(r.eligible_at||'Not recorded')}</td><td><span class="tag ${r.maturity==='matured'?'tag-green':r.maturity==='upcoming'?'tag-amber':'tag-gray'}">${esc(r.maturity)}</span></td><td class="amount">${esc(r.open_amount)}</td><td class="amount">${esc(r.requested_amount)}</td><td class="amount">${esc(r.paid_amount)}</td><td class="amount">${esc(r.other_amount)}</td><td>${r.request_ids.map(esc).join(', ')||'—'}</td></tr>`).join('')||'<tr><td colspan="13" style="text-align:center;padding:30px">No ledger settlements match these filters.</td></tr>';
   el('cnStatus').textContent='Live ledger data · generated '+data.generated_at.replace('T',' ').replace('Z',' UTC');
   el('cnCount').textContent=`${data.total} settlement group(s) · Page ${page} of ${totalPages}`;
   el('cnPrev').disabled=page<=1;el('cnNext').disabled=page>=totalPages;el('cnCsv').disabled=!rows.length;
  }catch(e){if(own!==serial)return;el('cnCount').textContent='Report unavailable';el('cnStatus').textContent=e.message||'Unable to load statement';
   if(/PIN|unlock|locked/i.test(e.message||'')){
    const a=document.createElement('a');a.href='/agent/payment';a.textContent=' Open Payment Section to verify your existing Security PIN.';el('cnStatus').appendChild(a);
   }
  }
 }
 el('cnFilters').onsubmit=e=>{e.preventDefault();page=1;load()};el('cnFilters').onreset=()=>setTimeout(()=>{page=1;load()},0);
 el('cnSize').onchange=()=>{page=1;load()};el('cnPrev').onclick=()=>{if(page>1){page--;load()}};el('cnNext').onclick=()=>{if(page<totalPages){page++;load()}};
 el('cnCsv').onclick=()=>{
  const cells=['cycle_key','agent_name','payment_type','currency','total_amount','cdr_count','eligible_at','maturity','open_amount','requested_amount','paid_amount','other_amount','request_ids'];
  const cell=v=>'"'+String(v??'Not recorded').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const text=[cells.map(cell).join(','),...rows.map(r=>cells.map(k=>cell(Array.isArray(r[k])?r[k].join(';'):r[k])).join(','))].join('\r\n');
  const u=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download='galaxy-live-settlement-page-'+page+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
 };
 let active=false;const changed=()=>{const next=root.classList.contains('active');if(next&&!active)load();active=next;};
 new MutationObserver(changed).observe(root,{attributes:true,attributeFilter:['class']});changed();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
