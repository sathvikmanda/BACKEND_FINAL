const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const RecordingSession = require("../models/RecordingSession");
const activeSessions = new Map();


async function startRecording(rtspUrl, baseDir, helpId, lockerId) {
  // ---------- SAFETY GUARDS ----------
  
  if (!rtspUrl) {
    console.error("startRecording aborted: rtspUrl missing");
    return;
  }

  if (!baseDir) {
    console.error("startRecording aborted: baseDir missing");
    return;
  }

  if (!helpId) {
    console.error("startRecording aborted: helpId missing");
    return;
  }

  if (activeSessions.has(helpId)) {
    console.log("Recording already active for:", helpId);
    return;
  }

  console.log("startRecording called with:", {
    helpId,
    lockerId,
    rtspUrl,
    baseDir,
  });

  // ---------- PATH SETUP ----------
  const dir = path.join(baseDir, helpId);
  fs.mkdirSync(dir, { recursive: true });

  const outputPath = path.join(dir, "full.mp4");

  // ---------- DB ENTRY ----------
  const session = await RecordingSession.create({
    sessionId: helpId,
    lockerId,
    rawVideoFile: "full.mp4",
    startedAt: new Date(),
    status: "active",
  });

  // ---------- FFMPEG ----------
  const ffmpeg = spawn("ffmpeg", [
    "-rtsp_transport", "tcp",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-i", rtspUrl,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath,
  ]);

  ffmpeg.stderr.on("data", d =>
    console.log("[FFMPEG]", d.toString())
  );

  ffmpeg.on("error", err => {
    console.error("❌ FFMPEG error:", err);
  });

  activeSessions.set(helpId, {
  process: ffmpeg,
  session,
  baseDir,
});


  console.log("🎥 Recording started:", outputPath);
}

/**
 * Stops an active recording
 * @param {{ sessionId: string }}
 */
async function stopRecording(sessionId ) {
  console.log("stopRecording ENTERED for:", sessionId);

  if (!sessionId) {
    console.error("stopRecording aborted: sessionId missing");
    return;
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    console.warn("No active recording for:", sessionId);
    return;
  }

  const { process: ffmpeg, session, baseDir } = entry;

  console.log("Stopping recording for", sessionId);

ffmpeg.kill("SIGTERM");

await new Promise(resolve => {
  ffmpeg.on("close", resolve);
});


  await RecordingSession.findByIdAndUpdate(session._id, {
    endedAt: new Date(),
    status: "completed",
  });

  activeSessions.delete(sessionId);

  console.log("Recording finalized for", sessionId);
  const { runDriveSync } = require("./driveSyncWorker");

runDriveSync(baseDir, "L00002")
  .catch(err => console.error("Immediate upload error:", err));

}

module.exports = {
  activateRecording: startRecording,
  deactivateRecording: stopRecording,
};
