const mongoose = require("mongoose");

const ParcelSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  senderName: String,
  senderPhone: String,

  receiverName: String,
  receiverPhone: { type: String, required: true },

  description: String,
  type: { type: String, enum: ["document", "package", "gift", "other"], default: "package" },
  size: { type: String, enum: ["small", "medium", "large"], required: true },

  location_id: { type: mongoose.Schema.Types.ObjectId, ref: "DropLocation" }, // optional for tracking region
  lockerId: { type: String },                 // Actual drop locker
  compartmentId: { type: String },
  UsercompartmentId: { type: String },
  destinationLockerId: { type: String },      // Selected destination locker (optional)
  lockerLat: { type: String },
  lockerLng: { type: String },

  accessCode: { type: String, unique: true, required: true,   index: true },
  modifyCode:{type: String, unique: true, index: true},
  qrImage: String,
  unlockUrl: String,

  razorpayOrderId: String,
  cost: { type: mongoose.Decimal128, default: 0, required: true },
  paymentOption: { type: String, enum: ["sender_pays", "receiver_pays"] },
  paymentStatus: { type: String, enum: ["pending", "completed"], default: "pending" },

    customId: {
    type: String,
    required: true,
    unique: true
  },

  store_self: {
  type: Boolean,
  default: false
},
  terminal_store: {
  type: Boolean,
  default: false
},
isDropoff:{
  type : Boolean,
  default : false
},
razorpayPaymentLink: { type: String },
paymentStatus: { type: String, default: "pending" },


status: {
  type: String,
  enum: [
    "awaiting_payment",
    "awaiting_drop",
    "awaiting_pick",
    "in_transit",
    "picked",
    "picked_with_overstay",
    "overstay",              // ⬅️ service expired but still held
    "closed_no_charge",      // ⬅️ reassigned or expired
    "expired"                // legacy / optional
  ],
  default: "awaiting_payment"
},

transitInfo: {
  courier: String,
  courierCode: String,
  shiprocketCourierId: Number,
  shiprocketOrderId: String,

  awb: { type: String },   // ✅ REQUIRED

  fromLockerId: String,
  toLockerId: String,
  rate: mongoose.Decimal128,
  etd: String,
  startedAt: Date,
  deliveredAt: Date
},


  shiprocketQuote: {
    courier_name: String,
    estimated_cost: Number,
    etd: String
  },


  receiverDeliveryMethod: { type: String, default: null },    // "courier" or "locker"
  recipientAddress: { type: String, default: null},
  recipientPincode : {type : String},
  selectedLocker : {type : String},
  selectedLockerPincode: {type : String},
  droppedAt: Date,
  pickedAt: Date,
  expiresAt: { type: Date, default : null },
  createdAt: { type: Date, default: Date.now },
  duration : {type : String, default : null},


  // =======================
// EXPIRY & OVERSTAY LOGIC
// =======================

service: {
  overstayStartedAt: { type: Date },        // when normal service expired
  maxHoldUntil: { type: Date },  // after this → no liability
   warnedBeforeExpiry: { type: Boolean, default: false }           
},

billing: {
  isChargeable: { type: Boolean, default: false },
  ratePerHour: { type: Number, default: 20 }, // ₹20/hr example
  amountAccrued: { type: Number, default: 0 },
  lastCalculatedAt: { type: Date }
},

closureReason: {
  type: String,
  enum: [
    "picked_up",
    "reassigned_no_charge",
    "expired_no_liability"
  ]
},

// =======================
// PICKUP (FOR COURIER)
// =======================
pickup_name: String,
pickup_phone: String,
pickup_address: String,
pickup_city: String,
pickup_state: String,
pickup_pincode: String,

// =======================
// DELIVERY (FOR COURIER)
// =======================
delivery_name: String,
delivery_phone: String,
delivery_address: String,
delivery_city: String,
delivery_state: String,
delivery_pincode: String,

// =======================
// COURIER / PARTNER LINKS
// =======================

partner: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Partner",
  index: true,
  default: null
},

deliveryAgent: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "DeliveryAgent",
  index: true,
  default: null
},




});

module.exports = mongoose.model("Parcel2", ParcelSchema);