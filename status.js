/**
 * status.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Queries the lock status of ALL compartments across both BU addresses:
 *   • addr 0x00  → Lock_0  … Lock_10  (11 locks)
 *   • addr 0x01  → Lock_0  … Lock_4   ( 5 locks)
 *
 * Run with:  node status.js
 *
 * Protocol mirrors server.js:
 *   buildGetStatusPacket  – assemble an 8-byte status-query frame (CMD 0x80)
 *   parseLockStatus       – decode the 16-bit hook-state bitmask from the response
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const net = require("net");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BU_IP          = "192.168.0.178";
const BU_PORT        = 4001;
const ACK_TIMEOUT_MS = 3000;   // wait up to 3 s for a response per address
const STEP_DELAY_MS  = 400;    // pause between queries so the BU isn't flooded

// ─── BU address map ──────────────────────────────────────────────────────────
// Each entry: { addr, lockCount } — matches the compartment layout in server.js
const BU_ADDRESSES = [
  { addr: 0x00, lockCount: 11, label: "BU-A (addr 0x00)" },
  { addr: 0x01, lockCount: 5,  label: "BU-B (addr 0x01)" },
];

// ─── Packet builder (identical to server.js) ─────────────────────────────────
/**
 * Builds a Kerong get-status packet.
 *
 * Frame layout (8 bytes):
 *   [ STX | ADDR | LOCKNUM | CMD | ASK | DATALEN | ETX | CHECKSUM ]
 *
 * @param {number} addr  BU address (0x00 or 0x01)
 * @returns {Buffer}
 */
function buildGetStatusPacket(addr = 0x00) {
  const STX     = 0x02;
  const LOCKNUM = 0x00;
  const CMD     = 0x80;   // get-status command
  const ASK     = 0x00;
  const DATALEN = 0x00;
  const ETX     = 0x03;

  const sum = (STX + addr + LOCKNUM + CMD + ASK + DATALEN + ETX) & 0xff;
  return Buffer.from([STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX, sum]);
}

// ─── Response parser (identical to server.js) ────────────────────────────────
/**
 * Decodes the 16-bit hook-state bitmask from a status response frame.
 * Returns an object like { Lock_0: "Locked", Lock_1: "Unlocked", … }
 *
 * @param {Buffer} data  Raw bytes received from BU
 * @returns {Object|null}
 */
function parseLockStatus(data) {
  if (!data || data.length < 10) return null;

  const len      = data.length;
  const hookLow  = data[len - 2];
  const hookHigh = data[len - 1];
  const hookState = (hookHigh << 8) | hookLow;

  const status = {};
  for (let i = 0; i < 12; i++) {
    status[`Lock_${i}`] = hookState & (1 << i) ? "Locked" : "Unlocked";
  }
  return status;
}

// ─── TCP helper ───────────────────────────────────────────────────────────────
/** Simple ms-delay helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends one packet over `socket` and resolves with the raw response buffer.
 * Rejects on write error or if no data arrives within ACK_TIMEOUT_MS.
 */
function sendPacket(socket, packet) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Response timeout"));
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

// ─── Display helpers ──────────────────────────────────────────────────────────
const LOCKED_ICON   = "🔒";
const UNLOCKED_ICON = "🔓";

function printHeader(label) {
  console.log(`\n┌─────────────────────────────────────────────────┐`);
  console.log(`│  ${label.padEnd(47)}│`);
  console.log(`├──────────────┬──────────────────────────────────┤`);
  console.log(`│  Compartment │  Status                          │`);
  console.log(`├──────────────┼──────────────────────────────────┤`);
}

function printRow(compartmentId, statusStr) {
  const icon   = statusStr === "Locked" ? LOCKED_ICON : UNLOCKED_ICON;
  const cell   = `  ${icon}  ${statusStr}`.padEnd(34);
  const idCell = `  Lock #${compartmentId}`.padEnd(14);
  console.log(`│${idCell}│${cell}│`);
}

function printFooter() {
  console.log(`└──────────────┴──────────────────────────────────┘`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔌  Connecting to BU at ${BU_IP}:${BU_PORT} …`);

  const socket = await new Promise((resolve, reject) => {
    const s = new net.Socket();

    s.connect(BU_PORT, BU_IP, () => {
      console.log(`✅  Connected.\n`);
      resolve(s);
    });

    s.on("error", (err) => reject(new Error(`TCP error: ${err.message}`)));
  });

  let totalLocked   = 0;
  let totalUnlocked = 0;
  let totalErrors   = 0;

  for (const { addr, lockCount, label } of BU_ADDRESSES) {
    const packet = buildGetStatusPacket(addr);

    let statusObj = null;

    try {
      const raw = await sendPacket(socket, packet);
      console.log(`📡  Raw response for ${label}: ${raw.toString("hex").toUpperCase()}`);
      statusObj = parseLockStatus(raw);
    } catch (err) {
      console.error(`❌  Failed to get status for ${label}: ${err.message}`);
    }

    printHeader(label);

    for (let i = 0; i < lockCount; i++) {
      if (!statusObj) {
        printRow(i, "ERROR (no response)");
        totalErrors++;
      } else {
        const st = statusObj[`Lock_${i}`] ?? "Unknown";
        printRow(i, st);
        if (st === "Locked")   totalLocked++;
        else if (st === "Unlocked") totalUnlocked++;
        else totalErrors++;
      }
    }

    printFooter();

    // Brief pause before querying next address
    await sleep(STEP_DELAY_MS);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  const total = totalLocked + totalUnlocked + totalErrors;
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Total compartments queried : ${total}
  🔒  Locked                 : ${totalLocked}
  🔓  Unlocked               : ${totalUnlocked}
  ❌  Errors / No response   : ${totalErrors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  socket.destroy();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("💥  Fatal error:", err.message);
  process.exit(1);
});
