'use strict';
/* pwbench lib/users.js — bench users create/login + deterministic scope distribution (bench DB only) */
const path = require('path');
const { loadConfig } = require('./guard');
const { raw } = require('./api');
const D = () => require(path.join(loadConfig().APP_ROOT, 'node_modules/better-sqlite3'));

/** Deterministic chained distribution: admin(all) -> managers -> agents (per mgr) -> clients (per agent). */
function distribute(benchDbFile, { managers = 3, agentsPer = 2, clientsPer = 2, share = 1.0 } = {}) {
  const d = new (D())(benchDbFile);
  const mgrs = d.prepare('SELECT id FROM users WHERE role=? ORDER BY id LIMIT ?').all('manager', managers);
  const ags = mgrs.length ? d.prepare(`SELECT a.id, a.parent_id FROM users a WHERE a.role='agent' AND a.parent_id IN (${mgrs.map(m => m.id).join(',')}) ORDER BY a.id`).all() : [];
  const cls = ags.length ? d.prepare(`SELECT c.id, c.parent_id FROM users c WHERE c.role='client' AND c.parent_id IN (${ags.map(a => a.id).join(',')}) ORDER BY c.id`).all() : [];
  const total = d.prepare('SELECT COUNT(*) c FROM numbers').get().c;
  const pool = Math.floor(total * Math.min(1, share));
  const perMgr = Math.floor(pool / Math.max(1, mgrs.length));
  const perAgent = mgrs.length ? Math.floor(perMgr / Math.max(1, agentsPer)) : 0;
  const perClient = ags.length ? Math.floor(perAgent / Math.max(1, clientsPer)) : 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const m of mgrs) d.prepare('UPDATE numbers SET manager_id=? WHERE manager_id IS NULL AND id IN (SELECT id FROM numbers WHERE manager_id IS NULL ORDER BY id LIMIT ?)').run(m.id, perMgr);
    for (const a of ags) d.prepare('UPDATE numbers SET agent_id=? WHERE agent_id IS NULL AND manager_id=? AND id IN (SELECT id FROM numbers WHERE agent_id IS NULL AND manager_id=? ORDER BY id LIMIT ?)').run(a.id, a.parent_id, a.parent_id, perAgent);
    for (const c of cls) d.prepare('UPDATE numbers SET client_id=? WHERE client_id IS NULL AND agent_id=? AND id IN (SELECT id FROM numbers WHERE client_id IS NULL AND agent_id=? ORDER BY id LIMIT ?)').run(c.id, c.parent_id, c.parent_id, perClient);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); d.close(); throw e; }
  const scopes = {
    total,
    managerScoped: d.prepare('SELECT COUNT(*) c FROM numbers WHERE manager_id IS NOT NULL').get().c,
    agentScoped: d.prepare('SELECT COUNT(*) c FROM numbers WHERE agent_id IS NOT NULL').get().c,
    clientScoped: d.prepare('SELECT COUNT(*) c FROM numbers WHERE client_id IS NOT NULL').get().c,
    duplicates: d.prepare('SELECT COUNT(*) c FROM (SELECT number FROM numbers GROUP BY number HAVING COUNT(*)>1)').get().c,
  };
  d.close(); return scopes;
}
async function ensureUsers(client, cfg, { managers = 0, agentsPer = 2, clientsPer = 2 } = {}) {
  const admin = await client.login('vibepk', 'vibepk123');
  const creds = { admin: { username: 'vibepk', password: 'vibepk123', token: admin.token, id: admin.user?.id } };
  const mk = [];
  for (let i = 0; i < managers; i++) mk.push({ username: `bm${i}`, password: 'pwbench123', role: 'manager', name: 'Bench Mgr ' + i, parent: 'admin' });
  const ags = [];
  for (let i = 0; i < managers; i++) for (let a = 0; a < agentsPer; a++) ags.push({ username: `bm${i}a${a}`, password: 'pwbench123', role: 'agent', name: `A${i}-${a}`, parent: `bm${i}` });
  mk.push(...ags);
  for (const a of ags) for (let c = 0; c < clientsPer; c++) mk.push({ username: a.username + 'c' + c, password: 'pwbench123', role: 'client', name: a.username + ' client ' + c, parent: a.username });
  // two-phase: managers -> login -> agents (parent id chahiye) -> login -> clients
  const phases = mk.reduce((acc, u) => { (acc[u.role] = acc[u.role] || []).push(u); return acc; }, {});
  for (const role of ['manager', 'agent', 'client']) {
    for (const u of (phases[role] || [])) {
      let parentId = null;
      if (u.parent === 'admin') parentId = creds.admin.id;
      else if (creds[u.parent]) parentId = creds[u.parent].id;
      const r = await raw(cfg.BENCH_PORT, 'POST', '/api/users', { token: creds.admin.token, body: { username: u.username, password: u.password, role: u.role, name: u.name, parent_id: parentId } });
      if (r.status !== 200 && r.status !== 201 && !/exist/i.test(JSON.stringify(r.j || {}))) console.log(`   (user ${u.username}: http ${r.status})`);
    }
    for (const u of (phases[role] || [])) {
      const lg = await client.login(u.username, u.password);
      creds[u.username] = { username: u.username, password: u.password, token: lg.token, id: lg.user?.id, role: u.role };
    }
  }
  return creds;
}
module.exports = { distribute, ensureUsers };
