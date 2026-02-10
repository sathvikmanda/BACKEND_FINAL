import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const FFMPEG_PATH = "ffmpeg";

export function recordClip({ rtspUrl, baseDir, helpId, type }) {
  const recordingsDir = path.join(baseDir, "recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

  const filename = `${type}_${helpId}_${Date.now()}.mp4`;
  const outputPath = path.join(recordingsDir, filename);

  console.log("🎥 Recording", filename);

  const p = spawn(FFMPEG_PATH, [
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-t", "10",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    outputPath
  ]);

  return new Promise(resolve => {
    p.on("close", () => resolve(filename));
  });
}
