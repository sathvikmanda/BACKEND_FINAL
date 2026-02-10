const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function cutClip({ baseDir, helpId, start, duration, outFile }) {
  return new Promise((resolve, reject) => {
    const input = path.join(baseDir, "recordings", helpId, "full.mp4");
    const clipsDir = path.join(baseDir, "recordings", helpId, "clips");
    fs.mkdirSync(clipsDir, { recursive: true });

    const output = path.join(clipsDir, outFile);

    if (!fs.existsSync(input)) {
      return reject(new Error("full.mp4 missing"));
    }

    const ff = spawn("ffmpeg", [
      "-y",
      "-ss", String(start),
      "-i", input,
      "-t", String(duration),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      output,
    ]);

    ff.on("close", code => {
      if (code === 0) resolve(output);
      else reject(new Error("ffmpeg clip failed"));
    });
  });
}

module.exports = { cutClip };
