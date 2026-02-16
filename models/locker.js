const mongoose = require('mongoose');

const CompartmentSchema = new mongoose.Schema({
  compartmentId: String,
  isLocked: { type: Boolean, default: true },
  isBooked: { type: Boolean, default: false },
  isOverstay : {type : Boolean, default: false},
  currentParcelId : {type: String, default : null},
  size: {
    type: String,
    enum: ['small', 'medium', 'large'], // ✅ Restricts to valid sizes
    default: "medium" // ✅ Optional: make it required
  },
  bookingInfo: {
    userId: { type: String, default: null },
    bookingTime: { type: Date, default: null },
    otp: { type: String, default: null },

    // 🔐 DROP OTP (for gig worker)
    dropOtp: { type: String, default: null }, 
    pickupOtp : {type : String, default : null},          // 6-digit OTP
    dropOtpExpiresAt: { type: Date, default: null },    // expiry
    dropOtpUsed: { type: Boolean, default: false },     // one-time use
    pickupOtpUsed: { type: Boolean, default: false },   // one-time use
    recieverName :  { type: String, default: null },
    recieverPhone : {type: String, default: null}
  },
  courierInfo: {
    courierId: mongoose.Schema.Types.ObjectId,
    deliveryTime: Date
  },
  qrCode: { type: String, default: null }
});

const LockerSchema = new mongoose.Schema({
  lockerId: { type: String, required: true, unique: true },
  location_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DropLocation' },
  location: {
    lat: { type: Number },
    lng: { type: Number },
    address: { type: String },
     pincode: {type :String }
  },
  compartments: [CompartmentSchema],
stats: {
  storeClicks: { type: Number, default: 0 },
  sendClicks: { type: Number, default: 0 },
  dropClicks: { type: Number, default: 0 },
},
partner: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "LocationPartner",
  index: true
},
});

module.exports = mongoose.model('Locker', LockerSchema);
