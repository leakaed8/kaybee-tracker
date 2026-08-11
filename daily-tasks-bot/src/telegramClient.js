// Thin wrapper over the Telegram Bot API using the platform's built-in
// fetch (Node 18+). Never logs the token: the token only ever appears
// inside the request URL, which we deliberately don't log.

const API_BASE = "https://api.telegram.org";

function createTelegramClient(botToken) {
  async function call(method, body) {
    const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API error on ${method}: ${data.description || res.status}`);
    }
    return data.result;
  }

  return {
    sendMessage(chatId, text, replyMarkup) {
      return call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
    },
    editMessageText(chatId, messageId, text, replyMarkup) {
      return call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
    },
    answerCallbackQuery(callbackQueryId, text) {
      return call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      });
    },
    setWebhook(url, secretToken) {
      return call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
      });
    },
    deleteWebhook() {
      return call("deleteWebhook", {});
    },
    getMe() {
      return call("getMe", {});
    },
  };
}

module.exports = { createTelegramClient };
