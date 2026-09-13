'use strict';
/* pwbench lib/audit.js — DB-level integrity audit (bench DB ONLY, readonly) */
const path = require('path');
let D = null;
function db(open) { if (!D) D = require(path.join(require('./guard').loadConfig().APP_ROOT, 'node_modules/better-sqlite3')); return new D(open, { readonly: true }); }
function counts(benchDbFile) {
  const d = db(benchDbFile);
  const one = q => { try { return d.prepare(q).get(); } catch (e) { return { c: -1, err: e.message }; } };
  const out = {
    numbers: one('SELECT COUNT(*) c FROM numbers').c,
    sms_records: one('SELECT COUNT(*) c FROM sms_records').c,
    users: one('SELECT COUNT(*) c FROM users').c,
    ownership: one('SELECT COUNT(*) c FROM numbers WHERE manager_id IS NOT NULL').c,
    duplicate_numbers: one('SELECT COUNT(*) c FROM (SELECT number FROM numbers GROUP BY number HAVING COUNT(*)>1)').c,
    duplicate_sms_refs: one("SELECT COUNT(*) c FROM (SELECT message FROM sms_records WHERE message LIKE 'SYNTH-%' GROUP BY message HAVING COUNT(*)>1)").c,
    synth_sms: one("SELECT COUNT(*) c FROM sms_records WHERE message LIKE 'SYNTH-%'").c,
  };
  d.close(); return out;
}
/** audit synthetic ingest run: sent refs vs stored (unique message carries the ref) */
function ingestAudit(benchDbFile, sentRefs) {
  const d = db(benchDbFile);
  let found = 0; const missing = [];
  const CHUNK = 500;
  for (let i = 0; i < sentRefs.length; i += CHUNK) {
    const chunk = sentRefs.slice(i, i + CHUNK);
    const marks = chunk.map(() => 'message=?').join(' OR ');
    const got = d.prepare(`SELECT message FROM sms_records WHERE ${marks}`).all(...chunk).map(r => r.message);
    found += got.length;
    if (missing.length < 20) for (const m of chunk) if (!got.includes(m)) missing.push(m);
  }
  const dupRows = d.prepare("SELECT message, COUNT(*) c FROM sms_records WHERE message LIKE 'SYNTH-%' GROUP BY message HAVING c>1 LIMIT 5").all();
  d.close();
  return { sent: sentRefs.length, stored: found, lost: sentRefs.length - found, missingSample: missing, duplicateSamples: dupRows, pass: found === sentRefs.length && dupRows.length === 0 };
}
/** ownership race audit: orphan agent / agent without manager = FAIL */
function ownershipAudit(benchDbFile) {
  const d = db(benchDbFile);
  const multi = d.prepare('SELECT COUNT(*) c FROM numbers WHERE manager_id IS NOT NULL AND agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM users WHERE parent_id=manager_id)').get().c;
  const partial = d.prepare('SELECT COUNT(*) c FROM numbers WHERE agent_id IS NOT NULL AND manager_id IS NULL').get().c;
  d.close();
  return { orphanedAgent: multi, agentWithoutManager: partial, pass: multi === 0 && partial === 0 };
}
function sampleNumbers(benchDbFile, k) {
  const d = db(benchDbFile);
  const rows = d.prepare('SELECT number FROM numbers ORDER BY id LIMIT ?').all(k).map(r => r.number);
  d.close(); return rows;
}
module.exports = { counts, ingestAudit, ownershipAudit, sampleNumbers };
