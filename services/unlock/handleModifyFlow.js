const { unlockCompartment } = require("../locker/lockerHardware");

module.exports = async function handleModifyFlow(accessCode, { Parcel2, Locker, sendUnlock }) {

  const parcel = await Parcel2.findOne({ modifyCode: accessCode });
  if (!parcel) return null;

  if (parcel.status !== "awaiting_pick" || new Date(parcel.expiresAt) <= new Date()) {
    return { status: 400, body: { success: false, message: "Parcel not dropped yet" }};
  }

  const locker = await Locker.findOne({ lockerId: parcel.lockerId });
  if (!locker) {
    return { status: 404, body: { success: false, message: "Locker not found" }};
  }

  const { sent } = await unlockCompartment(sendUnlock, parcel.compartmentId);
  if (!sent) {
    return { status: 502, body: { success: false, message: "Unlock failed" }};
  }

  parcel.modifyCode = null;
  await parcel.save();

  return {
    status: 200,
    body: { success: true, message: "Locker unlocked for modification" }
  };
};
