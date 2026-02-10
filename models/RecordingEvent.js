const mongoose = require("mongoose");

const RecordingEventSchema = new mongoose.Schema({
  sessionId: String,          // helpId
  type: String,               // door_open, help_button, etc
  occurredAt: Date,

  // NEW
  resolvedAt: Date,
  status: {
    type: String,
    enum: ["active", "resolved"],
    default: "active",
  },
});

module.exports = mongoose.model("RecordingEvent", RecordingEventSchema);
