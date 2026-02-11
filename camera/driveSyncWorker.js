const fs = require("fs");
const path = require("path");
const { uploadComplaintFolder } = require("./googleDriveUploader");
const RecordingSession = require("../models/RecordingSession");

async function runDriveSync(baseDir, lockerId) {
  const sessions = await RecordingSession.find({
    status: "completed",
    cloudUploaded: { $ne: true }
  });

  for (const session of sessions) {
    const helpId = session.sessionId;

    try {
      await uploadComplaintFolder(baseDir, lockerId, helpId);

      session.cloudUploaded = true;
      await session.save();

      const localDir = path.join(baseDir, "recordings", "pickup", helpId);
      fs.rmSync(localDir, { recursive: true, force: true });

      console.log("🗑 Deleted local folder:", helpId);

    } catch (err) {
      console.error("❌ Upload failed for", helpId, err.message);
    }
  }
}

module.exports = { runDriveSync };
