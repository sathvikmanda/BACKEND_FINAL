const mongoose = require("mongoose");


// ---------------- REUSABLE SUB SCHEMAS ----------------

const RevenueRulesSchema = new mongoose.Schema({
  partnerSharePercent: { type: Number, min: 0, max: 100 },
  platformSharePercent: { type: Number, min: 0, max: 100 },

  fixedMonthlyRent: { type: Number, min: 0 },
  minGuarantee: { type: Number, min: 0 },

  perParcelRate: { type: Number, min: 0 },
  perOpenRate: { type: Number, min: 0 },

  capAmount: { type: Number, min: 0 },

  thresholdSlabs: [{
    upto: Number,
    partnerPercent: Number
  }]
}, { _id: false });


const RevenueHistorySchema = new mongoose.Schema({
  modelType: String,
  rules: RevenueRulesSchema,
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  note: String
}, { _id: false });


const RevenueLedgerSchema = new mongoose.Schema({
  parcelId: { type: mongoose.Schema.Types.ObjectId, ref: "Parcel", index: true },

  grossAmount: { type: Number, required: true },
  platformShare: { type: Number, required: true },
  partnerShare: { type: Number, required: true },

  modelTypeUsed: String,

  calculationSnapshot: Object, // stores rules used at calculation time

  calculatedAt: { type: Date, default: Date.now },
  settled: { type: Boolean, default: false },
  payoutBatchId: mongoose.Schema.Types.ObjectId

}, { _id: false });


// ---------------- MAIN SCHEMA ----------------

const LocationPartnerSchema = new mongoose.Schema({

  // ---------- BASIC INFO ----------
  partnerName: { type: String, required: true, trim: true },
  propertyType: { 
    type: String, 
    enum: ["residential", "retail", "office", "university", "transport", "other"],
    required: true 
  },

  contactPerson: String,

  phone: { type: String, required: true, unique: true, index: true },
  email: { type: String, lowercase: true, trim: true },

  // ---------- LOCATION ----------
  address: String,
  city: String,
  state: String,
  pincode: String,

  location: {
    type: {
      lat: Number,
      lng: Number
    },
    index: "2dsphere"
  },

  // ---------- VERIFICATION ----------
  kyc: {
    pan: String,
    gst: String,
    aadhaar: String
  },

  documents: {
    propertyProofUrl: String,
    idProofUrl: String,
    agreementUrl: String
  },

  verificationStatus: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
    index: true
  },

  // ---------- REVENUE ENGINE ----------
  revenue: {

    modelType: {
      type: String,
      enum: [
        "full_partner_profit",
        "revenue_share",
        "franchise",
        "fixed_rent",
        "hybrid",
        "custom"
      ],
      required: true
    },

    rules: RevenueRulesSchema,

    ownership: {
      lockerOwner: {
        type: String,
        enum: ["platform", "partner", "shared"],
        default: "platform"
      },
      maintenanceBy: {
        type: String,
        enum: ["platform", "partner"],
        default: "platform"
      }
    },

    settlement: {
      payoutCycle: {
        type: String,
        enum: ["daily", "weekly", "monthly"],
        default: "monthly"
      },
      autoPayout: { type: Boolean, default: false },
      payoutMethod: String,
      payoutDelayDays: { type: Number, default: 7 }
    },

    history: [RevenueHistorySchema]
  },

  // ---------- LEDGER ----------
  revenueLedger: [RevenueLedgerSchema],

  // ---------- AGGREGATE STATS ----------
  revenueStats: {
    totalGross: { type: Number, default: 0 },
    totalPartnerEarned: { type: Number, default: 0 },
    totalPlatformEarned: { type: Number, default: 0 },

    pendingPayout: { type: Number, default: 0 },
    paidOut: { type: Number, default: 0 },

    lastPayoutDate: Date,
    lastCalculatedAt: Date
  },

  // ---------- FRANCHISE ----------
  franchiseDetails: {
    franchiseFeePaid: Number,
    contractYears: Number,
    startDate: Date,
    endDate: Date,
    lockerCountPurchased: Number
  },

  // ---------- CONTRACT ----------
  contract: {
    startDate: Date,
    endDate: Date,
    agreementUrl: String,
    signedAt: Date,
    signedBy: String
  },

  // ---------- LOCKERS ----------
  lockers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Locker",
    index: true
  }],

  // ---------- STATUS ----------
  googleId: String,

  isApproved: { type: Boolean, default: false, index: true },
  isActive: { type: Boolean, default: true, index: true },

}, { timestamps: true });


// ---------------- EXPORT ----------------

module.exports = mongoose.model("LocationPartner", LocationPartnerSchema);
