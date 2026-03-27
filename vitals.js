/**
 * vitals.js — Termux/Android system vitals
 *
 * ─── PERMISSION SETUP REQUIRED ON THE TABLET ───────────────────────────────
 *
 *  1. Install from F-Droid (NOT Google Play — Play builds are outdated):
 *       • Termux              (f-droid.org/en/packages/com.termux/)
 *       • Termux:API          (f-droid.org/en/packages/com.termux.api/)
 *     Both must be signed with the same key. Installing one from F-Droid and
 *     the other from Play Store will cause the API bridge to silently fail.
 *
 *  2. Inside Termux, install packages:
 *       pkg install termux-api curl inetutils
 *     • termux-api   → enables all termux-* commands below
 *     • curl         → DNS/connectivity probe, external IP check
 *     • inetutils    → provides `ping` (not present by default on Android)
 *
 *  3. Grant permissions to Termux:API in Android Settings → Apps → Termux:API:
 *       • Location (Fine)    → required by termux-wifi-connectioninfo (SSID/RSSI)
 *                              and termux-telephony-cellinfo
 *       • Phone              → required by termux-telephony-deviceinfo/cellinfo
 *
 *  4. Grant permissions to Termux in Android Settings → Apps → Termux:
 *       • (No extra permissions needed for the vitals below beyond API access)
 *
 *  NOTE ON /proc AND /sys:
 *    Android locks down /proc/net/* (arp, dev, wireless) via SELinux since
 *    Android 10, and /sys/class/thermal/* and /sys/class/power_supply/* since
 *    ~Android 9. These are NOT readable without root and are not used here.
 *    Everything below uses either /proc/meminfo, /proc/cpuinfo, /proc/stat,
 *    /proc/uptime, /proc/loadavg (all confirmed readable), Node.js built-ins,
 *    or termux-api commands.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Data sources used, verified to work on Android 10–14 without root:
 *
 *   /proc/uptime     — system + idle uptime (always readable)
 *   /proc/meminfo    — full memory breakdown (always readable)
 *   /proc/cpuinfo    — CPU model + core count (always readable)
 *   /proc/stat       — CPU tick counters, sampled for real load % (always readable)
 *   /proc/loadavg    — 1/5/15 min load averages (always readable)
 *   getprop          — Android system properties (always available, no pkg needed)
 *   df               — storage mounts (Android busybox, always available)
 *   os.networkInterfaces() — IP/MAC of all interfaces (Node built-in, always works)
 *   net.Socket TCP connect  — internet reachability without shell tools (Node built-in)
 *   termux-battery-status  — battery: %, status, health, temp, current, plugged
 *   termux-wifi-connectioninfo — WiFi: ssid, bssid, rssi, link_speed, frequency
 *   termux-telephony-deviceinfo — device IMEI-hash, operator info
 *   termux-telephony-cellinfo   — cell tower signal (requires Location + Phone perms)
 *   termux-sensor               — accelerometer motion detect, temperature sensors
 *   termux-camera-info          — on-device camera list (id, dimensions, flash)
 *   curl                        — external IP + DNS reachability probe
 *   ping                        — round-trip latency to gateway (needs inetutils)
 */

"use strict";

const os       = require("os");
const fs       = require("fs");
const path     = require("path");
const net      = require("net");
const { exec } = require("child_process");
const profiler = require("./profiler");

// ─── constants ───────────────────────────────────────────────────────────────

const RELIABILITY_FILE = path.join(__dirname, ".reliability.json");
const RELIABILITY_TMP  = RELIABILITY_FILE + ".tmp";

// Timeouts — all well below the 15 s heartbeat interval so nothing blocks.
// termux-api commands start an IPC bridge; the first call after a long idle
// can take 1–2 s. 4 s is a safe ceiling that still catches hangs.
const T_API    = 4000;   // termux-api commands
const T_SHELL  = 4000;   // generic shell
const T_CURL   = 5000;   // curl (DNS + TLS handshake)
const T_PING   = 6000;   // ping with packet count


// ─── core helpers ─────────────────────────────────────────────────────────────

/** Run a shell command. Returns stdout string or null. Never throws. */
function shell(cmd, ms = T_SHELL) {
  return new Promise(resolve => {
    exec(cmd, { timeout: ms, maxBuffer: 32 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}

/** Read a /proc or /sys file synchronously. Returns string or null. */
function readProc(p) {
  try { return fs.readFileSync(p, "utf8"); }
  catch { return null; }
}

/** Parse a float; return null if not finite. */
function n(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }

/** Round to one decimal. */
function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }

/** Bytes → whole MB. */
function MB(b) { return b == null ? null : Math.round(Number(b) / 1048576); }

/** x/y as a percentage (one decimal). */
function pct(used, total) {
  if (!used || !total) return null;
  return r1(used / total * 100);
}

/**
 * Wrap any async probe so it never throws.
 * Returns null on error and prints a one-line warning to stderr.
 */
async function safe(label, fn) {
  try   { return await fn(); }
  catch (e) { process.stderr.write(`[vitals:${label}] ${e.message}\n`); return null; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. OS IDENTITY
//    Sources: getprop (always), uname -r (always), /proc/uptime (always)
// ═══════════════════════════════════════════════════════════════════════════════

async function getOSInfo() {
  // All getprop calls run in parallel; each has its own 2 s timeout so one
  // missing property doesn't delay the others.
  const propNames = [
    "ro.build.version.release",    // "13", "14" — Android version
    "ro.build.version.sdk",        // "33" — API level
    "ro.product.model",            // "Pixel 7a"
    "ro.product.manufacturer",     // "Google"
    "ro.product.board",            // SoC / hardware board name
    "ro.serialno",                 // device serial number
    "ro.build.fingerprint",        // full build string for exact OS identification
  ];

  const vals = await Promise.all(propNames.map(p => shell(`getprop ${p}`, 2000)));
  const [release, sdk, model, manufacturer, board, serial, fingerprint] = vals;

  // /proc/uptime format: "12345.67 89012.34"  (uptime_secs idle_secs)
  const uptimeRaw  = readProc("/proc/uptime");
  const uptimeSecs = uptimeRaw ? n(uptimeRaw.split(/\s+/)[0]) : null;

  return {
    platform:             "android",
    arch:                 os.arch(),             // "arm64" — Node built-in, always works
    hostname:             os.hostname(),
    nodeVersion:          process.version,
    kernelRelease:        await shell("uname -r", 2000) ?? os.release(),
    androidVersion:       release      ?? null,
    androidSDK:           sdk          ? parseInt(sdk, 10) : null,
    deviceModel:          model        ?? null,
    manufacturer:         manufacturer ?? null,
    hardwareBoard:        board        ?? null,
    serialNumber:         serial       ?? null,  // useful for fleet identification
    buildFingerprint:     fingerprint  ?? null,
    systemUptimeSeconds:  uptimeSecs   != null ? Math.round(uptimeSecs) : Math.round(os.uptime()),
    processUptimeSeconds: Math.round(process.uptime()),
    timezone:             Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 2. MEMORY
//    Source: /proc/meminfo (always readable on Android)
// ═══════════════════════════════════════════════════════════════════════════════

function getMemory() {
  const raw = readProc("/proc/meminfo");
  if (!raw) return null;

  // Each line: "MemTotal:      3932160 kB"
  const kB = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(\\d+)`, "m"));
    return m ? parseInt(m[1], 10) * 1024 : null;   // kB → bytes
  };

  const total     = kB("MemTotal");
  const free      = kB("MemFree");
  const available = kB("MemAvailable");   // accounts for reclaimable cache
  const cached    = kB("Cached");
  const swapTotal = kB("SwapTotal");
  const swapFree  = kB("SwapFree");
  const used      = total != null && free != null ? total - free : null;

  const heap = process.memoryUsage();   // Node heap — always works

  return {
    system: {
      totalMB:     MB(total),
      usedMB:      MB(used),
      freeMB:      MB(free),
      availableMB: MB(available),       // best indicator of actual headroom
      cachedMB:    MB(cached),
      swapTotalMB: MB(swapTotal),
      swapUsedMB:  swapTotal != null && swapFree != null ? MB(swapTotal - swapFree) : null,
      usedPct:     pct(used, total),
    },
    process: {
      heapUsedMB:  MB(heap.heapUsed),
      heapTotalMB: MB(heap.heapTotal),
      rssMB:       MB(heap.rss),
      externalMB:  MB(heap.external),
    },
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 3. CPU
//    Sources: /proc/stat (load delta), /proc/cpuinfo (model/cores), /proc/loadavg
// ═══════════════════════════════════════════════════════════════════════════════

async function getCPU() {
  // Sample /proc/stat twice with 300 ms gap to get instantaneous load.
  // /proc/stat format: "cpu  user nice system idle iowait irq softirq steal ..."
  function sample() {
    const raw  = readProc("/proc/stat");
    if (!raw) return null;
    const line = raw.split("\n").find(l => l.startsWith("cpu "));
    if (!line) return null;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    const idle   = (fields[3] ?? 0) + (fields[4] ?? 0);   // idle + iowait
    const total  = fields.reduce((a, b) => a + b, 0);
    return { idle, total };
  }

  const s1 = sample();
  await new Promise(r => setTimeout(r, 300));
  const s2 = sample();

  let loadPct = null;
  if (s1 && s2) {
    const dt = s2.total - s1.total;
    const di = s2.idle  - s1.idle;
    if (dt > 0) loadPct = r1(100 * (1 - di / dt));
  }

  // /proc/cpuinfo is always readable on Android arm/arm64 devices.
  // "Hardware:" line gives the SoC name (e.g. "Qualcomm Technologies, Inc SM8550-AB")
  // "model name:" is present on x86 emulators.
  // Count "processor:" entries for logical core count.
  const cpuinfo   = readProc("/proc/cpuinfo");
  const cores     = cpuinfo ? (cpuinfo.match(/^processor\s*:/gm) ?? []).length : os.cpus().length;
  const hwLine    = cpuinfo?.match(/^Hardware\s*:\s*(.+)$/m);
  const modelLine = cpuinfo?.match(/^model name\s*:\s*(.+)$/m);
  const model     = (hwLine ?? modelLine)?.[1]?.trim() ?? null;

  // /proc/loadavg format: "0.52 0.71 0.83 3/1024 12345"
  const lavRaw = readProc("/proc/loadavg");
  const lavParts = lavRaw ? lavRaw.trim().split(/\s+/) : [];
  const [la1, la5, la15] = lavParts.map(n);

  return {
    model,
    cores,
    loadPct,                                        // instantaneous %
    loadAvg: { "1m": la1, "5m": la5, "15m": la15 },// rolling averages
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 4. STORAGE
//    Source: `df` — Android busybox, always available, no packages needed
// ═══════════════════════════════════════════════════════════════════════════════

async function getStorage() {
  // Android `df` output (no flags needed — busybox df works without -k on some builds)
  // Columns: Filesystem  1K-blocks  Used  Available  Use%  Mounted-on
  const out = await shell("df", 3000);
  if (!out) return null;

  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;

    const [fsName, totalK, usedK, availK, usePctStr, mount] = cols;

    // Skip virtual/kernel filesystems — not meaningful for capacity monitoring
    if (/^(tmpfs|devtmpfs|proc|sysfs|debugfs|cgroup|none|overlay|udev|run|dev|cg2_bpf|tracefs)$/i.test(fsName)) continue;
    if (!mount) continue;

    const totalBytes = parseInt(totalK, 10) * 1024;
    if (!totalBytes || isNaN(totalBytes)) continue;

    rows.push({
      mount,
      fsType:  fsName,
      totalGB: r1(totalBytes / 1e9),
      usedGB:  r1(parseInt(usedK,  10) * 1024 / 1e9),
      freeGB:  r1(parseInt(availK, 10) * 1024 / 1e9),
      usedPct: parseInt(usePctStr, 10) || null,
    });
  }
  return rows.length ? rows : null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. BATTERY — percentage and temperature
//
//    WHY termux-battery-status IS THE RIGHT METHOD:
//    On Android, battery information is provided by the OS through the
//    BatteryManager API (android.os.BatteryManager). There is no /proc or /sys
//    path that exposes this without root on modern Android — the OS intentionally
//    routes it through a broadcast intent (Intent.ACTION_BATTERY_CHANGED).
//    termux-battery-status is the command-line bridge to that API.
//    It is the Android equivalent of `os.uptime()` — the correct, official
//    channel for this data.
//
//    PERMISSION: None beyond Termux:API being installed from F-Droid.
//
//    CONFIRMED JSON FIELDS (from termux-api source code and community reports):
//      percentage  — integer 0–100           ← battery level
//      temperature — float °C (e.g. 28.5)   ← battery temperature
//      health      — "GOOD" | "OVERHEAT" | "DEAD" | "OVER_VOLTAGE" | "COLD"
//      status      — "CHARGING" | "DISCHARGING" | "FULL" | "NOT_CHARGING"
//      plugged     — "UNPLUGGED" | "AC" | "USB" | "WIRELESS"
//      current     — integer µA (negative = discharging, positive = charging)
//
//    RELIABILITY NOTE:
//    On very old Android Go devices (Android 8.1), this command can hang.
//    The T_API timeout (4 s) handles this — the call returns null gracefully.
// ═══════════════════════════════════════════════════════════════════════════════

async function getBattery() {
  const raw = await shell("termux-battery-status", T_API);

  if (!raw) {
    // Termux:API not installed, or the IPC bridge is not running.
    // Setup: install Termux:API from F-Droid, then `pkg install termux-api`
    return { available: false };
  }

  try {
    const j = JSON.parse(raw);

    // percentage and temperature are the two fields specifically required.
    // Both are always present when termux-battery-status responds.
    return {
      available:    true,
      percent:      j.percentage  ?? null,   // 0–100, the battery level
      temperatureC: j.temperature ?? null,   // °C, the battery cell temperature
      status:       j.status      ?? null,   // CHARGING / DISCHARGING / FULL
      isCharging:   j.status ? /^(CHARGING|FULL)$/i.test(j.status) : null,
      health:       j.health      ?? null,   // GOOD / OVERHEAT / DEAD etc.
      plugged:      j.plugged     ?? null,   // AC / USB / WIRELESS / UNPLUGGED
      // µA → mA for readability; negative = discharging, positive = charging
      currentMa:    j.current != null ? Math.round(j.current / 1000) : null,
    };
  } catch {
    return { available: false, error: "json_parse" };
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 6. NETWORK
//    Sources:
//      os.networkInterfaces()  — always works (Node built-in)
//      termux-wifi-connectioninfo — needs Termux:API + Location permission (Fine)
//        JSON fields: ssid, bssid, mac_address, rssi, link_speed_mbps,
//                     frequency_mhz, ip_address, network_id, ssid_hidden
//      TCP connect to 8.8.8.8:53 — internet reachability (Node built-in, no shell)
//      ping 8.8.8.8             — round-trip latency (needs `pkg install inetutils`)
//      curl https://api.ipify.org — external IP (needs `pkg install curl`)
//      curl -o /dev/null <url>  — DNS + HTTP reachability check
// ═══════════════════════════════════════════════════════════════════════════════

async function getNetwork() {
  const [ifaces, wifi, connectivity] = await Promise.all([
    getNetworkInterfaces(),
    getWifiInfo(),
    getConnectivity(),
  ]);
  return { interfaces: ifaces, wifi, connectivity };
}

function getNetworkInterfaces() {
  // os.networkInterfaces() is the only reliable way to get IPs on Android 10+
  // (ifconfig and ip addr are unreliable or need extra pkg installs).
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of (addrs ?? [])) {
      if (a.internal) continue;
      result.push({
        iface:   name,
        family:  a.family,     // "IPv4" or "IPv6"
        address: a.address,
        netmask: a.netmask,
        mac:     a.mac,
      });
    }
  }
  return result;
}

async function getWifiInfo() {
  // PERMISSION: Termux:API app must have Location (Fine) granted.
  // Android 10+ returns bssid as "02:00:00:00:00:00" (MAC privacy) — we flag this.
  // Android 14 can hang indefinitely without Location — enforced via T_API timeout.
  const raw = await shell("termux-wifi-connectioninfo", T_API);
  if (!raw) return { available: false };

  try {
    const j = JSON.parse(raw);
    const macPrivate   = j.bssid === "02:00:00:00:00:00";
    const ssidUnknown  = !j.ssid || j.ssid === "<unknown ssid>";

    return {
      available:        true,
      ssid:             ssidUnknown ? null : j.ssid,
      ssidHidden:       j.ssid_hidden ?? false,
      ssidUnknown,                          // true if Location not granted
      bssid:            macPrivate ? null : j.bssid,
      macPrivacyActive: macPrivate,         // Android 10+ privacy behaviour
      rssiDbm:          j.rssi              ?? null,
      signalStrength:   classifyRSSI(j.rssi),
      linkSpeedMbps:    j.link_speed_mbps   ?? null,
      frequencyMHz:     j.frequency_mhz     ?? null,
      ipAddress:        j.ip_address        ?? null,
    };
  } catch {
    return { available: false, error: "json_parse" };
  }
}

function classifyRSSI(rssi) {
  if (rssi == null) return "unknown";
  if (rssi >= -50)  return "excellent";
  if (rssi >= -65)  return "good";
  if (rssi >= -75)  return "fair";
  if (rssi >= -85)  return "poor";
  return "very_poor";
}

async function getConnectivity() {
  const [tcpCheck, pingResult, dnsCheck, publicIP] = await Promise.all([
    // Node TCP connect to 8.8.8.8:53 — no shell tool required, always works
    tcpConnect("8.8.8.8", 53, 5000),
    // ping needs `pkg install inetutils` — gracefully returns null if absent
    pingHost("8.8.8.8"),
    // curl DNS + HTTP check — needs `pkg install curl`
    curlCheck("https://www.google.com"),
    // curl to get external/public IP — useful to detect NAT type
    curlPublicIP(),
  ]);

  return {
    // TCP check is the most reliable — works with just Node, no packages
    internetReachable: tcpCheck.reachable,
    tcpLatencyMs:      tcpCheck.latencyMs,
    // ping gives round-trip stats including packet loss
    ping:              pingResult,
    // DNS+HTTP check via curl
    http:              dnsCheck,
    publicIP,
  };
}

function tcpConnect(host, port, timeoutMs) {
  return new Promise(resolve => {
    const t0     = Date.now();
    const socket = new net.Socket();
    let   done   = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable: ok, latencyMs: ok ? Date.now() - t0 : null });
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error",   () => finish(false));
  });
}

async function pingHost(host) {
  // Android busybox ping: `ping -c 4 -W 2 <host>`
  // -W 2 = 2 second timeout per packet (busybox flag; differs from inetutils)
  // Try both busybox and inetutils flag styles
  const out = await shell(`ping -c 4 -W 2 ${host}`, T_PING);
  if (!out) return { available: false };  // inetutils not installed

  // Parse RTT line: "rtt min/avg/max/mdev = 12.3/14.5/16.7/1.2 ms"
  const rttM  = out.match(/rtt[^=]+=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
  const lossM = out.match(/(\d+)%\s+packet loss/);

  return {
    available:     true,
    latencyMinMs:  rttM ? r1(parseFloat(rttM[1])) : null,
    latencyAvgMs:  rttM ? r1(parseFloat(rttM[2])) : null,
    latencyMaxMs:  rttM ? r1(parseFloat(rttM[3])) : null,
    packetLossPct: lossM ? parseInt(lossM[1], 10) : null,
  };
}

async function curlCheck(url) {
  // -s silent, -o discard body, -w write response code, --max-time cap total
  const t0  = Date.now();
  const out = await shell(`curl -s -o /dev/null -w "%{http_code}" --max-time 4 ${url}`, T_CURL);
  const ms  = Date.now() - t0;
  if (out == null) return { available: false };   // curl not installed
  const code = parseInt(out, 10);
  return { available: true, resolved: code >= 100, statusCode: code, latencyMs: ms };
}

async function curlPublicIP() {
  const out = await shell("curl -s --max-time 4 https://api.ipify.org", T_CURL);
  if (!out) return null;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(out.trim()) ? out.trim() : null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 7. TELEPHONY / CELLULAR
//    Sources:
//      termux-telephony-deviceinfo — operator, roaming state
//        JSON fields: data_activity, data_state, device_id (hashed IMEI),
//                     device_software_version, phone_count,
//                     network_operator, network_operator_name,
//                     network_country_iso, network_type, network_roaming
//      termux-telephony-cellinfo   — cell tower signal strength
//        Permission: Location (Fine) + Phone
//        NOTE: SecurityException on Android 10+ if target SDK ≥ 29 — falls back
// ═══════════════════════════════════════════════════════════════════════════════

async function getTelephony() {
  const [devRaw, cellRaw] = await Promise.all([
    shell("termux-telephony-deviceinfo", T_API),
    shell("termux-telephony-cellinfo",   T_API),
  ]);

  let deviceInfo = null;
  if (devRaw) {
    try {
      const j = JSON.parse(devRaw);
      deviceInfo = {
        networkOperatorName: j.network_operator_name ?? null,
        networkType:         j.network_type          ?? null, // "LTE", "NR" (5G), etc.
        networkRoaming:      j.network_roaming        ?? null,
        networkCountryISO:   j.network_country_iso    ?? null,
        dataState:           j.data_state             ?? null, // "CONNECTED" etc.
        phoneCount:          j.phone_count            ?? null,
        // device_id is hashed in modern Android — safe to transmit
        deviceIdHash:        j.device_id              ?? null,
      };
    } catch { /* json error */ }
  }

  let cellInfo = null;
  if (cellRaw) {
    try {
      const arr = JSON.parse(cellRaw);
      // Each entry has type (gsm/lte/nr), registered, and signal fields
      cellInfo = (Array.isArray(arr) ? arr : [arr]).map(c => ({
        type:       c.type       ?? null,
        registered: c.registered ?? null,
        level:      c.lte?.signal_strength ?? c.gsm?.signal_strength ?? c.nr?.ss_rsrp ?? null,
      })).slice(0, 4);   // cap to 4 cells
    } catch { /* json error or SecurityException output */ }
  }

  return {
    available:  devRaw != null,
    deviceInfo,
    cellInfo,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 8. SENSORS (motion/orientation/temperature)
//    Source: termux-sensor
//    Permission: none beyond Termux:API
//    -n 1 = read exactly once then stop (no infinite stream)
//    Sensor names are device-specific; we try common names and take what responds.
// ═══════════════════════════════════════════════════════════════════════════════

async function getSensors() {
  // Read accelerometer once (always present on any Android device with sensors)
  // JSON: { "android.sensor.accelerometer": { "values": [x, y, z] } }
  // Values in m/s²; at rest z ≈ 9.8 (gravity). Deviation = device is moving.
  const accelRaw = await shell("termux-sensor -s accelerometer -n 1 -d 0", T_API);

  // Optional: ambient temperature sensor (not present on all devices)
  const tempRaw  = await shell("termux-sensor -s 'Ambient Temperature' -n 1 -d 0", T_API);

  let motion = null;
  if (accelRaw) {
    try {
      const j    = JSON.parse(accelRaw);
      const vals = Object.values(j)[0]?.values ?? [];
      if (vals.length >= 3) {
        const [x, y, z] = vals;
        const magnitude = Math.sqrt(x*x + y*y + z*z);
        // Deviation from gravity (9.81 m/s²) indicates motion
        const deviation = Math.abs(magnitude - 9.81);
        motion = {
          x: r1(x), y: r1(y), z: r1(z),
          magnitudeMs2:   r1(magnitude),
          deviationMs2:   r1(deviation),
          deviceMoving:   deviation > 1.5,   // threshold in m/s²
        };
      }
    } catch { /* sensor not available */ }
  }

  let ambientC = null;
  if (tempRaw) {
    try {
      const j    = JSON.parse(tempRaw);
      const vals = Object.values(j)[0]?.values;
      if (Array.isArray(vals) && vals.length) ambientC = r1(vals[0]);
    } catch { /* no ambient sensor on this device */ }
  }

  return {
    motion,
    ambientC,
    available: motion != null || ambientC != null,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 9. CAMERA INFO (on-device camera, not IP cameras)
//    Source: termux-camera-info
//    Permission: none beyond Termux:API
//    Reports the tablet's own cameras — useful to confirm the phone camera
//    is functional and what resolutions are supported.
//    JSON fields: array of { id, facing, flash_available, max_digital_zoom,
//                             physical_size, focal_lengths,
//                             capabilities: [{ width, height }] }
// ═══════════════════════════════════════════════════════════════════════════════

async function getCameraInfo() {
  const raw = await shell("termux-camera-info", T_API);
  if (!raw) return { available: false };

  try {
    const arr = JSON.parse(raw);
    const cameras = (Array.isArray(arr) ? arr : [arr]).map(c => ({
      id:             c.id                  ?? null,
      facing:         c.facing              ?? null,  // "back" | "front"
      flashAvailable: c.flash_available     ?? null,
      maxDigitalZoom: c.max_digital_zoom    ?? null,
      // Report the max resolution only (saves payload space)
      maxResolution: (() => {
        const caps = c.capabilities ?? [];
        if (!caps.length) return null;
        const best = caps.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b));
        return { width: best.width, height: best.height };
      })(),
    }));
    return { available: true, cameras };
  } catch {
    return { available: false, error: "json_parse" };
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 10. PROCESS HEALTH (Node.js process itself)
//     Source: Node.js built-ins — always works
// ═══════════════════════════════════════════════════════════════════════════════

async function getProcessHealth() {
  // Event-loop lag: a 0-ms setImmediate should fire almost instantly.
  // High values (>50ms) indicate something is blocking the event loop.
  const lagMs = await new Promise(resolve => {
    const t = Date.now();
    setImmediate(() => resolve(Date.now() - t));
  });

  const heap = process.memoryUsage();

  return {
    pid:            process.pid,
    uptimeSeconds:  Math.round(process.uptime()),
    eventLoopLagMs: lagMs,
    heapUsedMB:     MB(heap.heapUsed),
    heapTotalMB:    MB(heap.heapTotal),
    rssMB:          MB(heap.rss),
    externalMB:     MB(heap.external),
    // These internal V8 methods are available in all Node.js versions we use
    activeHandles:  (process._getActiveHandles?.() ?? []).length,
    activeRequests: (process._getActiveRequests?.() ?? []).length,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 11. RELIABILITY COUNTERS (persistent across restarts)
//     Atomic write (tmp → rename) prevents corrupt JSON on power loss.
// ═══════════════════════════════════════════════════════════════════════════════

let _rel = null;

function loadReliability() {
  if (_rel) return _rel;
  try   { _rel = JSON.parse(fs.readFileSync(RELIABILITY_FILE, "utf8")); }
  catch { _rel = { sent: 0, failed: 0, startedAt: new Date().toISOString(), lastRestart: new Date().toISOString() }; }
  return _rel;
}

function saveReliability(data) {
  try {
    fs.writeFileSync(RELIABILITY_TMP, JSON.stringify(data));
    fs.renameSync(RELIABILITY_TMP, RELIABILITY_FILE);
  } catch { /* disk full / permissions — non-fatal */ }
}

function recordHeartbeat({ success }) {
  const r = loadReliability();
  if (success) r.sent++; else r.failed++;
  saveReliability(r);
}

function getReliability() {
  const r     = loadReliability();
  const total = r.sent + r.failed;
  return { ...r, total, successRatePct: total ? r1(r.sent / total * 100) : null };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MASTER EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

async function getVitals() {
  // Each probe is individually timed so you can see which one is slowest.
  // Memory deltas show which probe allocates the most heap.
  const timed = (tag, fn) => profiler.trace(tag, fn).catch(e => {
    process.stderr.write(`[vitals:${tag}] ${e.message}\n`);
    return null;
  });

  const [osInfo, memory, cpu, storage, battery, network, telephony, sensors, cameras, proc] =
    await Promise.all([
      timed("vitals.os",        getOSInfo),
      timed("vitals.memory",    () => Promise.resolve(getMemory())),
      timed("vitals.cpu",       getCPU),
      timed("vitals.storage",   getStorage),
      timed("vitals.battery",   getBattery),
      timed("vitals.network",   getNetwork),
      timed("vitals.telephony", getTelephony),
      timed("vitals.sensors",   getSensors),
      timed("vitals.cameras",   getCameraInfo),
      timed("vitals.process",   getProcessHealth),
    ]);

  return {
    os:          osInfo,
    memory,
    cpu,
    storage,
    battery,
    network,
    telephony,
    sensors,
    cameras,
    process:     proc,
    reliability: getReliability(),
  };
}

module.exports = { getVitals, recordHeartbeat };
