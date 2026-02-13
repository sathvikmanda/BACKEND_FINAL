const fs = require("fs");
const path = require("path");

function appendTimeline(baseDir, helpId, message) {
  const dir = path.join(baseDir, helpId);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, "timeline.txt");
  const ts = new Date().toISOString();

  fs.appendFileSync(file, `[${ts}] ${message}\n`);
}

module.exports = { appendTimeline };
