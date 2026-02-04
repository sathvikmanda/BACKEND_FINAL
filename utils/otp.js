const crypto = require("crypto");

exports.GenerateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

exports.hashOtp = (otp) =>
  crypto.createHash("sha256").update(otp).digest("hex");
