const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;

const SCHEMAS = {
  Products: ["id", "name", "category", "expiry", "qty", "sold90", "description", "price", "form", "packSize", "unitsPerDay", "ingredients", "updatedBy", "updatedAt", "sku"],
  // Doctor-visit redesign (Doctor Memory / Call Coaching / Follow-up system)
  // appended 10 optional columns: objective/doctorNeeds/reaction/concern/
  // doctorInsight/commitment/patientsToTry/callOutcome/keyLearning/nextAction.
  // Every pre-existing row (doctor or pharmacy) reads these back as "" via
  // rowToObject's positional fallback — pharmacy visits never populate them,
  // and any doctor visit that predates this change renders under "Legacy
  // note" client-side rather than inventing structured data for it.
  //
  // Manager Performance Management redesign appended 9 more optional columns:
  // interactionType (in_person/phone/whatsapp/video/other, "" = legacy row —
  // always treated as in_person for KPI math, since that's what every visit
  // was before this field existed), locationVerified/distanceFromCustomerKm
  // (computed and frozen once at save time for in-person visits only, never
  // recomputed later against a customer's possibly-since-edited coordinates),
  // and 6 optional doctor-only "quality call" planning fields (treatmentGoal/
  // keyMessage/plannedObjectionHandling/plannedClose are pre-call planning;
  // buyingMotive/customerComments are during-call) that close the gaps
  // between the fields already shipped above and the spec's AOO framework.
  Visits: [
    "id", "client", "notes", "coordsLat", "coordsLng", "time", "repName", "itemsMentioned", "objectionTag",
    "objective", "doctorNeeds", "reaction", "concern", "doctorInsight", "commitment",
    "patientsToTry", "callOutcome", "keyLearning", "nextAction",
    "interactionType", "locationVerified", "distanceFromCustomerKm",
    "treatmentGoal", "keyMessage", "plannedObjectionHandling", "plannedClose",
    "buyingMotive", "customerComments",
  ],
  Clients: ["id", "name", "phone", "tier", "area", "assignedRep", "registrationNumber", "address", "coordsLat", "coordsLng", "discountRate", "nameAr", "type"],
  // assignedRep appended (Manager Performance Management redesign) — mirrors
  // Clients.assignedRep exactly, including the same auto-claim-on-first-visit
  // behavior, so per-rep doctor coverage/targets mean something. "" = doctor
  // is unassigned, matching every pre-existing row.
  Doctors: ["id", "name", "hospital", "area", "phone", "specialty", "tier", "registrationNumber", "address", "coordsLat", "coordsLng", "assignedRep"],
  OutreachLog: ["id", "name", "date", "templateIndex"],
  Orders: ["id", "clientName", "visitId", "repName", "date", "items", "total", "status", "discountRate", "netTotal", "posEntered", "posEnteredAt", "posEnteredBy"],
  Reps: ["id", "name", "passcode", "email", "exportSheetId", "telegramChatId", "telegramLinkCode", "isSupervisor", "supplementStoresOnly", "medRepOnly"],
  Offers: ["id", "label", "buyQty", "getQty", "expiresAt", "active"],
  PushSubscriptions: ["id", "role", "repName", "endpoint", "p256dh", "auth"],
  Settings: ["key", "value"],
  Samples: ["id", "doctorName", "productName", "productId", "status", "repName", "visitId", "date", "qty"],
  PunchLog: ["id", "repName", "type", "time", "coordsLat", "coordsLng", "auto", "confirmed"],
  StockMovement: ["id", "productName", "year", "month", "qty"],
  MonthlyDigests: ["id", "month", "status", "payload", "createdAt"],
  FollowUps: ["id", "entityName", "entityType", "repName", "dueDate", "status", "visitId", "createdAt", "needsSample", "sampleItems", "sampleReminded", "stopReason", "smartiObjective"],
  PharmacySales: ["id", "productName", "pharmacyName", "expiry", "qty"],
  Competitors: ["id", "name", "supplierName", "supplierContact", "offerDetails", "notes", "createdAt"],
  CompetitorSightings: ["id", "visitId", "client", "repName", "competitorName", "notes", "date"],
  VisitComments: ["id", "visitId", "authorName", "text", "createdAt"],
  // NEVER add a retailer stock-status field here (availability, inStock,
  // outOfStock, soldOut, stockStatus, ...) — this table researches which
  // products are LISTED by Lebanese retailers, not their current stock.
  // A retailer's "Out of Stock" label on a listing is not a reason to
  // exclude or remove a product. See RecallRetailerListings for per-source
  // listing data (price/URL/date) — this master row is deliberately
  // retailer-agnostic; a product doesn't get a second master row just
  // because it's listed on more than one retailer site.
  // sku/sourceLabel/sourceUrl appended (Phase 2D) — the manager research
  // editor needs somewhere to record a SKU and where a fact (not a
  // retailer's price/listing — see RecallRetailerListings for that) came
  // from. researchStatus/missingFields (Phase 3) are always SERVER-derived
  // from the record's own fields, never accepted verbatim from a client
  // patch — see deriveCompetitorResearchStatus in index.js.
  CompetitorProducts: [
    "id", "competitorName", "productName", "genericName", "form", "dosage", "packSize", "price", "discountRate", "notes", "createdAt",
    "unitsPerDay", "ingredients", "manufacturer", "manufacturingCountry", "ingredientOrigin", "gmp", "thirdPartyCertification",
    "coaAvailability", "contaminantTesting", "expiryDate", "evidenceReferences", "otherIngredients", "createdBy", "updatedBy", "updatedAt",
    "researchStatus", "missingFields", "sku", "sourceLabel", "sourceUrl",
  ],
  TrainingVideos: ["id", "title", "r2ObjectKey", "quiz", "createdAt"],
  TrainingProgress: ["id", "employeeId", "videoId", "completedAt", "quizResponses"],
  TrainingStudies: ["id", "title", "url", "notes", "createdAt", "nutrient", "createdBy"],
  TrainingStudyViews: ["id", "employeeId", "studyId", "viewedAt"],
  // A master list of every product the company carries, independent of the
  // Stock/Products tab (which tracks per-batch qty + expiry and gets fully
  // replaced on every stock re-import). This is what "Compare with our
  // product" under Competitors reads from, so a product's dosage/pack-size
  // details survive regardless of which batch is currently in stock.
  // sku appended (this phase) so a manager can record/see it in the general
  // Settings -> Product Catalog screen, not just via the Recall research
  // editor — matches the Products/Stock tab, which already has one.
  ProductCatalog: ["id", "name", "price", "form", "packSize", "unitsPerDay", "ingredients", "notes", "createdBy", "createdAt", "updatedBy", "updatedAt", "sku"],

  // ---------- Recall (medical rep training/knowledge-reference module) ----------
  // Structure-only for now — no clinical content is populated. Recall sits on
  // top of ProductCatalog (the master product list) rather than duplicating
  // it: RecallProductIngredients.productId points at ProductCatalog.id.
  RecallCategories: ["id", "name", "description", "displayOrder", "active"],
  // repId stores the rep's NAME (e.g. "Rita"), matching the repName identity
  // convention used by every other table in this app (Visits.repName,
  // Orders.repName, Samples.repName, ...) — not a separate numeric Reps.id
  // foreign key, so no lookup indirection is needed anywhere.
  RepCategoryAssignments: ["id", "repId", "categoryId", "assignedBy", "createdAt"],
  // categoryId is not in the spec's literal column list but is added here —
  // without it there is no way to know which ingredients belong to which
  // Recall category, which every downstream count/query in this phase
  // depends on. Flagged in the implementation report.
  // absorptionTimingNotes/repTakeawayQuestions/repTakeaway30Second appended
  // (Recall Phase 1) — the "Absorption & Timing" and "Rep Takeaway" sections
  // needed fields that didn't exist yet; repQuickTakeaway/clinicalCheckpoints
  // already covered the rest of those two sections' content.
  RecallIngredients: [
    "id", "categoryId", "name", "commonName", "scientificName", "description", "physiologicalRole",
    "clinicalUses", "evidenceSummary", "evidenceLevel", "precautions", "contraindications",
    "drugInteractionSummary", "clinicalCheckpoints", "repQuickTakeaway", "whatNotToClaim", "lastReviewed",
    "absorptionTimingNotes", "repTakeawayQuestions", "repTakeaway30Second",
  ],
  RecallIngredientForms: [
    "id", "ingredientId", "formName", "chemicalName", "formType", "compoundAmount", "activeAmount", "unit",
    "conversionRequired", "absorptionNotes", "metabolicNotes", "clinicalEvidence", "evidenceComparison",
    "documentedAdvantages", "documentedLimitations", "sourceIds", "lastReviewed",
  ],
  RecallDosageForms: ["id", "name", "route", "releaseType", "administrationMethod", "description"],
  // missingFields appended (Phase 2C) — mirrors the CompetitorProducts
  // pattern: verificationStatus already covers "how sure are we", but there
  // was no field naming WHICH facts are still unverified for an our-product
  // link. Appended at the end per the positional-schema rule.
  // sku/manufacturer/sourceLabel/sourceUrl appended (Phase 2D) for the
  // manager research editor — sourceId already links to a formal
  // RecallResearchSources row when one exists; sourceLabel/sourceUrl let a
  // manager record where a fact came from (e.g. "Manufacturer label") on
  // the spot, without first creating a full source record.
  RecallProductIngredients: [
    "id", "productId", "ingredientId", "chemicalForm", "compoundAmount", "activeAmount", "unit",
    "servingSize", "dailyAmount", "amountBasis", "sourceId", "verificationStatus", "notes", "missingFields",
    "sku", "manufacturer", "sourceLabel", "sourceUrl",
  ],
  // sampleSize/limitations appended (Recall Phase 1) — needed for the
  // evidence-card format (N, limitations) alongside the fields already here.
  RecallClinicalEvidence: [
    "id", "ingredientId", "productId", "formId", "condition", "population", "intervention", "dose", "route",
    "duration", "comparator", "outcome", "result", "clinicalSignificance", "evidenceLevel", "studyType",
    "sourceId", "publicationYear", "lastReviewed", "sampleSize", "limitations",
  ],
  RecallResearchSources: [
    "id", "sourceType", "sourceName", "title", "authors", "journal", "pmid", "pmcid", "doi", "url",
    "publicationYear", "sourceDate", "sourceQuality", "notes",
  ],
  RecallDrugInteractions: [
    "id", "ingredientId", "drugName", "drugClass", "direction", "mechanism", "clinicalSignificance",
    "timing", "evidenceLevel", "pharmacistCheckpoint", "sourceId", "lastReviewed",
  ],
  RecallCompetitorRelationships: [
    "id", "ourProductId", "competitorProductId", "comparisonType", "notes", "sourceIds", "createdAt",
  ],
  RecallQuizQuestions: [
    "id", "categoryId", "ingredientId", "question", "optionA", "optionB", "optionC", "optionD",
    "correctAnswer", "explanation", "sourceIds", "active",
  ],
  // One row per (competitor master product × retailer). Deliberately has NO
  // availability/inStock field — a retailer's page is a price/existence
  // source, not a live stock feed, and the URL is a research citation, not
  // a live connection this app polls. Never pick one listing's price as
  // "the market price" — all listings for a product are shown side by side.
  RecallRetailerListings: [
    "id", "competitorProductId", "retailer", "sourceUrl", "displayedPrice", "currency",
    "researchDate", "notes", "createdBy", "createdAt",
  ],
  // Generic: usable for a conflict on any entity/field (a competitor
  // product's chemical form, one of our own ProductCatalog products'
  // serving size, etc.) without needing a dedicated "conflict" column on
  // every table. Recording a conflict always keeps BOTH source values —
  // never resolved by silently picking one.
  // resolution/resolvedBy/resolvedAt appended (Phase 2D) — resolving a
  // conflict picks one source's value onto the actual record (an explicit,
  // auditable manager action, never automatic) but the conflict ROW itself
  // is kept as history with status flipped to RESOLVED, not deleted —
  // both original source values stay visible.
  RecallFieldConflicts: [
    "id", "entityType", "entityId", "fieldName", "sourceALabel", "sourceAValue",
    "sourceBLabel", "sourceBValue", "status", "notes", "createdAt",
    "resolution", "resolvedBy", "resolvedAt",
  ],

  // ---------- Manager Performance Management redesign ----------
  // One row per rep (upserted by repName, never duplicated). Every numeric
  // field is manager-set and independent per rep — there is no fallback to a
  // single global number here (that's what the pre-existing global
  // Settings.monthlyVisitTarget/monthlyRevenueTarget remain for, used only
  // as a stopgap in the UI for a rep who has no RepTargets row yet).
  RepTargets: [
    "id", "repName", "territory",
    "fieldDaysPerMonth", "fieldHoursPerDay",
    "minVisitsPerDay", "targetVisitsPerDay", "stretchVisitsPerDay",
    "monthlyVisitTargetOverride", // "" = auto-calc as targetVisitsPerDay * fieldDaysPerMonth
    "doctorVisitTarget", "pharmacyVisitTarget", "followUpTarget",
    "coverageTargetPct", "qualityCallTargetPct",
    "revenueTarget", "conversionTargetPct", // both optional, "" = not set
    "updatedBy", "updatedAt",
  ],
  // Generic, append-only audit trail reused across every "record the change"
  // requirement in the redesign (rep target edits, interaction-type
  // corrections, customer reassignment, follow-up edits, manager notes) —
  // mirrors the "status flips, old value never overwritten, resolver/
  // timestamp recorded" shape RecallFieldConflicts already established,
  // simplified since there's no two-source conflict to resolve here, just a
  // plain before/after change to log. Rows are never edited or deleted.
  AuditLog: [
    "id", "entityType", "entityId", "field", "oldValue", "newValue",
    "changedBy", "changedAt", "reason",
  ],
  // Manager coaching notes per rep — always appended, never overwritten, so
  // "Coaching Priority" has a real history rather than one mutable note.
  ManagerNotes: [
    "id", "repName", "note", "coachingAction", "reviewDate",
    "createdBy", "createdAt",
  ],

  // ---------- Product Expert: Certifications + Rep Q&A ----------
  // One row per certification document. brand/level/certificationType are
  // plain strings validated client-side against a fixed option list (not a
  // separate lookup table — the list is small and hardcoded, same pattern as
  // e.g. CALL_OUTCOME_OPTIONS). documentKey is the R2 object key and is
  // stripped from every response reps can see (see parseCertification in
  // index.js) — a rep only ever gets a short-TTL presigned view-url, never
  // the raw key, so there is no rep-facing download path at the data layer.
  Certifications: [
    "id", "brand", "level", "certificationType",
    "productId", "productName",
    "documentKey", "documentName", "documentMimeType",
    "title", "description", "issueDate", "expiryDate",
    "createdBy", "createdAt",
  ],
  // Rep-submitted product/evidence questions. status starts "pending" and
  // flips to "published" once a manager answers — published rows are what
  // populate the searchable "Answered Questions" list. answerDocumentKey
  // follows the same never-exposed-raw pattern as Certifications.documentKey.
  RepQuestions: [
    "id", "question", "productName", "brand", "category",
    "askedBy", "askedAt", "status",
    "answer", "answerDocumentKey", "answerDocumentName",
    "answeredBy", "answeredAt",
    "answerDocumentMimeType", // appended: the in-app viewer needs this to know whether to render the attachment as a PDF (canvas) or an image
  ],
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
      // Must span the tab's real column count, not a hardcoded A1:Z1 — a
      // schema with more than 26 columns (e.g. CompetitorProducts) would
      // otherwise never be seen as "already topped up" past column Z, and
      // get its header row rewritten on every single init.
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1:${columnLetter(headers.length)}1`,
      });
      const firstRow = existing.data.values?.[0];
      // Also tops up an existing tab whose header row is shorter than the
      // current schema (e.g. new columns added to Orders for POS tracking)
      // — data itself is always read/written by position from the JS
      // schema array, never by looking up the sheet's header text, so this
      // is purely for a human opening the sheet to see the right labels.
      if (!firstRow || firstRow.length === 0 || firstRow.length < headers.length) {
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

// Standard spreadsheet base-26 column numbering (1 -> A, 26 -> Z, 27 -> AA,
// 28 -> AB, ...). Every range built from a schema's column count MUST go
// through this — String.fromCharCode(64 + n) silently breaks past 26
// columns (e.g. n=28 produces character code 92, "\", an invalid A1
// range) with no error until the Sheets API itself rejects the range.
// CompetitorProducts crossed 26 columns when Phase 3 appended
// researchStatus/missingFields; this derives correctly for any column
// count so future schema growth (on any tab) can't reintroduce the bug.
function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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
    range: `${tab}!A2:${columnLetter(headers.length)}`,
  });
  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({ ...rowToObject(headers, row), _row: idx + 2 }))
    .filter((r) => r.id !== "" && r.id !== undefined);
}

// Fetches multiple id-keyed tabs in a single Sheets API request instead of
// one request per tab — the biggest lever against "Read requests per
// minute" quota errors, since the polled /api/bootstrap endpoint used to
// cost 12 separate requests every 20 seconds, per open session. Not for
// Settings (key/value shape, no "id" column to filter on).
async function getAllRowsBatch(tabs) {
  await ensureSheets();
  const sheets = getSheets();
  const ranges = tabs.map((tab) => {
    const headers = SCHEMAS[tab];
    return `${tab}!A2:${columnLetter(headers.length)}`;
  });
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges,
  });
  const valueRanges = res.data.valueRanges || [];
  const result = {};
  tabs.forEach((tab, i) => {
    const headers = SCHEMAS[tab];
    const rows = valueRanges[i]?.values || [];
    result[tab] = rows
      .map((row, idx) => ({ ...rowToObject(headers, row), _row: idx + 2 }))
      .filter((r) => r.id !== "" && r.id !== undefined);
  });
  return result;
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
    range: `${tab}!A${target._row}:${columnLetter(headers.length)}${target._row}`,
    valueInputOption: "RAW",
    requestBody: { values: [objectToRow(headers, merged)] },
  });
  return true;
}

// Applies many patches to the SAME tab in one read + one write, instead of
// updateRowById's one-read-plus-one-write PER call — a loop that patches
// hundreds of rows (e.g. a name-derived field backfill over a large
// imported table) must not turn into hundreds of sequential Sheets API
// calls, which is exactly what blows through the per-minute read/write
// quota in one page load.
async function batchUpdateRows(tab, updates) {
  if (!updates.length) return;
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const rows = await getAllRows(tab);
  const rowById = new Map(rows.map((r) => [String(r.id), r]));
  const data = [];
  for (const { id, patch } of updates) {
    const target = rowById.get(String(id));
    if (!target) continue;
    const merged = { ...target, ...patch };
    data.push({
      range: `${tab}!A${target._row}:${columnLetter(headers.length)}${target._row}`,
      values: [objectToRow(headers, merged)],
    });
  }
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
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
    range: `${tab}!A2:${columnLetter(headers.length)}`,
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
    range: `${tab}!A2:${columnLetter(headers.length)}`,
  });
  return res.data.values || [];
}

async function setSettings(patch) {
  await ensureSheets();
  const sheets = getSheets();
  const existingRows = await getAllRowsRaw("Settings");
  const keyIndex = new Map(existingRows.map((row, i) => [row[0], i + 2]));

  // Batched into at most 2 requests total (one batchUpdate for existing
  // keys, one append for new ones) instead of one request per key — a patch
  // with many keys (e.g. many overdue alerts firing in the same run) must
  // not turn into that many sequential Sheets API calls.
  const updates = [];
  const appends = [];
  for (const [key, value] of Object.entries(patch)) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (keyIndex.has(key)) {
      const rowNum = keyIndex.get(key);
      updates.push({ range: `Settings!A${rowNum}:B${rowNum}`, values: [[key, serialized]] });
    } else {
      appends.push([key, serialized]);
    }
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
  }
  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Settings!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends },
    });
  }
}

module.exports = {
  ensureSheets,
  getAllRows,
  getAllRowsBatch,
  appendRow,
  appendRows,
  updateRowById,
  batchUpdateRows,
  deleteRowById,
  replaceAllRows,
  getSettings,
  setSettings,
  createRepExportSheet,
  appendToRepExportSheet,
};
