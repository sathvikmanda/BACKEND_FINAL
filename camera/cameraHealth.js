const { spawn } = require("child_process");
const url = require("url");

const FFMPEG_PROBE = process.env.FFPROBE_PATH || "ffprobe";

function parseRtspEndpoint(rtspUrl) {
  try {
    const u = new URL(rtspUrl);
    return {
      host: u.hostname,
      port: u.port || 554,
      protocol: u.protocol,
      path: u.pathname + u.search,
    };
  } catch (e) {
    return null;
  }
}

function probeCamera(rtspUrl, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const data = { online: false, latency: null, error: null, details: null };
    const start = Date.now();

    const args = [
      "-v", "error",
      "-rtsp_transport", "tcp",
      "-stimeout", String(timeoutMs * 1000),
      "-i", rtspUrl,
      "-show_streams",
      "-show_format",
      "-print_format", "json",
    ];

    const p = spawn(FFMPEG_PROBE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (!p.killed) p.kill("SIGTERM");
      data.error = "probe_timeout";
      data.latency = Date.now() - start;
      resolve(data);
    }, timeoutMs);

    p.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    p.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    p.on("error", (err) => {
      clearTimeout(timer);
      data.error = err.message;
      data.latency = Date.now() - start;
      resolve(data);
    });

    p.on("close", (code) => {
      clearTimeout(timer);
      data.latency = Date.now() - start;

      if (code === 0) {
        data.online = true;
        try {
          data.details = JSON.parse(stdout || "{}");
        } catch (errJson) {
          data.details = null;
        }
        return resolve(data);
      }

      data.error = stderr.trim() || `ffprobe_exit_${code}`;
      resolve(data);
    });
  });
}

async function checkCameraVitals(camera) {
  if (!camera || !camera.id || !camera.rtsp) {
    throw new Error("Camera config missing required fields: id, rtsp");
  }

  const endpoint = parseRtspEndpoint(camera.rtsp);
  if (!endpoint) {
    return {
      id: camera.id,
      rtsp: camera.rtsp,
      online: false,
      reason: "bad_rtsp_url",
      parsed: null,
    };
  }

  const probe = await probeCamera(camera.rtsp);
  return {
    id: camera.id,
    rtsp: camera.rtsp,
    online: probe.online,
    latencyMs: probe.latency,
    reason: probe.online ? "ok" : probe.error || "probe_failed",
    details: probe.details,
    parsed: endpoint,
  };
}

async function checkAllCameras(cameras = []) {
  const results = [];
  for (const cam of cameras) {
    try {
      results.push(await checkCameraVitals(cam));
    } catch (err) {
      results.push({
        id: cam?.id || "unknown",
        rtsp: cam?.rtsp || null,
        online: false,
        reason: err.message,
      });
    }
  }
  return results;
}

module.exports = {
  checkCameraVitals,
  checkAllCameras,
};
