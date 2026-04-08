const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { appendCompressionStats, appendTimeline } = require("./timelineWriter");
const RecordingSession = require("../models/RecordingSession");

// ==============================
// 🔐 AUTH
// ==============================

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "credentials", "google-drive.json"),
  scopes: ["https://www.googleapis.com/auth/drive"]
});

async function getDrive() {
  const client = await auth.getClient();
  return google.drive({
    version: "v3",
    auth: client
  });
}

// ==============================
// 📁 GET OR CREATE FOLDER
// ==============================

async function getOrCreateFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    supportsAllDrives: true,
    fields: "id"
  });

  return folder.data.id;
}

// ==============================
// 🔥 FIXED DB UPDATE FUNCTION
// ==============================

async function updateRecordingAfterUpload(helpId, cameraId, fileId) {
  try {
    const embedUrl = `https://drive.google.com/file/d/${fileId}/preview`;
    const viewUrl  = `https://drive.google.com/file/d/${fileId}/view`;

    const updated = await RecordingSession.findOneAndUpdate(
      { sessionId: helpId, cameraId: cameraId },   // ✅ FIXED
      {
        $set: {
          driveFileId: fileId,
          embedUrl,
          viewUrl,
          cloudUploaded: true,
          uploadedAt: new Date(),
          status: "completed",
          endedAt: new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      console.log("⚠️ No matching recording found:", helpId, cameraId);
    } else {
      console.log("✅ Recording updated:", helpId, cameraId);
    }

  } catch (err) {
    console.error("❌ Upload update failed:", err);
  }
}

// ==============================
// 🎥 UPLOAD VIDEO + SAVE EMBED
// ==============================

async function uploadVideoAndSaveEmbed(filePath, lockerId, helpId, cameraId) {
  const drive      = await getDrive();
  const rootFolder = process.env.GDRIVE_ROOT_FOLDER;

  const lockerFolderId    = await getOrCreateFolder(drive, lockerId, rootFolder);
  const complaintFolderId = await getOrCreateFolder(drive, helpId, lockerFolderId);

  const fileName = path.basename(filePath);

  // 🔍 Check if already uploaded
  const existing = await drive.files.list({
    q: `'${complaintFolderId}' in parents and name='${fileName}' and trashed=false`,
    fields: "files(id)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  let fileId;

  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id;
    console.log(`[DRIVE] Already exists — reusing: ${fileId}`);
  } else {
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [complaintFolderId] },
      media: { body: fs.createReadStream(filePath) },
      supportsAllDrives: true,
      fields: "id"
    });

    fileId = res.data.id;
    console.log(`[DRIVE] Uploaded — fileId: ${fileId}`);
  }

  // 🔓 Make public for iframe
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true
  });

  // 🔥 UPDATE DB (FIXED)
  await updateRecordingAfterUpload(helpId, cameraId, fileId);

  console.log(`[DRIVE] embedUrl saved — ${helpId}/${cameraId}`);

  return {
    fileId,
    embedUrl: `https://drive.google.com/file/d/${fileId}/preview`,
    viewUrl: `https://drive.google.com/file/d/${fileId}/view`
  };
}

// ==============================
// 📦 EXISTING FUNCTIONS (UNCHANGED)
// ==============================

async function uploadSingleFileToDrive(filePath, lockerId, helpId) {
  const drive = await getDrive();
  const rootFolder = process.env.GDRIVE_ROOT_FOLDER;

  const lockerFolderId = await getOrCreateFolder(drive, lockerId, rootFolder);
  const complaintFolderId = await getOrCreateFolder(drive, helpId, lockerFolderId);

  // ⚠️ NOTE: This does NOT update DB (keep for non-video use)
  await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [complaintFolderId]
    },
    media: {
      body: fs.createReadStream(filePath)
    },
    supportsAllDrives: true
  });
}

// ==============================
// 📦 BULK UPLOAD (UNCHANGED)
// ==============================

async function uploadComplaintFolder(baseDir, lockerId, helpId) {
  const drive = await getDrive();
  const rootFolder = process.env.GDRIVE_ROOT_FOLDER;

  if (!rootFolder) {
    throw new Error("GDRIVE_ROOT_FOLDER not set in .env");
  }

  const localDir = path.join(baseDir, "recordings", helpId);

  if (!fs.existsSync(localDir)) {
    throw new Error("Local complaint folder not found: " + localDir);
  }

  console.log("☁ Uploading complaint:", helpId);

  const lockerFolderId = await getOrCreateFolder(drive, lockerId, rootFolder);
  const complaintFolderId = await getOrCreateFolder(drive, helpId, lockerFolderId);

  async function uploadRecursive(dir, parentId) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);

      if (fs.lstatSync(fullPath).isDirectory()) {
        const folderId = await getOrCreateFolder(drive, item, parentId);
        await uploadRecursive(fullPath, folderId);
      } else {
        await drive.files.create({
          requestBody: { name: item, parents: [parentId] },
          media: { body: fs.createReadStream(fullPath) },
          supportsAllDrives: true
        });
      }
    }
  }

  await uploadRecursive(localDir, complaintFolderId);

  console.log("✅ Complaint uploaded successfully:", helpId);
  appendTimeline(baseDir, helpId, "CLOUD UPLOADED SUCCESSFULLY");
}

module.exports = {
  uploadComplaintFolder,
  uploadSingleFileToDrive,
  uploadVideoAndSaveEmbed,
  updateRecordingAfterUpload
};