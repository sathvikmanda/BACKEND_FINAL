module.exports = async function allocateCompartment(locker, parcel, deps) {
  const { Parcel2, client } = deps;

  // 1️⃣ Clean overstayed compartments of same size
  for (const c of locker.compartments) {
    if (
      c.size !== parcel.size ||
      !c.isBooked ||
      !c.isOverstay ||
      !c.currentParcelId
    ) continue;

    const oldParcel = await Parcel2.findById(c.currentParcelId);

    if (!oldParcel) {
      // Corrupt state → free it
      c.isBooked = false;
      c.isOverstay = false;
      c.currentParcelId = null;
      continue;
    }

    // notify old parcel user
    try {
      await client.messages.create({
        to: `whatsapp:+91${oldParcel.receiverPhone}`,
        from: "whatsapp:+15558076515",
        contentSid: "HXaf300dc862c5bf433a99649bf553a34e",
        contentVariables: JSON.stringify({
          2: oldParcel.customId,
        }),
      });
    } catch (err) {
      console.error("Overstay notify failed:", err.message);
    }

    // expire parcel
    oldParcel.status = "expired";
    await oldParcel.save();

    // free compartment
    c.isBooked = false;
    c.isOverstay = false;
    c.currentParcelId = null;
  }

  // 2️⃣ Find free compartment of required size
  const compartment = locker.compartments.find(
    c => !c.isBooked && c.size === parcel.size
  );

  if (!compartment) {
    return {
      ok: false,
      error: "NO_COMPARTMENT"
    };
  }
  await locker.save();

  return {
    ok: true,
    compartment
  };
};
