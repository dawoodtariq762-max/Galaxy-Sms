// SMPP Server module removed from POWER X SMS.
// Kept as a harmless stub so older deployments that still have this file do not start any listener.
module.exports = {
  start() { return { ok: false, disabled: true, message: 'SMPP server removed' }; },
  restart() { return { ok: false, disabled: true, message: 'SMPP server removed' }; },
  stop() { return { ok: true, disabled: true }; },
  status() { return { enabled: false, ports: [], sessions: [], removed: true }; }
};
