const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const RecordingSession = require("../models/RecordingSession");
const { getCameraConfig } = require("./recordingOrchestrator");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const activeSessions = new Map();

async function spawnRecording(rtspUrl, baseDir, helpId, lockerId, cameraId) {
  const sessionDir = path.join(baseDir, "recordings", helpId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const outputFile = path.join(
    sessionDir,
    `${cameraId}_${Date.now()}.mp4`
  );

  const key = helpId + "_" + cameraId;
  console.log("Starting recording:", key);

  const ffmpeg = spawn(FFMPEG, [
    "-fflags", "+genpts",
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "aac",
    // 🔥 Fragmented MP4 — each fragment is self-contained
    // File is valid/playable even if ffmpeg is killed mid-recording
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof+faststart",
    "-frag_duration", "5000000", // fragment every 5 seconds
    "-use_wallclock_as_timestamps", "1",
    outputFile
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  ffmpeg.stderr.on("data", data => {
    console.log(`[FFMPEG ${cameraId}]`, data.toString());
  });

  ffmpeg.on("close", code => {
    console.log(`FFmpeg exited for ${key} with code ${code}`);
  });

  activeSessions.set(key, {
    process: ffmpeg,
    outputFile
  });

  await RecordingSession.create({
    sessionId: helpId,
    helpId,
    lockerId,
    cameraId,
    rawVideoFile: outputFile,
    startedAt: new Date()
  });
}

async function startRecording(baseDir, helpId, lockerId) {
  const cameras = getCameraConfig();
  if (!cameras || cameras.length === 0) {
    console.error("No cameras configured");
    return;
  }

  for (const cam of cameras) {
    if (!cam.rtsp) {
      console.error(`Missing RTSP URL for camera: ${cam.id}`);
      continue;
    }
    await spawnRecording(cam.rtsp, baseDir, helpId, lockerId, cam.id);
  }
}

async function stopRecording({ helpId, cameraId }) {
  const key = helpId + "_" + cameraId;
  const entry = activeSessions.get(key);
  if (!entry) return;

  const ffmpeg = entry.process;
  console.log("Stopping:", key);

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      console.warn(`FFmpeg SIGKILL fallback for ${key}`);
      ffmpeg.kill("SIGKILL");
      activeSessions.delete(key);
      resolve();
    }, 8000); // hard kill after 8s

    ffmpeg.on("close", code => {
      clearTimeout(timeout);
      console.log(`FFmpeg exited for ${key} with code ${code}`);
      activeSessions.delete(key);
      console.log("Recording finalized:", key);
      resolve();
    });

    // SIGINT is the correct graceful stop for ffmpeg on Android
    ffmpeg.kill("SIGINT");
  });
}

async function stopAllRecordingsForSession(helpId) {
  const sessions = await RecordingSession.find({
    sessionId: helpId,
    status: "active"
  });

  for (const session of sessions) {
    await stopRecording({
      helpId,
      cameraId: session.cameraId
    });
    session.status = "completed";
    session.endedAt = new Date();
    session.cloudUploaded = false;
    await session.save();
  }
}

module.exports = {
  activateRecording: startRecording,
  deactivateRecording: stopRecording,
  stopAllRecordingsForSession
};