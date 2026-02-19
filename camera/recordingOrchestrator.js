const path = require("path");
const fs = require("fs");
let SYSTEM_READY = false;
let CAMERA_CONFIG = [];

async function initRecordingSystem({ baseDir, cameras, io }) {
  if (SYSTEM_READY) return;

  if (!cameras || cameras.length === 0) {
    throw new Error("No cameras configured");
  }

  CAMERA_CONFIG = cameras;

  const recordingsDir = path.join(baseDir, "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });

  console.log("Multi-Camera Recording System Initialized");

  SYSTEM_READY = true;
}

function getCameraConfig() {
  return CAMERA_CONFIG;
}

module.exports = {
  initRecordingSystem,
  getCameraConfig
};