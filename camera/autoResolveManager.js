// camera/autoResolveManager.js

const fs = require("fs");
const path = require("path");

const RecordingEvent = require("../models/RecordingEvent");
const RecordingSession = require("../models/RecordingSession");
const HelpRequest = require("../models/helpRequest");

const { deactivateRecording } = require("./recordingSessionManager");
const { generateClipsForSession } = require("./multiClipProcessor");
const { EVENT_AUTO_RESOLVE_MS } = require("./autoResolveRules");
const { appendTimeline } = require("./timelineWriter");

/* ---------------- CONFIG ---------------- */
const IDLE_TIMEOUT_MS = 30_000;
const MIN_RECORDING_SECONDS = 15;

const idleTimers = new Map();

/* ---------------- EVENT AUTO RESOLVE ---------------- */
function autoResolveEvent(event) {
  const ttl = EVENT_AUTO_RESOLVE_MS[event.type];
  if (!ttl) return;

  setTimeout(async () => {
    const fresh = await RecordingEvent.findById(event._id);
    if (!fresh || fresh.status !== "active") return;

    fresh.status = "resolved";
    fresh.resolvedAt = new Date();
    await fresh.save();

    appendTimeline(
      process.cwd(),
      fresh.sessionId,
      `EVENT AUTO-RESOLVED: ${fresh.type}`
    );

    console.log(`⏲️ Event auto-resolved → ${fresh.type} (${fresh.sessionId})`);
  }, ttl);
}

/* ---------------- COMPLAINT AUTO RESOLVE ---------------- */
async function autoResolveComplaint(helpId, baseDir) {
  console.log("🤖 Auto-resolve check for", helpId);

  const activeEvents = await RecordingEvent.countDocuments({
    sessionId: helpId,
    status: "active",
    type: { $nin: ["complaint_open", "complaint_resolved"] },
  });

  if (activeEvents > 0) {
    console.log("⏳ Complaint still has active events:", helpId);
    return;
  }

  const session = await RecordingSession.findOne({
    sessionId: helpId,
    status: "active",
  });

  if (!session) {
    console.log("ℹ️ No active recording session for", helpId);
    return;
  }

  const duration =
    (Date.now() - session.startedAt.getTime()) / 1000;

  if (duration < MIN_RECORDING_SECONDS) {
    console.log("⏳ Recording too short, delaying auto-resolve");
    scheduleAutoResolve(helpId, baseDir);
    return;
  }

  const complaint = await HelpRequest.findOne({
    helpId,
    status: { $ne: "resolved" },
  });

  if (!complaint) return;

  console.log("✅ Auto-resolving complaint:", helpId);

  complaint.status = "resolved";
  await complaint.save();

  appendTimeline(baseDir, helpId, "COMPLAINT AUTO-RESOLVED");

  await deactivateRecording({ sessionId: helpId, reason: "ALL" });

  await new Promise(r => setTimeout(r, 3000));

  const sourcePath = path.join(
  baseDir,
  "recordings",
  "pickup",
  helpId,
  session.rawVideoFile
);


  if (!fs.existsSync(sourcePath)) {
    console.error("❌ Recording missing for", helpId);
    return;
  }

  const clips = await generateClipsForSession(helpId, baseDir);
  complaint.clips = clips;
  await complaint.save();

  console.log(`✂️ Clips generated for ${helpId}: ${clips.length}`);
}

/* ---------------- SCHEDULER ---------------- */
function scheduleAutoResolve(helpId, baseDir) {
  if (idleTimers.has(helpId)) {
    clearTimeout(idleTimers.get(helpId));
  }

  const timer = setTimeout(() => {
    autoResolveComplaint(helpId, baseDir)
      .catch(err => console.error("Auto-resolve error:", err))
      .finally(() => idleTimers.delete(helpId));
  }, IDLE_TIMEOUT_MS);

  idleTimers.set(helpId, timer);
  console.log("⏱️ Auto-resolve timer scheduled for", helpId);
}

module.exports = {
  autoResolveEvent,
  scheduleAutoResolve,
};
