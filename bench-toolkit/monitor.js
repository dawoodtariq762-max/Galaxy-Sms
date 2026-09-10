'use strict';
/* Temporary live monitoring dashboard — 127.0.0.1 ONLY, benchmark environment ke liye.
   Production panel se koi taluq nahi. Test ke baad poora folder delete. */
const http = require('http'), fs = require('fs'), path = require('path');
const guard = require('./lib/guard');
const cfg = guard.loadConfig();
const { raw, } = require('./lib/api');
const pidFile = path.join(guard.ROOT, 'run', 'bench.pid');
const HTML = `<!doctype html><html><head><meta charset=utf-8><title>pwbench monitor</title>
<meta http-equiv=refresh content="2"><style>body{font-family:ui-monospace;background:#0b1020;color:#dce6ff;padding:24px}
h1{font-size:18px} table{border-collapse:collapse;margin-top:12px} td,th{border:1px solid #27365e;padding:6px 12px;font-size:14px}
.ok{color:#7CFF9B}.warn{color:#FFD37C}.bad{color:#FF7C7C}</style></head><body>
<h1>🧪 pwbench monitor (temporary — sirf benchmark environment)</h1><div id=s>loading…</div>
<script>
fetch('/stats').then(r=>r.json()).then(d=>{
 let h='<table><tr><th>metric</th><th>value</th></tr>';
 const row=(k,v,c)=>h+='<tr><td>'+k+'</td><td class="'+(c||'')+'">'+v+'</td></tr>';
 if(!d.health) row('bench server','DOWN','bad');
 else{row('health','ok '+d.health.uptime_s+'s','ok');row('rss',d.health.rss_mb+'MB');row('heap',d.health.heap_mb+'MB');
  row('EL lag p50/p95/p99',d.health.event_loop.lag_p50_ms+' / '+d.health.event_loop.lag_p95_ms+' / '+d.health.event_loop.lag_p99_ms+' ms',d.health.event_loop.lag_p99_ms>250?'bad':'ok');
  row('db size',d.health.db_size_mb+'MB');row('wal size',d.health.wal_size_mb+'MB',d.health.wal_size_mb>500?'warn':'');row('cache entries',d.health.cache_entries);row('numbers_ver',d.health.numbers_ver);}
 row('bench cpu%',d.cpu??'—');row('bench rss',d.rss?d.rss+'MB':'—');row('bench io read',d.io?d.io+'MB':'—');
 h+='</table>';
 if(d.reports&&d.reports.length){h+='<h1>reports</h1><table><tr><th>file</th></tr>';d.reports.slice(0,15).forEach(r=>h+='<tr><td>'+r+'</td></tr>');h+='</table>';}
 document.getElementById('s').innerHTML=h;}).catch(e=>document.getElementById('s').textContent='ERR '+e);
</script></body></html>`;
let prev = null;
function readPidStats() {
  try {
    const pid = +fs.readFileSync(pidFile, 'utf8').trim();
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const rssMB = +(+st[23] * 4 / 1024).toFixed(1);
    let io = 0; try { io = +(/read_bytes:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/io`, 'utf8'))?.[1] || 0) / 1048576; } catch (_) {}
    const cur = { utime: +st[13], stime: +st[14] };
    let cpu = null;
    if (prev) cpu = +(((cur.utime - prev.utime) + (cur.stime - prev.stime)) * 10).toFixed(1); // per 1s tick, 100Hz
    prev = cur;
    return { cpu, rss: rssMB, io: +io.toFixed(1), pid };
  } catch (_) { return {}; }
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/stats') {
    let health = null; try { health = (await raw(cfg.BENCH_PORT, 'GET', '/api/health')).j; } catch (_) {}
    const reports = fs.existsSync(cfg.REPORT_DIR) ? fs.readdirSync(cfg.REPORT_DIR).filter(f => f.endsWith('.md')).sort().reverse() : [];
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ health, ...readPidStats(), reports }));
    return;
  }
  res.setHeader('Content-Type', 'text/html'); res.end(HTML);
});
server.listen(cfg.MONITOR_PORT, '127.0.0.1', () => console.log(`🧪 monitor: http://127.0.0.1:${cfg.MONITOR_PORT} (localhost-only)`));
