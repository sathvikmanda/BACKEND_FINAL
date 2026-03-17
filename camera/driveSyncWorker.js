const fs = require("fs");
const path = require("path");
const RecordingSession = require("../models/RecordingSession");
const { uploadComplaintFolder, uploadSingleFileToDrive } = require("./googleDriveUploader");
const { compressVideo } = require("./videoCompressor");
const { appendCompressionStats, appendTimeline } = require("./timelineWriter");

async function runDriveSync(baseDir, lockerId) {
  console.log("run drive sync entered");

  const sessions = await RecordingSession.find({
    status: "completed",
    cloudUploaded: { $ne: true }
  });

  for (const session of sessions) {
    const helpId = session.sessionId;
    const recordingsBase = path.join(baseDir, "recordings");
    const localDir = path.join(recordingsBase, helpId);

    // Folder already cleaned up — mark as uploaded and move on silently
    if (!fs.existsSync(localDir)) {
      await RecordingSession.updateMany(
        { sessionId: helpId },
        { cloudUploaded: true, uploadedAt: new Date() }
      );
      continue;
    }

    try {
      const files = fs.readdirSync(localDir)
        .filter(f => f.endsWith(".mp4"));

      for (const file of files) {
        if (file.includes("_compressed")) continue;
        const fullPath = path.join(localDir, file);
        const compressedPath = await compressVideo(fullPath);
        appendCompressionStats(recordingsBase, helpId, fullPath, compressedPath);
        fs.unlinkSync(fullPath);
      }

      appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD STARTED");
      await uploadComplaintFolder(baseDir, lockerId, helpId);
      appendTimeline(recordingsBase, helpId, "CLOUD UPLOAD SUCCESSFUL");

      const timelinePath = path.join(localDir, "timeline.txt");
      await uploadSingleFileToDrive(timelinePath, lockerId, helpId);

      await RecordingSession.updateMany(
        { sessionId: helpId },
        { cloudUploaded: true, uploadedAt: new Date() }
      );

      fs.rmSync(localDir, { recursive: true, force: true });
      console.log("☁ Uploaded & cleaned:", helpId);

    } catch (err) {
      console.error("Upload failed:", helpId, err.message);
    }
  }
}

module.exports = { runDriveSync };