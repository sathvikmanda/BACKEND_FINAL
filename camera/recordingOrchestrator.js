const fs = require("fs");
const path = require("path");

let SYSTEM_READY = false;

async function initRecordingSystem({ baseDir, cameraRtspUrl, io }) {
  if (SYSTEM_READY) return;

  if (!cameraRtspUrl) {
    throw new Error("CAMERA_RTSP is missing");
  }

  const recordingsDir = path.join(baseDir, "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });

  console.log("🎥 Camera Recording System Initialized");
  console.log("   📁", recordingsDir);
  console.log("   📡", cameraRtspUrl);

  if (io) {
    io.on("connection", socket => {
      console.log("📡 Client connected:", socket.id);
    });
  }

  SYSTEM_READY = true;
}

module.exports = { initRecordingSystem };
