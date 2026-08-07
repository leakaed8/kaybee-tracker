// Thin wrapper over the Telegram Bot API (plain HTTPS, no SDK needed).
// Requires TELEGRAM_BOT_TOKEN. Every function no-ops safely if it's unset,
// since Telegram alerts are an optional feature on top of the rest of the app.

const API_BASE = "https://api.telegram.org";

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function isConfigured() {
  return Boolean(token());
}

async function call(method, body) {
  if (!isConfigured()) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const res = await fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error on ${method}`);
  return data.result;
}

async function getMe() {
  return call("getMe");
}

async function sendMessage(chatId, text, replyMarkup) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

async function answerCallbackQuery(id, text) {
  return call("answerCallbackQuery", { callback_query_id: id, text });
}

async function setWebhook(url, secretToken) {
  return call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
  });
}

module.exports = { isConfigured, getMe, sendMessage, answerCallbackQuery, setWebhook };
