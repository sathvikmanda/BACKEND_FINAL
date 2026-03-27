/**
 * hardware.js
 *
 * Physical-layer probes for the Droppoint locker edge node.
 *
 * APPROACH: All hardware reachability is done via Node's built-in `net` and
 * `http` modules — pure TCP/HTTP connects. No shell tools (ping, ip, arp) are
 * used here because their availability on Android is unreliable.
 *
 * What is probed:
 *   • Kerong Bridge Unit (BU) — TCP on protocol port + HTTP status scrape
 *   • IP cameras            — TCP on RTSP port + HTTP
 *   • Local gateway/router  — TCP on HTTP port
 *   • USB serial devices    — fs.existsSync on /dev/ttyUSB* paths
 *   • Lock compartment state — parsed from BU HTTP response
 *
 * ⚙️  Edit HW_CONFIG below to match your physical installation.
 */

"use strict";

const net  = require("net");
const http = require("http");
const fs   = require("fs");


// ─── deployment configuration ────────────────────────────────────────────────
// Change these values to match the actual IP addresses in your locker network.

const HW_CONFIG = {

  bu: {
    host:     "192.168.1.100",   // Kerong BU LAN IP
    tcpPort:  9999,              // Kerong default protocol port
    httpPort: 80,                // BU HTTP status page (set null to skip)
    httpPath: "/status",
    timeoutMs: 3000,
  },

  cameras: [
    { id: "cam_01", label: "Locker Front", host: "192.168.1.101", rtspPort: 554, httpPort: 80, timeoutMs: 3000 },
    { id: "cam_02", label: "Locker Rear",  host: "192.168.1.102", rtspPort: 554, httpPort: 80, timeoutMs: 3000 },
  ],

  gateway: {
    host:     "192.168.1.1",
    tcpPort:  80,
    timeoutMs: 2000,
  },

  // RS-485 USB adapter device paths to check for presence on Android
  serialPaths: [
    "/dev/ttyUSB0",
    "/dev/ttyUSB1",
    "/dev/ttyACM0",
    "/dev/ttyACM1",
  ],

  // Optional: expected MAC addresses of hardware devices.
  // Set to null to disable MAC verification for that device.
  // NOTE: Android 10+ randomises MACs in ARP replies so this can only
  //       be verified if the BU/camera exposes its MAC via HTTP API.
  expectedMACs: {
    bu:     null,
    cam_01: null,
    cam_02: null,
  },
};


// ─── low-level probes — pure Node, no shell ───────────────────────────────────

/**
 * Attempt a TCP connect. Returns { reachable, latencyMs }.
 * Never throws. Uses only Node built-ins.
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const t0     = Date.now();
    const socket = new net.Socket();
    let   done   = false;

    const finish = (reachable) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable, latencyMs: reachable ? Date.now() - t0 : null });
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error",   () => finish(false));
  });
}

/**
 * HTTP GET probe. Returns { reachable, statusCode, latencyMs, body? }.
 * body is only included when fetchBody=true and is capped at 4 KB.
 * Never throws.
 */
function httpProbe(host, port, path, timeoutMs, fetchBody = false) {
  return new Promise(resolve => {
    const t0  = Date.now();
    const req = http.request(
      { host, port, path, method: "GET" },
      res => {
        if (!fetchBody) {
          res.resume();   // drain so socket is freed
          return resolve({ reachable: true, statusCode: res.statusCode, latencyMs: Date.now() - t0 });
        }
        let body = "";
        res.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
        res.on("end",  () => resolve({ reachable: true, statusCode: res.statusCode, latencyMs: Date.now() - t0, body: body.slice(0, 4096) }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ reachable: false, error: "timeout" }); });
    req.on("error", e => resolve({ reachable: false, error: e.code ?? e.message }));
    req.end();
  });
}


// ─── BU status body parser ───────────────────────────────────────────────────
// Kerong HTTP interfaces vary — handles JSON and key=value (lock1=1) formats.

function parseBUStatus(body) {
  if (!body) return null;

  // Try JSON
  try {
    const j = JSON.parse(body);
    const locks = j.locks ?? j.lockers ?? j.compartments ?? null;
    if (locks && Array.isArray(locks)) {
      return {
        format: "json",
        compartments: locks.map(l => ({
          id:     l.id ?? l.no ?? l.num ?? "?",
          status: normaliseLock(l.status ?? l.state ?? l.lock_status),
          fault:  l.fault ?? l.error ?? null,
        })),
      };
    }
    return { format: "json_unknown", topKeys: Object.keys(j).slice(0, 10) };
  } catch { /* not JSON */ }

  // Try key=value: lock1=1&lock2=0
  if (/lock\d+=\d/i.test(body)) {
    const compartments = [];
    for (const m of body.matchAll(/lock(\d+)=(\d)/gi)) {
      compartments.push({ id: parseInt(m[1]), status: m[2] === "1" ? "locked" : "unlocked", fault: null });
    }
    if (compartments.length) return { format: "kv", compartments };
  }

  return { format: "unknown", preview: body.slice(0, 100) };
}

function normaliseLock(raw) {
  if (raw == null) return "unknown";
  const s = String(raw).toLowerCase();
  if (["locked", "1", "true", "close", "closed"].includes(s)) return "locked";
  if (["unlocked", "0", "false", "open"].includes(s))          return "unlocked";
  if (["fault", "error", "alarm"].includes(s))                 return "fault";
  return s;
}


// ─── individual hardware probes ──────────────────────────────────────────────

async function probeBU() {
  const { host, tcpPort, httpPort, httpPath, timeoutMs } = HW_CONFIG.bu;

  const tcp = await tcpProbe(host, tcpPort, timeoutMs);

  let httpResult   = null;
  let boardStatus  = null;

  if (httpPort) {
    httpResult  = await httpProbe(host, httpPort, httpPath, timeoutMs, true);
    boardStatus = parseBUStatus(httpResult.body ?? null);
  }

  return {
    host,
    reachable:    tcp.reachable,
    tcpLatencyMs: tcp.latencyMs,
    http:         httpResult ? { reachable: httpResult.reachable, statusCode: httpResult.statusCode ?? null, latencyMs: httpResult.latencyMs ?? null, error: httpResult.error ?? null } : null,
    boardStatus,
  };
}

async function probeCamera(cam) {
  const [rtsp, http_] = await Promise.all([
    tcpProbe(cam.host, cam.rtspPort, cam.timeoutMs),
    cam.httpPort ? httpProbe(cam.host, cam.httpPort, "/", cam.timeoutMs) : Promise.resolve(null),
  ]);

  const rtspUp = rtsp.reachable;
  const httpUp = http_?.reachable ?? null;

  let health = "offline";
  if (rtspUp || httpUp)             health = "online";
  if (rtspUp && httpUp === false)   health = "degraded";

  return {
    id:    cam.id,
    label: cam.label,
    host:  cam.host,
    health,
    rtsp:  { reachable: rtspUp, latencyMs: rtsp.latencyMs },
    http:  http_ ? { reachable: httpUp, statusCode: http_.statusCode ?? null, latencyMs: http_.latencyMs ?? null } : null,
  };
}

async function probeGateway() {
  const { host, tcpPort, timeoutMs } = HW_CONFIG.gateway;
  const result = await tcpProbe(host, tcpPort, timeoutMs);
  return { host, reachable: result.reachable, latencyMs: result.latencyMs };
}

function getUSBDevices() {
  // fs.existsSync is synchronous and always available — no shell needed
  const present = HW_CONFIG.serialPaths.filter(p => {
    try { fs.accessSync(p); return true; }
    catch { return false; }
  });
  return { serialPathsPresent: present, adapterCount: present.length };
}


// ─── operational verdict ─────────────────────────────────────────────────────

function deriveOperationalState({ bu, cameras, usb }) {
  const issues = [];

  if (bu && !bu.reachable) {
    issues.push({ severity: "critical", component: "bu", msg: "Bridge Unit unreachable on TCP" });
  }

  if (cameras) {
    const offline = cameras.cameras.filter(c => c.health === "offline").length;
    if (offline > 0) {
      issues.push({
        severity:  offline === cameras.cameras.length ? "critical" : "degraded",
        component: "cameras",
        msg:       `${offline}/${cameras.cameras.length} camera(s) offline`,
      });
    }
  }

  if (usb && usb.adapterCount === 0 && HW_CONFIG.serialPaths.length > 0) {
    issues.push({ severity: "degraded", component: "usb", msg: "No RS-485 serial adapter found at expected paths" });
  }

  const faulted = (bu?.boardStatus?.compartments ?? []).filter(c => c.status === "fault");
  if (faulted.length) {
    issues.push({ severity: "critical", component: "locks", msg: `Compartment fault: ${faulted.map(l => l.id).join(", ")}` });
  }

  const open = (bu?.boardStatus?.compartments ?? []).filter(c => c.status === "unlocked");
  if (open.length) {
    issues.push({ severity: "info", component: "locks", msg: `Open compartments: ${open.map(l => l.id).join(", ")}` });
  }

  let state = "healthy";
  if (issues.some(i => i.severity === "critical")) state = "critical";
  else if (issues.some(i => i.severity === "degraded")) state = "degraded";

  return { state, issues };
}


// ─── master export ───────────────────────────────────────────────────────────

async function getHardwareVitals() {
  const safe = async (label, fn) => {
    try   { return await fn(); }
    catch (e) { process.stderr.write(`[hw/${label}] ${e.message}\n`); return null; }
  };

  const [bu, camerasRaw, gateway] = await Promise.all([
    safe("bu",      probeBU),
    safe("cameras", () => Promise.all(HW_CONFIG.cameras.map(c => probeCamera(c)))),
    safe("gateway", probeGateway),
  ]);

  const usb = getUSBDevices();   // sync

  const cameras = camerasRaw ? {
    summary: {
      total:    camerasRaw.length,
      online:   camerasRaw.filter(c => c.health === "online").length,
      degraded: camerasRaw.filter(c => c.health === "degraded").length,
      offline:  camerasRaw.filter(c => c.health === "offline").length,
    },
    cameras: camerasRaw,
  } : null;

  const operational = deriveOperationalState({ bu, cameras, usb });

  return { operational, bu, cameras, gateway, usb };
}

module.exports = { getHardwareVitals, HW_CONFIG };
