const { unlockCompartment } = require("../locker/lockerHardware");

module.exports = async function handlePickupFlow(
  accessCode,deps

) {
  try {
    const {  Parcel2, Locker, sendUnlock, checkLockerStatus, User, razorpay, RATE_BY_SIZE } = deps;

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
      let amount = parcel.billing.amountAccrued || 0;

      if (!amount || amount === 0) {
        const diff = now - parcel.expiresAt;
        const hours = Math.ceil(diff / (1000 * 60 * 60));
        amount = hours * RATE_BY_SIZE[parcel.size];

        await Parcel2.updateOne(
          { _id: parcel._id },
          { $set: { "billing.amountAccrued": amount } }
        );
      }

      amount = Number(amount);

      if (amount > 0) {
        const order = await razorpay.orders.create({
          amount: amount * 100,
          currency: "INR",
          receipt: `parcel_${parcel.customId}`,
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
            amount,
            parcelId : `${parcel._id}`
          }
        };
      }
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