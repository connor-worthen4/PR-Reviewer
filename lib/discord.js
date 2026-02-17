/**
 * Discord notification delivery.
 * Sends messages to a configured channel via the Discord Bot API.
 * Silently skips if not configured.
 */

const { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, log } = require("./config");

async function notify(message) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) return;

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message }),
      }
    );

    if (!res.ok) {
      log("WARN", `Discord notification failed: ${res.status}`);
    }
  } catch (err) {
    log("WARN", `Discord notification error: ${err.message}`);
  }
}

module.exports = { notify };
