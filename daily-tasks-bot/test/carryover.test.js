const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/db");
const taskService = require("../src/taskService");

// Fresh in-memory libSQL database per test -- no network, no Turso account
// needed. This is the same schema.sql the real deployment uses.
async function freshDb() {
  return createDb({ url: ":memory:" });
}

test("a pending task carries over day after day, staying one row", async () => {
  const db = await freshDb();

  const created = await taskService.addTask(db, "2026-08-10", {
    title: "Call supplier about Mason order",
    dueDate: "2026-08-10",
    chatId: 111,
  });
  assert.equal(created.due_date, "2026-08-10");
  assert.equal(created.original_due_date, "2026-08-10");
  assert.equal(created.carryover_count, 0);

  // Day rolls to Aug 11: the task is still pending, so it should carry over.
  let grouped = await taskService.getTodayGrouped(db, "2026-08-11");
  assert.equal(grouped.carriedOver.length, 1);
  assert.equal(grouped.newToday.length, 0);
  let task = grouped.carriedOver[0];
  assert.equal(task.id, created.id);
  assert.equal(task.due_date, "2026-08-11");
  assert.equal(task.original_due_date, "2026-08-10", "original due date must never change");
  assert.equal(task.carryover_count, 1);

  // Day rolls to Aug 12: still not completed, carries over again.
  grouped = await taskService.getTodayGrouped(db, "2026-08-12");
  assert.equal(grouped.carriedOver.length, 1);
  task = grouped.carriedOver[0];
  assert.equal(task.due_date, "2026-08-12");
  assert.equal(task.original_due_date, "2026-08-10");
  assert.equal(task.carryover_count, 2);

  // Still exactly one row in the whole table -- no duplication.
  const all = await db.execute("SELECT COUNT(*) as c FROM tasks");
  assert.equal(Number(all.rows[0].c), 1);
});

test("completing a task stops it from carrying over", async () => {
  const db = await freshDb();
  const created = await taskService.addTask(db, "2026-08-10", {
    title: "Check inventory",
    dueDate: "2026-08-10",
    chatId: 111,
  });

  await taskService.completeTask(db, created.id);

  const grouped = await taskService.getTodayGrouped(db, "2026-08-13");
  assert.equal(grouped.carriedOver.length, 0);
  assert.equal(grouped.newToday.length, 0);

  const stillThere = await taskService.getTaskById(db, created.id);
  assert.equal(stillThere.status, "completed");
  assert.equal(stillThere.due_date, "2026-08-10", "completed tasks keep their due date, they don't carry over");
});

test("a task due today is 'new today', not carried over", async () => {
  const db = await freshDb();
  await taskService.addTask(db, "2026-08-12", {
    title: "Review sales reps",
    dueDate: "2026-08-12",
    chatId: 111,
  });

  const grouped = await taskService.getTodayGrouped(db, "2026-08-12");
  assert.equal(grouped.newToday.length, 1);
  assert.equal(grouped.carriedOver.length, 0);
});

test("a task due in the future does not show up early", async () => {
  const db = await freshDb();
  await taskService.addTask(db, "2026-08-12", {
    title: "Future task",
    dueDate: "2026-08-15",
    chatId: 111,
  });

  const grouped = await taskService.getTodayGrouped(db, "2026-08-12");
  assert.equal(grouped.newToday.length, 0);
  assert.equal(grouped.carriedOver.length, 0);
  assert.equal(grouped.pendingCount, 0);
});

test("manual 'tomorrow' reschedule moves due_date without touching carryover_count", async () => {
  const db = await freshDb();
  const created = await taskService.addTask(db, "2026-08-12", {
    title: "Approve Instagram content",
    dueDate: "2026-08-12",
    chatId: 111,
  });

  const rescheduled = await taskService.rescheduleTomorrow(db, "2026-08-12", created.id);
  assert.equal(rescheduled.due_date, "2026-08-13");
  assert.equal(rescheduled.carryover_count, 0, "manual reschedule is not an automatic carryover");
  assert.equal(rescheduled.status, "pending");
});

test("a deleted task never reappears, even across day rollovers", async () => {
  const db = await freshDb();
  const created = await taskService.addTask(db, "2026-08-10", {
    title: "Obsolete task",
    dueDate: "2026-08-10",
    chatId: 111,
  });
  await taskService.deleteTask(db, created.id);

  const grouped = await taskService.getTodayGrouped(db, "2026-08-14");
  assert.equal(grouped.carriedOver.length, 0);
  assert.equal(grouped.newToday.length, 0);
});

test("digest idempotency flag: marking sent then checking again for the same day", async () => {
  const db = await freshDb();
  assert.equal(await taskService.wasDigestSentToday(db, "2026-08-12"), false);
  await taskService.markDigestSentToday(db, "2026-08-12");
  assert.equal(await taskService.wasDigestSentToday(db, "2026-08-12"), true);
  assert.equal(await taskService.wasDigestSentToday(db, "2026-08-13"), false);
});
