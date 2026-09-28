'use strict';
// Presentation contract checks. No server, database, credentials or network.
// Run: node tests/ui-theme.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
let total = 0;
function test(name, fn) { fn(); total++; console.log('PASS',name); }
for (const role of ['admin','manager','agent','client','management','panel-sharing','payment','test']) {
  test(role+' common non-login light theme',()=>{
    const s=read(role+'.html');
    assert.match(s, /<body class="gx-light gx-lamix">/);
    assert.equal((s.match(/href="\/assets\/lamix-light\.css/g)||[]).length,1);
    assert.match(s,/assets\/galaxy-logo\.png/);
    assert.doesNotMatch(s, /data-page=["']bonus["']|href=["'][^"']*\/bonus["']/i);
  });
}
for (const name of ['login','management-login','panel-sharing-login','payment-login','test-login']) {
  test(name+' stays outside new theme and dashboard runtime',()=>{
    const s=read(name+'.html');assert.doesNotMatch(s,/lamix-light|dashboard-ui|gx-lamix/);
    assert.match(s,/\/api\/login/);
  });
}
for(const role of ['admin','manager','agent','client']) {
  test(role+' uses the existing dashboard response and reporting hooks',()=>{
    const s=read(role+'.html');
    assert.match(s,/const d=await API.get\('\/dashboard'\)/);
    assert.equal((s.match(new RegExp("GXDashboard.render\\(d, '"+role+"'\\)",'g'))||[]).length,1);
    assert.ok(s.includes("GXDashboard.refreshExtras('"+role+"')"));
    assert.match(s,/GXDashboard.error\(\)/);
    assert.match(s,/window.GX&&GX.map\('#gxMap'/);
  });
}
const js=read('assets/dashboard-ui.js');
test('Dashboard module parses, exposes presentation-only entry points',()=>{
  const context={window:{}};vm.runInNewContext(js,context);
  assert.equal(typeof context.window.GXDashboard.render,'function');
  assert.equal(typeof context.window.GXDashboard.refreshExtras,'function');
  assert.equal(typeof context.window.GXDashboard.error,'function');
  assert.ok(Object.isFrozen(context.window.GXDashboard));
});
test('No write APIs, storage, timers, new security or bonus behavior',()=>{
  assert.doesNotMatch(js,/API\.(post|put|del|upload)\(|localStorage|sessionStorage|setInterval\(|fetch\(/);
  assert.doesNotMatch(js,/\/bonus|\/notifications|\/agent\/self-allocate/);
  assert.match(js,/API.get\('\/stats-summary\//);
  assert.match(js,/API.get\('\/number-import-batches'\)/);
});
test('Client shortcuts never fabricate restricted destinations',()=>{
  assert.match(js,/Not available for Client/);
  assert.doesNotMatch(js,/\/client\/(selfAllocate|clients|creditNotes)/);
  assert.match(js,/role === 'client' \? \['range'\] : \['client','range'\]/);
});
test('Finance reuses existing formatter; unavailable earning is explicit',()=>{
  assert.match(js,/window.pay3\(value\)/);
  for(const label of ['Daily Real Earning','This Week Real Earning','This Month Real Earning'])assert.ok(js.includes(label));
  assert.match(js,/<strong>Unavailable<\/strong>/);
  assert.match(js,/no new earning formula has been applied/i);
  assert.doesNotMatch(js,/provider_cost_today\s*-|payout_month\s*-/);
});
test('Seven-day backend rows, accessible chart and five summary fields',()=>{
  assert.match(js,/Array.isArray\(data.daily7\)/);
  assert.match(js,/View daily counts/);
  for(const field of ['sms_yesterday','payout_week','payout_month','numbers','clients'])assert.ok(js.includes('data.'+field));
  assert.match(js,/esc\(r.key\)/);assert.match(js,/esc\(r.range_name\)/);
});
test('Responsive rules remain scoped and provide focus/overflow treatment',()=>{
  const css=read('assets/lamix-light.css');
  assert.match(css,/body.gx-light.gx-lamix/);assert.match(css,/:focus-visible/);
  assert.match(css,/overflow-x:auto/);assert.match(css,/@media\(max-width:600px\)/);
  assert.doesNotMatch(css,/gx-login|gx-portal-login/);
});
console.log(total+' UI presentation contract checks passed.');
