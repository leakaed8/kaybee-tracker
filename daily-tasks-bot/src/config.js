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
  tursoDatabaseUrl: required("TURSO_DATABASE_URL"),
  tursoAuthToken: required("TURSO_AUTH_TOKEN"),
  port: Number(process.env.PORT) || 3000,
  timezone: process.env.TIMEZONE || "Asia/Beirut",
};

module.exports = config;
