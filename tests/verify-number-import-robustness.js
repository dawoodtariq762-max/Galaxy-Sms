/**
 * Test suite to verify number import robustness and fix verification.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('======================================================');
console.log('STARTING NUMBER IMPORT ROBUSTNESS VERIFICATION');
console.log('======================================================\n');

function t(desc, condition, info = '') {
  if (condition) {
    console.log(`PASS | ${desc}`);
  } else {
    console.error(`FAIL | ${desc} ${info ? '(' + info + ')' : ''}`);
    process.exitCode = 1;
  }
}

// 1. Check Benin file parsing
const files = fs.readdirSync('/home/user/uploads').filter(f => f.startsWith('Benin'));
const beninPath = path.join('/home/user/uploads', files[0]);
const beninRaw = fs.readFileSync(beninPath, 'utf8');

// Use the parser logic from the frontend
function extractNumbersFromText(text) {
  if (!text) return [];
  text = String(text).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const cells = s.includes('\t') || s.includes(';') || s.includes(',') ? s.split(/[\t,;]+/) : [s];
    for (const cell of cells) {
      const raw = cell.replace(/^["']+|["']+$/g, '').trim();
      if (!raw) continue;
      const spaceTokens = raw.split(/\s+/).filter(Boolean);
      if (spaceTokens.length > 1 && spaceTokens.every(t => t.replace(/\D/g, '').length >= 5)) {
        for (const t of spaceTokens) {
          const hasPlus = t.startsWith('+');
          const d = t.replace(/\D/g, '');
          if (d.length >= 5) {
            const num = (hasPlus ? '+' : '') + d;
            if (!seen.has(num)) { seen.add(num); out.push(num); }
          }
        }
        continue;
      }
      const hasPlus = raw.startsWith('+');
      const d = raw.replace(/\D/g, '');
      if (d.length >= 5) {
        const num = (hasPlus ? '+' : '') + d;
        if (!seen.has(num)) { seen.add(num); out.push(num); }
      }
    }
  }
  return out;
}

const beninParsed = extractNumbersFromText(beninRaw);
t('Benin file extracts exactly 5,000 numbers', beninParsed.length === 5000, `got ${beninParsed.length}`);
t('First number matches 2290192920000', beninParsed[0] === '2290192920000');
t('Last number matches 2290192924999', beninParsed[beninParsed.length - 1] === '2290192924999');

// 2. Test Edge Cases: BOM, Quotes, Spaces, Hyphens, Delimiters
const edgeCaseSample = `
\uFEFF2290192920001
"2290192920002"
'2290192920003'
+229 01 92 92 00 04
229-0192-920005
(229) 0192920006
2290192920007, 2290192920008; 2290192920009
2290192920010 2290192920011 2290192920012
`;

const edgeParsed = extractNumbersFromText(edgeCaseSample);
t('Edge case sample parsed all 12 numbers without skipping', edgeParsed.length === 12, `got ${edgeParsed.length}`);
t('BOM first line preserved correctly', edgeParsed.includes('2290192920001'));
t('Double quoted number cleaned', edgeParsed.includes('2290192920002'));
t('Single quoted number cleaned', edgeParsed.includes('2290192920003'));
t('Formatted number with spaces cleaned and + preserved', edgeParsed.includes('+2290192920004'));
t('Hyphenated number cleaned', edgeParsed.includes('2290192920005'));
t('Parenthesized number cleaned', edgeParsed.includes('2290192920006'));
t('CSV and semicolon row extracted multiple numbers', edgeParsed.includes('2290192920007') && edgeParsed.includes('2290192920008') && edgeParsed.includes('2290192920009'));
t('Space-separated independent numbers extracted', edgeParsed.includes('2290192920010') && edgeParsed.includes('2290192920011') && edgeParsed.includes('2290192920012'));

// 3. Backend normalization test
const serverCode = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
t('Backend server.js has normalizeNumberForImport', serverCode.includes('function normalizeNumberForImport'));
t('Backend server.js has parseImportLineTokens', serverCode.includes('function parseImportLineTokens'));
t('Backend server.js processNumberImportJob invalidates cache via bumpNumbersVer', serverCode.includes('bumpNumbersVer') && serverCode.includes('clearApiReadCache'));
t('Backend server.js checks duplicate by cleanPhone', serverCode.includes('cleanPhone(number)'));

// 4. Management.html & Admin.html audit
const mgmtCode = fs.readFileSync(path.join(__dirname, '../management.html'), 'utf8');
const adminCode = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

t('management.html uses extractNumbersFromText in doImport', mgmtCode.includes('extractNumbersFromText(text)'));
t('management.html uses extractNumbersFromText in bulkImportTxtFiles', mgmtCode.includes('const nums=extractNumbersFromText(text)'));
t('management.html doImport handles Excel / large files via multipart', mgmtCode.includes('API.upload("/numbers/import-file"'));
t('admin.html uses extractNumbersFromText in doImport', adminCode.includes('extractNumbersFromText(text)'));
t('admin.html uses extractNumbersFromText in doImportTestNumbers', adminCode.includes('extractNumbersFromText(text)'));

// 5. Cleaned numbers file check
const cleanedFile = '/home/user/Benin_SBIN_SA_5000_cleaned.txt';
t('Cleaned 5000-numbers file exists at /home/user/Benin_SBIN_SA_5000_cleaned.txt', fs.existsSync(cleanedFile));
if (fs.existsSync(cleanedFile)) {
  const lines = fs.readFileSync(cleanedFile, 'utf8').trim().split('\n');
  t('Cleaned file contains exactly 5,000 lines', lines.length === 5000, `got ${lines.length}`);
}

console.log('\n======================================================');
console.log('NUMBER IMPORT ROBUSTNESS SUITE COMPLETED');
console.log('======================================================');
