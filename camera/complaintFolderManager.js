const fs = require("fs");
const path = require("path");

function ensureComplaintDir(baseDir, helpId) {
  const dir = path.join(baseDir, "recordings", helpId);
  const clipsDir = path.join(dir, "clips");

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir);

  return dir;
}

module.exports = { ensureComplaintDir };