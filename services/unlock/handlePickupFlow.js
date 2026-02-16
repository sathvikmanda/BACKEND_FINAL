const { unlockCompartment } = require("../locker/lockerHardware");

module.exports = async function handlePickupFlow(
  accessCode,deps

) {
  try {
    const { Parcel2, Locker, sendUnlock, checkLockerStatus, User, razorpay, RATE_BY_SIZE, LocationPartner } = deps;


    const now = new Date();
    console.log(accessCode);
    const parcel = await Parcel2.findOne({ accessCode });

    if (!parcel) {
      return {
        status: 404,
        body: { success: false, message: "Parcel not found" }
      };
    }

    if (parcel.status === "awaiting_drop") {
      return {
        status: 400,
        body: { success: false, message: "Parcel is not dropped yet" }
      };
    }

    if (parcel.status === "expired") {
      return {
        status: 400,
        body: { success: false, message: "Parcel expired — contact support" }
      };
    }

    if (parcel.status === "picked") {
      return {
        status: 400,
        body: { success: false, message: "Parcel already picked" }
      };
    }

    if (!["awaiting_pick", "overstay"].includes(parcel.status)) {
      return {
        status: 400,
        body: { success: false, message: "Invalid parcel state" }
      };
    }

    const locker = await Locker.findOne({ lockerId: parcel.lockerId });
    if (!locker) {
      return {
        status: 404,
        body: { success: false, message: "Locker not found" }
      };
    }

    const compartment = locker.compartments.find(
      c => c.compartmentId === parcel.compartmentId
    );

    if (
      !compartment ||
      compartment.currentParcelId?.toString() !== parcel._id.toString()
    ) {
      await Parcel2.updateOne(
        { _id: parcel._id },
        {
          $set: {
            status: "closed_no_charge",
            "billing.isChargeable": false
          }
        }
      );

      return {
        status: 410,
        body: { success: false, message: "Parcel no longer available" }
      };
    }

    // ---------- OVERSTAY BILLING ----------

    
    if (parcel.expiresAt < now && parcel.status !== "overstay") {
      parcel.status = "overstay";
      parcel.billing.isChargeable = true;
      await parcel.save();
    }

    if (parcel.status === "overstay") {
      const nowTime = new Date();

const diffMs = now - parcel.expiresAt;
const extraHours = Math.max(
  1,
  Math.ceil(diffMs / (1000 * 60 * 60))
);

const ratePerHour = RATE_BY_SIZE[parcel.size];
const amount = extraHours * ratePerHour;

await Parcel2.updateOne(
  { _id: parcel._id },
  {
    $set: {
      "billing.amountAccrued": amount,
      "billing.ratePerHour": ratePerHour,
      cost: amount,
      paymentStatus: "pending",
    },
  }
);

const order = await razorpay.orders.create({
  amount: amount * 100,
  currency: "INR",
  receipt: `parcel_${parcel.customId}`,
});

return {
  status: 402,
  body: {
    success: false,
    paymentRequired: true,
    parcelId: `${parcel._id}`,
    amount,
    usageSummary: {
      size: parcel.size,
      extraHours,
      ratePerHour,
      storedAt: parcel.createdAt.toISOString(),
      freeUntil: parcel.expiresAt.toISOString(),
      now: now.toISOString(),
    },
  },
};




      }
    

    // ---------- UNLOCK ----------

    const hw = await unlockCompartment({
      sendUnlock,
      checkLockerStatus,
      compartmentId: compartment.compartmentId
    });

    if (!hw.ok) {
      return {
        status: 504,
        body: {
          success: false,
          message: "Compartment did not unlock",
          details: hw
        }
      };
    }

    compartment.isBooked = false;
    compartment.currentParcelId = null;
    await locker.save();

    await Parcel2.updateOne(
      { _id: parcel._id },
      {
        $set: {
          status: "picked",
          pickedUpAt: new Date(),
          "billing.isChargeable": false
        }
      }
    );


    // ---------- PARTNER REVENUE ----------
if (parcel.partner && parcel.cost > 0) {

  const partner = await LocationPartner.findById(parcel.partner);

  if (partner && partner.isActive && partner.verificationStatus === "approved") {

    const calc = calculatePartnerRevenue(parcel.cost, partner.revenue);

    const ledgerEntry = {
      parcelId: parcel._id,
      grossAmount: parcel.cost,
      platformShare: calc.platformShare,
      partnerShare: calc.partnerShare,
      modelTypeUsed: partner.revenue.modelType,
      calculationSnapshot: partner.revenue.rules,
      calculatedAt: new Date()
    };

    partner.revenueLedger.push(ledgerEntry);

    partner.revenueStats.totalGross += parcel.cost;
    partner.revenueStats.totalPartnerEarned += calc.partnerShare;
    partner.revenueStats.totalPlatformEarned += calc.platformShare;
    partner.revenueStats.pendingPayout += calc.partnerShare;
    partner.revenueStats.lastCalculatedAt = new Date();

    await partner.save();
  }
}


    return {
      status: 200,
      body: {
        success: true,
        type: "pickup",
        message: "Locker unlocked successfully"
      }
    };

  } catch (err) {
    console.error("PICKUP FLOW ERROR:", err);

    return {
      status: 500,
      body: { success: false, message: "Server error" }
    };
  }
};