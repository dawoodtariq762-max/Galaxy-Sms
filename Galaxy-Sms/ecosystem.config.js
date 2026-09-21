/**
 * PM2 process configuration — Power X SMS
 * =============================================================================
 * Start:    pm2 start ecosystem.config.js
 * Reload:   pm2 restart powerx --update-env
 * Logs:     pm2 logs powerx
 *
 * WHY THESE SETTINGS (measured on this project, not copied from a template):
 *
 * exec_mode: 'fork'  +  instances: 1
 *   This app MUST stay single-process. Verified in the code:
 *     backend/providerSync.js:582  setInterval(runDueProviders, 12s)
 *     backend/providerSync.js:588  setInterval(flushBookkeeping, 5min)
 *     backend/backup.js:112        setInterval(createBackup, 3h)
 *   In PM2 cluster mode every worker runs its own copy of these timers, so
 *   with 2 workers the provider API would be polled twice per tick (duplicate
 *   SMS risk) and two processes would write the same backup file at the same
 *   moment. Cluster mode also gives no benefit here: better-sqlite3 is
 *   synchronous and a single writer, so extra workers would just contend on
 *   the same WAL lock.
 *
 * max_memory_restart: '1500M'
 *   Measured steady-state RSS after the better-sqlite3 migration is ~150 MB
 *   and it stays flat as the database grows (tested to 900,000 SMS / 954 MB
 *   DB with RSS still at 148 MB). 1500M is therefore a leak-catcher, not a
 *   normal operating limit — if it ever trips, something is genuinely wrong.
 *
 * kill_timeout: 10000
 *   backend/db.js:278 closeDb() runs `wal_checkpoint(TRUNCATE)` on SIGINT so
 *   the .sqlite file is self-contained on shutdown. PM2's default grace period
 *   is only 1600 ms, which can cut a checkpoint short on a large database.
 *   10 s gives the checkpoint room to finish cleanly.
 *
 * exp_backoff_restart_delay: 200
 *   Without this, a crash-on-boot (e.g. a corrupt DB file) makes PM2 restart
 *   in a tight loop and burn 100% CPU. Backoff spaces the retries out.
 *
 * min_uptime / max_restarts
 *   If the process cannot stay alive for 30 s, ten times in a row, PM2 marks
 *   it "errored" and stops instead of looping forever — so the logs show a
 *   real error rather than being drowned in restart spam.
 * =============================================================================
 */
module.exports = {
  apps: [
    {
      name: 'powerx',
      script: 'backend/server.js',
      cwd: __dirname,

      // ---- single process (see note above) ----
      exec_mode: 'fork',
      instances: 1,

      // ---- restart policy ----
      autorestart: true,
      watch: false,                     // never restart on file change in production
      max_memory_restart: '1500M',
      exp_backoff_restart_delay: 200,
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 2000,

      // ---- clean shutdown so the WAL checkpoint completes ----
      kill_timeout: 10000,
      shutdown_with_message: false,
      wait_ready: false,

      // ---- logs ----
      time: true,                       // timestamp every log line
      merge_logs: true,
      error_file: '/root/powerx-logs/error.log',
      out_file: '/root/powerx-logs/out.log',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
