/**
 * unlock.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Opens ALL 16 compartments across two BU (Base Unit) addresses:
 *   • addr 0x00  → compartments 0 – 10  (11 locks)
 *   • addr 0x01  → compartments 0 – 4   ( 5 locks)
 *
 * Run with:  node unlock.js
 *
 * Hardware protocol mirrors server.js exactly:
 *   buildKerongUnlockPacket  – assemble a 8-byte unlock frame
 *   sendPacket               – write frame over TCP, await ACK
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const net = require("net");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BU_IP = "192.168.0.178";
const BU_PORT = 4001;

/** Delay between consecutive unlock commands (ms) — gives hardware time to ACK */
const STEP_DELAY_MS = 300;

/** How long to wait for an ACK from the BU before giving up (ms) */
const ACK_TIMEOUT_MS = 2000;

// ─── Compartment map ─────────────────────────────────────────────────────────
// Each entry: { addr, compartmentId }
const ALL_LOCKS = [
  // addr 0x00 → indices 0 through 10
  ...Array.from({ length: 11 }, (_, i) => ({ addr: 0x00, compartmentId: i })),

  // addr 0x01 → indices 0 through 4
  ...Array.from({ length: 5 }, (_, i) => ({ addr: 0x01, compartmentId: i })),
];

// ─── Packet builders (identical to server.js) ─────────────────────────────────
/**
 * Builds a Kerong unlock packet.
 *
 * Frame layout (8 bytes):
 *   [ STX | ADDR | LOCKNUM | CMD | ASK | DATALEN | ETX | CHECKSUM ]
 *
 * @param {number} compartmentId  0-based lock index on this BU (0x00 – 0x0B)
 * @param {number} addr           BU address  (0x00 or 0x01)
 * @returns {Buffer}
 */
function buildKerongUnlockPacket(compartmentId = 0x00, addr = 0x00) {
  const STX = 0x02;
  const CMD = 0x81;   // unlock command
  const ASK = 0x00;
  const DATALEN = 0x00;
  const ETX = 0x03;

  const LOCKNUM = compartmentId;
  const bytes = [STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX];
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0) & 0xff;
  bytes.push(checksum);

  return Buffer.from(bytes);
}

// ─── TCP helpers ──────────────────────────────────────────────────────────────
/**
 * Sends one packet over `socket` and resolves with the raw ACK buffer.
 * Rejects if no data arrives within ACK_TIMEOUT_MS.
 */
function sendPacket(socket, packet) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ACK timeout"));
    }, ACK_TIMEOUT_MS);

    socket.once("data", (data) => {
      clearTimeout(timer);
      resolve(data);
    });

    socket.write(packet, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** Simple ms-delay helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🔌 Connecting to BU at ${BU_IP}:${BU_PORT} …`);

  const socket = await new Promise((resolve, reject) => {
    const s = new net.Socket();

    s.connect(BU_PORT, BU_IP, () => {
      console.log(`✅ Connected.\n`);
      resolve(s);
    });

    s.on("error", (err) => {
      reject(new Error(`TCP error: ${err.message}`));
    });
  });

  let successCount = 0;
  let failCount = 0;

  for (const { addr, compartmentId } of ALL_LOCKS) {
    const label = `addr 0x${addr.toString(16).padStart(2, "0").toUpperCase()}  lock #${compartmentId}`;

    try {
      const packet = buildKerongUnlockPacket(compartmentId, addr);

      process.stdout.write(`  🔓 Unlocking ${label} … `);

      const ack = await sendPacket(socket, packet);

      console.log(`ACK: ${ack.toString("hex").toUpperCase()}`);
      successCount++;
    } catch (err) {
      console.log(`❌ FAILED — ${err.message}`);
      failCount++;
    }

    // Brief pause so the hardware doesn't get flooded
    await sleep(STEP_DELAY_MS);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Total locks : ${ALL_LOCKS.length}
  ✅ Success  : ${successCount}
  ❌ Failed   : ${failCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  socket.destroy();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  process.exit(1);
});
