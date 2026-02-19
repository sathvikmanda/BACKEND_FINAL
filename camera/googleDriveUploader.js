const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { appendCompressionStats, appendTimeline } = require("./timelineWriter");
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
// ⬆️ FILE UPLOAD
// ==============================

async function uploadFile(drive, filePath, parentId) {

  const fileName = path.basename(filePath);

  // 🔍 Check if file already exists
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name='${fileName}' and trashed=false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (existing.data.files.length > 0) {
    console.log("🔁 File already exists, skipping:", fileName);
    return;
  }

  // ⬆ Upload only if not exists
  await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId]
    },
    media: {
      body: fs.createReadStream(filePath)
    },
    supportsAllDrives: true
  });

  console.log("☁ Uploaded:", fileName);
}
async function uploadSingleFileToDrive(filePath, lockerId, helpId) {

  const drive = await getDrive();
  const rootFolder = process.env.GDRIVE_ROOT_FOLDER;

  const lockerFolderId = await getOrCreateFolder(drive, lockerId, rootFolder);
  const complaintFolderId = await getOrCreateFolder(drive, helpId, lockerFolderId);

  await uploadFile(drive, filePath, complaintFolderId);
}


// ==============================
// 📦 UPLOAD FULL COMPLAINT FOLDER
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

        await uploadFile(drive, fullPath, parentId);

      }
    }
  }

  await uploadRecursive(localDir, complaintFolderId);

  console.log("✅ Complaint uploaded successfully:", helpId);
  appendTimeline(baseDir, helpId, "CLOUD UPLOADED SUCCESSFULLY");
}

module.exports = { uploadComplaintFolder, uploadSingleFileToDrive };