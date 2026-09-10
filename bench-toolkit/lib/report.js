'use strict';
/* pwbench lib/report.js — auto report writer + labels + final capacity answer */
const fs = require('fs'), path = require('path');
const { ROOT } = require('./guard');

function verdict(latP50, kind = 'browse') {
  const caps = { browse: [80, 200, 500], ingest: [15, 40, 100], alloc: [5000, 10000, 20000], search: [30, 100, 300], dash: [500, 1500, 4000] };
  const c = caps[kind] || caps.browse;
  return latP50 <= c[0] ? '🟢 EASY' : latP50 <= c[1] ? '🟡 WARNING' : latP50 <= c[2] ? '🟠 STRESSED' : '🔴 BREAKING';
}
function write(mode, cfg, { title, config = {}, results = [], integrity = {}, bottleneck = '', notes = [] }) {
  const now = new Date(), stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(cfg.REPORT_DIR, { recursive: true });
  const rep = { mode, title, at: now.toISOString(), config, results, integrity, bottleneck, notes,
    host: { node: process.version, platform: `${require('os').type()} ${require('os').arch()}`, cpus: require('os').cpus().length, totalMemGB: +(require('os').totalmem() / 1e9).toFixed(1) } };
  fs.writeFileSync(path.join(cfg.REPORT_DIR, `${mode}-${stamp}.json`), JSON.stringify(rep, null, 2));
  const L = [];
  L.push(`# pwbench report — ${title}`);
  L.push(`\n- Mode: \`${mode}\`  |  At: ${now.toISOString()}  |  Node ${rep.host.node}, ${rep.host.cpus} vCPU, ${rep.host.totalMemGB}GB`);
  if (Object.keys(config).length) { L.push('\n## Config'); for (const [k, v] of Object.entries(config)) L.push(`- ${k}: ${v}`); }
  L.push('\n## Results');
  L.push('| Metric | Value | Verdict | Label |'); L.push('|---|---|---|---|');
  for (const r of results) L.push(`| ${r.name} | ${r.value} | ${r.verdict || ''} | ${r.label || 'MEASURED'} |`);
  if (integrity && Object.keys(integrity).length) {
    L.push('\n## Integrity audit'); for (const [k, v] of Object.entries(integrity)) L.push(`- ${k}: ${JSON.stringify(v)}`);
    const ok = integrity.pass === true; L.push(`\nIntegrity: **${ok ? '✅ PASS — no loss / no unexpected duplicates' : '❌ FAIL'}**`);
  }
  if (bottleneck) L.push(`\n## Bottleneck\n${bottleneck}`);
  if (notes.length) { L.push('\n## Notes'); for (const n of notes) L.push(`- ${n}`); }
  L.push(`\n_labels: MEASURED = is box par chala · PROJECTED = model+partial proof · EXTRAPOLATED = linear/IO model · DISK-MEASURED = I/O proof_`);
  fs.writeFileSync(path.join(cfg.REPORT_DIR, `${mode}-${stamp}.md`), L.join('\n'));
  console.log(`\n📄 report: ${cfg.REPORT_DIR}/${mode}-${stamp}.{md,json}`);
  return rep;
}
/** Final capacity answer aggregator — reads all reports and answers. */
function capacity(cfg) {
  const files = fs.existsSync(cfg.REPORT_DIR) ? fs.readdirSync(cfg.REPORT_DIR).filter(f => f.endsWith('.json')) : [];
  const rows = [];
  for (const f of files) { try { rows.push(JSON.parse(fs.readFileSync(path.join(cfg.REPORT_DIR, f), 'utf8'))); } catch (_) {} }
  const find = (mode, re) => { const r = rows.filter(x => x.mode === mode).pop(); if (!r) return 'NOT TESTED'; const hit = r.results.find(x => re.test(x.name)) || (re.test(r.title) ? r.results.find(x => x.verdict) : null); return hit ? `${hit.value} ${hit.verdict || ''} (${hit.label})` : 'NOT TESTED'; };
  const L = ['# FINAL CAPACITY ANSWER (auto-generated)', '\n## Numbers scale (inventory benchmark)', '| Scale | Answer |', '|---|---|'];
  for (const s of ['1M', '5M', '10M', '20M', '50M', '100M', '200M', '500M', '600M']) L.push(`| ${s} | ${find('m1', new RegExp(`\\b${s}\\b|inventory ${s}`, 'i'))} |`);
  L.push('\n## Incoming SMS (sustained)'); L.push('| Rate | Answer |', '|---|---|');
  for (const r of [50, 70, 100, 150, 200, 300, 500, 1000]) L.push(`| ${r}/s | ${find('m2', new RegExp(String(r) + '\\/s'))} |`);
  L.push('\n## Concurrent users'); L.push('| Users | Answer |', '|---|---|');
  for (const u of [50, 100, 150, 250, 500]) L.push(`| ${u} | ${find('m3', new RegExp('\\b' + u + '\\b'))} |`);
  L.push('\n## Combined scenarios'); L.push('| Scenario | Answer |', '|---|---|');
  for (const [k, v] of [['20M+150u+70sms', 'C1'], ['20M+150u+150sms', 'C2'], ['20M+150u+200sms', 'C3'], ['50M+150u+100sms', 'C4'], ['100M+150u+100sms', 'C5 (representative)']]) L.push(`| ${k} | ${find('m5', new RegExp(v.replace(/[()]/g, '\\$&')))} |`);
  const out = path.join(cfg.REPORT_DIR, 'CAPACITY-ANSWER.md');
  fs.writeFileSync(out, L.join('\n')); console.log('📄 ' + out);
}
module.exports = { write, verdict, capacity };
