const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;

const SCHEMAS = {
  Products: ["id", "name", "category", "expiry", "qty", "sold90", "description", "price"],
  Visits: ["id", "client", "notes", "coordsLat", "coordsLng", "time", "repName", "itemsMentioned", "objectionTag"],
  Clients: ["id", "name", "phone", "tier", "area", "assignedRep", "registrationNumber", "address"],
  Doctors: ["id", "name", "hospital", "area", "phone", "specialty", "tier", "registrationNumber", "address"],
  OutreachLog: ["id", "name", "date", "templateIndex"],
  Orders: ["id", "clientName", "visitId", "repName", "date", "items", "total", "status"],
  Reps: ["id", "name", "passcode", "email", "exportSheetId"],
  Offers: ["id", "label", "buyQty", "getQty", "expiresAt", "active"],
  PushSubscriptions: ["id", "role", "repName", "endpoint", "p256dh", "auth"],
  Settings: ["key", "value"],
  Samples: ["id", "doctorName", "productName", "productId", "status", "repName", "visitId", "date"],
  PunchLog: ["id", "repName", "type", "time", "coordsLat", "coordsLng"],
};

const VISIT_EXPORT_HEADERS = ["client", "notes", "coordsLat", "coordsLng", "time"];

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY environment variables."
    );
  }
  key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email,
    key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
}

let sheetsClient = null;
function getSheets() {
  if (!sheetsClient) {
    sheetsClient = google.sheets({ version: "v4", auth: getAuth() });
  }
  return sheetsClient;
}

let driveClient = null;
function getDrive() {
  if (!driveClient) {
    driveClient = google.drive({ version: "v3", auth: getAuth() });
  }
  return driveClient;
}

// Creates a personal spreadsheet for a rep's own visit history, shares
// view access with their email, and returns the new spreadsheet's ID.
async function createRepExportSheet(repName, email) {
  const sheets = getSheets();
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `KayBee Visits — ${repName}` },
      sheets: [{ properties: { title: "Visits" } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Visits!A1",
    valueInputOption: "RAW",
    requestBody: { values: [VISIT_EXPORT_HEADERS] },
  });
  if (email) {
    try {
      const drive = getDrive();
      await drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: true,
        requestBody: { type: "user", role: "reader", emailAddress: email },
      });
    } catch (e) {
      console.error("Couldn't share visits export sheet", e.message);
    }
  }
  return spreadsheetId;
}

async function appendToRepExportSheet(spreadsheetId, visitRow) {
  if (!spreadsheetId) return;
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Visits!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [VISIT_EXPORT_HEADERS.map((h) => visitRow[h] ?? "")] },
    });
  } catch (e) {
    console.error("Couldn't append to rep's visits export sheet", e.message);
  }
}

if (!SHEET_ID) {
  console.warn(
    "WARNING: SHEET_ID is not set. Set it in your environment before starting the server."
  );
}

let initPromise = null;
// Creates any missing tabs and writes the header row, so a brand-new blank
// Google Sheet works with no manual tab setup on the user's part.
async function ensureSheets() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const sheets = getSheets();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTitles = meta.data.sheets.map((s) => s.properties.title);

    const missing = Object.keys(SCHEMAS).filter((name) => !existingTitles.includes(name));
    if (missing.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    }

    for (const [tab, headers] of Object.entries(SCHEMAS)) {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1:Z1`,
      });
      const firstRow = existing.data.values?.[0];
      if (!firstRow || firstRow.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] },
        });
      }
    }

    // Default sheet ("Sheet1") is left alone if present but unused.
  })();
  return initPromise;
}

function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = row[i] ?? "";
  });
  return obj;
}

function objectToRow(headers, obj) {
  return headers.map((h) => {
    const v = obj[h];
    return v === undefined || v === null ? "" : v;
  });
}

async function getAllRows(tab) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${String.fromCharCode(64 + headers.length)}`,
  });
  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({ ...rowToObject(headers, row), _row: idx + 2 }))
    .filter((r) => r.id !== "" && r.id !== undefined);
}

async function appendRow(tab, obj) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [objectToRow(headers, obj)] },
  });
}

const APPEND_CHUNK_SIZE = 2000;

async function appendRows(tab, objects) {
  await ensureSheets();
  if (objects.length === 0) return;
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  for (let i = 0; i < objects.length; i += APPEND_CHUNK_SIZE) {
    const chunk = objects.slice(i, i + APPEND_CHUNK_SIZE);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: chunk.map((o) => objectToRow(headers, o)) },
    });
  }
}

async function updateRowById(tab, id, patch) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const rows = await getAllRows(tab);
  const target = rows.find((r) => String(r.id) === String(id));
  if (!target) return false;
  const merged = { ...target, ...patch };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${target._row}:${String.fromCharCode(64 + headers.length)}${target._row}`,
    valueInputOption: "RAW",
    requestBody: { values: [objectToRow(headers, merged)] },
  });
  return true;
}

async function deleteRowById(tab, id) {
  await ensureSheets();
  const sheets = getSheets();
  const rows = await getAllRows(tab);
  const target = rows.find((r) => String(r.id) === String(id));
  if (!target) return false;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetProps = meta.data.sheets.find((s) => s.properties.title === tab).properties;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetProps.sheetId,
              dimension: "ROWS",
              startIndex: target._row - 1,
              endIndex: target._row,
            },
          },
        },
      ],
    },
  });
  return true;
}

async function replaceAllRows(tab, objects) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];

  // clear everything below the header row, then write the new rows in one shot
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${String.fromCharCode(64 + headers.length)}`,
  });
  if (objects.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: objects.map((o) => objectToRow(headers, o)) },
    });
  }
}

async function getSettings() {
  const rows = await getAllRowsRaw("Settings");
  const settings = {};
  rows.forEach((row) => {
    const [key, value] = row;
    if (key) settings[key] = value;
  });
  return settings;
}

// Settings uses "key" as its id column, so it can't reuse getAllRows (which
// filters/expects an "id" column) — read it directly instead.
async function getAllRowsRaw(tab) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${String.fromCharCode(64 + headers.length)}`,
  });
  return res.data.values || [];
}

async function setSettings(patch) {
  await ensureSheets();
  const sheets = getSheets();
  const existingRows = await getAllRowsRaw("Settings");
  const keyIndex = new Map(existingRows.map((row, i) => [row[0], i + 2]));

  for (const [key, value] of Object.entries(patch)) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (keyIndex.has(key)) {
      const rowNum = keyIndex.get(key);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Settings!A${rowNum}:B${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[key, serialized]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Settings!A1",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [[key, serialized]] },
      });
    }
  }
}

module.exports = {
  ensureSheets,
  getAllRows,
  appendRow,
  appendRows,
  updateRowById,
  deleteRowById,
  replaceAllRows,
  getSettings,
  setSettings,
  createRepExportSheet,
  appendToRepExportSheet,
};
