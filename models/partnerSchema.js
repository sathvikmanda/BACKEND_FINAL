const mongoose = require("mongoose");

/**
 * 💰 Billing sub-schema
 */

const BillingSchema = new mongoose.Schema({

  // ₹ per hour of storage used
  hourlyRate: {
    type: Number,
    required: true,
    min: 0
  },

  currency: {
    type: String,
    default: "INR"
  },

  lastBilledAt: Date,
  nextBillingAt: Date,

  totalBilled: {
    type: Number,
    default: 0
  },

  outstandingAmount: {
    type: Number,
    default: 0
  }

}, { _id: false });


/**
 * 🧩 Partner schema (merged)
 */
const PartnerSchema = new mongoose.Schema({

  // 👤 Login / owner info
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },

  // 🏢 Company info
  companyName: { type: String, required: true },
  logoUrl: String,

  // 📦 Storage policy
  maxStorageHours: {
    type: Number,
    default: 72,
    min: 1,
    max: 720
  },

  // 🔐 Auth & API
  apiKey: { type: String, unique: true },
  googleId: { type: String, unique: true, sparse: true },

  // 💰 Billing — usage based
  billing: BillingSchema,

  // 🛡️ Status
  isApproved: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },

  // 📊 Metadata
  lastLoginAt: Date,
  createdAt: { type: Date, default: Date.now }

});

module.exports = mongoose.model("Partner", PartnerSchema);