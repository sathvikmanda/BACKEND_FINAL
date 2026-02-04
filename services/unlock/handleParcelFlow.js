const handleDropFlow = require("./handleDropFlow");
const handlePickupFlow = require("./handlePickupFlow");

module.exports = async function handleParcelFlow(accessCode, deps) {
  const { Parcel2 } = deps;

  const parcel = await Parcel2.findOne({ accessCode });
  if (!parcel) {
    return {
      status: 404,
      body: { success: false, message: "Invalid code" }
    };
  }

  if (parcel.status === "awaiting_drop") {
    return handleDropFlow(accessCode, deps);
  }

  return handlePickupFlow(accessCode, deps);
};


