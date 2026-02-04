module.exports = async function resolveFlow(code, { Parcel2 }) {

  if (await Parcel2.findOne({ modifyCode: code })) return "MODIFY";
  if (await Parcel2.findOne({ accessCode: code })) return "PARCEL";

  return "INVALID";
};

    