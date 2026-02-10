const RecordingEvent = require("../models/RecordingEvent");

async function logEvent(sessionId, type) {
  return RecordingEvent.create({
    sessionId,
    type,
    occurredAt: new Date(),
  });
}

module.exports = { logEvent };
