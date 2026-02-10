const mongoose = require("mongoose");

const recordingSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  lockerId: { type: String, required: true },

  rawVideoFile: { type: String, required: true },

  startedAt: { type: Date, required: true },
  endedAt: Date,

  status: {
    type: String,
    enum: ["active", "completed"],
    default: "active",
  },
});

module.exports = mongoose.model(
  "RecordingSession",
  recordingSessionSchema
);
