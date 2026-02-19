const mongoose = require("mongoose");

const recordingSessionSchema = new mongoose.Schema({
  sessionId: { 
    type: String, 
    required: true, 
    index: true 
  },

  cameraId: { 
    type: String, 
    required: true,
    index: true
  },

  cameraName: { 
    type: String 
  },

  lockerId: { 
    type: String, 
    required: true 
  },

  rawVideoFile: { 
    type: String, 
    required: true 
  },

  startedAt: { 
    type: Date, 
    required: true 
  },

  endedAt: Date,

  status: {
    type: String,
    enum: ["active", "completed"],
    default: "active",
  },

  cloudUploaded: {
    type: Boolean,
    default: false,
    index: true
  },

  uploadedAt: Date

}, {
  timestamps: true
});

recordingSessionSchema.index(
  { sessionId: 1, cameraId: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "RecordingSession",
  recordingSessionSchema
);