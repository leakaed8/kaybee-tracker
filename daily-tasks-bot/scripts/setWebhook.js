// One-off script you run locally (not on Render) after deploying, to tell
// Telegram where to send updates. Reads TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET
// and PUBLIC_BASE_URL from daily-tasks-bot/.env -- see SETUP.md step 6.
const { loadEnv } = require("./loadEnv");
loadEnv();

const { createTelegramClient } = require("../src/telegramClient");

async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.WEBHOOK_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;

  if (!token || !secret || !baseUrl) {
    console.error(
      "Missing one of TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, PUBLIC_BASE_URL in daily-tasks-bot/.env"
    );
    process.exit(1);
  }

  const telegram = createTelegramClient(token);
  const url = `${baseUrl.replace(/\/$/, "")}/webhook/${secret}`;
  await telegram.setWebhook(url, secret);
  console.log("Webhook registered.");
  console.log("(URL not printed -- it contains your secret.)");
}

run().catch((err) => {
  console.error("Failed to set webhook:", err.message);
  process.exit(1);
});
