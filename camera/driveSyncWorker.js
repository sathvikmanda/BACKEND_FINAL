const fs = require("fs");
const path = require("path");
const RecordingSession = require("../models/RecordingSession");
const { uploadVideoAndSaveEmbed } = require("./googleDriveUploader");
const { appendTimeline } = require("./timelineWriter");

let syncInProgress = false;

async function runDriveSync(baseDir, lockerId) {
  if (syncInProgress) {
    console.log("Drive sync already in progress — skipping");
    return;
  }

  syncInProgress = true;
  console.log("🚀 Drive sync started");

  try {
    const sessions = await RecordingSession.find({
      status: "completed",
      cloudUploaded: { $ne: true }
    });

    for (const session of sessions) {
      const helpId   = session.sessionId;
      const cameraId = session.cameraId;

      const recordingsBase = path.join(baseDir, "recordings");
      const localDir       = path.join(recordingsBase, helpId);

      if (!fs.existsSync(localDir)) {
        continue;
      }

      try {
        appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD STARTED");

        const files = fs.readdirSync(localDir);

        for (const file of files) {
          if (!file.endsWith(".mp4")) continue;

          // ✅ FIX: only upload the file that belongs to THIS session's cameraId
          // Assumes files are named like cam1.mp4, cam2.mp4
          // Adjust this check if your naming convention differs
          if (!file.includes(cameraId)) {
            console.log(`⏭ Skipping ${file} — doesn't match cameraId ${cameraId}`);
            continue;
          }

          const fullPath = path.join(localDir, file);
          console.log(`🎥 Uploading: ${fullPath} for ${cameraId}`);

          await uploadVideoAndSaveEmbed(fullPath, lockerId, helpId, cameraId);
        }

        appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD SUCCESSFUL");

        // Belt-and-suspenders: mark uploaded even if uploader already did it
        await RecordingSession.updateOne(
          { sessionId: helpId, cameraId: cameraId },
          { $set: { cloudUploaded: true, uploadedAt: new Date() } }
        );

        // 🧹 Only clean the folder after ALL cameras for this helpId are uploaded.
        // Check if any sibling sessions for the same helpId are still pending.
        const pending = await RecordingSession.countDocuments({
          sessionId: helpId,
          cloudUploaded: { $ne: true }
        });

        if (pending === 0) {
          fs.rmSync(localDir, { recursive: true, force: true });
          console.log(`🗑 Cleaned local folder: ${helpId}`);
        } else {
          console.log(`📂 Keeping folder — ${pending} camera(s) still pending for ${helpId}`);
        }

        console.log(`☁ Uploaded: ${helpId} / ${cameraId}`);

      } catch (err) {
        console.error(`❌ Upload failed: ${helpId} / ${cameraId}`, err.message);
        appendTimeline(recordingsBase, helpId, `UPLOAD ERROR: ${err.message}`);
      }
    }

  } finally {
    syncInProgress = false;
  }
}

module.exports = { runDriveSync };