module.exports = async function resolveFlow(code, { Parcel2 }) {

  // MODIFY FLOW — always highest priority
  const modify = await Parcel2.findOne(
    { modifyCode: code },
    { _id: 1 }
  );

  if (modify) return "MODIFY";

  // ACCESS CODE LOOKUP
  const parcel = await Parcel2.findOne(
    { accessCode: code },
    { _id: 1, partner: 1, terminal_store: 1 }
  );

  if (!parcel) return "INVALID";
  // =========================
  // DELIVERY PICKUP CONDITION
  // =========================

  // partner-linked parcel → delivery pickup flow
  if (parcel.partner){
    return "DELIVERY_PICKUP";
  }
  
  if(parcel.isDropOff){
    return "DROPOFF";
  }


  // default user parcel pickup
  return "PARCEL";
};