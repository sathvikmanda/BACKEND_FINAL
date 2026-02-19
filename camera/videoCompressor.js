const { spawn } = require("child_process");
const path = require("path");

function compressVideo(inputPath) {

  return new Promise((resolve, reject) => {

    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, ".mp4");

    const outputPath = path.join(
      dir,
      base + "_compressed.mp4"
    );

    console.log("🎬 Compressing:", inputPath);

    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vcodec", "libx264",
      "-crf", "28",
      "-preset", "veryfast",
      "-acodec", "aac",
      "-movflags", "+faststart",
      outputPath
    ]);

    ffmpeg.stderr.on("data", d =>
      console.log("[COMPRESS]", d.toString())
    );

    ffmpeg.on("close", code => {
      if (code === 0) {
        console.log("✅ Compression complete:", outputPath);
        resolve(outputPath);
      } else {
        reject(new Error("Compression failed"));
      }
    });

  });
}

module.exports = { compressVideo };