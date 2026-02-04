const mongoose = require("mongoose");

const DeliveryAgentSchema = new mongoose.Schema({
 partner: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", index: true },
  name: String,
  phone: { type: String, required: true, index: true },
  accessCode: { type: String, required: true, unique: true, index: true },
  isActive: { type: Boolean, default: true },
  lastUsedAt: Date,
  totalDrops: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model("DeliveryAgent", DeliveryAgentSchema);
