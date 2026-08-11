CREATE TABLE IF NOT EXISTS tasks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | completed | deleted
  priority             TEXT NOT NULL DEFAULT 'normal',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  due_date             TEXT NOT NULL,                   -- YYYY-MM-DD, Asia/Beirut calendar date
  original_due_date    TEXT NOT NULL,                   -- immutable, set once at creation
  completed_at         TEXT,
  carryover_count      INTEGER NOT NULL DEFAULT 0,
  telegram_message_id  INTEGER,                         -- last message this task was rendered in
  telegram_chat_id     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_date);

-- Single-row table tracking bookkeeping like "did we already send today's
-- digest", so a duplicate cron ping never sends the morning message twice.
CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
