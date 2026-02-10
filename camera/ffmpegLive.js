const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const FFMPEG_PATH = "ffmpeg";

let liveProcess = null;
let viewerCount = 0;
let stopTimer = null;

function startLiveStream(rtspUrl, baseDir) {
  if (liveProcess) {
    viewerCount++;
    console.log("👥 Viewer joined. Count:", viewerCount);
    return;
  }

  const streamDir = path.join(baseDir, "stream");
  if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir);

  console.log("▶ Starting LIVE stream");

  liveProcess = spawn(FFMPEG_PATH, [
  "-rtsp_transport", "tcp",
  "-fflags", "nobuffer",
  "-flags", "low_delay",
  "-probesize", "32",
  "-analyzeduration", "0",

  "-i", rtspUrl,

  "-an",
  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-tune", "zerolatency",
  "-g", "15",
  "-keyint_min", "15",
  "-sc_threshold", "0",

  "-f", "hls",
  "-hls_time", "0.5",
  "-hls_list_size", "2",
  "-hls_flags", "delete_segments+independent_segments",
  "-hls_allow_cache", "0",

  path.join(streamDir, "live.m3u8")
]);


  viewerCount = 1;

  // 🔍 IMPORTANT: attach listeners AFTER spawn
  liveProcess.stderr.on("data", d => {
    console.log("[FFMPEG]", d.toString());
  });

  liveProcess.on("close", code => {
    console.log("⛔ Live stream stopped (code", code + ")");
    liveProcess = null;
    viewerCount = 0;
  });

  liveProcess.on("error", err => {
    console.error("❌ FFmpeg spawn error:", err);
    liveProcess = null;
    viewerCount = 0;
  });
}

function stopLiveStreamDelayed() {
  viewerCount--;

  console.log("👥 Viewer left. Count:", viewerCount);

  if (viewerCount > 0) return;

  if (stopTimer) clearTimeout(stopTimer);

  stopTimer = setTimeout(() => {
    if (liveProcess) {
      console.log("🛑 No viewers — stopping live stream");
      liveProcess.kill("SIGTERM");
      liveProcess = null;
    }
  }, 10_000);
}

module.exports = {
  startLiveStream,
  stopLiveStreamDelayed,
};
