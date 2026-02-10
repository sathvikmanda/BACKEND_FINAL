const HelpRequest = require("../models/helpRequest");

/**
 * Adds a clip entry to a HelpRequest
 */
async function addClip({ helpId, type, start, end, path }) {
  if (!helpId || !type || start == null || end == null) {
    throw new Error("addClip: missing required fields");
  }

  console.log("🟡 addClip called:", {
    helpId,
    type,
    start,
    end,
    path,
  });

  const res = await HelpRequest.findOneAndUpdate(
    { helpId },
    {
      $push: {
        clips: {
          type,
          start,
          end,
          path,
          createdAt: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!res) {
    throw new Error("addClip: HelpRequest not found");
  }

  console.log("🟢 Clip metadata added to HelpRequest");
  return res;
}

module.exports = { addClip };
