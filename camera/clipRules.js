const { RECORDING_REASONS } = require("./recordingReasons");

const CLIP_RULES = {
  [RECORDING_REASONS.DOOR_OPEN]: { before: 5, after: 15 },
  [RECORDING_REASONS.HELP_BUTTON]: { before: 10, after: 20 },
  [RECORDING_REASONS.KIOSK_INTERACTION]: { before: 5, after: 10 },
  [RECORDING_REASONS.SUPPORT_AGENT]: { before: 10, after: 30 },
  [RECORDING_REASONS.ERROR_FLOW]: { before: 10, after: 20 },
};

module.exports = { CLIP_RULES };
