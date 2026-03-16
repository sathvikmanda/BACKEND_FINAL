const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// Try to recover a corrupted MP4 (missing moov atom)
function recoverVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, ".mp4");
    const recoveredPath = path.join(dir, base + "_recovered.mp4");

    console.log("🔧 Attempting recovery:", inputPath);

    const ffmpeg = spawn(FFMPEG, [
      "-y",
      "-fflags", "+genpts+igndts",
      "-err_detect", "ignore_err",
      "-i", inputPath,
      "-c", "copy",
      "-movflags", "+faststart",
      recoveredPath
    ]);

    ffmpeg.stderr.on("data", d => console.log("[RECOVER]", d.toString()));

    ffmpeg.on("close", code => {
      if (code === 0 && fs.existsSync(recoveredPath)) {
        const size = fs.statSync(recoveredPath).size;
        if (size > 10000) { // at least 10KB — real content
          console.log("✅ Recovery successful:", recoveredPath);
          resolve(recoveredPath);
        } else {
          fs.unlinkSync(recoveredPath);
          reject(new Error("Recovered file too small — likely empty"));
        }
      } else {
        if (fs.existsSync(recoveredPath)) fs.unlinkSync(recoveredPath);
        reject(new Error("Recovery failed with code " + code));
      }
    });
  });
}

function compressVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, ".mp4");
    const outputPath = path.join(dir, base + "_compressed.mp4");

    console.log("🎬 Compressing:", inputPath);

    const ffmpeg = spawn(FFMPEG, [
      "-y",
      "-fflags", "+genpts+igndts",
      "-err_detect", "ignore_err",
      "-i", inputPath,
      "-vcodec", "libx264",
      "-crf", "28",
      "-preset", "veryfast",
      "-acodec", "aac",
      "-movflags", "+faststart",
      outputPath
    ]);

    ffmpeg.stderr.on("data", d => console.log("[COMPRESS]", d.toString()));

    ffmpeg.on("close", code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        if (size > 10000) {
          console.log("✅ Compression complete:", outputPath);
          resolve(outputPath);
        } else {
          fs.unlinkSync(outputPath);
          reject(new Error("Compressed file too small"));
        }
      } else {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        reject(new Error("Compression failed with code " + code));
      }
    });
  });
}

// Main entry: try compress → if fails try recover then compress → if still fails skip
async function compressOrRecover(inputPath) {
  // First try direct compression
  try {
    return await compressVideo(inputPath);
  } catch (err) {
    console.warn("⚠️ Direct compression failed, attempting recovery:", err.message);
  }

  // Try recovery first then compress
  let recoveredPath = null;
  try {
    recoveredPath = await recoverVideo(inputPath);
    const compressedPath = await compressVideo(recoveredPath);
    // Clean up recovered file
    if (fs.existsSync(recoveredPath)) fs.unlinkSync(recoveredPath);
    return compressedPath;
  } catch (err) {
    // Clean up recovered file if it exists
    if (recoveredPath && fs.existsSync(recoveredPath)) fs.unlinkSync(recoveredPath);
    throw new Error("Both compression and recovery failed: " + err.message);
  }
}

module.exports = { compressVideo: compressOrRecover };