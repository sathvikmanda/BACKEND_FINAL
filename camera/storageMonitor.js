const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const RecordingSession = require("../models/RecordingSession");

function checkStorageAndSync(driveLetter = "C:") {
  return new Promise((resolve, reject) => {
    // ==============================
    // 🪟 WINDOWS
    // ==============================
    if (process.platform === "win32") {
      exec("wmic logicaldisk get size,freespace,caption", (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.trim().split("\n").slice(1);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts[0] === driveLetter) {
            const free = parseInt(parts[1]);
            const size = parseInt(parts[2]);
            const used = size - free;
            return resolve({
              total: size,
              used: used,
              available: free,
              percentUsed: (used / size) * 100
            });
          }
        }
        reject(new Error("Drive not found"));
      });
    }
    // ==============================
    // 🐧 LINUX / ANDROID / MAC
    // ==============================
    else {
      exec("df -k /", (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.trim().split("\n");
        const parts = lines[1].split(/\s+/);
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const available = parseInt(parts[3]) * 1024;
        resolve({
          total,
          used,
          available,
          percentUsed: (used / total) * 100
        });
      });
    }
  });
}

// ==============================
// 🧹 CLEAN UP ORPHANED FOLDERS
// Folders on disk with no DB record or stuck in non-completed state
// older than maxAgeHours — deletes them to free space
// ==============================
async function cleanOrphanedFolders(baseDir, maxAgeHours = 24) {
  const recordingsDir = path.join(baseDir, "recordings");
  if (!fs.existsSync(recordingsDir)) return;

  const folders = fs.readdirSync(recordingsDir);
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  for (const folder of folders) {
    const folderPath = path.join(recordingsDir, folder);
    if (!fs.lstatSync(folderPath).isDirectory()) continue;

    const stat = fs.statSync(folderPath);
    const ageMs = now - stat.mtimeMs;

    if (ageMs < maxAgeMs) continue; // too recent — skip

    // Check if it's uploaded already
    const session = await RecordingSession.findOne({ sessionId: folder });

    if (!session) {
      // No DB record at all — orphan, delete it
      console.log("🧹 Removing orphaned folder (no DB record):", folder);
      fs.rmSync(folderPath, { recursive: true, force: true });
      continue;
    }

    if (session.cloudUploaded) {
      // Already uploaded but folder wasn't cleaned — clean it now
      console.log("🧹 Removing already-uploaded folder:", folder);
      fs.rmSync(folderPath, { recursive: true, force: true });
      continue;
    }

    console.log("⏳ Skipping folder (not yet uploaded):", folder);
  }
}

module.exports = { checkStorageAndSync, cleanOrphanedFolders };