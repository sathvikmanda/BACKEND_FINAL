function getBoardAddress(compartmentId) {
  let addr = 0x00;
  let lockNum = parseInt(compartmentId);

  if (lockNum > 11) {
    addr = 0x01;
    lockNum -= 12;
  }

  return { addr, lockNum };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function unlockCompartment({
  sendUnlock,
  checkLockerStatus,
  compartmentId,
  verifyDelay = 500,
  verifyTimeout = 2000
}) {
  const { addr, lockNum } = getBoardAddress(compartmentId);

  // 1️⃣ send unlock
  const sent = await sendUnlock(lockNum, addr);
  if (!sent) {
    return {
      ok: false,
      error: "SEND_FAIL",
      addr,
      lockNum
    };
  }

  // 2️⃣ wait for relay movement
  await wait(verifyDelay);

  // 3️⃣ verify status from board
  const status = await checkLockerStatus(addr, lockNum, verifyTimeout);

  if (status !== "Unlocked") {
    return {
      ok: false,
      error: "NOT_UNLOCKED",
      addr,
      lockNum,
      reported: status || null
    };
  }

  return {
    ok: true,
    addr,
    lockNum
  };
}

module.exports = {
  getBoardAddress,
  unlockCompartment
};
