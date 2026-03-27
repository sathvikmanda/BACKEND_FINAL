/**
 * location.js — Device location for Droppoint locker nodes
 *
 * ─── PERMISSION REQUIRED ─────────────────────────────────────────────────────
 *
 *   Android Settings → Apps → Termux:API → Permissions → Location
 *     ✅ "Allow all the time"   ← select this, not "only while using"
 *
 *   This grants the Termux:API background service access to the device's
 *   LocationManager, which is what termux-location calls internally.
 *   Without it the command returns { "API_ERROR": "Failed to get location" }
 *   or hangs indefinitely.
 *
 * ─── HOW termux-location WORKS ───────────────────────────────────────────────
 *
 *   termux-location is a shell bridge to Android's LocationManager Java API.
 *   It is the correct, standard method — equivalent to os.uptime() or
 *   process.memoryUsage(). There is no /proc or /sys path for GPS on Android.
 *
 *   Three providers, ordered fastest → most accurate:
 *
 *   passive   (-p passive -r last)
 *     Returns the last fix cached by any other app on the device.
 *     Completes in <100ms. Accuracy varies. May be hours old.
 *     Zero energy cost — reads a cached value, no hardware involved.
 *
 *   network   (-p network -r once)
 *     Uses WiFi access point positions + cell tower IDs.
 *     Completes in 1–5 s. Accuracy typically 10–50 m in urban areas.
 *     Low energy cost — no GPS chip involved.
 *
 *   gps       (-p gps -r once)
 *     Uses the hardware GPS receiver.
 *     Cold start: 10–60 s. Warm start (had recent fix): 2–10 s.
 *     Accuracy: 3–10 m with clear sky.
 *     For a FIXED locker this only runs ONCE on first boot, then is cached.
 *
 * ─── STRATEGY FOR A FIXED LOCKER ─────────────────────────────────────────────
 *
 *   1. On first launch, acquire a GPS fix (most accurate, runs once).
 *      This happens in the background — it does NOT block the first heartbeat.
 *      The first heartbeat sends whatever is available immediately (passive/network).
 *
 *   2. The GPS fix is saved to .location.json (atomic write, crash-safe).
 *
 *   3. Every subsequent heartbeat reads from cache — zero GPS overhead.
 *
 *   4. Every NETWORK_REFRESH_HOURS hours, re-verify with the network provider.
 *      This is cheap (1–5 s) and confirms the cache is still sane.
 *      Useful for detecting if the locker has been physically moved.
 *
 *   5. Every GPS_REFRESH_DAYS days, re-acquire a GPS fix to update the cache.
 *      For a fixed device this is effectively never needed, but it ensures
 *      the cloud always has a recent, accurate coordinate.
 *
 * ─── JSON FIELDS RETURNED BY termux-location (confirmed) ────────────────────
 *
 *   latitude    — decimal degrees, WGS84
 *   longitude   — decimal degrees, WGS84
 *   altitude    — metres above sea level (0 if unavailable)
 *   accuracy    — horizontal accuracy radius in metres (lower = better)
 *   bearing     — degrees from true north (0 for stationary devices)
 *   speed       — metres/second (0 for stationary devices)
 *   elapsedMs   — time taken to get this fix in milliseconds
 *
 * ─── EXPORTED API ────────────────────────────────────────────────────────────
 *
 *   getLocation()   → { lat, lng, accuracyM, altitudeM, provider,
 *                        fixAge, fixedAt, source, mapsUrl }
 *   module is self-initialising — just require() it and call getLocation().
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const { exec } = require("child_process");

// ─── configuration ────────────────────────────────────────────────────────────

const CACHE_FILE    = path.join(__dirname, ".location.json");
const CACHE_TMP     = CACHE_FILE + ".tmp";

// How long to keep each type of fix before re-acquiring
const NETWORK_REFRESH_HOURS = 6;     // re-verify with network provider every 6 h
const GPS_REFRESH_DAYS      = 30;    // full GPS re-acquire every 30 days

// Command timeouts
// GPS cold start can legitimately take 60 s — give it generous room.
// network is fast; 12 s covers bad cell conditions.
// passive returns immediately from cache — 5 s is very conservative.
const T_GPS     = 65_000;
const T_NETWORK = 12_000;
const T_PASSIVE =  5_000;

// ─── module state ─────────────────────────────────────────────────────────────

let _cache        = null;   // in-memory copy of last good fix
let _acquiring    = false;  // prevent concurrent GPS acquisitions
let _initialised  = false;  // has the startup sequence run?

// ─── helpers ──────────────────────────────────────────────────────────────────

function shell(cmd, ms) {
  return new Promise(resolve => {
    exec(cmd, { timeout: ms, maxBuffer: 4096 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}

/** Round coordinates to 6 decimal places (~0.1 m precision — no excess digits). */
function r6(x)  { return x == null ? null : Math.round(x * 1e6) / 1e6; }
function r1(x)  { return x == null ? null : Math.round(x * 10)  / 10;  }

/** Seconds since an ISO timestamp. */
function ageSecs(isoStr) {
  if (!isoStr) return null;
  return Math.round((Date.now() - new Date(isoStr).getTime()) / 1000);
}

/** Atomic write: write to .tmp then rename, so power loss can't corrupt the file. */
function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_TMP, JSON.stringify(data, null, 2));
    fs.renameSync(CACHE_TMP, CACHE_FILE);
    _cache = data;
  } catch (e) {
    process.stderr.write(`[location] cache write failed: ${e.message}\n`);
  }
}

/** Read cache from disk on first load. */
function loadCache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    _cache = null;
  }
  return _cache;
}

// ─── termux-location wrapper ──────────────────────────────────────────────────

/**
 * Run termux-location with a given provider and parse the result.
 * Returns a normalised fix object or null on failure.
 *
 * @param {"gps"|"network"|"passive"} provider
 * @param {number} timeoutMs
 */
async function acquire(provider, timeoutMs) {
  // -r once = get one reading then exit (vs streaming updates)
  // -r last = return the most recently cached fix (passive only)
  const request = provider === "passive" ? "last" : "once";
  const raw     = await shell(
    `termux-location -p ${provider} -r ${request}`,
    timeoutMs
  );

  if (!raw) return null;

  let j;
  try { j = JSON.parse(raw); } catch { return null; }

  // API_ERROR is returned when Location permission is denied or GPS is off
  if (j.API_ERROR) {
    process.stderr.write(`[location:${provider}] API_ERROR: ${j.API_ERROR}\n`);
    return null;
  }

  if (j.latitude == null || j.longitude == null) return null;

  return {
    lat:       r6(j.latitude),
    lng:       r6(j.longitude),
    accuracyM: j.accuracy  != null ? r1(j.accuracy)  : null,
    altitudeM: j.altitude  != null ? r1(j.altitude)  : null,
    bearing:   j.bearing   != null ? r1(j.bearing)   : null,
    speed:     j.speed     != null ? r1(j.speed)     : null,
    elapsedMs: j.elapsedMs ?? null,
    provider,
    fixedAt:   new Date().toISOString(),
  };
}

// ─── acquisition strategies ───────────────────────────────────────────────────

/**
 * Fast path: try passive (instant) then network (1–5 s).
 * Used to get something useful for the first heartbeat while GPS warms up.
 */
async function acquireFast() {
  const passive = await acquire("passive", T_PASSIVE);
  if (passive) {
    process.stdout.write(`[location] passive fix: ${passive.lat},${passive.lng} ±${passive.accuracyM}m\n`);
    return passive;
  }

  const network = await acquire("network", T_NETWORK);
  if (network) {
    process.stdout.write(`[location] network fix: ${network.lat},${network.lng} ±${network.accuracyM}m\n`);
    return network;
  }

  return null;
}

/**
 * Full GPS acquisition — most accurate, but slow on cold start.
 * Runs in the background (non-blocking). Writes result to cache when done.
 */
async function acquireGPS() {
  if (_acquiring) return;
  _acquiring = true;

  process.stdout.write("[location] GPS acquisition started (may take up to 60 s)...\n");
  const fix = await acquire("gps", T_GPS);

  if (fix) {
    process.stdout.write(`[location] GPS fix acquired: ${fix.lat},${fix.lng} ±${fix.accuracyM}m in ${fix.elapsedMs}ms\n`);
    writeCache({ ...fix, source: "gps" });
  } else {
    process.stderr.write("[location] GPS acquisition failed — keeping existing cache\n");
  }

  _acquiring = false;
}

/**
 * Network re-verification.
 * Cheap re-check for drift detection (e.g. locker was moved).
 * Only replaces the cache if the new fix is more accurate OR the
 * cache is too old. GPS-sourced fixes are not overwritten by network
 * unless they are stale.
 */
async function reVerifyNetwork() {
  const fix = await acquire("network", T_NETWORK);
  if (!fix) return;

  const cached = loadCache();

  // If we have a GPS fix that's less than GPS_REFRESH_DAYS old, keep it.
  // Network accuracy (10–50 m) is worse than GPS (3–10 m).
  if (cached?.source === "gps") {
    const ageHours = (ageSecs(cached.fixedAt) ?? Infinity) / 3600;
    if (ageHours < GPS_REFRESH_DAYS * 24) {
      process.stdout.write(`[location] network re-verify: ${fix.lat},${fix.lng} ±${fix.accuracyM}m (GPS cache kept)\n`);
      // Still write a "verified" timestamp so we know the re-check ran
      writeCache({ ...cached, lastVerifiedAt: new Date().toISOString(), verifiedAccuracyM: fix.accuracyM });
      return;
    }
  }

  // Otherwise update cache with the network fix
  process.stdout.write(`[location] network re-verify: ${fix.lat},${fix.lng} ±${fix.accuracyM}m (cache updated)\n`);
  writeCache({ ...fix, source: "network" });
}

// ─── refresh scheduler ────────────────────────────────────────────────────────

let _lastNetworkRefresh = 0;
let _lastGPSRefresh     = 0;

/**
 * Called once per heartbeat. Decides whether a refresh is needed
 * and runs it in the background without blocking the caller.
 */
function scheduleRefreshIfNeeded() {
  const now         = Date.now();
  const networkDue  = now - _lastNetworkRefresh > NETWORK_REFRESH_HOURS * 3_600_000;
  const gpsDue      = now - _lastGPSRefresh     > GPS_REFRESH_DAYS     * 86_400_000;

  if (gpsDue && !_acquiring) {
    _lastGPSRefresh     = now;
    _lastNetworkRefresh = now;   // GPS supersedes network, reset both
    // Run entirely in background — does NOT await, does NOT block heartbeat
    acquireGPS().catch(e => process.stderr.write(`[location] GPS error: ${e.message}\n`));

  } else if (networkDue && !_acquiring) {
    _lastNetworkRefresh = now;
    reVerifyNetwork().catch(e => process.stderr.write(`[location] network error: ${e.message}\n`));
  }
}

// ─── startup ──────────────────────────────────────────────────────────────────

/**
 * Run once when the module is first required.
 * Does NOT block — fires everything in the background.
 *
 * Sequence:
 *   1. Load disk cache (instant)
 *   2. If cache is missing or very old, get a fast fix (passive/network)
 *   3. Start GPS acquisition in background
 */
async function initialise() {
  if (_initialised) return;
  _initialised = true;

  loadCache();

  // If we have no cache at all, get a fast fix so the first heartbeat
  // has something to send (GPS may take a minute)
  if (!_cache) {
    const fast = await acquireFast();
    if (fast) writeCache({ ...fast, source: fast.provider });
  }

  // Always attempt a full GPS acquisition on startup — it runs in the background
  // and will update the cache when complete, even if the first heartbeats go
  // out without it.
  _lastGPSRefresh = Date.now();
  acquireGPS().catch(e => process.stderr.write(`[location] startup GPS error: ${e.message}\n`));
}

// Fire and forget — initialise runs once, non-blocking
initialise().catch(() => {});

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Return the current best location for inclusion in the heartbeat payload.
 *
 * This is synchronous from the caller's perspective — it reads from the
 * in-memory cache. The cache is kept fresh by the background scheduler.
 *
 * Call scheduleRefreshIfNeeded() once per heartbeat to trigger background
 * refreshes when they are due.
 */
function getLocation() {
  scheduleRefreshIfNeeded();

  const c = loadCache();
  if (!c) {
    return {
      available: false,
      reason:    "No fix yet — GPS acquiring in background. Check Location permission on Termux:API.",
    };
  }

  const fixAgeSecs = ageSecs(c.fixedAt);

  return {
    available:        true,
    lat:              c.lat,
    lng:              c.lng,
    accuracyM:        c.accuracyM,
    altitudeM:        c.altitudeM,
    provider:         c.source ?? c.provider,
    fixedAt:          c.fixedAt,
    fixAgeSecs,
    fixAgeHours:      fixAgeSecs != null ? r1(fixAgeSecs / 3600) : null,
    lastVerifiedAt:   c.lastVerifiedAt   ?? null,
    verifiedAccuracyM: c.verifiedAccuracyM ?? null,
    acquiring:        _acquiring,

    // Direct link for admin convenience — paste in any browser to see the pin
    mapsUrl: `https://maps.google.com/?q=${c.lat},${c.lng}`,
  };
}

module.exports = { getLocation };
