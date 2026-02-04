const mongoose = require("mongoose");

const ShipmentSchema = new mongoose.Schema({

  // 🔗 Link back to parcel
  parcelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Parcel2",
    required: true
  },

  // 🆔 IDs from your flow
  internalOrderId: String,              // parcel.customId
  shiprocketOrderId: String,            // orderRes.data.order_id
  shipmentId: String,                   // orderRes.data.shipment_id
  awb: String,

  // 🚚 Courier
  courierName: String,

  // 👤 Receiver (you already have this in parcel — duplicate for safety snapshot)
  receiver: {
    name: String,
    phone: String,
    address: String,
    city: String,
    state: String,
    pincode: String
  },

  // 📦 Dimensions (derived from size logic)
  dimensions: {
    length: Number,
    breadth: Number,
    height: Number,
    weight: Number
  },

  // 💰 Pricing
  rate: Number,                          // estimated_cost
  etd: String,

  // 📍 Status Tracking
  status: {
    type: String,
    default: "created"
  },

  statusText: String,
  lastTrackingUpdate: Date,

  // 📜 Tracking Timeline
  trackingHistory: [{
    status: String,
    location: String,
    description: String,
    time: Date
  }],

  // ⏱ Lifecycle Dates
  startedAt: Date,
  pickupGenerated: Boolean,
  deliveredAt: Date,
  expiresAt: Date,

  // 🔔 Notification Control
  lastNotifiedStatus: String,

  // 🧾 Store raw API responses (VERY useful)
  raw: {
    createOrder: mongoose.Schema.Types.Mixed,
    assignAwb: mongoose.Schema.Types.Mixed,
    pickup: mongoose.Schema.Types.Mixed
  },

  createdAt: {
    type: Date,
    default: Date.now
  }

});

// Indexes for fast lookup
ShipmentSchema.index({ parcelId: 1 });
ShipmentSchema.index({ shipmentId: 1 });
ShipmentSchema.index({ awb: 1 });

module.exports = mongoose.model("Shipment", ShipmentSchema);
