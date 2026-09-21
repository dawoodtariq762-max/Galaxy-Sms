#!/usr/bin/env node
/* Extract every inline <script> block from an HTML file and node --check it. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const body = m[2] || '';
  if (/\bsrc\s*=/.test(attrs)) continue; // external script
  if (!body.trim()) continue;
  i++;
  const tmp = path.join('/tmp', `blk-${process.pid}-${i}.js`);
  fs.writeFileSync(tmp, body);
  try {
    execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
    console.log(`OK   block #${i} (${body.length} chars)`);
  } catch (e) {
    bad++;
    console.log(`FAIL block #${i} (${body.length} chars):\n${e.stderr.toString().slice(0, 1200)}`);
  }
}
console.log(`${path.basename(file)}: ${i} inline block(s), ${bad} FAIL`);
process.exit(bad ? 1 : 0);
