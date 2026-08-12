const { isAuthorized } = require("./auth");
const { extractTitleAndDueDate, todayInTz } = require("./dateUtils");
const taskService = require("./taskService");
const { buildTodayMessage, rebuildMessage } = require("./messageBuilder");

const UNAUTHORIZED_TEXT =
  "🔒 This is a private bot. You are not authorized to use it.";

function parseCommand(text) {
  const match = text.trim().match(/^\/(\w+)(@\w+)?\s*([\s\S]*)$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[3].trim() };
}

async function sendTodayMessage(ctx, chatId) {
  const { store, telegram, config } = ctx;
  const today = todayInTz(config.timezone);
  const grouped = await taskService.getTodayGrouped(store, today);
  const { text, keyboard } = buildTodayMessage(grouped, config.timezone);
  const sent = await telegram.sendMessage(chatId, text, keyboard);
  const allTaskIds = [...grouped.carriedOver, ...grouped.newToday].map((t) => t.id);
  await taskService.setTaskMessageRef(store, allTaskIds, chatId, sent.message_id);
  return sent;
}

async function handleMessage(ctx, message) {
  const { config, telegram, logger } = ctx;
  const userId = message.from && message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (!isAuthorized(config.allowedTelegramUserId, userId)) {
    if (!config.allowedTelegramUserId) {
      await telegram.sendMessage(
        chatId,
        `👋 Setup mode.\n\nYour Telegram user ID is:\n<code>${userId}</code>\n\n` +
          `Set this as the <code>ALLOWED_TELEGRAM_USER_ID</code> environment variable, then redeploy. ` +
          `Until then, no one (including you) can use this bot.`
      );
    } else {
      await telegram.sendMessage(chatId, UNAUTHORIZED_TEXT);
      logger.warn("Rejected message from unauthorized user", { userId, chatId });
    }
    return;
  }

  if (!text.startsWith("/")) {
    await telegram.sendMessage(
      chatId,
      "I didn't recognize that. Try /add <task>, /today, or /help."
    );
    return;
  }

  const parsed = parseCommand(text);
  if (!parsed) return;

  switch (parsed.command) {
    case "start":
      await telegram.sendMessage(
        chatId,
        "👋 <b>DailyTasks</b> is ready.\n\n" +
          "/add &lt;task&gt; — add a task (optionally ending in \"tomorrow\", a weekday, or YYYY-MM-DD)\n" +
          "/today — show today's tasks\n" +
          "/help — show this again"
      );
      return;
    case "help":
      await telegram.sendMessage(
        chatId,
        "<b>Commands</b>\n" +
          "/add Call supplier — due today\n" +
          "/add Call supplier tomorrow\n" +
          "/add Call supplier Friday\n" +
          "/add Call supplier 2026-08-15\n" +
          "/today — show today's tasks with buttons\n\n" +
          "Buttons on each task: ✅ Done, ↩️ Tomorrow, 🗑 Delete."
      );
      return;
    case "add": {
      if (!parsed.args) {
        await telegram.sendMessage(chatId, "Usage: /add <task description>");
        return;
      }
      const { title, dueDate } = extractTitleAndDueDate(parsed.args, config.timezone);
      if (!title) {
        await telegram.sendMessage(chatId, "Usage: /add <task description>");
        return;
      }
      const today = todayInTz(config.timezone);
      const task = await taskService.addTask(ctx.store, today, { title, dueDate, chatId });
      await telegram.sendMessage(
        chatId,
        `Added: <b>${escapeForReply(task.title)}</b>\nDue: ${task.due_date}`
      );
      return;
    }
    case "today":
      await sendTodayMessage(ctx, chatId);
      return;
    default:
      await telegram.sendMessage(chatId, "Unknown command. Try /help.");
  }
}

function escapeForReply(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleCallbackQuery(ctx, callbackQuery) {
  const { store, telegram, config, logger } = ctx;
  const userId = callbackQuery.from && callbackQuery.from.id;
  const message = callbackQuery.message;
  if (!message) return;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (!isAuthorized(config.allowedTelegramUserId, userId)) {
    await telegram.answerCallbackQuery(callbackQuery.id, "Not authorized.");
    logger.warn("Rejected callback from unauthorized user", { userId, chatId });
    return;
  }

  const [action, taskId] = (callbackQuery.data || "").split(":");
  if (!taskId) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }

  let feedback = "";
  let pendingConfirmDeleteId = null;

  switch (action) {
    case "done":
      await taskService.completeTask(store, taskId);
      feedback = "Done ✅";
      break;
    case "tomorrow":
      await taskService.rescheduleTomorrow(store, todayInTz(config.timezone), taskId);
      feedback = "Moved to tomorrow ↩️";
      break;
    case "delete":
      pendingConfirmDeleteId = taskId;
      feedback = "Confirm delete?";
      break;
    case "delete_confirm":
      await taskService.deleteTask(store, taskId);
      feedback = "Deleted 🗑";
      break;
    case "delete_cancel":
      feedback = "Cancelled";
      break;
    default:
      await telegram.answerCallbackQuery(callbackQuery.id);
      return;
  }

  const tasks = await taskService.getTasksOnMessage(store, chatId, messageId);
  const { text, keyboard } = rebuildMessage(tasks, config.timezone, { pendingConfirmDeleteId });
  await telegram.editMessageText(chatId, messageId, text, keyboard);
  await telegram.answerCallbackQuery(callbackQuery.id, feedback);
}

async function handleUpdate(ctx, update) {
  try {
    if (update.message) {
      await handleMessage(ctx, update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(ctx, update.callback_query);
    }
  } catch (err) {
    ctx.logger.error("Error handling update", { message: err.message });
  }
}

module.exports = { handleUpdate, sendTodayMessage, parseCommand };
