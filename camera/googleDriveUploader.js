const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

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

async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    supportsAllDrives: true,
    fields: "id"
  });

  return res.data.id;
}

async function uploadFile(drive, filePath, parentId) {
  const fileName = path.basename(filePath);

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

async function uploadComplaintFolder(baseDir, lockerId, helpId) {
  const drive = await getDrive();   // 🔥 THIS MUST EXIST

  const rootFolder = process.env.GDRIVE_ROOT_FOLDER;

  const lockerFolderId = await createFolder(drive, lockerId, rootFolder);
  const complaintFolderId = await createFolder(drive, helpId, lockerFolderId);

  const localDir = path.join(baseDir, helpId);

  const files = fs.readdirSync(localDir);

  for (const file of files) {
    const fullPath = path.join(localDir, file);

    if (fs.lstatSync(fullPath).isFile()) {
      await uploadFile(drive, fullPath, complaintFolderId);
    }
  }

  console.log("✅ Complaint folder uploaded:", helpId);
}

module.exports = { uploadComplaintFolder };
