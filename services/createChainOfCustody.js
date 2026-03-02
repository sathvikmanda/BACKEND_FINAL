
const ChainOfCustody = require("../models/chainOfCustody");
const Parcel2 = require("../models/parcel");

async function createChainOfCustody({
    parcelId,
    intent,
    ownerType,
    ownerPhone,
    ownerLockerId,
    custodyType,
    custodyPhone,
    custodyLockerId,
    initialActorType,
    initialActorIdentifier
}) {

    // 1️⃣ Validate parcel exists
    const parcel = await Parcel2.findById(parcelId);
    if (!parcel) {
        throw new Error("Parcel not found");
    }

    // 2️⃣ Ensure chain does not already exist
    const existing = await ChainOfCustody.findOne({ parcelId });
    if (existing) {
        throw new Error("ChainOfCustody already exists for this parcel");
    }

    // 3️⃣ Validate owner identity rules
    if (ownerType === "droppoint" && !ownerLockerId) {
        throw new Error("Droppoint owner requires lockerId");
    }

    if (ownerType === "user" || ownerType === "recipient") {
        if (!ownerPhone) {
            throw new Error("User/Recipient owner requires phone");
        }
    }

    // 4️⃣ Validate custody identity rules
    if (custodyType === "droppoint" || custodyType === "locker") {
        if (!custodyLockerId) {
            throw new Error("Locker custody requires lockerId");
        }
    }

    if (custodyType === "user" || custodyType === "recipient" || custodyType === "delivery_agent") {
        if (!custodyPhone) {
            throw new Error("Custody holder requires phone");
        }
    }

    // 5️⃣ Create document
    const chain = await ChainOfCustody.create({
        parcelId,
        intent,

        currentOwner: {
            ownerType,
            identity: {
                phone: ownerPhone || null,
                lockerId: ownerLockerId || null
            }
        },

        currentCustodyHolder: {
            holderType: custodyType,
            identity: {
                phone: custodyPhone || null,
                lockerId: custodyLockerId || null
            }
        },

        history: [
            {
                actorType: initialActorType || "system",
                actorIdentifier: initialActorIdentifier || "SYSTEM",
                eventType: "parcel_created",
                eventTimestamp: new Date()
            }
        ]
    });

    return chain;
}

module.exports = createChainOfCustody;