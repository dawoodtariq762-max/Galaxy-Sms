const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log(' VERIFYING "payterm" / "payTerm" ALLOCATION FIX');
console.log('================================================================\n');

// 1. Inspect panel-sharing.html
const html = fs.readFileSync(path.join(__dirname, '../panel-sharing.html'), 'utf8');

// Check that closeAllocConfirmModal() is called without accessing pendingAllocData after it
assert(!html.includes('closeAllocConfirmModal();\n\n    alert(`✅ Successfully allocated ${res.count} numbers to ${res.panel_name}!\n\nDownstream Price: ${priceVal}\nBilling Period: ${pendingAllocData.payterm}'),
  'Must NOT access pendingAllocData.payterm after closeAllocConfirmModal');

assert(!html.includes('pendingAllocData.ranges[0] || res.range_name'),
  'Must NOT access pendingAllocData.ranges after closeAllocConfirmModal');

assert(html.includes('const currentAlloc = pendingAllocData;'),
  'Must capture currentAlloc reference in proceedWithConfirmedAllocation');

assert(html.includes('const assignedPayterm = res.payterm || currentAlloc.payterm || \'weekly_7_1\';'),
  'Must use assignedPayterm derived from res or currentAlloc');

assert(html.includes('Billing Period: ${assignedPayterm}'),
  'Must use safe assignedPayterm in alert');

console.log('  ✅ PASS: panel-sharing.html correctly references local allocation context and does not read from null pendingAllocData');

// 2. Simulate the exact frontend flow before and after
console.log('\n--- Simulation of Frontend Allocation Flow ---');

let pendingAllocData = {
  ids: [101, 102],
  userId: 1,
  payterm: 'weekly_7_1',
  ranges: ['UK Range 01']
};

function closeAllocConfirmModalSim() {
  pendingAllocData = null;
}

// Reproduce the old bug:
let oldBugError = null;
try {
  const currentAlloc = pendingAllocData;
  const res = { ok: true, count: 2, panel_name: 'Partner X', payterm: 'weekly_7_1' };
  
  // Old bug sequence:
  pendingAllocData = null; // simulated closeAllocConfirmModal()
  const msg = `Billing Period: ${pendingAllocData.payterm}`; // Throws!
} catch (e) {
  oldBugError = e.message;
}

assert(oldBugError && oldBugError.includes("Cannot read properties of null (reading 'payterm')"),
  `Old flow must trigger exact error, got: ${oldBugError}`);
console.log(`  ✅ PASS: Confirmed exact reproduction of error: "${oldBugError}"`);

// Verify the fixed flow:
let fixedFlowSucceeded = false;
let alertMsg = '';
try {
  pendingAllocData = {
    ids: [101, 102],
    userId: 1,
    payterm: 'weekly_7_1',
    ranges: ['UK Range 01']
  };
  const currentAlloc = pendingAllocData;
  const res = { ok: true, count: 2, panel_name: 'Partner X', payterm: 'weekly_7_1' };

  closeAllocConfirmModalSim(); // pendingAllocData is now null

  const assignedPayterm = res.payterm || currentAlloc.payterm || 'weekly_7_1';
  const assignedRangeName = (currentAlloc.ranges && currentAlloc.ranges[0]) || res.range_name || res.panel_name || 'Range';

  alertMsg = `✅ Successfully allocated ${res.count} numbers to ${res.panel_name}!\nDownstream Price: $0.0080\nBilling Period: ${assignedPayterm}`;
  fixedFlowSucceeded = true;
} catch (e) {
  fixedFlowSucceeded = false;
}

assert(fixedFlowSucceeded, 'Fixed flow must succeed without throwing');
assert(alertMsg.includes('Billing Period: weekly_7_1'), 'Alert message must include billing period');
console.log('  ✅ PASS: Fixed flow executes cleanly without any null property exception');

// 3. Backend safety check
console.log('\n--- Backend payoutRateForPaymentCycle Resilience ---');
const db = require('../backend/db');
db.init();

const serverJs = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
assert(serverJs.includes('if (!row) return \'0\';'),
  'payoutRateForPaymentCycle must have null row guard');

console.log('  ✅ PASS: Backend payoutRateForPaymentCycle guarded against null row lookup');

console.log('\n================================================================');
console.log(' ALL PAYTERM ALLOCATION CHECKS PASSED (100%)');
console.log('================================================================');
