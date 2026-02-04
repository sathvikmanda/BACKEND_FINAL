const mongoose = require("mongoose");

/**
 * 💰 Billing sub-schema
 */
const BillingSchema = new mongoose.Schema({
  model: {
    type: String,
    enum: ["per_order", "monthly", "commission"],
    required: true
  },

  rate: {
    type: Number,
    required: true
  },

  currency: {
    type: String,
    default: "INR"
  },

  billingCycle: {
    type: String,
    enum: ["weekly", "monthly"],
    default: "monthly"
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
  name: { type: String, required: true },           // "Vivek Kaushik"
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },

  // 🏢 Company info
  companyName: { type: String, required: true },    // "Droppoint Systems Pvt Ltd"
  logoUrl: String,

  // 🔐 Auth & API
  apiKey: { type: String, unique: true },
  googleId: { type: String, unique: true, sparse: true },

  // 💰 Billing
  billing: BillingSchema,

  // 🛡️ Status flags
  isApproved: { type: Boolean, default: false },    // admin approval
  isActive: { type: Boolean, default: true },

  // 📊 Metadata
  lastLoginAt: Date,
  createdAt: { type: Date, default: Date.now }

});

module.exports = mongoose.model("Partner", PartnerSchema);