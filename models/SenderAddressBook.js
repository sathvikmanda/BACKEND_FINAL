
const mongoose = require("mongoose");

const ReceiverAddressSubSchema = new mongoose.Schema({

  receiverName: { type: String, required: true },
  receiverPhone: String,

  delivery_address: { type: String, required: true },
  delivery_city: String,
  delivery_state: String,
  delivery_pincode: String,

  label: String, // Home / Office / Client / Warehouse

  lastUsedAt: {
    type: Date,
    default: Date.now
  }

}, { _id: true }); // keep _id so each address can be edited/deleted


const SenderAddressBookSchema = new mongoose.Schema({

  senderName: String,

  senderPhone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  receivers: [ReceiverAddressSubSchema]

}, { timestamps: true });


module.exports = mongoose.model(
  "SenderAddressBook",
  SenderAddressBookSchema
);