const { addDays } = require("./dateUtils");

function nowIso() {
  return new Date().toISOString();
}

// Every function below takes "today" (a YYYY-MM-DD string, already resolved
// against Asia/Beirut by the caller) as an explicit argument rather than
// reading the clock itself. That keeps all the carry-over logic pure and
// deterministic, so it can be unit tested without mocking time.

async function addTask(db, today, { title, dueDate, chatId }) {
  const due = dueDate || today;
  const now = nowIso();
  const result = await db.execute({
    sql: `INSERT INTO tasks
            (title, status, priority, created_at, updated_at, due_date, original_due_date, carryover_count, telegram_chat_id)
          VALUES (?, 'pending', 'normal', ?, ?, ?, ?, 0, ?)`,
    args: [title, now, now, due, due, chatId],
  });
  return getTaskById(db, Number(result.lastInsertRowid));
}

// Rolls forward any pending task whose due_date has slipped into the past
// relative to "today". Safe to call as often as we like (idempotent once a
// task's due_date reaches today, the WHERE clause simply stops matching it).
async function runCarryover(db, today) {
  const now = nowIso();
  const result = await db.execute({
    sql: `UPDATE tasks
          SET due_date = ?, carryover_count = carryover_count + 1, updated_at = ?
          WHERE status = 'pending' AND due_date < ?`,
    args: [today, now, today],
  });
  return result.rowsAffected || 0;
}

async function getTodayGrouped(db, today) {
  await runCarryover(db, today);

  const pending = await db.execute({
    sql: `SELECT * FROM tasks WHERE status = 'pending' AND due_date = ? ORDER BY id ASC`,
    args: [today],
  });
  const completedToday = await db.execute({
    sql: `SELECT * FROM tasks WHERE status = 'completed' AND due_date = ? ORDER BY id ASC`,
    args: [today],
  });

  const rows = pending.rows.map(rowToTask);
  const carriedOver = rows.filter((t) => t.original_due_date !== t.due_date);
  const newToday = rows.filter((t) => t.original_due_date === t.due_date);

  return {
    today,
    carriedOver,
    newToday,
    completedCount: completedToday.rows.length,
    pendingCount: rows.length,
  };
}

async function getTaskById(db, id) {
  const result = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  return result.rows[0] ? rowToTask(result.rows[0]) : null;
}

async function completeTask(db, id) {
  const now = nowIso();
  await db.execute({
    sql: `UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    args: [now, now, id],
  });
  return getTaskById(db, id);
}

async function rescheduleTomorrow(db, today, id) {
  const tomorrow = addDays(today, 1);
  const now = nowIso();
  await db.execute({
    sql: `UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    args: [tomorrow, now, id],
  });
  return getTaskById(db, id);
}

async function deleteTask(db, id) {
  const now = nowIso();
  await db.execute({
    sql: `UPDATE tasks SET status = 'deleted', updated_at = ? WHERE id = ?`,
    args: [now, id],
  });
}

async function getTasksOnMessage(db, chatId, messageId) {
  const result = await db.execute({
    sql: `SELECT * FROM tasks
          WHERE telegram_chat_id = ? AND telegram_message_id = ? AND status != 'deleted'
          ORDER BY id ASC`,
    args: [chatId, messageId],
  });
  return result.rows.map(rowToTask);
}

async function setTaskMessageRef(db, taskIds, chatId, messageId) {
  if (!taskIds.length) return;
  const now = nowIso();
  await db.batch(
    taskIds.map((id) => ({
      sql: `UPDATE tasks SET telegram_message_id = ?, telegram_chat_id = ?, updated_at = ? WHERE id = ?`,
      args: [messageId, chatId, now, id],
    }))
  );
}

async function wasDigestSentToday(db, today) {
  const result = await db.execute({
    sql: `SELECT value FROM bot_state WHERE key = 'last_digest_sent_date'`,
    args: [],
  });
  return Boolean(result.rows[0] && result.rows[0].value === today);
}

async function markDigestSentToday(db, today) {
  await db.execute({
    sql: `INSERT INTO bot_state (key, value) VALUES ('last_digest_sent_date', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [today],
  });
}

function rowToTask(row) {
  return {
    id: Number(row.id),
    title: row.title,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
    due_date: row.due_date,
    original_due_date: row.original_due_date,
    completed_at: row.completed_at,
    carryover_count: Number(row.carryover_count),
    telegram_message_id: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
    telegram_chat_id: row.telegram_chat_id == null ? null : Number(row.telegram_chat_id),
  };
}

module.exports = {
  addTask,
  runCarryover,
  getTodayGrouped,
  getTaskById,
  completeTask,
  rescheduleTomorrow,
  deleteTask,
  getTasksOnMessage,
  setTaskMessageRef,
  wasDigestSentToday,
  markDigestSentToday,
};
