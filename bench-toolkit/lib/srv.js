'use strict';
/* pwbench lib/srv.js — isolated bench server lifecycle + system stats */
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), net = require('net');

async function portFree(port, host = '127.0.0.1') {
  // connect success = listener exists = NOT free. ECONNREFUSED/timeout = free.
  return new Promise(res => { const s = net.connect({ port, host }, () => { s.destroy(); res(false); }); s.on('error', () => res(true)); s.setTimeout(1200, () => { s.destroy(); res(true); }); setTimeout(() => { try { s.destroy(); } catch (_) {} res(true); }, 1600); });
}
async function waitFree(port, timeoutS = 30) { const t0 = Date.now(); while (Date.now() - t0 < timeoutS * 1000) { if (await portFree(port)) return true; await new Promise(r => setTimeout(r, 500)); } return false; }

/** Boot an isolated PowerX instance on its own DB (NEVER the production DB file). */
async function startBenchServer(cfg, { dbFile, env = {}, label = 'bench' } = {}) {
  if (!(await portFree(cfg.BENCH_PORT))) { console.error(`✗ port ${cfg.BENCH_PORT} busy — pehle purana bench server band karo: fuser -k ${cfg.BENCH_PORT}/tcp`); process.exit(1); }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const child = spawn('node', [path.join(cfg.APP_ROOT, 'backend/server.js')], {
    cwd: cfg.APP_ROOT,
    env: { ...process.env, DB_FILE: dbFile, PORT: String(cfg.BENCH_PORT), JWT_SECRET: 'pwbench-isolated-secret', SQLITE_CACHE_MB: process.env.BENCH_CACHE_MB || '512', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const ok = await new Promise(resolve => {
    const onData = d => { buf += d; if (/running:/.test(buf)) { cleanup(); resolve(true); } };
    const onErr = d => { buf += d; };
    const cleanup = () => { child.stdout.off('data', onData); child.stderr.off('data', onErr); clearTimeout(to); };
    child.stdout.on('data', onData); child.stderr.on('data', onErr);
    const to = setTimeout(() => { cleanup(); resolve(false); }, 120000);
    child.once('exit', c => { cleanup(); console.error(`✗ ${label} server boot exit(${c}):\n` + buf.slice(-1200)); resolve(false); });
  });
  if (!ok) { try { child.kill('SIGKILL'); } catch (_) {} process.exit(1); }
  child.removeAllListeners('exit'); // boot ho gaya — ab shutdown par false-alarm print na ho
  const killNow = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', killNow);
  console.log(`✓ ${label} bench server: http://127.0.0.1:${cfg.BENCH_PORT} (db=${dbFile}) pid=${child.pid}`);
  return { proc: child, pid: child.pid, killNow, dbFile, bootLog: () => buf };
}

/** Sample CPU%/RSS from /proc (Linux). */
function sysSample(pids) {
  const out = {};
  const ticks = (typeof process.cpuUsage === 'function');
  for (const name of Object.keys(pids)) {
    const pid = pids[name]; if (!pid) continue;
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
      const utime = +st[13], stime = +st[14];
      const rssKb = +st[23] * 4;
      let readSectors = 0;
      try { const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8'); readSectors = +(/read_bytes:\s+(\d+)/.exec(io)?.[1] || 0); } catch (_) {}
      out[name] = { utime, stime, rssKb, readBytes: readSectors };
    } catch (_) { out[name] = null; }
  }
  out._clk = ticks ? process.cpuUsage() : null;
  return out;
}
function sysDelta(a, b, dtMs) {
  const out = {};
  const HZ = 100;
  for (const k of Object.keys(b)) { if (k.startsWith('_') || !b[k] || !a[k]) continue;
    const cpuTicks = (b[k].utime - a[k].utime) + (b[k].stime - a[k].stime);
    out[k] = { cpuPct: +((cpuTicks * (1000 / HZ) * 100) / dtMs).toFixed(1), rssMB: +(b[k].rssKb / 1024).toFixed(1), ioMB: +(((b[k].readBytes - a[k].readBytes) || 0) / 1048576).toFixed(1) };
  }
  return out;
}
module.exports = { startBenchServer, portFree, waitFree, sysSample, sysDelta };
