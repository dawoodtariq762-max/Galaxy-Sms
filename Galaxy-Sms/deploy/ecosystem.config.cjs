// PowerX — PM2 process model (Phase-2 POWERX_ROLE split)
// api   : web + worker exports (user-facing; must never wait on timers)
// sync  : timers only (provider sync + automatic backups)
// Rules: cluster mode KABHI nahi (SQLite single-writer). Dono processes same
// DB file, WAL mode. Small VPS (<8GB / light traffic)? sirf `powerx-all` chalao
// (POWERX_ROLE unset) — single process, sab kuch andar.
module.exports = {
  apps: [
    {
      name: 'powerx-api',
      script: 'backend/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { POWERX_ROLE: 'api' },
      max_memory_restart: '1500M',
      time: true,
    },
    {
      name: 'powerx-sync',
      script: 'backend/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { POWERX_ROLE: 'sync' },
      max_memory_restart: '800M',
      time: true,
    },
  ],
};
