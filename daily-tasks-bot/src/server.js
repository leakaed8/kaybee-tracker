const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { createDb } = require("./db");
const { createTelegramClient } = require("./telegramClient");
const { handleUpdate } = require("./botHandlers");
const taskService = require("./taskService");
const { buildDigestMessage } = require("./messageBuilder");
const { todayInTz } = require("./dateUtils");

async function main() {
  const db = await createDb({ url: config.tursoDatabaseUrl, authToken: config.tursoAuthToken });
  const telegram = createTelegramClient(config.telegramBotToken);
  const ctx = { db, telegram, config, logger };

  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => res.send("DailyTasks bot is running."));
  app.get("/health", (req, res) => res.status(200).json({ ok: true }));

  // Telegram webhook. The secret in the path plus the header Telegram sets
  // from our setWebhook secret_token both have to match, otherwise a
  // random visitor hitting this URL gets a 404 and nothing else happens.
  app.post(`/webhook/:secret`, async (req, res) => {
    const pathSecretOk = req.params.secret === config.webhookSecret;
    const headerSecretOk = req.get("x-telegram-bot-api-secret-token") === config.webhookSecret;
    if (!pathSecretOk || !headerSecretOk) {
      res.sendStatus(404);
      return;
    }
    res.sendStatus(200); // ack immediately; Telegram doesn't need to wait for our processing
    handleUpdate(ctx, req.body || {}).catch((err) =>
      logger.error("Unhandled webhook error", { message: err.message })
    );
  });

  // Hit once a day (9:30 AM Asia/Beirut) by an external scheduler (cron-job.org).
  // Idempotent: if it's pinged twice for the same Beirut calendar day, the
  // second call is a no-op.
  app.get("/cron/daily", async (req, res) => {
    if (req.query.key !== config.cronSecret) {
      res.sendStatus(404);
      return;
    }
    try {
      const today = todayInTz(config.timezone);
      const alreadySent = await taskService.wasDigestSentToday(db, today);
      if (alreadySent) {
        res.status(200).json({ ok: true, skipped: "already sent today" });
        return;
      }
      if (!config.allowedTelegramUserId) {
        res.status(200).json({ ok: true, skipped: "no ALLOWED_TELEGRAM_USER_ID configured yet" });
        return;
      }
      const grouped = await taskService.getTodayGrouped(db, today);
      const { text, keyboard } = buildDigestMessage(grouped, config.timezone);
      const sent = await telegram.sendMessage(config.allowedTelegramUserId, text, keyboard);
      const allTaskIds = [...grouped.carriedOver, ...grouped.newToday].map((t) => t.id);
      await taskService.setTaskMessageRef(db, allTaskIds, config.allowedTelegramUserId, sent.message_id);
      await taskService.markDigestSentToday(db, today);
      logger.info("Sent daily digest", { taskCount: allTaskIds.length });
      res.status(200).json({ ok: true, sent: true, taskCount: allTaskIds.length });
    } catch (err) {
      logger.error("Failed to send daily digest", { message: err.message });
      res.status(500).json({ ok: false });
    }
  });

  app.listen(config.port, () => {
    logger.info(`DailyTasks bot listening on port ${config.port}`);
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { message: err.message });
  process.exit(1);
});
