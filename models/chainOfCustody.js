const mongoose = require("mongoose");

const CustodyEventSchema = new mongoose.Schema({
    actorType: {
        type: String,
        enum: ["user", "droppoint", "delivery_agent", "recipient", "system"],
        required: true
    },

    actorIdentifier: {
        type: String,   // phone or lockerId
        required: true
    },

    eventType: {
        type: String,
        enum: [
            "parcel_created",
            "dropped_by_sender",
            "dropped_by_delivery_agent",
            "custody_transferred_to_locker",
            "picked_up_by_delivery_agent",
            "custody_transferred_to_delivery_agent",
            "handed_over_to_recipient",
            "ownership_transferred",
            "returned_to_sender",
            "manual_override",
            "dispute_flagged",
            "picked_up_by_sender",
            "picked_up_by_user",
            "picked_up_by_receiver"
        ],
        required: true
    },

    eventTimestamp: {
        type: Date,
        default: Date.now
    }

}, { _id: false });

const ChainOfCustodySchema = new mongoose.Schema({

    parcelId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Parcel2",
        required: true,
        unique: true,
        index: true
    },

    intent: {
        type: String,
        enum: [
            "self_storage",
            "courier_shipment",
            "drop_for_someone",
            "delivery_drop",
            "personal_drop"
        ],
        required: true
    },

    // 🔹 LEGAL OWNER
    currentOwner: {
        ownerType: {
            type: String,
            enum: ["user", "droppoint", "recipient"],
            required: true
        },
        identity: {
            phone: String,
            lockerId: String
        }
    },

    // 🔹 PHYSICAL HOLDER
    currentCustodyHolder: {
        holderType: {
            type: String,
            enum: ["user", "droppoint", "delivery_agent", "recipient", "locker"],
            required: true
        },
        identity: {
            phone: String,
            lockerId: String
        }
    },

    history: [CustodyEventSchema],

}, { timestamps: true });

module.exports = mongoose.model("ChainOfCustody", ChainOfCustodySchema);