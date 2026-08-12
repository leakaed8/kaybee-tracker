const { addDays } = require("./dateUtils");

function nowIso() {
  return new Date().toISOString();
}

function byCreatedAt(a, b) {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

// Every function below takes "today" (a YYYY-MM-DD string, already resolved
// against Asia/Beirut by the caller) as an explicit argument rather than
// reading the clock itself, and a "store" (see sheetsStore.js / the test
// double in test/memoryStore.js) rather than talking to any specific
// database directly. That keeps the carry-over logic pure, deterministic,
// and testable without real Google credentials.

async function addTask(store, today, { title, dueDate, chatId }) {
  const due = dueDate || today;
  const now = nowIso();
  return store.insertTask({
    title,
    status: "pending",
    priority: "normal",
    created_at: now,
    updated_at: now,
    due_date: due,
    original_due_date: due,
    completed_at: null,
    carryover_count: 0,
    telegram_message_id: null,
    telegram_chat_id: chatId == null ? null : String(chatId),
  });
}

// Rolls forward any pending task whose due_date has slipped into the past
// relative to "today". Safe to call as often as we like (idempotent once a
// task's due_date reaches today, the filter simply stops matching it).
async function runCarryover(store, today) {
  const all = await store.listTasks();
  const toRoll = all.filter((t) => t.status === "pending" && t.due_date < today);
  if (!toRoll.length) return 0;
  const now = nowIso();
  await store.batchUpdateTasks(
    toRoll.map((t) => ({
      id: t.id,
      patch: { due_date: today, carryover_count: t.carryover_count + 1, updated_at: now },
    }))
  );
  return toRoll.length;
}

async function getTodayGrouped(store, today) {
  await runCarryover(store, today);
  const all = await store.listTasks();

  const pending = all
    .filter((t) => t.status === "pending" && t.due_date === today)
    .sort(byCreatedAt);
  const completedToday = all.filter((t) => t.status === "completed" && t.due_date === today);

  const carriedOver = pending.filter((t) => t.original_due_date !== t.due_date);
  const newToday = pending.filter((t) => t.original_due_date === t.due_date);

  return {
    today,
    carriedOver,
    newToday,
    completedCount: completedToday.length,
    pendingCount: pending.length,
  };
}

async function findTaskById(store, id) {
  const all = await store.listTasks();
  return all.find((t) => t.id === id) || null;
}

async function completeTask(store, id) {
  const existing = await findTaskById(store, id);
  if (!existing || existing.status !== "pending") return existing;
  const now = nowIso();
  return store.updateTask(id, { status: "completed", completed_at: now, updated_at: now });
}

async function rescheduleTomorrow(store, today, id) {
  const existing = await findTaskById(store, id);
  if (!existing || existing.status !== "pending") return existing;
  const tomorrow = addDays(today, 1);
  const now = nowIso();
  return store.updateTask(id, { due_date: tomorrow, updated_at: now });
}

async function deleteTask(store, id) {
  const now = nowIso();
  await store.updateTask(id, { status: "deleted", updated_at: now });
}

async function getTasksOnMessage(store, chatId, messageId) {
  const all = await store.listTasks();
  return all
    .filter(
      (t) =>
        t.status !== "deleted" &&
        String(t.telegram_chat_id) === String(chatId) &&
        String(t.telegram_message_id) === String(messageId)
    )
    .sort(byCreatedAt);
}

async function setTaskMessageRef(store, taskIds, chatId, messageId) {
  if (!taskIds.length) return;
  const now = nowIso();
  await store.batchUpdateTasks(
    taskIds.map((id) => ({
      id,
      patch: { telegram_message_id: String(messageId), telegram_chat_id: String(chatId), updated_at: now },
    }))
  );
}

async function wasDigestSentToday(store, today) {
  const value = await store.getState("last_digest_sent_date");
  return value === today;
}

async function markDigestSentToday(store, today) {
  await store.setState("last_digest_sent_date", today);
}

module.exports = {
  addTask,
  runCarryover,
  getTodayGrouped,
  findTaskById,
  completeTask,
  rescheduleTomorrow,
  deleteTask,
  getTasksOnMessage,
  setTaskMessageRef,
  wasDigestSentToday,
  markDigestSentToday,
};
