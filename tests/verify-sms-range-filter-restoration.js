/**
 * verify-sms-range-filter-restoration.js
 * Comprehensive end-to-end verification of SMS Range Filter restoration and searchable dropdown behavior
 * across Admin, Manager, Agent, and Client portals without external dependencies.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('VERIFYING SMS RANGE FILTER RESTORATION & SEARCHABLE DROPDOWNS');
console.log('================================================================\n');

// Helper to create a lightweight mock DOM environment
function createMockWindow() {
  const elements = new Map();

  class MockElement {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        has: (c) => classes.has(c)
      };
      this.style = {};
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.value = '';
      this._innerHTML = '';
      this.textContent = '';
      this.eventListeners = new Map();
    }

    getAttribute(name) {
      return this.attributes.get(name) || null;
    }

    setAttribute(name, val) {
      this.attributes.set(name, String(val));
    }

    addEventListener(event, fn) {
      if (!this.eventListeners.has(event)) this.eventListeners.set(event, []);
      this.eventListeners.get(event).push(fn);
    }

    dispatchEvent(ev) {
      const fns = this.eventListeners.get(ev.type) || [];
      fns.forEach(fn => fn(ev));
      return true;
    }

    closest(selector) {
      let cur = this;
      const cleanSel = selector.replace(/^\./, '');
      while (cur) {
        if (cur.classList && cur.classList.has(cleanSel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }

    querySelector(selector) {
      const results = this.querySelectorAll(selector);
      return results.length > 0 ? results[0] : null;
    }

    querySelectorAll(selector) {
      const matches = [];
      function recurse(node) {
        for (const ch of node.children) {
          if (selector.startsWith('.')) {
            const cls = selector.slice(1);
            if (ch.classList && ch.classList.has(cls)) matches.push(ch);
          } else if (selector.startsWith('#')) {
            const id = selector.slice(1);
            if (ch.id === id) matches.push(ch);
          } else if (selector === 'input' || selector === 'input[type="hidden"]') {
            if (ch.tagName === 'INPUT') matches.push(ch);
          }
          recurse(ch);
        }
      }
      recurse(this);
      return matches;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      return child;
    }

    set innerHTML(html) {
      this._innerHTML = html;
      this.children = [];
      
      const self = this;
      function parseNodes(str, parent) {
        const tagRegex = /<([a-z0-9]+)([^>]*)>(.*?)<\/\1>|<([a-z0-9]+)([^>]*)\/?>/gis;
        let match;
        let hasMatches = false;
        while ((match = tagRegex.exec(str)) !== null) {
          hasMatches = true;
          const tag = match[1] || match[4];
          const attrs = match[2] || match[5] || '';
          const inner = match[3] || '';

          const el = new MockElement(tag);
          const idMatch = attrs.match(/id="([^"]+)"/);
          if (idMatch) el.id = idMatch[1];
          const classMatch = attrs.match(/class="([^"]+)"/);
          if (classMatch) classMatch[1].split(/\s+/).forEach(c => el.classList.add(c));
          const valMatch = attrs.match(/value="([^"]*)"/);
          if (valMatch) el.value = valMatch[1];
          const styleMatch = attrs.match(/style="([^"]*)"/);
          if (styleMatch) el.style.cssText = styleMatch[1];
          const dataSearchMatch = attrs.match(/data-search="([^"]*)"/);
          if (dataSearchMatch) el.setAttribute('data-search', dataSearchMatch[1]);
          const dataValMatch = attrs.match(/data-value="([^"]*)"/);
          if (dataValMatch) el.setAttribute('data-value', dataValMatch[1]);

          parent.appendChild(el);
          if (inner && inner.includes('<')) {
            parseNodes(inner, el);
          } else {
            el.textContent = inner.replace(/<[^>]+>/g, '').trim();
          }
        }
      }
      parseNodes(html, this);
    }

    get innerHTML() {
      return this._innerHTML;
    }
  }

  const document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (selector) => {
      const res = [];
      for (const el of elements.values()) {
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          if (el.classList.has(cls)) res.push(el);
        } else if (selector.startsWith('#')) {
          if (el.id === selector.slice(1)) res.push(el);
        }
      }
      return res;
    },
    createElement: (tag) => new MockElement(tag),
    addEventListener: () => {}
  };

  function registerElement(tag, id, classes = []) {
    const el = new MockElement(tag, id);
    classes.forEach(c => el.classList.add(c));
    elements.set(id, el);
    return el;
  }

  return { MockElement, document, elements, registerElement };
}

// 1. ADMIN PORTAL VERIFICATION
console.log('--- 1. Admin Portal (admin.html) ---');
const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

assert(adminHtml.includes('id="numRangeContainer"'), 'numRangeContainer exists in admin.html');
assert(adminHtml.includes('id="numClientContainer"'), 'numClientContainer exists in admin.html');
assert(adminHtml.includes('id="deleteRangeContainer"'), 'deleteRangeContainer exists in admin.html');
assert(adminHtml.includes('id="deleteRangeSelect"'), 'deleteRangeSelect fallback exists in admin.html');
assert(adminHtml.includes('id="adminRangeDeleteTools"'), 'adminRangeDeleteTools container preserved');
assert(adminHtml.includes('deleteNumbersByRange()'), 'deleteNumbersByRange action preserved');
assert(adminHtml.includes('rebuildDashboardStats()'), 'rebuildDashboardStats action preserved');
assert(adminHtml.includes('function renderAdminNumbersRangeFilter'), 'renderAdminNumbersRangeFilter defined in admin.html');
assert(adminHtml.includes('function renderAdminNumbersDeleteRangeFilter'), 'renderAdminNumbersDeleteRangeFilter defined in admin.html');
assert(adminHtml.includes('function refreshAdminNumbersFilters'), 'refreshAdminNumbersFilters defined in admin.html');

// 2. MANAGER PORTAL VERIFICATION
console.log('\n--- 2. Manager Portal (manager.html) ---');
const mgrHtml = fs.readFileSync(path.join(__dirname, '../manager.html'), 'utf8');

assert(mgrHtml.includes('id="numRangeContainer"'), 'numRangeContainer exists in manager.html');
assert(mgrHtml.includes('id="numAgentContainer"'), 'numAgentContainer exists in manager.html');
assert(mgrHtml.includes('baRangeDropdownContainer'), 'baRangeDropdownContainer (Bulk Allocation range selector) distinct');
assert(mgrHtml.includes('function refreshManagerNumbersFilters'), 'refreshManagerNumbersFilters defined in manager.html');
assert(mgrHtml.includes('loadRateCard(), loadAgents()]).then(refreshManagerNumbersFilters)'), 'loadManagerPageData auto-refreshes numbers filters');

// 3. AGENT PORTAL VERIFICATION
console.log('\n--- 3. Agent Portal (agent.html) ---');
const agtHtml = fs.readFileSync(path.join(__dirname, '../agent.html'), 'utf8');

assert(agtHtml.includes('id="numRangeContainer"'), 'numRangeContainer exists in agent.html');
assert(agtHtml.includes('id="numClientContainer"'), 'numClientContainer exists in agent.html');
assert(agtHtml.includes('baRangeDropdownContainer'), 'baRangeDropdownContainer (Bulk Allocation range selector) distinct');
assert(agtHtml.includes('function refreshAgentNumbersFilters'), 'refreshAgentNumbersFilters defined in agent.html');
assert(agtHtml.includes('loadRateCard(), loadClients()]).then(refreshAgentNumbersFilters)'), 'loadAgentPageData auto-refreshes numbers filters');

// 4. CLIENT PORTAL VERIFICATION
console.log('\n--- 4. Client Portal (client.html) ---');
const cliHtml = fs.readFileSync(path.join(__dirname, '../client.html'), 'utf8');

assert(cliHtml.includes('id="numRangeContainer"'), 'numRangeContainer exists in client.html');
assert(cliHtml.includes('id="stRangeContainer"'), 'stRangeContainer in stats page distinct');
assert(cliHtml.includes('id="testRangeContainer"'), 'testRangeContainer in test page distinct');
assert(cliHtml.includes("if(page==='numbers'){ loadRanges(); return loadNumbers(); }"), 'loadClientPageData calls loadRanges for numbers page');

// 5. RUNTIME BEHAVIOR OF renderSearchSelect & setSearchDropdownValue
console.log('\n--- 5. Runtime Searchable Dropdown Engine (galaxy.js) ---');
const galaxyJs = fs.readFileSync(path.join(__dirname, '../assets/galaxy.js'), 'utf8');
const { document, registerElement, elements } = createMockWindow();

// Prepare containers in mock DOM
registerElement('div', 'numRangeContainer');
registerElement('div', 'numClientContainer');
registerElement('div', 'deleteRangeContainer');

const sandbox = {
  window: {},
  document: document,
  Event: class { constructor(type, opts) { this.type = type; this.bubbles = !!opts?.bubbles; } },
  console: console
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(galaxyJs, sandbox);

assert(typeof sandbox.window.renderSearchSelect === 'function', 'renderSearchSelect exists on window');
assert(typeof sandbox.window.setSearchDropdownValue === 'function', 'setSearchDropdownValue exists on window');
assert(typeof sandbox.window.toggleSearchDropdown === 'function', 'toggleSearchDropdown exists on window');
assert(typeof sandbox.window.filterSearchDropdown === 'function', 'filterSearchDropdown exists on window');

// Test rendering searchable dropdown for numRange
sandbox.window.renderSearchSelect('numRangeContainer', {
  id: 'numRange',
  placeholder: 'Select Range',
  searchPlaceholder: 'Search range...',
  items: [
    { value: 'UK_Vodafone_01', label: 'UK_Vodafone_01' },
    { value: 'US_AT&T_02', label: 'US_AT&T_02' },
    { value: 'DE_Telekom_03', label: 'DE_Telekom_03' }
  ],
  value: ''
});

const renderedHiddenInput = document.getElementById('numRange');
assert(renderedHiddenInput !== null, 'Hidden input with id "numRange" created');
assert(renderedHiddenInput.value === '', 'Initial value of numRange is empty string');

const wrapEl = document.getElementById('dd_wrap_numRange');
assert(wrapEl !== null, 'Dropdown wrapper "dd_wrap_numRange" created');
assert(wrapEl.classList.has('searchable-dropdown'), 'Wrapper has "searchable-dropdown" class');

// Test selecting a value
let changeFired = false;
renderedHiddenInput.addEventListener('change', () => { changeFired = true; });

sandbox.window.setSearchDropdownValue('numRange', 'UK_Vodafone_01', 'UK_Vodafone_01');
assert(renderedHiddenInput.value === 'UK_Vodafone_01', 'setSearchDropdownValue set value to UK_Vodafone_01');
assert(changeFired === true, 'Change event dispatched on input');

// Test resetting value
sandbox.window.setSearchDropdownValue('numRange', '', 'Select Range');
assert(renderedHiddenInput.value === '', 'setSearchDropdownValue reset value to empty string');

// 6. VERIFY NO INADVERTENT DELETIONS / OVERLAPS ACROSS WORKFLOWS
console.log('\n--- 6. Separation of Workflows Verification ---');
// Verify Range Filter vs Range Allocation vs Range Deletion
assert(adminHtml.includes('id="numRange"') && adminHtml.includes('allocRangeDropdownContainer') && adminHtml.includes('id="deleteRangeSelect"'), 'Admin maintains distinct IDs: numRange (filter), allocRangeDropdownContainer (alloc), deleteRangeSelect (delete)');
assert(mgrHtml.includes('id="numRange"') && mgrHtml.includes('baRangeDropdownContainer'), 'Manager maintains distinct IDs: numRange (filter) and baRange (bulk alloc)');
assert(agtHtml.includes('id="numRange"') && agtHtml.includes('baRangeDropdownContainer'), 'Agent maintains distinct IDs: numRange (filter) and baRange (bulk alloc)');
assert(cliHtml.includes('id="numRange"') && cliHtml.includes('id="stRangeContainer"') && cliHtml.includes('id="testRangeContainer"'), 'Client maintains distinct IDs: numRange (numbers filter), stRange (stats filter), testRange (test filter)');

console.log('\n================================================================');
console.log(`ALL TESTS COMPLETE: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
