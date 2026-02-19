const fs = require("fs");
const path = require("path");

function appendTimeline(baseDir, helpId, message) {
  const dir = path.join(baseDir, "recordings", helpId);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, "timeline.txt");
  const ts = new Date().toISOString();

  fs.appendFileSync(file, `[${ts}] ${message}\n`);
}

function appendCompressionStats(baseDir, helpId, originalPath, compressedPath) {

  const originalSize = fs.statSync(originalPath).size;
  const compressedSize = fs.statSync(compressedPath).size;

  const formatSize = bytes =>
    (bytes / (1024 * 1024)).toFixed(2) + " MB";

  appendTimeline(
    baseDir,
    helpId,
    `Compression completed:
Original: ${formatSize(originalSize)}
Compressed: ${formatSize(compressedSize)}
Saved: ${formatSize(originalSize - compressedSize)}`
  );
}

module.exports = {
  appendTimeline,
  appendCompressionStats
};