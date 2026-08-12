// Central place that reads environment variables. Nothing here ever logs
// a secret value -- see logger.js for redaction on top of that.

function required(name, { allowEmptyInDev = false } = {}) {
  const value = process.env[name];
  if (!value && !allowEmptyInDev) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || "";
}

const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  // Allowed to be blank at boot: the bot runs in "setup mode" until this is set.
  allowedTelegramUserId: process.env.ALLOWED_TELEGRAM_USER_ID || "",
  webhookSecret: required("WEBHOOK_SECRET"),
  cronSecret: required("CRON_SECRET"),
  // Same env var names as kaybee-tracker's server/.env.example, so if this is
  // deployed with the same Google Cloud service account, you can reuse the
  // exact same GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY values.
  googleServiceAccountEmail: required("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  googlePrivateKey: required("GOOGLE_PRIVATE_KEY"),
  sheetId: required("SHEET_ID"),
  port: Number(process.env.PORT) || 3000,
  timezone: process.env.TIMEZONE || "Asia/Beirut",
};

module.exports = config;
