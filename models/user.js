const mongoose = require("mongoose");
const bcrypt = require('bcryptjs');

const walletSchema = new mongoose.Schema(
  {
    credits: { type: Number, default: 0 },
    totalSpent: { type: mongoose.Decimal128, default: 0 },
    autoReload: { type: Boolean, default: false },
    autoReloadAmount: { type: Number, default: 50 },
    autoReloadThreshold: { type: Number, default: 10 },
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    planId: String,
    status: { type: String, default: "active" },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    password: { type: String }, // not required for Google or OTP users
    googleId: { type: String, unique: true, sparse: true },
    phone: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    isPhoneVerified: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ["user", "admin", "technician", "partner"],
      default: "user",
    },
    lastLogin: {
  type: Date,
  default: null
}
,

    parcels: [{ type: mongoose.Schema.Types.ObjectId, ref: "Parcel" }],
    wallet: {
      type: walletSchema,
      default: () => ({}), // ✅ Ensures wallet is created with default fields
    },
    subscription: {
      type: subscriptionSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
  }
);

// Hash password only if it's being set/modified
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
