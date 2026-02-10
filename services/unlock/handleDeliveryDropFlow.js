const { unlockCompartment } = require("../locker/lockerHardware");
module.exports = async function handleDeliveryPickupFlow( accessCode,deps) {
     const {  Parcel2, Locker, sendUnlock, checkLockerStatus, User, razorpay, RATE_BY_SIZE, Partner } = deps;
  const parcel = await Parcel2.findOne({ accessCode });

  if (!parcel) {
    return {
      status: 404,
      body: { success:false, message:"Parcel not found" }
    };
  }

  if (parcel.status !== "awaiting_pick" && parcel.status !== "overstay") {
    return {
      status: 400,
      body: { success:false, message:"Not ready for pickup" }
    };
  }

  // =====================
  // TIME CALCULATION
  // =====================

  const now = new Date();
  const hoursUsed = Math.ceil(
    (now - parcel.createdAt) / 3600000
  );

  // =====================
  // PARTNER BILLING
  // =====================

  let partnerCharge = 0;

  if (parcel.partner) {
    console.log(parcel.partner);
    const partner = await Partner.findById(parcel.partner);

    if (partner?.billing?.hourlyRate) {
      partnerCharge = hoursUsed * partner.billing.hourlyRate;

      await Partner.findByIdAndUpdate(partner._id, {
        $inc: {
          "billing.totalBilled": partnerCharge,
          "billing.outstandingAmount": partnerCharge
        }
      });
    }

    // =====================
    // USER OVERSTAY BILLING
    // =====================

    if (hoursUsed > partner.maxStorageHours) {

      const extraHours = hoursUsed - partner.maxStorageHours;
      const penaltyRate = RATE_BY_SIZE[parcel.size] || 20;

      const userCharge = extraHours * penaltyRate;

      parcel.billing.amountAccrued =
        (parcel.billing.amountAccrued || 0) + userCharge;

      parcel.billing.isChargeable = true;

      let amount = Number(parcel.billing.amountAccrued);

      if (amount > 0){
        const order = await razorpay.orders.create({
          amount : amount * 100,
          currency : "INR",
          receipt : `parcel_${parcel.customId}`
        });
                await Parcel2.updateOne(
          { _id: parcel._id },
          {
            $set: {
              razorpayOrderId: order.id,
              cost: amount,
              paymentStatus: "pending",
            },
          }
        );
          return {
          status: 402,
          body: {
            success: false,
            paymentRequired: true,
            parcelId : `${parcel._id}`,
            amount,
            usageSummary:{
                size: parcel.size,
                extraHours,
                ratePerHour : penaltyRate,
                storedAt : parcel.createdAt.toISOString(),
                freeUntil : parcel.expiresAt.toISOString(),
                now : now.toISOString(),
            }
          }
        };


      }

      
    } else {
      parcel.status = "picked";
    }
  }

  // =====================
  // LOCKER RELEASE
  // =====================

  const locker = await Locker.findOne({ lockerId: parcel.lockerId });

  if (locker) {
    const compartment = locker.compartments.find(
      c => c.compartmentId === parcel.compartmentId
    );

    if (compartment) {
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
    }

  }

  // =====================
  // UPDATE PARCEL
  // =====================

  parcel.pickedAt = now;
  await parcel.save();

  // =====================
  // RESPONSE
  // =====================

  return {
    status: 200,
    body: {
      success: true,
      message: "Pickup successful",
      hoursUsed,
      partnerCharge,
      userPenalty: parcel.billing.amountAccrued || 0
    }
  };
}