const { unlockCompartment } = require("../locker/lockerHardware");
const allocateCompartment = require("../locker/allocateCompartment");

module.exports = async function handleDropFlow(
  accessCode,
  {
    Parcel2,
    Locker,
    sendUnlock,
    checkLockerStatus,
    client
  }
) {
  try {

    const parcel = await Parcel2.findOne({ accessCode });
    if (!parcel) {
      return {
        status: 404,
        body: { success: false, message: "Parcel not found" }
      };
    }

    if (parcel.status !== "awaiting_drop") {
      return {
        status: 400,
        body: {
          success: false,
          message: "Parcel is not in drop status"
        }
      };
    }

    const locker = await Locker.findOne({ lockerId: parcel.lockerId });

    if (!locker) {
      return {
        status: 404,
        body: {
          success: false,
          message: "Locker not found or mismatch"
        }
      };
    }

    // ---------- COMPARTMENT ALLOCATION ----------

    const alloc = await allocateCompartment(locker, parcel, {
      Parcel2,
      client
    });

    if (!alloc.ok) {
      return {
        status: 400,
        body: {
          success: false,
          message: "No available compartments"
        }
      };
    }

    const compartment = alloc.compartment;

    // ---------- HARDWARE UNLOCK ----------

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

    // ---------- RETURN ----------

    return {
      status: 200,
      body: {
        success: true,
        message: "Parcel dropped successfully",
        compartmentId: parcel.UsercompartmentId,
        lockerId: locker.lockerId
      }
    };

  } catch (err) {
    console.error("DROP FLOW ERROR:", err);

    return {
      status: 500,
      body: { success: false, message: "Server error" }
    };
  }
};