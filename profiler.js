/**
 * profiler.js — Execution timing, memory attribution, and async lag tracking
 *
 * ─── WHAT THIS SOLVES ────────────────────────────────────────────────────────
 *
 *  1. Sequential timing  — microsecond-precision duration of any code block
 *  2. Memory attribution — heap delta before/after each operation, so you know
 *                          which component is growing memory
 *  3. Async lag          — time from request dispatch to response arrival,
 *                          isolating compute wait from external service wait
 *  4. Anomaly detection  — per-tag thresholds; anything exceeding them is flagged
 *  5. Statistics         — rolling p50/p95/p99 per operation name
 *  6. Hang detection     — async spans that never close appear in pendingAsync()
 *
 * ─── TIMING SOURCE ───────────────────────────────────────────────────────────
 *
 *  process.hrtime.bigint()
 *    • Built into Node.js (no packages required)
 *    • Returns a BigInt in NANOSECONDS
 *    • Monotonic clock — unaffected by NTP adjustments or DST changes
 *    • The correct tool for measuring durations (Date.now() is wall-clock only)
 *    • Resolution is nanoseconds; practical precision on Android ARM64 is ~100ns
 *
 * ─── MEMORY SOURCE ───────────────────────────────────────────────────────────
 *
 *  process.memoryUsage()
 *    • Built into Node.js (no packages required)
 *    • Returns: heapUsed, heapTotal, rss, external, arrayBuffers
 *    • heapUsed = live objects on the V8 heap (most useful metric)
 *    • rss      = total Resident Set Size (includes native libs, buffers)
 *    • external = C++ objects tracked by V8 (Buffers, etc.)
 *    • Taking a snapshot before/after an operation gives its heap contribution
 *
 * ─── OVERHEAD ────────────────────────────────────────────────────────────────
 *
 *  DEBUG = false (production):
 *    start()    → one process.hrtime.bigint() + one process.memoryUsage() call
 *    end()      → same + arithmetic + array push to ring buffer
 *    Total per span: ~2–5 µs. Safe to leave in production.
 *
 *  DEBUG = true (development):
 *    Adds console.log + optional file I/O. Disable in production.
 *
 * ─── QUICK USAGE ─────────────────────────────────────────────────────────────
 *
 *  const profiler = require('./profiler');
 *
 *  // Sequential (sync or await-style):
 *  const s = profiler.start('kerong.lockOpen');
 *  await openLock(compartmentId);
 *  profiler.end(s);
 *
 *  // Async with wrapper (cleanest):
 *  const result = await profiler.trace('bu.httpStatus', () => fetchBUStatus());
 *
 *  // Async manual (when request and response are in different callbacks):
 *  const id = profiler.startAsync('camera.rtspConnect', { host: cam.host });
 *  socket.connect(..., () => profiler.endAsync(id, { success: true }));
 *
 *  // Memory snapshot:
 *  profiler.memSnapshot('afterImageDecode');
 *
 *  // Get stats:
 *  console.log(profiler.stats());             // all tags
 *  console.log(profiler.stats('bu.httpStatus')); // one tag
 *  console.log(profiler.pendingAsync());      // detect hangs
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  // Set to true during debugging to enable console output and file logging.
  // Set to false in production — timing still runs, just silently.
  DEBUG: process.env.PROFILER_DEBUG === "1" || false,

  // How many completed spans to keep in the ring buffer (older ones are dropped).
  // 500 spans × ~300 bytes each ≈ 150 KB — safe for long-running processes.
  RING_SIZE: 500,

  // Per-tag anomaly thresholds (milliseconds). Spans exceeding these are
  // flagged in console output and marked anomaly:true in their record.
  // Add your own tags as needed.
  THRESHOLDS: {
    "heartbeat.total":     12000,   // full heartbeat cycle
    "vitals.collect":       8000,   // all vitals in parallel
    "hardware.probe":       6000,   // BU + cameras + gateway
    "bu.tcpConnect":         500,
    "bu.httpStatus":        2000,
    "camera.rtspProbe":     1000,
    "post.cloud":           5000,   // HTTP POST to admin server
    "battery.read":         4000,   // termux-battery-status
    "wifi.read":            4000,   // termux-wifi-connectioninfo
    "dns.check":            3000,
    "tcp.internetCheck":     500,
  },

  // Where to flush the profile log (null = don't write to disk).
  LOG_FILE: path.join(__dirname, ".profile.json"),

  // How many duration samples to keep per tag for percentile calculation.
  SAMPLE_WINDOW: 100,
};


// ─── ring buffer ──────────────────────────────────────────────────────────────
// Fixed-size circular array. When full, the oldest entry is overwritten.
// No dynamic allocation after construction — safe for long-running processes.

class RingBuffer {
  constructor(size) {
    this._buf   = new Array(size).fill(null);
    this._size  = size;
    this._head  = 0;   // next write position
    this._count = 0;   // number of valid entries
  }

  push(item) {
    this._buf[this._head % this._size] = item;
    this._head++;
    if (this._count < this._size) this._count++;
  }

  /** Return all valid entries in chronological order. */
  toArray() {
    if (this._count === 0) return [];
    if (this._count < this._size) return this._buf.slice(0, this._count);
    const start = this._head % this._size;
    return [...this._buf.slice(start), ...this._buf.slice(0, start)];
  }

  get length() { return this._count; }
}


// ─── helpers ──────────────────────────────────────────────────────────────────

/** Round to n decimal places. */
function rd(x, dp = 3) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Convert nanosecond BigInt to a plain millisecond number (3 dp). */
function nsToMs(ns) { return rd(Number(ns) / 1e6, 3); }

/** Convert nanosecond BigInt to a plain microsecond number (1 dp). */
function nsToUs(ns) { return rd(Number(ns) / 1e3, 1); }

/** Snapshot Node.js process memory. All values in MB. */
function memNow() {
  const m = process.memoryUsage();
  return {
    heapUsedMB:  rd(m.heapUsed  / 1048576, 2),
    heapTotalMB: rd(m.heapTotal / 1048576, 2),
    rssMB:       rd(m.rss       / 1048576, 2),
    externalMB:  rd(m.external  / 1048576, 2),
  };
}

/** Compute percentile from a sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * p) - 1;
  return rd(sorted[Math.max(0, idx)], 3);
}


// ─── per-tag statistics accumulator ──────────────────────────────────────────
// Maintains a rolling window of recent samples per tag for percentile math.
// Also tracks lifetime count/sum/min/max without the window constraint.

class TagStats {
  constructor() {
    this._tags = {};
  }

  record(tag, durationMs) {
    let s = this._tags[tag];
    if (!s) {
      s = this._tags[tag] = { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [], anomalies: 0 };
    }
    s.count++;
    s.sum    += durationMs;
    s.min     = Math.min(s.min, durationMs);
    s.max     = Math.max(s.max, durationMs);
    s.samples.push(durationMs);
    if (s.samples.length > CONFIG.SAMPLE_WINDOW) s.samples.shift();
  }

  recordAnomaly(tag) {
    if (this._tags[tag]) this._tags[tag].anomalies++;
  }

  get(tag) {
    const s = this._tags[tag];
    if (!s) return null;
    const sorted = [...s.samples].sort((a, b) => a - b);
    return {
      count:      s.count,
      anomalies:  s.anomalies,
      avgMs:      rd(s.sum / s.count, 3),
      minMs:      rd(s.min, 3),
      maxMs:      rd(s.max, 3),
      p50Ms:      percentile(sorted, 0.50),
      p95Ms:      percentile(sorted, 0.95),
      p99Ms:      percentile(sorted, 0.99),
    };
  }

  all() {
    return Object.fromEntries(
      Object.keys(this._tags).map(tag => [tag, this.get(tag)])
    );
  }
}


// ─── profiler class ───────────────────────────────────────────────────────────

class Profiler {
  constructor() {
    this._ring        = new RingBuffer(CONFIG.RING_SIZE);
    this._tagStats    = new TagStats();
    this._pending     = new Map();   // asyncId → open async span
    this._pendingIdSeq = 0;
  }

  // ── SEQUENTIAL SPANS ──────────────────────────────────────────────────────
  // For timing a synchronous code block or an awaited async function where
  // both start and end are in the same lexical scope.
  //
  // Usage:
  //   const s = profiler.start('myOperation');
  //   doWork();
  //   profiler.end(s);

  /**
   * Begin a sequential timing span.
   * @param {string} tag   — operation name, used for grouping in stats
   * @param {object} meta  — optional extra fields stored with the record
   * @returns A span token to pass to end()
   */
  start(tag, meta = {}) {
    return {
      tag,
      meta,
      t0:   process.hrtime.bigint(),   // nanosecond monotonic clock
      mem0: process.memoryUsage(),      // heap snapshot at start
    };
  }

  /**
   * End a sequential span. Records duration and memory delta.
   * @returns The completed record (also stored in ring buffer)
   */
  end(span) {
    if (!span) return null;

    const t1       = process.hrtime.bigint();
    const mem1     = process.memoryUsage();
    const durationNs = t1 - span.t0;
    const durationMs = nsToMs(durationNs);
    const threshold  = CONFIG.THRESHOLDS[span.tag];
    const anomaly    = threshold != null && durationMs > threshold;

    const record = {
      type:        "sync",
      tag:         span.tag,
      durationMs,
      durationUs:  nsToUs(durationNs),  // sub-millisecond precision for fast ops
      anomaly,
      mem: {
        // heapDeltaMB: positive = allocated, negative = GC freed memory
        heapDeltaMB:  rd((mem1.heapUsed - span.mem0.heapUsed) / 1048576, 3),
        heapUsedMB:   rd(mem1.heapUsed  / 1048576, 2),
        rssMB:        rd(mem1.rss       / 1048576, 2),
      },
      at:          new Date().toISOString(),
      ...span.meta,
    };

    this._commit(record);
    return record;
  }

  // ── ASYNC TRACE WRAPPER ───────────────────────────────────────────────────
  // The cleanest API: wraps any Promise-returning function automatically.
  //
  // Usage:
  //   const data = await profiler.trace('bu.httpStatus', () => fetchBUStatus());
  //   const result = await profiler.trace('post.cloud', () => axios.post(url, body));

  /**
   * Execute an async function and time it end-to-end.
   * Captures whether it resolved or rejected.
   * @param {string}   tag  — operation name
   * @param {Function} fn   — async function to execute (called with no args)
   * @param {object}   meta — optional extra fields stored with the record
   */
  async trace(tag, fn, meta = {}) {
    const span = this.start(tag, meta);
    try {
      const result = await fn();
      this.end({ ...span, meta: { ...meta, success: true } });
      return result;
    } catch (e) {
      this.end({ ...span, meta: { ...meta, success: false, error: e.message } });
      throw e;
    }
  }

  // ── ASYNC MANUAL SPANS ────────────────────────────────────────────────────
  // For cases where request and response arrive in different callbacks or
  // different parts of the codebase (e.g. TCP connect → data event).
  //
  // Usage:
  //   const id = profiler.startAsync('camera.rtspProbe', { host: '192.168.1.101' });
  //   socket.on('connect', () => profiler.endAsync(id, { success: true }));
  //   socket.on('error',   () => profiler.endAsync(id, { success: false }));

  /**
   * Open an async span.
   * @returns An opaque ID string to pass to endAsync()
   */
  startAsync(tag, meta = {}) {
    const id = `${tag}:${++this._pendingIdSeq}`;
    this._pending.set(id, {
      tag,
      meta,
      t0:   process.hrtime.bigint(),
      mem0: process.memoryUsage(),
    });
    return id;
  }

  /**
   * Close an async span by the ID returned from startAsync().
   * Safe to call with null/undefined (when profiling is conditionally disabled).
   */
  endAsync(id, resultMeta = {}) {
    if (!id) return null;
    const span = this._pending.get(id);
    if (!span) return null;   // already closed or never opened
    this._pending.delete(id);

    const t1         = process.hrtime.bigint();
    const mem1       = process.memoryUsage();
    const durationNs = t1 - span.t0;
    const durationMs = nsToMs(durationNs);
    const threshold  = CONFIG.THRESHOLDS[span.tag];
    const anomaly    = threshold != null && durationMs > threshold;

    const record = {
      type:       "async",
      tag:        span.tag,
      durationMs,
      durationUs: nsToUs(durationNs),
      anomaly,
      mem: {
        heapDeltaMB:  rd((mem1.heapUsed - span.mem0.heapUsed) / 1048576, 3),
        heapUsedMB:   rd(mem1.heapUsed  / 1048576, 2),
        rssMB:        rd(mem1.rss       / 1048576, 2),
      },
      at: new Date().toISOString(),
      ...span.meta,
      ...resultMeta,
    };

    this._commit(record);
    return record;
  }

  // ── MEMORY SNAPSHOTS ──────────────────────────────────────────────────────
  // Take a named memory snapshot at any point. Useful for understanding
  // cumulative growth after multi-step pipelines.
  //
  // Usage:
  //   profiler.memSnapshot('afterImageDecode');
  //   heavyProcessing();
  //   profiler.memSnapshot('afterHeavyProcessing');

  memSnapshot(label) {
    const snap = { label, ...memNow(), at: new Date().toISOString() };
    if (CONFIG.DEBUG) {
      console.log(`  📊 [mem:${label}] heap ${snap.heapUsedMB}MB  rss ${snap.rssMB}MB  ext ${snap.externalMB}MB`);
    }
    return snap;
  }

  // ── PENDING ASYNC DETECTION ───────────────────────────────────────────────
  // Any async span that was opened but not yet closed.
  // Call this periodically to detect hung requests.

  pendingAsync() {
    const now = process.hrtime.bigint();
    return [...this._pending.entries()].map(([id, span]) => ({
      id,
      tag:       span.tag,
      pendingMs: nsToMs(now - span.t0),
      meta:      span.meta,
    }));
  }

  // ── STATISTICS ────────────────────────────────────────────────────────────

  /**
   * Get performance statistics.
   * @param {string|null} tag  — specific tag, or null for all tags
   */
  stats(tag = null) {
    return tag ? this._tagStats.get(tag) : this._tagStats.all();
  }

  /**
   * Get the N most recent completed spans, optionally filtered by tag.
   * @param {number}      n
   * @param {string|null} tag
   */
  recent(n = 20, tag = null) {
    let spans = this._ring.toArray();
    if (tag) spans = spans.filter(s => s.tag === tag);
    return spans.slice(-n);
  }

  /**
   * Flush ring buffer + stats to LOG_FILE (atomic write).
   * Call this on a schedule or on process exit for offline analysis.
   */
  flush() {
    if (!CONFIG.LOG_FILE) return;
    try {
      const data = {
        flushedAt:    new Date().toISOString(),
        pendingAsync: this.pendingAsync(),
        stats:        this.stats(),
        recent:       this._ring.toArray(),
      };
      const tmp = CONFIG.LOG_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, CONFIG.LOG_FILE);
    } catch (e) {
      process.stderr.write(`[profiler] flush failed: ${e.message}\n`);
    }
  }

  // ── INTERNAL ──────────────────────────────────────────────────────────────

  _commit(record) {
    this._ring.push(record);
    this._tagStats.record(record.tag, record.durationMs);
    if (record.anomaly) this._tagStats.recordAnomaly(record.tag);

    if (CONFIG.DEBUG) {
      const flag = record.anomaly ? "⚠️  SLOW " : "⏱  ";
      const mem  = `heap Δ${record.mem.heapDeltaMB >= 0 ? "+" : ""}${record.mem.heapDeltaMB}MB`;
      const us   = record.durationMs < 1 ? ` (${record.durationUs}µs)` : "";
      console.log(`  ${flag}[${record.tag}] ${record.durationMs}ms${us} | ${mem} | heap ${record.mem.heapUsedMB}MB rss ${record.mem.rssMB}MB`);
      if (record.anomaly) {
        const threshold = CONFIG.THRESHOLDS[record.tag];
        console.warn(`     └─ exceeded threshold ${threshold}ms by ${rd(record.durationMs - threshold, 1)}ms`);
      }
    }
  }
}


// Export a single shared profiler instance.
// All modules in the same process share the same ring buffer and stats.
module.exports = new Profiler();
module.exports.Profiler = Profiler;   // export class for testing
module.exports.CONFIG   = CONFIG;     // export config for runtime toggle
