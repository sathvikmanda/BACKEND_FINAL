const fs = require("fs");
const path = require("path");
const RecordingSession = require("../models/RecordingSession");
const { uploadComplaintFolder, uploadSingleFileToDrive } = require("./googleDriveUploader");
const { appendTimeline } = require("./timelineWriter");

// 🔒 Prevent two syncs running simultaneously
let syncInProgress = false;

async function runDriveSync(baseDir, lockerId) {
  if (syncInProgress) {
    console.log("Drive sync already in progress — skipping");
    return;
  }

  syncInProgress = true;
  console.log("run drive sync entered");

  try {
    const sessions = await RecordingSession.find({
      status: "completed",
      cloudUploaded: { $ne: true }
    });

    for (const session of sessions) {
      const helpId = session.sessionId;
      const recordingsBase = path.join(baseDir, "recordings");
      const localDir = path.join(recordingsBase, helpId);

      // Folder already cleaned up — mark as uploaded silently
      if (!fs.existsSync(localDir)) {
        await RecordingSession.updateMany(
          { sessionId: helpId },
          { cloudUploaded: true, uploadedAt: new Date() }
        );
        continue;
      }

      try {
        // ── Upload raw MP4s directly (no local compression) ──
        appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD STARTED");
        await uploadComplaintFolder(baseDir, lockerId, helpId);
        appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD SUCCESSFUL");

        // ── Re-upload updated timeline ──
        const timelinePath = path.join(localDir, "timeline.txt");
        if (fs.existsSync(timelinePath)) {
          await uploadSingleFileToDrive(timelinePath, lockerId, helpId);
        }

        // ── Mark uploaded and clean folder ──
        await RecordingSession.updateMany(
          { sessionId: helpId },
          { cloudUploaded: true, uploadedAt: new Date() }
        );

        fs.rmSync(localDir, { recursive: true, force: true });
        console.log("☁ Uploaded & cleaned:", helpId);

      } catch (err) {
        console.error("Upload failed:", helpId, err.message);
        appendTimeline(recordingsBase, helpId, `UPLOAD ERROR: ${err.message}`);
      }
    }
  } finally {
    syncInProgress = false;
  }
}

module.exports = { runDriveSync };