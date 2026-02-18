const mongoose = require("mongoose");

const LockerStatusSchema = new mongoose.Schema({

  lockerCode: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  internetOnline: Boolean,
  latencyMs: Number,
  strength: String,

  lastHeartbeatAt: Date,

  meta: {
    ip: String,
    version: String
  }

}, { timestamps: true });

module.exports = mongoose.model("LockerStatus", LockerStatusSchema);