const { unlockCompartment } = require("../locker/lockerHardware");
const allocateCompartment = require("../locker/allocateCompartment");

module.exports = async function handleDropFlow(
  accessCode,
  { Parcel2, Locker, sendUnlock, checkLockerStatus, client },
) {
  try {
    const parcel = await Parcel2.findOne({ accessCode });
    if (!parcel) {
      return {
        status: 404,
        body: { success: false, message: "Parcel not found" },
      };
    }

    if (parcel.status !== "awaiting_drop") {
      return {
        status: 400,
        body: {
          success: false,
          message: "Parcel is not in drop status",
        },
      };
    }

    const locker = await Locker.findOne({ lockerId: "L00002" });

    if (!locker) {
      return {
        status: 404,
        body: {
          success: false,
          message: "Locker not found or mismatch",
        },
      };
    }

    // ---------- COMPARTMENT ALLOCATION ----------

    const alloc = await allocateCompartment(locker, parcel, {
      Parcel2,
      client,
    });

    if (!alloc.ok) {
      return {
        status: 400,
        body: {
          success: false,
          message: "No available compartments",
        },
      };
    }

    const compartment = alloc.compartment;

    // ---------- HARDWARE UNLOCK ----------

    const hw = await unlockCompartment({
      sendUnlock,
      checkLockerStatus,
      compartmentId: compartment.compartmentId,
    });

    if (!hw.ok) {
      return {
        status: 504,
        body: {
          success: false,
          message: "Compartment did not unlock",
          details: hw,
        },
      };
    }

    // ---------- LOCKER UPDATE ----------

    compartment.isBooked = true;
    compartment.currentParcelId = parcel._id;
    await locker.save();

    // ---------- PARCEL UPDATE ----------

    parcel.status = "awaiting_pick";
    parcel.lockerLat = locker.location.lat;
    parcel.lockerLng = locker.location.lng;
    parcel.lockerId = locker.lockerId;
    parcel.compartmentId = compartment.compartmentId;
    parcel.UsercompartmentId = parseInt(compartment.compartmentId) + 1;

    if (parcel.duration && !isNaN(parcel.duration)) {
      const hours = parseInt(parcel.duration, 10);
      parcel.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }

    parcel.droppedAt = new Date();
    await parcel.save();

    // NOTIFY
    if (parcel.store_self) {
      await client.messages.create({
        to: `whatsapp:+91${parcel.senderPhone}`,
        from: "whatsapp:+15558076515",
        contentSid: "HXa7a69894f9567b90c1cacab6827ff46c",
        contentVariables: JSON.stringify({
          1: parcel.senderName,
          2: `mobile/incoming/${parcel.customId}/qr`,
        }),
      });
      const smsText2 = `Item successfully dropped at Locker ${
        locker.lockerId
      }. Pickup code: ${
        parcel.accessCode
      }. Share this securely. Receiver can also access via ${`https://demo.droppoint.in/${parcel.customId}/qr`} - DROPPOINT`;
      const sendResult2 = sendSMS(`91${parcel.senderPhone}`, smsText2);
      console.log(sendResult2);
    } else {
      await client.messages.create({
        to: `whatsapp:+91${parcel.receiverPhone}`,
        from: "whatsapp:+15558076515",
        contentSid: "HX4200777a18b1135e502d60b796efe670", // Approved Template SID
        contentVariables: JSON.stringify({
          1: parcel.receiverName,
          2: parcel.senderName,
          3: `mobile/incoming/${parcel.customId}/qr`,
          4: `dir/?api=1&destination=${parcel.lockerLat},${parcel.lockerLng}`,
        }),
      });
    }
    const smsText3 = `Item successfully dropped at Locker ${
      locker.lockerId
    }. Pickup code: ${
      parcel.accessCode
    }. Share this securely. Receiver can also access via ${`https://demo.droppoint.in/qr?parcelid=${parcel.customId}`} - DROPPOINT`;

    const sendResult3 = sendSMS(`91${parcel.senderPhone}`, smsText3);
    console.log(sendResult3);

    // ---------- RETURN ----------

    return {
      status: 200,
      body: {
        success: true,
        message: "Parcel dropped successfully",
        compartmentId: parcel.UsercompartmentId,
        lockerId: locker.lockerId,
      },
    };
  } catch (err) {
    console.error("DROP FLOW ERROR:", err);

    return {
      status: 500,
      body: { success: false, message: "Server error" },
    };
  }
};
