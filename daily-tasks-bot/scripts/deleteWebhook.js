// Removes the Telegram webhook, e.g. if you want to temporarily stop the
// bot from receiving updates.
const { loadEnv } = require("./loadEnv");
loadEnv();

const { createTelegramClient } = require("../src/telegramClient");

async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN in daily-tasks-bot/.env");
    process.exit(1);
  }
  const telegram = createTelegramClient(token);
  await telegram.deleteWebhook();
  console.log("Webhook removed.");
}

run().catch((err) => {
  console.error("Failed to delete webhook:", err.message);
  process.exit(1);
});
