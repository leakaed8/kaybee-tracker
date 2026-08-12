// Google Sheets as the task database. Mirrors the pattern already used in
// this repo's server/sheetsDb.js (JWT service-account auth, auto-created
// tabs + header row), so if this bot is deployed with the same Google Cloud
// service account as kaybee-tracker, no new Google setup is needed at all --
// just share one more spreadsheet (or reuse the existing one) with the same
// service account email.
//
// taskService.js never talks to googleapis directly -- it only calls the
// small store interface implemented here (listTasks/insertTask/updateTask/
// batchUpdateTasks/getState/setState). test/memoryStore.js implements the
// same interface in plain memory, which is what the unit tests use instead
// of hitting the real Sheets API.

const crypto = require("crypto");
const { google } = require("googleapis");

const TASK_HEADERS = [
  "id",
  "title",
  "status",
  "priority",
  "created_at",
  "updated_at",
  "due_date",
  "original_due_date",
  "completed_at",
  "carryover_count",
  "telegram_message_id",
  "telegram_chat_id",
];
const STATE_HEADERS = ["key", "value"];

function colLetter(n) {
  return String.fromCharCode(64 + n); // works for n <= 26, which every tab here is
}

function rowToTask(row) {
  const obj = {};
  TASK_HEADERS.forEach((h, i) => (obj[h] = row[i] ?? ""));
  return {
    id: obj.id,
    title: obj.title,
    status: obj.status,
    priority: obj.priority || "normal",
    created_at: obj.created_at,
    updated_at: obj.updated_at,
    due_date: obj.due_date,
    original_due_date: obj.original_due_date,
    completed_at: obj.completed_at || null,
    carryover_count: Number(obj.carryover_count) || 0,
    telegram_message_id: obj.telegram_message_id || null,
    telegram_chat_id: obj.telegram_chat_id || null,
  };
}

function taskToRow(task) {
  return TASK_HEADERS.map((h) => {
    const v = task[h];
    return v === undefined || v === null ? "" : v;
  });
}

function createSheetsStore(config) {
  const key = config.googlePrivateKey.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email: config.googleServiceAccountEmail,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const sheetId = config.sheetId;

  let ensured = null;
  async function ensureTabs() {
    if (ensured) return ensured;
    ensured = (async () => {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const existingTitles = meta.data.sheets.map((s) => s.properties.title);
      const missing = ["Tasks", "State"].filter((t) => !existingTitles.includes(t));
      if (missing.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
        });
      }
      for (const [tab, headers] of [
        ["Tasks", TASK_HEADERS],
        ["State", STATE_HEADERS],
      ]) {
        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${tab}!A1:${colLetter(headers.length)}1`,
        });
        const firstRow = existing.data.values && existing.data.values[0];
        if (!firstRow || firstRow.length === 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${tab}!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [headers] },
          });
        }
      }
    })();
    return ensured;
  }

  async function listTasks() {
    await ensureTabs();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Tasks!A2:${colLetter(TASK_HEADERS.length)}`,
    });
    const rows = res.data.values || [];
    return rows
      .map((row, idx) => ({ task: rowToTask(row), _row: idx + 2 }))
      .filter((r) => r.task.id !== "")
      .map((r) => ({ ...r.task, _row: r._row }));
  }

  async function insertTask(fields) {
    await ensureTabs();
    const task = { id: `t${crypto.randomUUID()}`, ...fields };
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "Tasks!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [taskToRow(task)] },
    });
    delete task._row;
    return task;
  }

  async function updateTask(id, patch) {
    const results = await batchUpdateTasks([{ id, patch }]);
    return results[0] || null;
  }

  // Applies multiple patches in a single Sheets API call -- important for
  // the daily carry-over rollover, which may touch several tasks at once.
  async function batchUpdateTasks(updates) {
    if (!updates.length) return [];
    await ensureTabs();
    const all = await listTasks();
    const byId = new Map(all.map((t) => [t.id, t]));
    const data = [];
    const results = [];
    for (const { id, patch } of updates) {
      const existing = byId.get(id);
      if (!existing) {
        results.push(null);
        continue;
      }
      const merged = { ...existing, ...patch };
      data.push({
        range: `Tasks!A${existing._row}:${colLetter(TASK_HEADERS.length)}${existing._row}`,
        values: [taskToRow(merged)],
      });
      delete merged._row;
      results.push(merged);
    }
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: "RAW", data },
      });
    }
    return results;
  }

  async function getState(stateKey) {
    await ensureTabs();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `State!A2:${colLetter(STATE_HEADERS.length)}`,
    });
    const rows = res.data.values || [];
    const found = rows.find((r) => r[0] === stateKey);
    return found ? found[1] : null;
  }

  async function setState(stateKey, value) {
    await ensureTabs();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `State!A2:${colLetter(STATE_HEADERS.length)}`,
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex((r) => r[0] === stateKey);
    if (rowIdx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: "State!A1",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [[stateKey, value]] },
      });
    } else {
      const rowNum = rowIdx + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `State!A${rowNum}:B${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[stateKey, value]] },
      });
    }
  }

  return { listTasks, insertTask, updateTask, batchUpdateTasks, getState, setState };
}

module.exports = { createSheetsStore };
