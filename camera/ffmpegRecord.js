import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const FFMPEG_PATH = "ffmpeg";

export function recordClip({ rtspUrl, baseDir, helpId, cameraId, type }) {
  const recordingsDir = path.join(baseDir, "recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

  // ✅ Create a subfolder per helpId
  const helpDir = path.join(recordingsDir, helpId);
  if (!fs.existsSync(helpDir)) fs.mkdirSync(helpDir);

  // ✅ Name the file after cameraId so the sync worker can match it
  const filename = `${cameraId}.mp4`;
  const outputPath = path.join(helpDir, filename);

  console.log("Recording", filename);

  const p = spawn(FFMPEG_PATH, [
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-c", "copy",
    "-t", "10",
    "-movflags", "+faststart",
    outputPath
  ], {
    stdio: ["pipe", "ignore", "pipe"]
  });

  return new Promise(resolve => {
    p.on("close", () => resolve(filename));
  });
}