const { todayInTz, formatHumanDate } = require("./dateUtils");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A task's section (CARRIED OVER vs NEW/TODAY) is decided once, from
// original_due_date vs "today", and stays stable even after the task is
// completed or rescheduled -- so re-rendering an existing message doesn't
// make items jump around.
function classify(task, today) {
  const section = task.original_due_date === today ? "new" : "carried";
  let displayState;
  if (task.status === "completed") displayState = "done";
  else if (task.status === "pending" && task.due_date !== today) displayState = "moved";
  else displayState = "open";
  return { section, displayState };
}

function renderLine(number, task, displayState) {
  const title = escapeHtml(task.title);
  if (displayState === "done") return `${number}. ✅ <s>${title}</s>`;
  if (displayState === "moved") return `${number}. ↩️ ${title} <i>(moved to tomorrow)</i>`;
  return `${number}. ☐ ${title}`;
}

function buttonsFor(task) {
  return [
    [
      { text: "✅ Done", callback_data: `done:${task.id}` },
      { text: "↩️ Tomorrow", callback_data: `tomorrow:${task.id}` },
      { text: "🗑", callback_data: `delete:${task.id}` },
    ],
  ];
}

function confirmDeleteButtons(task) {
  return [
    [
      { text: "⚠️ Confirm delete", callback_data: `delete_confirm:${task.id}` },
      { text: "Cancel", callback_data: `delete_cancel:${task.id}` },
    ],
  ];
}

// items: array of { task, section, displayState }, already classified.
function render(headingLines, items, pendingConfirmDeleteId) {
  const carried = items.filter((i) => i.section === "carried");
  const fresh = items.filter((i) => i.section === "new");

  const lines = [...headingLines];
  let n = 0;
  const keyboard = [];

  function renderGroup(groupLabel, group) {
    if (!group.length) return;
    lines.push("", groupLabel);
    for (const item of group) {
      n += 1;
      lines.push(renderLine(n, item.task, item.displayState));
      if (item.displayState === "open") {
        const rows =
          pendingConfirmDeleteId === item.task.id
            ? confirmDeleteButtons(item.task)
            : buttonsFor(item.task);
        keyboard.push(...rows);
      }
    }
  }

  renderGroup("🔄 <b>CARRIED OVER</b>", carried);
  renderGroup("📌 <b>NEW TODAY</b>", fresh);

  const completedCount = items.filter((i) => i.displayState === "done").length;
  const pendingCount = items.filter((i) => i.displayState === "open").length;
  lines.push("", `✅ ${completedCount} completed`, `⏳ ${pendingCount} pending`);

  return { text: lines.join("\n"), keyboard: { inline_keyboard: keyboard } };
}

function buildDigestMessage(grouped, timezone, { emptyOk = true } = {}) {
  const dateLabel = formatHumanDate(grouped.today, timezone);
  const headingLines = [`🌅 <b>TODAY'S TASKS</b>`, dateLabel];
  const today = grouped.today;
  const items = [
    ...grouped.carriedOver.map((task) => ({ task, ...classify(task, today) })),
    ...grouped.newToday.map((task) => ({ task, ...classify(task, today) })),
  ];
  if (!items.length && emptyOk) {
    headingLines.push("", "Nothing due today. 🎉");
  }
  return render(headingLines, items, null);
}

function buildTodayMessage(grouped, timezone) {
  const dateLabel = formatHumanDate(grouped.today, timezone);
  const headingLines = [`📋 <b>YOUR TASKS</b>`, dateLabel];
  const today = grouped.today;
  const items = [
    ...grouped.carriedOver.map((task) => ({ task, ...classify(task, today) })),
    ...grouped.newToday.map((task) => ({ task, ...classify(task, today) })),
  ];
  if (!items.length) {
    headingLines.push("", "Nothing due today. 🎉");
  }
  return render(headingLines, items, null);
}

// Rebuilds a previously-sent message from the tasks currently associated
// with it, reflecting whatever their live status/due_date is now.
function rebuildMessage(tasks, timezone, { headingLines, pendingConfirmDeleteId = null } = {}) {
  const today = todayInTz(timezone);
  const items = tasks.map((task) => ({ task, ...classify(task, today) }));
  const heading = headingLines || [`📋 <b>YOUR TASKS</b>`, formatHumanDate(today, timezone)];
  if (!items.length) {
    return render([...heading, "", "Nothing left here. 🎉"], [], null);
  }
  return render(heading, items, pendingConfirmDeleteId);
}

module.exports = {
  buildDigestMessage,
  buildTodayMessage,
  rebuildMessage,
  escapeHtml,
};
