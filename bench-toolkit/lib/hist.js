'use strict';
/* pwbench lib/hist.js — latency histogram + percentiles */
class Hist {
  constructor() { this.n = 0; this.sum = 0; this.max = 0; this.arr = []; }
  add(ms) { this.n++; this.sum += ms; if (ms > this.max) this.max = ms; if (this.arr.length < 200000) this.arr.push(ms); }
  pct(q) { if (!this.arr.length) return 0; const a = this.arr.slice().sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(1); }
  avg() { return this.n ? +(this.sum / this.n).toFixed(1) : 0; }
  out() { return { n: this.n, p50: this.pct(.5), p95: this.pct(.95), p99: this.pct(.99), max: +this.max.toFixed(1), avg: this.avg() }; }
}
module.exports = { Hist };
