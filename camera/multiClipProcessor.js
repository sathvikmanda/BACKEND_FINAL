const RecordingEvent = require("../models/RecordingEvent");
const RecordingSession = require("../models/RecordingSession");
const { CLIP_RULES } = require("./clipRules");
const { cutClip } = require("./clipCutter");
const { appendTimeline } = require("./timelineWriter");

async function generateClipsForSession(helpId, baseDir) {
  const session = await RecordingSession.findOne({ sessionId: helpId });
  if (!session || !session.endedAt) {
    throw new Error("Recording not finalized");
  }

  const events = await RecordingEvent.find({
    sessionId: helpId,
    status: "resolved",
    type: { $in: Object.keys(CLIP_RULES) },
  }).sort({ occurredAt: 1 });

  const startTs = session.startedAt.getTime();
  const clips = [];

  let counters = {};

  for (const e of events) {
    const rule = CLIP_RULES[e.type];
    if (!rule) continue;

    counters[e.type] = (counters[e.type] || 0) + 1;

    const eventSec = (e.occurredAt.getTime() - startTs) / 1000;
    const start = Math.max(0, eventSec - rule.before);
    const duration = rule.before + rule.after;

    const filename = `${e.type}_${String(counters[e.type]).padStart(3, "0")}.mp4`;

    const out = await cutClip({
      baseDir,
      helpId,
      start,
      duration,
      outFile: filename,
    });

    appendTimeline(baseDir, helpId, `CLIP GENERATED: ${filename}`);
    clips.push(out);
  }

  return clips;
}

module.exports = { generateClipsForSession };
