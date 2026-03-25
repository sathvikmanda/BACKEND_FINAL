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
  },

  vitals: {
    ram: {
      total: Number,
      used: Number,
      free: Number
    },

    storage: [
      {
        mount: String,
        total: Number,
        used: Number
      }
    ],

    cpu: {
      load: Number
    },

    battery: {
      percent: Number,
      isCharging: Boolean
    }
  }

}, { timestamps: true });

module.exports = mongoose.model("LockerStatus", LockerStatusSchema);