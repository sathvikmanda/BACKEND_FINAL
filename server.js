const express = require("express");
const Partner = require("./models/partnerSchema.js");
const DeliveryAgent = require("./models/deliveryAgent");
const LocationPartner = require("./models/LocationPartnerSchema.js");
const app = express();
const SenderBook = require("./models/SenderAddressBook");
const cors = require("cors");
const path = require("path")
const fs = require("fs")
const mongoose = require("mongoose");
const Parcel2 = require("./models/parcel");
const Locker = require("./models/locker");
const User = require("./models/user");
const http = require("http");
const { Server } = require("socket.io");
const https = require("https");
const server = http.createServer(app);
const io = new Server(server);
const lockerID = "L00002";
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { initRecordingSystem } = require("./camera/recordingOrchestrator");
const { activateRecording, deactivateRecording } = require("./camera/recordingSessionManager");
const { sendSMS } = require("./smartping.js");
require("dotenv").config();
const mongo_uri = process.env.MONGOURI
const twilio = require("twilio");
const { runDriveSync } = require("./camera/driveSyncWorker");
const { checkStorageAndSync } = require("./camera/storageMonitor");
const { appendTimeline } = require("./camera/timelineWriter");
const { generateClipsForSession } = require("./camera/multiClipProcessor");
const BASE_DIR = path.join(__dirname, "recordings");
const session = require("express-session");

app.use(session({
  secret: "droppoint-2025",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // true only if HTTPS
}));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,                                                         
  TWILIO_VERIFY_SERVICE_SID,
  TWILIO_WHATSAPP_VERIFY_SID,
} = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
  console.warn(
    "Twilio env vars missing. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID.",
  );
}
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VERIFY_SID = TWILIO_VERIFY_SERVICE_SID;
const WHATSAPP_VERIFY_SID = TWILIO_WHATSAPP_VERIFY_SID;

mongoose
  .connect(mongo_uri)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo not connected", err));

app.use(cors()); // allow Flutter to talk
app.use(express.json());


const Otp = require("./models/Otp.js");
const { GenerateOtp, hashOtp } = require("./utils/otp");

app.post("/api/otp/send", async (req, res) => {
  try {
    const phoneRaw = (req.body.phone || "").trim();

    if (!/^\d{10}$/.test(phoneRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number",
      });
    }

    const phone = phoneRaw;

    // 🔁 Clear old OTP
    await Otp.deleteMany({ phone });

    // 🔢 Generate OTP
    const otp = GenerateOtp();
    const otpHash = hashOtp(otp);

    await Otp.create({
      phone,
      otpHash,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      resendCount: 0,
      lastSentAt: new Date(),
    });

    // 📩 Send SMS (STPL)
    const OTPmsg = `Your Drop Point verification code is ${otp}. Do not share this OTP with anyone. Valid for ${5} minutes. - DROPPOINT`;
    sendSMS(phone, OTPmsg);

    console.log("✅ SMS OTP sent (STPL):", otp); // dev only

    return res.json({
      success: true,
      message: "OTP sent via SMS",
    });
  } catch (err) {
    console.error("❌ /api/otp/send error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});


app.post("/api/otp/resend-whatsapp", async (req, res) => {
  try {
    const phoneRaw = (req.body.phone || "").trim();

    if (!/^\d{10}$/.test(phoneRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number",
      });
    }

    const phone = `+91${phoneRaw}`;

    if (!client || !WHATSAPP_VERIFY_SID) {
      console.log(`[DEV] WhatsApp OTP requested for ${phone}`);
      return res.json({
        success: true,
        message: "OTP sent via WhatsApp (dev mode)",
      });
    }

    await client.verify.v2.services(WHATSAPP_VERIFY_SID).verifications.create({
      to: phone,
      channel: "whatsapp",
    });

    console.log("✅ WhatsApp OTP sent via Twilio to", phone);

    return res.json({
      success: true,
      message: "OTP sent via WhatsApp",
    });
  } catch (err) {
    console.error("❌ WhatsApp resend error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send WhatsApp OTP",
    });
  }
});

app.post("/otp/verify", async (req, res) => {
  try {
    const phoneRaw = (req.body.phone || "").trim();
    const otp = String(req.body.otp || "").trim();

    if (!phoneRaw || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone and OTP required",
      });
    }

    const phone = phoneRaw.replace("+91", "");

    // 1️⃣ STPL VERIFY (SMS)
    const record = await Otp.findOne({ phone });

    if (record && record.expiresAt > new Date()) {
      if (hashOtp(otp) === record.otpHash) {
        await Otp.deleteMany({ phone });
        return res.json({
          success: true,
          message: "OTP verified via SMS",
        });
      }
    }

    // 2️⃣ TWILIO VERIFY (WhatsApp fallback)
    if (client && WHATSAPP_VERIFY_SID) {
      try {
        const waResult = await client.verify.v2
          .services(WHATSAPP_VERIFY_SID)
          .verificationChecks.create({
            to: `+91${phone}`,
            code: otp,
          });

        if (waResult.status === "approved") {
          return res.json({
            success: true,
            message: "OTP verified via WhatsApp",
          });
        }
      } catch (e) {
        console.log("WhatsApp verify failed");
      }
    }

    return res.status(400).json({
      success: false,
      message: "Invalid or expired OTP",
    });
  } catch (err) {
    console.error("❌ VERIFY ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Verification failed",
    });
  }
});
const RATE_BY_SIZE = {
  small: 5,
  medium: 10,
  large: 20,
};

app.post("/api/complaint", async (req, res) => {
  try {
    const helpId = "HR-" + Date.now();

    console.log("📄 Complaint created:", helpId);

    // 1️⃣ Start recording
    await activateRecording(
  process.env.CAMERA_RTSP,
  BASE_DIR,
  helpId,
  "LOCKER-TEST"
);


    // 2️⃣ Write timeline entry
    appendTimeline(BASE_DIR, helpId, "COMPLAINT CREATED");

    res.json({
      success: true,
      helpId,
    });
  } catch (err) {
    console.error("❌ Complaint create failed:", err);
    res.status(500).json({ success: false });
  }
});






async function bootstrap() {
  console.log("🚀 Starting terminal server...");

  await startBuAndPolling();

  await initRecordingSystem({
    baseDir: BASE_DIR,
    cameraRtspUrl: process.env.CAMERA_RTSP,
    io
  });

  server.listen(4000, "0.0.0.0", () => {
    console.log("Server listening on all interfaces :4000");
  });

  console.log("🌟 System ready.");

  // 🔵 Drive sync every 10 mins
  // Drive sync every 10 mins
setInterval(async () => {
  try {
    await runDriveSync(BASE_DIR, "L00002");
  } catch (err) {
    console.error("Drive sync error:", err);
  }
}, 10 * 60 * 1000);

// Storage monitor every 5 mins
setInterval(async () => {
  try {
    await checkStorageAndSync(BASE_DIR, "L00002");
  } catch (err) {
    console.error("Storage monitor error:", err);
  }
}, 5 * 60 * 1000);

}



app.post("/api/complaint/resolve", async (req, res) => {
  try {
    const { helpId } = req.body;

    if (!helpId) {
      return res.status(400).json({ error: "helpId required" });
    }

    console.log("✅ Complaint resolved:", helpId);

    // 1️⃣ Stop recording
    await deactivateRecording({ sessionId: helpId });

    // 2️⃣ Wait a moment for file flush
    await new Promise(r => setTimeout(r, 2000));

    // 3️⃣ Generate clips
    const clips = await generateClipsForSession(helpId, BASE_DIR);

    // 4️⃣ Timeline entry
    appendTimeline(BASE_DIR, helpId, "COMPLAINT RESOLVED");
    appendTimeline(BASE_DIR, helpId, `CLIPS GENERATED: ${clips.length}`);

    res.json({
      success: true,
      message: "Recording stopped and clips generated",
      clips,
    });

  } catch (err) {
    console.error("❌ Complaint resolve failed:", err);
    res.status(500).json({ success: false });
  }
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
async function checkSingleLockStatus(addr = 0x00, compartmentId = 0) {
  try {
    const data = await sendPacket(buildGetStatusPacket(addr));

    if (!data) {
      console.warn("⚠️ No status frame received");
      return null;
    }

    const status = parseLockStatus(data);
    if (!status) {
      console.warn("⚠️ Status parse failed");
      return null;
    }

    const key = `Lock_${compartmentId}`;
    const result = status[key];

    console.log(`🔍 Lock ${compartmentId} @ addr ${addr} →`, result);

    return result; // "Locked" or "Unlocked"

  } catch (err) {
    console.error("checkSingleLockStatus error:", err);
    return null;
  }
}

async function resolveComplaint(helpId) {
  if (!helpId) return;

  console.log("✅ Complaint resolved:", helpId);
  await deactivateRecording(helpId);
}




async function verifyLockerClosedUntilLocked(
  addr,
  compartmentId,
  helpId,
  delayMs = 1000,
  maxRetries = 30 // 30 seconds max
) {
  console.log("👁️ Watching locker until locked...");

  for (let i = 0; i < maxRetries; i++) {
    await sleep(delayMs);

    const status = await checkSingleLockStatus(addr, compartmentId);

    console.log("Parsed locker status:", status);

    if (!status) continue;

if (status.toLowerCase() === "locked") {
  console.log("🔒 Locker confirmed locked");
  console.log("⏳ Waiting 5 seconds before finalizing...");
  await sleep(5000);

  if (helpId) {
    await resolveComplaint(helpId);
  }

  // Wait 5 seconds before returning
  

  return true;
}


  }

  console.warn("⚠️ Locker did not lock within timeout");
  return false;
}









/// UNLOCK FLOW

const resolveFlow = require("./services/unlock/resolveFlow");
const handleModifyFlow = require("./services/unlock/handleModifyFlow");
const handleParcelFlow = require("./services/unlock/handleParcelFlow");
const handleDeliveryPickupFlow = require("./services/unlock/handleDeliveryDropFlow.js");
const calculatePartnerRevenue = require("./utils/revenueCalc.js");
const deps = {
  Parcel2,
  Locker,
  User, 
  sendUnlock,
  checkLockerStatus,
  razorpay,
  client,
  io,
  RATE_BY_SIZE,
  sendSMS,
  Partner,
  client,
  LocationPartner,
  calculatePartnerRevenue
};


app.post("/api/locker/unlock-code", express.json(), async (req, res) => {
  try {
    const { accessCode } = req.body;
    const flow = await resolveFlow(accessCode, { Parcel2 });

    let result;
    console.log(flow);
    if (flow === "MODIFY") {
      result = await handleModifyFlow(accessCode, deps);
    } else if (flow === "PARCEL") {
      result = await handleParcelFlow(accessCode, deps);
    } else if (flow === "DELIVERY_PICKUP") {
      result = await handleDeliveryPickupFlow(accessCode,deps);
    } else {
      return res.status(404).json({
        success: false,
        message: "Invalid code",
      });
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error("UNLOCK ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/api/locker/scan", express.json(), async (req, res) => {
  try {
    console.log("sathvik");
    const { accessCode } = req.body;
    console.log(accessCode);
    if (!accessCode || accessCode.length !== 6) {
      return res.status(400).json({ success: false, message: "Invalid code" });
    }
    const flow = await resolveFlow(accessCode, { Parcel2 });

    let result;
   if (flow === "MODIFY") {
  result = await handleModifyFlow(accessCode, deps);
} else if (flow === "PARCEL") {
  // 🔥 USE PICKUP FLOW (HAS OVERSTAY LOGIC)
  result = await handlePickupFlow(accessCode, deps);
} else {
  return res.status(404).json({
    success: false,
    message: "Invalid code",
  });
}


    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error("UNLOCK ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/find-partner", async (req, res) => {
  try {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    // normalize phone
    phone = String(phone).replace(/\D/g, "").replace(/^91/, "").slice(-10);

    // 🔥 FIND ALL AGENTS FOR THIS PHONE
    const agents = await DeliveryAgent.find({ phone: Number(phone) }).populate(
      "partner",
    );

    if (!agents || agents.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Delivery agent not found",
      });
    }

    // 🔥 FILTER VALID PARTNERS
    const partners = agents
      .filter((a) => a.partner && a.partner.isActive)
      .map((a) => ({
        id: a.partner._id,
        name: a.partner.companyName,
      }));

    if (partners.length === 0) {
      return res.status(403).json({
        success: false,
        message: "No active delivery partners",
      });
    }

    return res.json({
      success: true,
      partners, // 👈 ARRAY
    });
  } catch (err) {
    console.error("Find Partner Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

app.post("/api/address-book/receivers", async (req, res) => {
  try {
    const { senderPhone } = req.body;

    if (!senderPhone) {
      return res.status(400).json({
        success: false,
        message: "senderPhone required",
      });
    }

    const book = await SenderBook.findOne({ senderPhone }).lean();

    if (!book) {
      return res.json({
        success: true,
        receivers: [],
      });
    }

    // optional: sort by last used
    const receivers = book.receivers.sort(
      (a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt),
    );

    res.json({
      success: true,
      count: receivers.length,
      receivers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch saved receivers",
    });
  }
});

app.post("/api/whatsapp/send-parcel-link", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    await client.messages
      .create({
        from: "whatsapp:+15558076515", // Twilio WhatsApp sender
        to: `whatsapp:+91${phone}`, // recipient
        contentSid: "HX7a4358da4233b61905270334204b262b",
        contentVariables: JSON.stringify({
          1: `https://demo.droppoint.in/create-parcel?senderPhone=${phone}`,
        }),
      })
      .then((message) => console.log("✅ WhatsApp Message Sent:", message.sid))
      .catch((error) => console.error("❌ WhatsApp Message Error:", error));

    console.log("✅ WhatsApp Message Sent to", phone);

    return res.json({
      success: true,
      message: "WhatsApp message sent successfully",
    });
  } catch (err) {
    console.error("❌ Twilio WhatsApp Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to send WhatsApp message",
    });
  }
});

app.post("/terminal/dropoff", async (req, res) => {
  try {
    let { size, hours, phone, sessionId, helpId } = req.body;

    if (!helpId) {
      return res.status(400).json({ error: "Missing helpId" });
    }

    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    size = size.toLowerCase();
    const PRICES = { small: 5, medium: 10, large: 20 };

    if (!PRICES[size]) {
      return res.status(400).json({ error: "Invalid size" });
    }

    const hrs = Number(hours);
    if (!Number.isInteger(hrs) || hrs < 1) {
      return res.status(400).json({ error: "Invalid hours" });
    }

    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // 🔒 VALIDATE RESERVATION
    const reservationCheck = await Locker.findOne({
      lockerId: lockerID,
      compartments: {
        $elemMatch: {
          size,
          status: "reserved",
          reservedBySession: sessionId,
          reservationExpiresAt: { $gt: new Date() }
        }
      }
    });

    if (!reservationCheck) {
      return res.status(400).json({
        error: "Reservation expired or invalid"
      });
    }

    const total = PRICES[size] * hrs;

    let customId;
    let exists = true;

    while (exists) {
      customId = "P" + Math.random().toString(36).substring(2, 7).toUpperCase();
      exists = await Parcel2.exists({ customId });
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + hrs * 3600000);

    const parcel = await Parcel2.create({
      senderPhone: phone,
      receiverPhone: phone,
      size,
      lockerId: lockerID,
      hours: hrs,
      terminal_store: true,
      accessCode: Math.floor(100000 + Math.random() * 900000).toString(),
      customId,
      cost: total,
      createdAt,
      expiresAt,
      status: "awaiting_payment",
      paymentStatus: "pending",
      helpId,
      sessionId
    });

    const order = await razorpay.orders.create({
      amount: total * 100,
      currency: "INR",
      receipt: parcel.customId,
      notes: {
        parcelId: parcel._id.toString(),
        phone,
      },
    });

    parcel.razorpayOrderId = order.id;
    await parcel.save();

    return res.json({
      parcelId: parcel._id.toString(),
      orderId: order.id,
      amount: order.amount,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    console.error("dropoff error:", err);
    res.status(500).json({ error: "Server error" });
  }
});



app.post("/terminal/payment/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      parcelId,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !parcelId) {
      return res.status(400).json({ success: false, error: "Missing parameters" });
    }

    const parcel = await Parcel2.findById(parcelId);
    if (!parcel) {
      return res.status(404).json({ success: false, error: "Parcel not found" });
    }

    if (parcel.paymentStatus === "completed") {
      return res.json({
        success: true,
        accessCode: parcel.accessCode,
        lockerId: parcel.lockerId ?? null,
        compartmentId: parcel.compartmentId ?? null,
      });
    }

    if (parcel.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ success: false, error: "Order mismatch" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    // 🔒 ATOMIC RESERVED → PAID
  const locker = await Locker.findOneAndUpdate(
  {
    lockerId: parcel.lockerId,
    compartments: {
      $elemMatch: {
        size: parcel.size,
        reservedBySession: parcel.sessionId,
        $or: [
          { status: "reserved" },
          { status: { $exists: false } }
        ]
      }
    }
  },
  {
    $set: {
      "compartments.$.status": "paid"
    }
  },
  { new: true }
);


    if (!locker) {
      return res.status(400).json({
        success: false,
        error: "Reservation invalid or expired"
      });
    }

    parcel.paymentStatus = "completed";
    parcel.status = "awaiting_pick";
    parcel.razorpayPaymentId = razorpay_payment_id;
    parcel.razorpaySignature = razorpay_signature;
    parcel.paidAt = new Date();
    await parcel.save();

    return res.json({
      success: true,
      accessCode: parcel.accessCode
    });

  } catch (err) {
    console.error("verify error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});



app.post("/terminal/payment/drop-verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      parcelId,
      helpId,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !parcelId
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Missing parameters" });
    }

    const parcel = await Parcel2.findById(parcelId);
    if (!parcel) {
      return res
        .status(404)
        .json({ success: false, error: "Parcel not found" });
    }

    if (parcel.paymentStatus === "completed") {
      return res.json({
        success: true,
        accessCode: parcel.accessCode,
        lockerId: parcel.lockerId,
        compartmentId: parcel.compartmentId,
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid signature" });
    }

    // ✅ Payment confirmed
    parcel.paymentStatus = "completed";
    parcel.status = "awaiting_pick";
    parcel.razorpayPaymentId = razorpay_payment_id;
    parcel.razorpaySignature = razorpay_signature;

    const locker = await Locker.findOne({ lockerId: "L00002" });
    if (!locker) {
      return res
        .status(409)
        .json({ success: false, error: "Locker not found" });
    }

    const compartment = locker.compartments.find(
      (c) => c.size === parcel.size && !c.isBooked,
    );

    if (!compartment) {
      return res
        .status(409)
        .json({ success: false, error: "No free compartment" });
    }

    let addr = 0x00;
    let lockNum = parseInt(compartment.compartmentId);
    if (lockNum > 11) {
      addr = 0x01;
      lockNum -= 12;
    }

    const sent = await sendUnlock(lockNum, addr);
    if (!sent) {
      return res.status(502).json({
        success: false,
        error: "Failed to unlock locker",
      });
    }
console.log("About to resolve complaint with helpId:", helpId);

    // 🔍 START WATCH LOOP (non-blocking)
    verifyLockerClosedUntilLocked(
      addr,
      lockNum,
      parcel.helpId,
      1000
    ).catch(err => {
      console.error("Verify loop crashed:", err);
    });

    compartment.isBooked = true;
    compartment.currentParcelId = parcel._id;
    await locker.save();

    parcel.lockerId = locker.lockerId;
    parcel.compartmentId = compartment.compartmentId;
    await parcel.save();

    await client.messages.create({
      to: `whatsapp:+91${parcel.receiverPhone}`,
      from: "whatsapp:+15558076515",
      contentSid: "HX4200777a18b1135e502d60b796efe670",
      contentVariables: JSON.stringify({
        1: parcel.receiverName,
        2: parcel.senderName,
        3: `mobile/incoming/${parcel.customId}/qr`,
        4: `dir/?api=1&destination=${parcel.lockerLat},${parcel.lockerLng}`,
      }),
    });

    const smsText1 = `Your Drop Point Locker Access Code is ${parcel.accessCode}. Please don't share this with anyone. -DROPPOINT`;
    sendSMS(`91${parcel.senderPhone}`, smsText1);

    return res.json({
      success: true,
      accessCode: parcel.accessCode,
      lockerId: parcel.lockerId,
      compartmentId: parcel.compartmentId,
    });

  } catch (err) {
    console.error("❌ payment verify error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});






app.post("/terminal/authdropoff", async (req, res) => {
  try {
    const { size, hours, senderPhone, receiverPhone } = req.body;

    const PRICES = { small: 5, medium: 10, large: 20 };

    if (!PRICES[size]) {
      return res.status(400).json({ error: "Invalid size" });
    }

    const hrs = Number(hours);
    if (!Number.isInteger(hrs) || hrs < 1 || hrs > 72) {
      return res.status(400).json({ error: "Invalid hours" });
    }
    if (!/^[6-9]\d{9}$/.test(senderPhone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    if (!/^[6-9]\d{9}$/.test(receiverPhone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    const total = PRICES[size] * hrs;

    // ---------- CREATE PARCEL ----------
    let customId;
    let exists = true;

    while (exists) {
      customId = "P" + Math.random().toString(36).substring(2, 7).toUpperCase();
      exists = await Parcel2.exists({ customId });
    }
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + hrs * 3600000);

    const parcel = await Parcel2.create({
      senderPhone: senderPhone,
      receiverPhone: receiverPhone,
      size,
      lockerId: lockerID,
      hours: hrs,
      terminal_store: true,
      accessCode: Math.floor(100000 + Math.random() * 900000).toString(),
      customId,
      cost: total,
      createdAt,
      expiresAt,
      status: "awaiting_payment",
      paymentStatus: "pending",
    });

    // ---------- CREATE RAZORPAY ORDER ----------
    const order = await razorpay.orders.create({
      amount: total * 100, // paise
      currency: "INR",
      receipt: parcel.customId,
      notes: {
        parcelId: parcel._id.toString(),
        senderPhone,
      },
    });

    parcel.razorpayOrderId = order.id;
    await parcel.save();

    // ✅ RETURN JSON FOR FLUTTER
    return res.json({
      parcelId: parcel._id.toString(),
      orderId: order.id,
      amount: order.amount, // paise
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("dropoff error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/locker/:lockerId/click", async (req, res) => {
  const { service } = req.body; // "store" | "send" | "receive"
  const { lockerId } = req.params;

  let fieldToInc = null;

  if (service === "store") fieldToInc = "stats.storeClicks";
  if (service === "send") fieldToInc = "stats.sendClicks";
  if (service === "drop") fieldToInc = "stats.dropClicks";

  if (!fieldToInc) {
    return res.status(400).json({ success: false, message: "Invalid service" });
  }

  await Locker.updateOne(
    { lockerId },
    { $inc: { [fieldToInc]: 1 } }
  );
  console.log("UPDATED");

  res.json({ success: true });
});

const { unlockCompartment } = require("./services/locker/lockerHardware.js")

app.post("/delivery/dropoff", async (req,res) => {
  try {
    console.log("📦 dropoff hit");

    const { recipientPhone, deliveryPhone, partnerId, size, hours } = req.body;
    console.log(req.body)
    const SIZE_ALLOWED = ["small", "medium", "large"];

    // ================= BASIC VALIDATION =================

    if (!partnerId) {
      return res
        .status(400)
        .json({ success: false, error: "partnerId required" });
    }

    if (!SIZE_ALLOWED.includes(size)) {
      return res.status(400).json({ error: "Invalid size" });
    }

    if (!/^[6-9]\d{9}$/.test(recipientPhone)) {
      return res.status(400).json({ error: "Invalid recipient phone" });
    }

    if (!/^[6-9]\d{9}$/.test(deliveryPhone)) {
      return res.status(400).json({ error: "Invalid delivery phone" });
    }

    // const hrs = Number(hours);
    // if (!Number.isInteger(hrs) || hrs < 1) {
    //   return res.status(400).json({ error: "Invalid hours" });
    // }

    // ================= PARTNER =================

    const partner = await Partner.findById(partnerId);
    if (!partner || !partner.isActive) {
      return res.status(403).json({
        error: "Invalid or inactive partner",
      });
    }
    const hrs = Number(partner.maxStorageHours);

if (!Number.isFinite(hrs) || hrs <= 0) {
  return res.status(400).json({
    error: "Partner maxStorageHours invalid"
  });
}
console.log("HOURS:", hrs);



    // if (hrs > partner.maxStorageHours) {
    //   return res.status(400).json({
    //     error: `Max allowed is ${partner.maxStorageHours} hours`,
    //   });
    // }

    // ================= AGENT =================

    const agent = await DeliveryAgent.findOne({
      phone: deliveryPhone,
      partner: partnerId,
    });

    if (!agent) {
      return res.status(403).json({
        error: "Agent not linked to this partner",
      });
    }

    // ================= COST =================

    const rate = partner.billing?.hourlyRate || 10;
    const total = rate * hrs;

    // ================= PARCEL ID =================

    let customId;
    while (true) {
      customId = "P" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const exists = await Parcel2.exists({ customId });
      if (!exists) break;
    }
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + hrs * 3600000);

    // ================= LOCKER ASSIGNMENT =================

    const locker = await Locker.findOne({ lockerId: "L00002" });
    if (!locker) {
      return res.status(500).json({ error: "Locker not found" });
    }

    const compartment = locker.compartments.find(
      (c) => c.size === size && !c.isBooked,
    );
    if (!compartment) {
      return res.status(409).json({
        error: "No free compartment",
      });
    }
      const hw = await unlockCompartment({
      sendUnlock,
      checkLockerStatus,
      compartmentId: compartment.compartmentId
    });

  

if (!hw.ok) {
  return res.status(504).json({
    success: false,
    message: "Compartment did not unlock",
    details: hw
  });
}

    // ================= CREATE PARCEL =================

    const parcel = await Parcel2.create({
      senderPhone: deliveryPhone,
      receiverPhone: recipientPhone,
      partner: partnerId,
      deliveryAgent: agent._id,
      size,
      lockerId: locker.lockerId,
      hours: hrs,
      terminal_store: true,
      accessCode: Math.floor(100000 + Math.random() * 900000).toString(),
      customId,
      cost: total,
      createdAt,
      expiresAt,
      status: "awaiting_pick",
      paymentStatus: "pending",
    });
    console.log(parcel.partner)

    // ================= MARK LOCKER =================

    compartment.isBooked = true;
    compartment.currentParcelId = parcel._id;
    await locker.save();

    parcel.compartmentId = compartment.compartmentId;
    await parcel.save();

    // ================= LINK TO PARTNER =================

    await Partner.findByIdAndUpdate(partnerId, {
      $push: { parcels: parcel._id },
    });

    // ================= AGENT STATS =================

    await DeliveryAgent.findByIdAndUpdate(agent._id, {
      $inc: { totalDrops: 1 },
    });

    // ================= NOTIFY =================

    /// POST - UNLOCK CHECK

    verifyLockerClosedUntilLocked({
  compartmentId: compartment.compartmentId,
  checkLockerStatus,
  req,
  maxTries: 3,
  delayMs: 1000
}).catch(err => {
  console.error("Locker verify failed:", err);
});
    // ================= RESPONSE =================


    return res.json({
      success: true,
      customId: parcel.customId,
      accessCode: parcel.accessCode,
      lockerId: parcel.lockerId,
      compartmentId: parcel.compartmentId,
      cost: total,
      partner: {
        id: partner._id,
        name: partner.companyName,
      },
    });
  } catch (err) {
    console.error("❌ dropoff error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

app.post("/api/overstay/payment/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      parcelId,
    } = req.body;

    const parcel = await Parcel2.findById(parcelId);

    if (!parcel) {
      return res.json({ success: false });
    }

    // 🔐 Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.json({ success: false });
    }

    // ✅ Mark payment success

    const locker = await Locker.findOne({ lockerId: parcel.lockerId });

    const compartment = locker.compartments.find(
      (c) => c.compartmentId === parcel.compartmentId
    );
    let addr = 0x00;
    let lockNum = parseInt(compartment.compartmentId);
    if (lockNum > 11) {
      addr = 0x01;
      lockNum -= 12;
    }

    const sent = await sendUnlock(lockNum, addr);
    if (!sent) {
      return res.status(502).json({ success: false, message: "Unlock failed" });
    }

    await wait(500);
    const hwStatus = await checkLockerStatus(addr, lockNum, 2000);
    if (hwStatus !== "Unlocked") {
      return res
        .status(504)
        .json({ success: false, message: "Unlock timeout" });
    }
    compartment.isBooked = false;
    compartment.currentParcelId = null;
    await locker.save();
    parcel.status = "picked_with_overstay";
    await parcel.save();

    res.json({
      success: true,
      accessCode: parcel.accessCode,
      redirect: "/",
    });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ success: false });
  }
});



app.post("/personal/dropoff", async (req, res) => {
  try {
    console.log("📦 new personal dropoff hit");

const { recipientPhone, deliveryPhone, size, hours, helpId } = req.body;




    console.log("Incoming helpId:", helpId);

    // ================= VALIDATION =================

    const SIZE_ALLOWED = ["small", "medium", "large"];

    if (!SIZE_ALLOWED.includes(size)) {
      return res.status(400).json({ error: "Invalid size" });
    }

    if (!/^[6-9]\d{9}$/.test(recipientPhone)) {
      return res.status(400).json({ error: "Invalid recipient phone" });
    }

    if (!/^[6-9]\d{9}$/.test(deliveryPhone)) {
      return res.status(400).json({ error: "Invalid delivery phone" });
    }

    const hrs = Number(hours);
    if (!Number.isInteger(hrs) || hrs < 1) {
      return res.status(400).json({ error: "Invalid hours" });
    }
    const ratePerHour = RATE_BY_SIZE[size];
const calculatedAmount = ratePerHour * hrs;
    console.log(calculatedAmount);
    if (!helpId) {
      return res.status(400).json({ error: "Missing helpId" });
    }

    // ================= LOCKER =================

    const locker = await Locker.findOne({ lockerId: "L00002" });
    console.log("Locker fetched:", locker ? "YES" : "NO");

    if (!locker) {
      return res.status(500).json({ error: "Locker not found" });
    }
    console.log("Locker exists, checking compartments...");


    const compartment = locker.compartments.find(
      (c) => c.size === size && !c.isBooked
    );
console.log("Compartment found:", compartment ? compartment.compartmentId : "NONE");
console.log("Incoming size:", size);
console.log(
  "Available compartments:",
  locker.compartments.map(c => ({
    id: c.compartmentId,
    size: c.size,
    isBooked: c.isBooked
  }))
);


    if (!compartment) {
      return res.status(409).json({
        error: "No free compartment",
      });
    }
    console.log("Compartment available, proceeding to unlock...");


    // ================= UNLOCK HARDWARE =================

   console.log("⚡ About to call unlockCompartment");

let hw;

try {
  hw = await unlockCompartment({
    sendUnlock,
    checkLockerStatus,
    compartmentId: compartment.compartmentId,
  });
  console.log("🔓 Unlock returned:", hw);
} catch (err) {
  console.error("❌ unlockCompartment threw error:", err);
  return res.status(500).json({
    success: false,
    message: "Unlock crashed",
  });
}


    console.log("🔓 Unlock result:", hw);

    if (!hw || !hw.ok) {
      return res.status(504).json({
        success: false,
        message: "Compartment did not unlock",
        details: hw,
      });
    }

    // ================= CREATE PARCEL =================

    let customId;
    while (true) {
      customId =
        "P" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const exists = await Parcel2.exists({ customId });
      if (!exists) break;
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + hrs * 3600000);

    const parcel = await Parcel2.create({
      senderPhone: deliveryPhone,
      receiverPhone: recipientPhone,
      size,
      cost : calculatedAmount,
      lockerId: locker.lockerId,
      hours: hrs,
      terminal_store: true,
      accessCode: Math.floor(100000 + Math.random() * 900000).toString(),
      customId,
      isDropoff: true,
      createdAt,
      expiresAt,
      status: "awaiting_pick",
      paymentStatus: "pending",
      helpId: helpId,
    });

    // ================= BOOK COMPARTMENT =================

    compartment.isBooked = true;
    compartment.currentParcelId = parcel._id;

    await locker.save();

    parcel.compartmentId = compartment.compartmentId;
    await parcel.save();

    console.log("✅ Unlock + Parcel created. Sending response to Flutter.");

    // ================= SEND RESPONSE IMMEDIATELY =================

    res.json({
      success: true,
      customId: parcel.customId,
      accessCode: parcel.accessCode,
      lockerId: parcel.lockerId,
      compartmentId: parcel.compartmentId,
    });

    // ================= BACKGROUND TASKS =================

    setImmediate(async () => {
      try {

        // ----------- NOTIFICATIONS -----------

        if (parcel.store_self) {
          await client.messages.create({
            to: `whatsapp:+91${parcel.senderPhone}`,
            from: "whatsapp:+15558076515",
            contentSid: "HXa7a69894f9567b90c1cacab6827ff46c",
            
          });

          const smsText2 = `Item successfully dropped at Locker ${
            locker.lockerId
          }. Pickup code: ${
            parcel.accessCode
          }. Share this securely. Receiver can also access via https://demo.droppoint.in/${parcel.customId}/qr - DROPPOINT`;

          console.log(await sendSMS(`91${parcel.senderPhone}`, smsText2));

        } else {

          await client.messages.create({
            to: `whatsapp:+91${parcel.receiverPhone}`,
            from: "whatsapp:+15558076515",
            contentSid: "HX4200777a18b1135e502d60b796efe670",
            contentVariables: JSON.stringify({
              1: parcel.receiverName || "",
              2: parcel.senderName || "",
              3: `mobile/incoming/${parcel.customId}/qr`,
              4: `dir/?api=1&destination=${parcel.lockerLat || ""},${parcel.lockerLng || ""}`,
            }),
          });
        }

        const smsText3 = `Item successfully dropped at Locker ${
          locker.lockerId
        }. Pickup code: ${
          parcel.accessCode
        }. Share this securely. Receiver can also access via https://demo.droppoint.in/qr?parcelid=${parcel.customId} - DROPPOINT`;

        console.log(await sendSMS(`91${parcel.senderPhone}`, smsText3));

        // ----------- LOCK CLOSE VERIFICATION -----------

        verifyLockerClosedUntilLocked(
          0x00,
          parseInt(compartment.compartmentId),
          helpId,
          1000
        )
          .then((result) => {
            if (!result) {
              console.warn("⚠️ Locker did not close in time");
            }
          })
          .catch((err) => {
            console.error("Verify loop crashed:", err);
          });

      } catch (err) {
        console.error("⚠️ Background task error:", err);
      }
    });

  } catch (err) {
    console.error("❌ personal dropoff error:", err);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: "Server error",
      });
    }
  }
});







app.post("/api/kiosk/reserve", async (req, res) => {
  const { lockerId, size, sessionId } = req.body;
console.log("RESERVE REQUEST:", req.body);

  const expiry = new Date(Date.now() + 3 * 60 * 1000);
const lockerDoc = await Locker.findOne({ lockerId });
console.log("LOCKER FOUND:", lockerDoc?.lockerId);
console.log("COMPARTMENTS:", lockerDoc?.compartments.map(c => ({
  id: c.compartmentId,
  size: c.size,
  status: c.status
})));
 const locker = await Locker.findOneAndUpdate(
  {
    lockerId,
    compartments: {
      $elemMatch: {
        size: size.toLowerCase(),
        $or: [
          { status: "available" },
          { status: "unknown" },  
          { status: { $exists: false } }  // 👈 handles old docs
        ]
      }
    }
  },
  {
    $set: {
      "compartments.$.status": "reserved",
      "compartments.$.reservedBySession": sessionId,
      "compartments.$.reservationExpiresAt": expiry
    }
  },
  { new: true }
);


  if (!locker) {
    return res.status(409).json({ success: false });
  }

  res.json({ success: true });
});


setInterval(async () => {
  await Locker.updateMany(
    {
      "compartments.status": "reserved",
      "compartments.reservationExpiresAt": { $lt: new Date() }
    },
    {
      $set: {
        "compartments.$[elem].status": "available",
        "compartments.$[elem].reservedBySession": null,
        "compartments.$[elem].reservationExpiresAt": null
      }
    },
    {
      arrayFilters: [
        {
          "elem.status": "reserved",
          "elem.reservationExpiresAt": { $lt: new Date() }
        }
      ]
    }
  );
}, 30000);


app.get("/locker/:lockerId/available-sizes", async (req, res) => {
  try {
    const { lockerId } = req.params;

    // Find locker by lockerId (not _id)
    const locker = await Locker.findOne({ lockerId: lockerId }).lean();

    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    // Default: assume none available
    const availability = {
      small: false,
      medium: false,
      large: false,
    };

    for (const c of locker.compartments) {
      const isFree = c.isBooked === false;

      if (isFree) {
        availability[c.size] = true; // if ANY free exists of that size → true
      }
    }
    console.log(availability);
    res.json(availability);
  } catch (err) {
    console.error("❌ Error getting available sizes:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/unlock", express.json(), async (req, res) => {
  const { accessCode } = req.body;
  console.log(accessCode);
  const sent = await sendUnlock(0, 0x00);
  console.log(sent);
  return res.json({
    success: true,

    message: "UNLCOKED",
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/// HARDWARE CONNECTION
const BU_IP = "192.168.0.178";
const BU_PORT = 4001;
const net = require("net");

let client1 = null;
let isConnected = false;

// =========================
//  Packet Builders
// =========================
function buildKerongUnlockPacket(compartmentId = 0x00, addr = 0x00) {
  const STX = 0x02;
  const CMD = 0x81;
  const ASK = 0x00;
  const DATALEN = 0x00;
  const ETX = 0x03;

  const LOCKNUM = compartmentId; // 0x00 to 0x0B
  const bytes = [STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX];
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0) & 0xff;
  bytes.push(checksum);

  return Buffer.from(bytes);
}

function isLockerUnlocked(status, lockerId) {
  const key = `Lock_${lockerId}`;
  if (!status.hasOwnProperty(key)) {
    throw new Error(`Locker ${lockerId} not found in status`);
  }
  return status[key] === "Unlocked";
}

async function unlockAndConfirm(lockNum, addr) {
  // 1. Send unlock packet
  await sendUnlock(lockNum, addr);

  // 2. Small delay (allow hardware to respond, ~300-500ms recommended)
  await new Promise((r) => setTimeout(r, 500));

  // 3. Query status
  const status = await getLockStatus(lockNum, addr); // implement send 0x80 and parse response

  // 4. Check if unlocked
  if (!status.isUnlocked) {
    throw new Error(`Failed to unlock locker ${lockNum} at addr ${addr}`);
  }

  return true;
}

function buildGetStatusPacket(addr = 0x00) {
  const STX = 0x02;
  const LOCKNUM = 0x00;
  const CMD = 0x80;
  const ASK = 0x00;
  const DATALEN = 0x00;
  const ETX = 0x03;

  let sum = STX + addr + LOCKNUM + CMD + ASK + DATALEN + ETX;
  const SUM = sum & 0xff;

  return Buffer.from([STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX, SUM]);
}

function parseLockStatus(data) {
  const len = data.length;
  if (len < 10) return null;

  const hookLow = data[len - 2];
  const hookHigh = data[len - 1];
  const hookState = (hookHigh << 8) | hookLow;

  let status = {};
  for (let i = 0; i < 12; i++) {
    status[`Lock_${i}`] = hookState & (1 << i) ? "Locked" : "Unlocked";
  }
  return status;
}

// =========================
//  BU Connection
// =========================
function connectToBU(ip = BU_IP, port = BU_PORT) {
  return new Promise((resolve) => {
    client1 = new net.Socket();

    client1.connect(port, ip, () => {
      console.log(`✅ Connected to BU at ${ip}:${port}`);
      isConnected = true;
      resolve(true);
    });

    client1.on("error", (err) => {
      console.error(`❌ TCP Error: ${err.message}`);
      isConnected = false;
      resolve(false);
    });

    client1.on("close", () => {
      console.warn("⚠️ BU connection closed. Reconnecting...");
      isConnected = false;
      setTimeout(() => connectToBU(ip, port), 2000);
    });

    // General data listener for polling
    client1.on("data", (data) => {
      // This will get overridden in send functions using once(), but for polling:
      if (pollingCallback) {
        pollingCallback(data);
      }
    });
  });
}

function closeBUConnection() {
  if (client1 && isConnected) {
    client1.end();
    client1.destroy();
    isConnected = false;
    console.log("🔌 BU connection closed manually");
  }
}
app.get("/status", (req, res) => {
  res.render("status");
});

// =========================
//  Send Packets
// =========================
async function sendPacket(packet) {
  return new Promise((resolve) => {
    if (!isConnected || !client1) {
      console.warn("⚠️ No active BU connection");
      return resolve(null);
    }

    client1.write(packet, (err) => {
      if (err) {
        console.error(`❌ Write Error: ${err.message}`);
        return resolve(null);
      }
      // console.log("📤 Sent:", packet.toString("hex").toUpperCase());
    });

    client1.once("data", (data) => {
      // console.log(`📥 Received: ${data.toString("hex").toUpperCase()}`);
      resolve(data);
    });
  });
}

function sendUnlock(compartmentId, addr = 0x00) {
  return sendPacket(buildKerongUnlockPacket(compartmentId, addr));
}

// =========================
//  Polling
// =========================
let pollingCallback = null;

function startPollingMultiple(addresses = [0x00, 0x01], intervalMs = 500, io) {
  pollingCallback = (data) => {
    const status = parseLockStatus(data);
    if (status) {
      // Extract address from response
      const addrFromResponse = data[1]; // byte after STX is usually address
      io.emit("lockerStatus", { addr: addrFromResponse, status });
    }
  };

  let currentIndex = 0;

  setInterval(() => {
    if (isConnected) {
      const addr = addresses[currentIndex];
      client1.write(buildGetStatusPacket(addr));
      currentIndex = (currentIndex + 1) % addresses.length;
    }
  }, intervalMs);
}

function startPolling(addr, intervalMs = 500, io) {
  pollingCallback = (data) => {
    const status = parseLockStatus(data);
    if (status) {
      io.emit("lockerStatus", { addr, status });
    }
  };

  setInterval(() => {
    if (isConnected) {
      client1.write(buildGetStatusPacket(addr));
    }
  }, intervalMs);
}

async function startBuAndPolling() {
  await connectToBU();

  // Start polling lockers for live UI updates
  startPolling(0x00, 500, io);
  startPolling(0x01, 500, io);
  startPollingMultiple([0x00, 0x01], 500, io);
}

async function checkLockerStatus(addr = 0x00, compartmentId = 0) {
  return new Promise((resolve) => {
    if (!isConnected || !client1) {
      console.warn("⚠️ No active BU connection");
      return resolve(null);
    }

    // Send GetStatus packet
    const packet = buildGetStatusPacket(addr);

    // Listen for 1 response only
    client1.once("data", (data) => {
      console.log(
        `📥 Received (checkLockerStatus): ${data.toString("hex").toUpperCase()}`,
      );

      const statusObj = parseLockStatus(data);
      if (!statusObj) {
        return resolve(null);
      }

      const key = `Lock_${compartmentId}`;
      const lockerStatus = statusObj[key];

      console.log("Parsed locker status:", lockerStatus);

      resolve(lockerStatus); // "Locked" or "Unlocked"
    });

    // Write packet
    client1.write(packet, (err) => {
      if (err) {
        console.error(`❌ Write Error: ${err.message}`);
        return resolve(null);
      }
      console.log(
        "📤 Sent (checkLockerStatus):",
        packet.toString("hex").toUpperCase(),
      );
    });
  });
}
const { getShiprocketEstimate } = require("./services/shiprocket.js");

// POST /api/delivery/estimate
app.post("/estimate", async (req, res) => {
  try {
    const { pickupPincode, dropPincode, weightKg } = req.body;

    if (!pickupPincode || !dropPincode) {
      return res.status(400).json({
        success: false,
        error: "Missing pincode",
      });
    }

    const estimates = await getShiprocketEstimate({
      pickup: { pincode: pickupPincode },
      drop: { pincode: dropPincode },
      parcel: { weightKg: weightKg || 0.5 },
    });

    // sort helpers
    const cheapest = [...estimates].sort((a, b) => a.rate - b.rate);
    const fastest = [...estimates].sort(
      (a, b) => a.estimated_delivery_days - b.estimated_delivery_days,
    );

    return res.json({
      success: true,
      cheapest,
      fastest,
    });
  } catch (err) {
    console.error("❌ Delivery estimate error:", err);
    return res.status(500).json({
      success: false,
      error: "Estimation failed",
    });
  }
});

app.post("/api/parcel/create", async (req, res) => {
  function genCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  try {
    const {
      senderName,
      senderPhone,
      receiverName,
      receiverPhone,
      delivery_address,
      delivery_city,
      delivery_state,
      delivery_pincode,
      size,
    } = req.body;

    // ✅ Create parcel
    const parcel = await Parcel2.create({
      senderName,
      senderPhone,

      receiverName,
      receiverPhone,

      delivery_address,
      delivery_city,
      delivery_state,
      delivery_pincode,

      size,

      receiverDeliveryMethod: "courier",

      accessCode: genCode(),
      modifyCode: genCode(),
      customId: "PARCEL-" + Date.now(),
      status: "awaiting_payment",
      paymentStatus: "pending",
    });

    // =========================
    // ✅ Save receiver to sender address book
    // =========================

    const receiverObj = {
      receiverName,
      receiverPhone,
      delivery_address,
      delivery_city,
      delivery_state,
      delivery_pincode,
      lastUsedAt: new Date(),
    };

    let book = await SenderBook.findOne({ senderPhone });

    if (!book) {
      // first time sender
      await SenderBook.create({
        senderName,
        senderPhone,
        receivers: [receiverObj],
      });
    } else {
      // check duplicate receiver
      const exists = book.receivers.find(
        (r) =>
          r.receiverPhone === receiverPhone &&
          r.delivery_pincode === delivery_pincode &&
          r.delivery_address === delivery_address,
      );

      if (!exists) {
        book.receivers.push(receiverObj);
      } else {
        exists.lastUsedAt = new Date(); // update usage
      }

      await book.save();
    }

    // =========================

    res.json({
      success: true,
      parcelId: parcel._id,
    });
  } catch (e) {
    console.error(e);
    res.send("Parcel creation failed");
  }
});

app.get("/api/parcel/rate/:id", async (req, res) => {
  try {
    const axios = require("axios");

    const parcel = await Parcel2.findById(req.params.id);
    if (!parcel) {
      return res.status(404).json({ message: "Parcel not found" });
    }

    // Shiprocket auth
    const tokenRes = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      },
    );

    const token = tokenRes.data.token;

    const rateRes = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode: "500081",
          delivery_postcode: parcel.delivery_pincode,
          weight:
            parcel.size === "small" ? 0.5 : parcel.size === "medium" ? 1 : 2,
          cod: 0,
        },
      },
    );

    const couriers = rateRes.data?.data?.available_courier_companies || [];
    console.log(couriers);
    return res.status(200).json({
      parcelId: parcel._id,
      couriers,
    });
  } catch (err) {
    console.log(err);
    console.error(err);
    res.status(500).json({
      message: "Failed to fetch parcel rates",
    });
  }
});

app.post("/api/parcel/select-courier/:id", async (req, res) => {
  try {
    const parcel = await Parcel2.findById(req.params.id);
    if (!parcel) {
      return res.status(404).json({ error: "Parcel not found" });
    }

    const { courier_code } = req.body;
    if (!courier_code) {
      return res.status(400).json({ error: "courier_code required" });
    }

    const axios = require("axios");

    // Shiprocket auth
    const tokenRes = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      },
    );

    const token = tokenRes.data.token;

    // Fetch rates again
    const rateRes = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode: "500081",
          delivery_postcode: parcel.delivery_pincode,
          weight:
            parcel.size === "small" ? 0.5 : parcel.size === "medium" ? 1 : 2,
          cod: 0,
        },
      },
    );

    const courier = rateRes.data.data.available_courier_companies.find(
      (c) => String(c.courier_company_id) === String(courier_code),
    );

    if (!courier) {
      return res.status(400).json({ error: "Invalid courier selected" });
    }

    // Save choice
    parcel.shiprocketQuote = {
      courier_name: courier.courier_name,
      estimated_cost: courier.rate,
      etd: courier.etd,
    };

    parcel.transitInfo = {
      courier: courier.courier_name,
      courierCode: courier.courier_company_id,
      rate: courier.rate,
      etd: courier.etd,
    };

    parcel.markModified("transitInfo");
    await parcel.save();

    res.json({
      success: true,
      parcelId: parcel._id,
      courier: courier.courier_name,
      rate: courier.rate,
      etd: courier.etd,
    });
  } catch (err) {
    console.error("SELECT COURIER ERROR:", err);
    res.status(500).json({ error: "Failed to lock courier" });
  }
});

app.post('/api/razorpay/order', express.json(), async (req, res) => {
  try {
    const { parcelId } = req.body;

    if (!parcelId) {
      return res.status(400).json({
        message: 'parcelId missing in request body',
      });
    }

    const parcel = await Parcel2.findById(parcelId);

    if (!parcel) {
      return res.status(400).json({
        message: 'Parcel not found',
      });
    }

    if (!parcel.cost || parcel.cost <= 0) {
      return res.status(400).json({
        message: 'Invalid overstay amount',
      });
    }

    const order = await razorpay.orders.create({
      amount: parcel.cost * 100, // PAISA
      currency: 'INR',
      receipt: `parcel_${parcel._id}`,
    });

    return res.status(200).json({
      key: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
    });
  } catch (err) {
    console.error('RAZORPAY ORDER ERROR:', err);

    return res.status(500).json({
      message: err.message || 'Order creation failed',
    });
  }
});






app.post("/api/razorpay/verify", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      parcelId,
    } = req.body;

    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(sign)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    await Parcel2.findByIdAndUpdate(parcelId, {
      paymentStatus: "completed",
      status: "awaiting_drop",
    });

    // 🔥 IMPORTANT: NO REDIRECT
    res.json({
      success: true,
      parcelId,
    });
  } catch (err) {
    console.error("RAZORPAY VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

const Shipment = require("./models/shipmentSchema");

app.post("/api/parcel/shiprocket/:id", async (req, res) => {
  const axios = require("axios");

  try {
    const parcel = await Parcel2.findById(req.params.id);

    if (!parcel) {
      return res.status(404).json({ error: "Parcel not found" });
    }

    if (!parcel.shiprocketQuote) {
      return res.status(400).json({ error: "Courier not selected" });
    }

    // ⛔ Prevent duplicate shipment creation
    if (parcel.transitInfo?.awb) {
      return res.json({
        success: true,
        message: "Shipment already created",
        awb: parcel.transitInfo.awb,
        courier: parcel.transitInfo.courier,
      });
    }

    // ===============================
    // 1️⃣ SHIPROCKET AUTH
    // ===============================
    const tokenRes = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      },
    );

    const token = tokenRes.data.token;

    // ===============================
    // 2️⃣ PARCEL DIMENSIONS
    // ===============================
    const dimensions =
      parcel.size === "small"
        ? { length: 10, breadth: 10, height: 5, weight: 0.5 }
        : parcel.size === "medium"
          ? { length: 20, breadth: 15, height: 10, weight: 1 }
          : { length: 30, breadth: 20, height: 15, weight: 2 };

    // ===============================
    // 3️⃣ CREATE SHIPROCKET ORDER
    // ===============================
    const orderRes = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/orders/create/adhoc",
      {
        order_id: parcel.customId,
        order_date: new Date().toISOString().split("T")[0],
        pickup_location: "Home",

        billing_customer_name: parcel.receiverName,
        billing_last_name: "NA",
        billing_address: parcel.delivery_address,
        billing_city: parcel.delivery_city,
        billing_state: parcel.delivery_state,
        billing_country: "India",
        billing_pincode: parcel.delivery_pincode,
        billing_phone: parcel.receiverPhone,

        shipping_is_billing: true,

        order_items: [
          {
            name: "Parcel",
            sku: "PARCEL-001",
            units: 1,
            selling_price: Number(parcel.shiprocketQuote.estimated_cost),
            discount: 0,
            tax: 0,
            hsn: "0000",
            is_document: 0,
          },
        ],

        payment_method: "Prepaid",
        sub_total: Number(parcel.shiprocketQuote.estimated_cost),

        ...dimensions,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const shipmentId = orderRes.data.shipment_id;

    // ===============================
    // 4️⃣ ASSIGN AWB
    // ===============================
    const awbRes = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
      { shipment_id: [shipmentId] },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const awbCode = awbRes.data.response.data.awb_code;

    // ⏳ Buffer for Shiprocket race condition
    await new Promise((r) => setTimeout(r, 3000));

    // ===============================
    // 5️⃣ PICKUP (SAFE CALL)
    // ===============================
    try {
      await axios.post(
        "https://apiv2.shiprocket.in/v1/external/courier/generate/pickup",
        { shipment_id: [shipmentId] },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (pickupErr) {
      console.warn("Pickup pending:", pickupErr.response?.data);
    }

    // ===============================
    // 6️⃣ SAVE TRANSIT INFO
    // ===============================
    parcel.transitInfo = {
      courier: orderRes.data.courier_name,
      shiprocketOrderId: orderRes.data.order_id,
      shiprocketCourierId: shipmentId,
      awb: awbCode,
      rate: parcel.shiprocketQuote.estimated_cost,
      etd: parcel.shiprocketQuote.etd,
      startedAt: new Date(),
    };

    parcel.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    parcel.markModified("transitInfo");
    await parcel.save();

    // ===============================
    // 7️⃣ SHIPMENT COLLECTION (OPTIONAL)
    // ===============================
    await Shipment.create({
      parcelId: parcel._id,
      internalOrderId: parcel.customId,
      shiprocketOrderId: orderRes.data.order_id,
      shipmentId,
      awb: awbCode,
      courierName: orderRes.data.courier_name,
      receiver: {
        name: parcel.receiverName,
        phone: parcel.receiverPhone,
        address: parcel.delivery_address,
        city: parcel.delivery_city,
        state: parcel.delivery_state,
        pincode: parcel.delivery_pincode,
      },
      dimensions,
      rate: parcel.shiprocketQuote.estimated_cost,
      etd: parcel.shiprocketQuote.etd,
      startedAt: new Date(),
      expiresAt: parcel.expiresAt,
      raw: {
        createOrder: orderRes.data,
        assignAwb: awbRes.data,
      },
    });
    try {
      const locker = await Locker.findOne({ lockerId: "L00002" });
      if (!locker) throw new Error("Locker not found");

      const compartment = locker.compartments.find(
        (c) => c.size === parcel.size && !c.isBooked,
      );
      if (!compartment) throw new Error("No free compartment");
      let addr = 0x00;
      let lockNum = parseInt(compartment.compartmentId);
      if (lockNum > 11) {
        addr = 0x01;
        lockNum -= 12;
      }
      const sent = await sendUnlock(lockNum, addr);

      compartment.isBooked = true;
      compartment.currentParcelId = parcel._id;

      await locker.save();
      parcel.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      parcel.status = "awaiting_pick";
      parcel.lockerId = locker.lockerId;
      parcel.compartmentId = compartment.compartmentId;
      await parcel.save();

      await client.messages.create({
        to: `whatsapp:+91${parcel.receiverPhone}`,
        from: "whatsapp:+15558076515",
        contentSid: "HXec73cd632b15592d48e1c6d698143e8d",
        contentVariables: JSON.stringify({
          1: parcel.accessCode,
        }),
      });
    } catch (err) {
      lockerError = err.message;
      console.error("⚠️ Locker allocation failed:", err.message);
    }

    // ===============================
    // ✅ FINAL RESPONSE (FLUTTER)
    // ===============================
    res.json({
      success: true,
      awb: awbCode,
      courier: parcel.transitInfo.courier,
      rate: parcel.transitInfo.rate,
      etd: parcel.transitInfo.etd,
    });
  } catch (err) {
    console.error("SHIPROCKET API ERROR:", err.response?.data || err);
    res.status(500).json({ error: "Shipment creation failed" });
  }
});

app.get("/api/lockers/all-locked", async (req, res) => {
  try {
    // decide which addresses to poll
    const addrs = (
      req.query.addrs
        ? String(req.query.addrs)
            .split(",")
            .map((s) => {
              s = s.trim();
              return s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
            })
        : [0x00]
    ) // default: two BUs
      .filter((n) => Number.isInteger(n) && n >= 0);

    if (!addrs.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid addresses provided." });
    }

    const perAddr = {};
    const unlockedList = [];
    let anyUnlocked = false;

    for (const addr of addrs) {
      // ask this BU for status
      const data = await sendPacket(buildGetStatusPacket(addr));

      if (!data) {
        // couldn't get a frame — be conservative
        perAddr[addr] = { ok: false, error: "no_response" };
        anyUnlocked = true;
        continue;
      }

      const status = parseLockStatus(data); // => { Lock_0: "Locked"/"Unlocked", ... }
      if (!status) {
        perAddr[addr] = {
          ok: false,
          error: "parse_failed",
          raw: data.toString("hex"),
        };
        anyUnlocked = true;
        continue;
      }

      // collect results for 0..11
      const locks = {};
      for (let i = 0; i < 5; i++) {
        const s = status[`Lock_${i}`];
        locks[i] = s;
        if (s === "Unlocked") {
          anyUnlocked = true;
          unlockedList.push({ addr, index: i });
        }
      }

      perAddr[addr] = { ok: true, status: locks };
    }

    return res.json({
      success: true,
      allLocked: !anyUnlocked,
      checkedAt: new Date().toISOString(),
      perAddr,
      unlockedList,
    });
  } catch (err) {
    console.error("all-locked API error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/payment", (req, res) => {
  res.render("payment.html");
});

const axios = require("axios");
const { exec } = require("child_process");


// =====================
// ⚙️ CONFIG
// =====================

const LOCKER_CODE = "L00002";
const ADMIN_URL = "https://admin.droppoint.in/api/locker-heartbeat";
const LOCKER_KEY = "supersecretkey";

const HEARTBEAT_INTERVAL = 5000;
const POST_TIMEOUT = 10000;

const BUFFER_FILE = "./hb-buffer.jsonl";


// =====================
// 🌐 CROSS PLATFORM PING
// =====================

function pingHost(host = "8.8.8.8") {

  const isWin = process.platform === "win32";
  const cmd = isWin
    ? `ping -n 2 ${host}`
    : `ping -c 2 ${host}`;

  return new Promise(resolve => {

    exec(cmd, { timeout: 6000 }, (err, stdout) => {

      if (err || !stdout) {
        return resolve({ online:false, latency:null });
      }

      const txt = stdout.toString();
      let latency = null;

      if (isWin) {
        const m = txt.match(/Average = (\d+)/);
        if (m) latency = parseInt(m[1]);
      } else {
        const m = txt.match(/time[=<]\s*([\d.]+)/);
        if (m) latency = Math.round(parseFloat(m[1]));
      }

      resolve({
        online: true,
        latency
      });

    });

  });
}


// =====================
// 📊 STRENGTH
// =====================

function strength(lat){
  if (lat == null) return "unknown";
  if (lat < 50) return "strong";
  if (lat < 120) return "medium";
  return "weak";
}


// =====================
// 💾 OFFLINE BUFFER
// =====================

function bufferSave(obj){
  fs.appendFileSync(
    BUFFER_FILE,
    JSON.stringify(obj) + "\n"
  );
}

async function flushBuffer(){

  if (!fs.existsSync(BUFFER_FILE)) return;

  const lines = fs.readFileSync(BUFFER_FILE,"utf8")
    .split("\n")
    .filter(Boolean);

  if (!lines.length) return;

  console.log("📤 Flushing buffer:", lines.length);

  const remaining = [];

  for (const line of lines){

    const data = JSON.parse(line);

    const ok = await postHeartbeat(data, false);

    if (!ok) remaining.push(line);
  }

  if (remaining.length)
    fs.writeFileSync(BUFFER_FILE, remaining.join("\n")+"\n");
  else
    fs.unlinkSync(BUFFER_FILE);
}


// =====================
// 📡 POST WITH RETRY
// =====================

async function postHeartbeat(payload, allowBuffer = true){

  try {

    await axios.post(
      ADMIN_URL,
      payload,
      {
        timeout: POST_TIMEOUT,
        headers: {
          "x-locker-key": LOCKER_KEY
        }
      }
    );

    //console.log("✅ HB sent", payload.internetOnline, payload.latencyMs);
    return true;

  } catch (e){

    console.log("❌ HB post fail:", e.message);

    if (allowBuffer){
      bufferSave(payload);
      console.log("💾 buffered");
    }

    return false;
  }
}


// =====================
// ❤️ HEARTBEAT LOOP
// =====================

async function heartbeat(){

  const net = await pingHost();

  const payload = {
    lockerCode: LOCKER_CODE,
    internetOnline: net.online,
    latencyMs: net.latency,
    strength: net.online ? strength(net.latency) : "offline",
    deviceTime: new Date().toISOString(),
    agentVersion: "2.0.0"
  };

  const ok = await postHeartbeat(payload);

  if (ok) {
    await flushBuffer();
  }

}


// =====================
// 🚀 START
// =====================

console.log("🚀 Kiosk Agent v2 started:", LOCKER_CODE);

heartbeat();
setInterval(heartbeat, HEARTBEAT_INTERVAL);


bootstrap().catch((err) => {
  console.error("❌ Fatal bootstrap error:", err);
  process.exit(1);
});
