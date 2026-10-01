const { google } = require("googleapis");
const { AsyncLocalStorage } = require("async_hooks");

const SHEET_ID = process.env.SHEET_ID;

// ---------- Rate limiting + retry for the Google Sheets/Drive APIs ----------
// Google enforces "Read requests per minute per user" (and a separate write
// limit) at 60, shared by every call this one service account makes. On
// Render's free tier the whole process restarts on every deploy AND every
// wake-from-sleep, and several independent background jobs each issue their
// own handful of reads (see the startup section of index.js) — that burst
// alone can exceed 60 requests inside the first second, well before any real
// user traffic arrives, and used to just fail outright (429, logged, and the
// job's work silently skipped until its next interval).
//
// A single shared FIFO queue fixed that (a burst spreads out instead of
// overrunning the quota) but created a DIFFERENT real problem: the six
// background jobs are deliberately delayed 90s past boot so they don't
// compete with the very first requests after a cold start — but a real user
// action landing at or after that same 90s mark could still get queued
// BEHIND dozens of background-job calls with no way to jump the line,
// turning an ordinary Check-In save into a 47-SECOND wait (confirmed via
// this file's callGoogleApi timing logs). A background job losing a few
// seconds is invisible to everyone; a rep staring at "Saving…" is not.
//
// The fix is real priority, not just staggered timing: every Sheets/Drive
// call made from inside a background job's own execution is tagged via
// runAsBackgroundJob() (an AsyncLocalStorage context, since the tag has to
// survive through async/await without being threaded through every
// function signature in this file). The scheduler below always drains the
// INTERACTIVE queue first — a background call only ever gets a turn when
// there is no interactive call waiting, so a live user request can never be
// stuck behind background housekeeping, only behind other live requests or
// Google's own quota window.
const backgroundJobContext = new AsyncLocalStorage();
function runAsBackgroundJob(fn) {
  return backgroundJobContext.run(true, fn);
}
function isRunningAsBackgroundJob() {
  return backgroundJobContext.getStore() === true;
}

// Google tracks "Read requests per minute per user" and "Write requests per
// minute per user" as SEPARATE 60/min budgets — but this used to be modeled
// as one shared 50/min bucket for every call regardless of type. As real
// usage grew (more reps, more concurrent actions, the Telegram bot), that
// single undersized bucket became the actual bottleneck: a page that only
// reads competed with a save that only writes for the exact same slots,
// and interactive requests queued behind each other even though Google's
// real read and write quotas were nowhere near exhausted. Splitting into
// two independent trackers (each still kept a few requests under Google's
// real 60/min ceiling as a safety margin) roughly doubles real throughput
// with no added risk of a genuine 429.
const GOOGLE_API_READ_LIMIT_PER_MINUTE = 55;
const GOOGLE_API_WRITE_LIMIT_PER_MINUTE = 55;
const GOOGLE_API_RATE_WINDOW_MS = 60 * 1000;

const rateTrackers = {
  read: { timestamps: [], limit: GOOGLE_API_READ_LIMIT_PER_MINUTE },
  write: { timestamps: [], limit: GOOGLE_API_WRITE_LIMIT_PER_MINUTE },
};
// Interactive (a live HTTP request) always goes first within its own type's
// queue — background only gets a slot when nothing real is waiting for that
// same type. Read and write are fully independent: a write-quota wait can
// never hold up a read, and vice versa.
const queuesByType = {
  read: { interactive: [], background: [] },
  write: { interactive: [], background: [] },
};
const pumpingByType = { read: false, write: false };

function pumpGoogleApiQueue(type) {
  if (pumpingByType[type]) return;
  pumpingByType[type] = true;
  (async () => {
    const tracker = rateTrackers[type];
    const queues = queuesByType[type];
    while (queues.interactive.length > 0 || queues.background.length > 0) {
      const now = Date.now();
      tracker.timestamps = tracker.timestamps.filter((t) => now - t < GOOGLE_API_RATE_WINDOW_MS);
      if (tracker.timestamps.length >= tracker.limit) {
        const waitMs = GOOGLE_API_RATE_WINDOW_MS - (now - tracker.timestamps[0]) + 50;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const resolveNext = queues.interactive.length > 0 ? queues.interactive.shift() : queues.background.shift();
      tracker.timestamps.push(Date.now());
      resolveNext();
    }
    pumpingByType[type] = false;
  })();
}

function acquireGoogleApiSlot(type) {
  return new Promise((resolve) => {
    (isRunningAsBackgroundJob() ? queuesByType[type].background : queuesByType[type].interactive).push(resolve);
    pumpGoogleApiQueue(type);
  });
}

function isGoogleRateLimitError(err) {
  const code = err?.code ?? err?.response?.status;
  if (code === 429) return true;
  return /quota exceeded|rate limit exceeded/i.test(err?.message || "");
}

// `type` classifies the call against Google's own read/write quota split:
// "read" for values.get/batchGet and spreadsheet metadata reads, "write"
// for anything that mutates the sheet (append/update/batchUpdate/clear,
// spreadsheet structure changes, Drive permission grants). Every call site
// below passes it explicitly.
async function callGoogleApi(fn, { maxRetries = 5, type = "write" } = {}) {
  for (let attempt = 0; ; attempt++) {
    await acquireGoogleApiSlot(type);
    try {
      return await fn();
    } catch (err) {
      if (isGoogleRateLimitError(err) && attempt < maxRetries) {
        const backoffMs = Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 500;
        console.warn(`Google API rate-limited, retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
}

// ---------- Short-TTL read cache for slow-changing tabs ----------
// Every request that touches a client, doctor, product, rep, or active
// offer re-read that whole tab from Google Sheets from scratch, even though
// these tabs are edited rarely (an admin adding a pharmacy, a manager
// updating stock) compared to how often they're READ (every visit, punch,
// order, and bootstrap call needs them). Caching them for a few seconds
// means the many requests that land in the same short window — multiple
// reps active at once, or one rep's own visit+punch+order in quick
// succession — share a single Sheets API read instead of each paying for
// their own, which is the single biggest lever against the shared
// read-quota bucket above filling up under real traffic. Never applied to
// high-churn tabs (Visits, Orders, Samples, PunchLog, ...) where a request
// needs the true current state, not a few seconds behind.
const CACHEABLE_TABS = new Set(["Products", "Clients", "Doctors", "Reps", "Offers", "Settings"]);
const READ_CACHE_TTL_MS = 20 * 1000;
const readCache = new Map(); // tab -> { data, expiresAt }

function getFreshCacheEntry(tab) {
  if (!CACHEABLE_TABS.has(tab)) return undefined;
  const entry = readCache.get(tab);
  return entry && entry.expiresAt > Date.now() ? entry : undefined;
}

function setCacheEntry(tab, data) {
  if (!CACHEABLE_TABS.has(tab)) return;
  readCache.set(tab, { data, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

// Called after every write to a tab so the next read reflects it
// immediately rather than serving stale data for up to READ_CACHE_TTL_MS —
// correctness always wins over the cache.
function invalidateReadCache(tab) {
  readCache.delete(tab);
}

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
  // subTerritory appended (Pharmacy territory hierarchy) — a finer
  // classification WITHIN `area` (e.g. area="Dahiyeh", subTerritory="Chiyah"),
  // blank for every pharmacy outside a territory that actually needs one.
  // `area` itself stays the top-level "Territory" — never renamed, since it's
  // already searched/displayed everywhere as-is.
  // addressAr appended (duplicate-safe pharmacy import) — the Arabic-text
  // address a source file often carries alongside its English translation;
  // kept alongside `address` (English) rather than replacing it, same as
  // nameAr sits alongside `name`.
  Clients: ["id", "name", "phone", "tier", "area", "assignedRep", "registrationNumber", "address", "coordsLat", "coordsLng", "discountRate", "nameAr", "type", "subTerritory", "addressAr"],
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
  // My Schedule (Med Rep Schedule feature) appended 10 columns, reusing this
  // SAME tab for both check-in-driven follow-ups AND manual meetings rather
  // than building a parallel table — `type` ("FOLLOW_UP"/"MEETING", blank =
  // legacy FOLLOW_UP) is the only new concept, everything else here already
  // fit meetings too (entityName/entityType/repName/dueDate/status). `status`
  // gained two new values: "cancelled" (a single activity called off from
  // the calendar — NOT the same as "stopped", which means "stop visiting
  // this pharmacy altogether" and keeps its existing distinct meaning) and
  // "rescheduled" (the row a reschedule replaced — distinct from "done" so a
  // snoozed/rescheduled follow-up is never miscounted as completed).
  // `dueTime` is a plain "HH:MM" string, never reinterpreted through any
  // Date/timezone logic, exactly like `dueDate` already is — always Beirut
  // wall-clock by the app's standing timezone convention. `reminderSentAt`
  // doubles as the reminder jobs' own idempotency guard (same pattern as
  // `sampleReminded` above). `rescheduledFromId` gives a queryable
  // reschedule audit chain.
  FollowUps: [
    "id", "entityName", "entityType", "repName", "dueDate", "status", "visitId", "createdAt", "needsSample", "sampleItems", "sampleReminded", "stopReason", "smartiObjective",
    "type", "dueTime", "purpose", "notes", "reminderEnabled", "reminderOffset", "reminderSentAt", "cancelledAt", "completedAt", "rescheduledFromId",
  ],
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
    // Lebanese-market retail research (already live in the production
    // sheet from an earlier research pass — these four columns existed
    // with real data before the app's code knew about them, since
    // getAllRows reads positionally by this array's length; appending them
    // here is what makes that already-collected data visible/writable).
    "servingSize", "marketPriceUSD", "marketPriceRetailer", "marketPriceNotes",
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
    // Same situation as CompetitorProducts above — already live in
    // production with real data from the Lebanese-market research pass,
    // appended here so the app can finally read them.
    "packCount", "servingSize", "unitsPerDay",
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

  // ---------- Product Expert: Why Our Products? (Feature/Benefit/USP) ----------
  // Features and benefits belong to a category (always set) and optionally
  // to one of that category's linked ProductCatalog products. imageKey
  // follows the same R2-object-key-never-exposed-raw pattern as
  // Certifications.documentKey — a viewer only ever gets a presigned URL.
  RecallProductFeatures: [
    "id", "categoryId", "productId", "productName",
    "title", "description",
    "imageKey", "imageName", "imageMimeType",
    "isKeyDifferentiator",
    "createdBy", "createdAt", "updatedBy", "updatedAt",
  ],
  // featureIds is a comma-joined list of RecallProductFeatures ids, same
  // convention already used by RecallCompetitorRelationships.sourceIds.
  RecallProductBenefits: [
    "id", "categoryId", "productId", "productName",
    "featureIds",
    "title", "description",
    "isKeyDifferentiator",
    "createdBy", "createdAt", "updatedBy", "updatedAt",
  ],
  // One row per categoryId, upserted (same upsert-by-key shape as
  // RepTargets-by-repName) rather than an append-only log — a category has
  // exactly one current USP at a time. status flips back to "draft"
  // whenever anyone but a manager edits the text, so an approved badge
  // never silently survives a content change; only the manager-only approve
  // route can set "approved".
  RecallCategoryUsp: [
    "id", "categoryId", "text", "status",
    "suggestedBy", "suggestedAt", "approvedBy", "approvedAt",
  ],
  // Replaces the Feature/Benefit split above with one unified concept: a
  // "Product Advantage" chains Feature -> Products -> Benefit in a single
  // row instead of two separately-managed lists a rep had to mentally
  // reconnect. productIds is a comma-joined list (this codebase has no
  // join-table concept anywhere — every existing many-to-many, e.g.
  // RecallCompetitorRelationships.sourceIds and RecallProductBenefits.
  // featureIds above, is a comma-joined ID list on the owning row; this
  // follows the same pattern rather than inventing a junction sheet), so
  // one Advantage can genuinely cover several products (e.g. the same
  // vitamin at two different doses) with zero product duplication.
  // RecallProductFeatures/RecallProductBenefits above are NEVER deleted or
  // written to again once this ships — they become read-only history, and
  // their existing rows are migrated once (see ensureProductAdvantagesMigrated
  // in index.js) into this shape rather than lost.
  RecallProductAdvantages: [
    "id", "categoryId", "feature", "benefit", "productIds",
    "isKeyDifferentiator",
    "createdBy", "createdAt", "updatedBy", "updatedAt",
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
  const created = await callGoogleApi(() => sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `KayBee Visits — ${repName}` },
      sheets: [{ properties: { title: "Visits" } }],
    },
  }), { type: "write" });
  const spreadsheetId = created.data.spreadsheetId;
  await callGoogleApi(() => sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Visits!A1",
    valueInputOption: "RAW",
    requestBody: { values: [VISIT_EXPORT_HEADERS] },
  }), { type: "write" });
  if (email) {
    try {
      const drive = getDrive();
      await callGoogleApi(() => drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: true,
        requestBody: { type: "user", role: "reader", emailAddress: email },
      }), { type: "write" });
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
    await callGoogleApi(() => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Visits!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [VISIT_EXPORT_HEADERS.map((h) => visitRow[h] ?? "")] },
    }), { type: "write" });
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
    const meta = await callGoogleApi(() => sheets.spreadsheets.get({ spreadsheetId: SHEET_ID }), { type: "read" });
    const existingTitles = meta.data.sheets.map((s) => s.properties.title);

    const missing = Object.keys(SCHEMAS).filter((name) => !existingTitles.includes(name));
    if (missing.length) {
      await callGoogleApi(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      }), { type: "write" });
    }

    for (const [tab, headers] of Object.entries(SCHEMAS)) {
      // Must span the tab's real column count, not a hardcoded A1:Z1 — a
      // schema with more than 26 columns (e.g. CompetitorProducts) would
      // otherwise never be seen as "already topped up" past column Z, and
      // get its header row rewritten on every single init.
      const existing = await callGoogleApi(() => sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1:${columnLetter(headers.length)}1`,
      }), { type: "read" });
      const firstRow = existing.data.values?.[0];
      // Also tops up an existing tab whose header row is shorter than the
      // current schema (e.g. new columns added to Orders for POS tracking)
      // — data itself is always read/written by position from the JS
      // schema array, never by looking up the sheet's header text, so this
      // is purely for a human opening the sheet to see the right labels.
      if (!firstRow || firstRow.length === 0 || firstRow.length < headers.length) {
        await callGoogleApi(() => sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] },
        }), { type: "write" });
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
  const cached = getFreshCacheEntry(tab);
  if (cached) return cached.data;
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const res = await callGoogleApi(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${columnLetter(headers.length)}`,
  }), { type: "read" });
  const rows = res.data.values || [];
  const result = rows
    .map((row, idx) => ({ ...rowToObject(headers, row), _row: idx + 2 }))
    .filter((r) => r.id !== "" && r.id !== undefined);
  setCacheEntry(tab, result);
  return result;
}

// Fetches multiple id-keyed tabs in a single Sheets API request instead of
// one request per tab — the biggest lever against "Read requests per
// minute" quota errors, since the polled /api/bootstrap endpoint used to
// cost 12 separate requests every 20 seconds, per open session. Not for
// Settings (key/value shape, no "id" column to filter on). Tabs already
// served by the short-TTL cache skip the API call entirely; only the
// tabs that are missing or stale go into the batchGet, so a request whose
// tabs are all cache-hits costs zero Sheets API calls.
async function getAllRowsBatch(tabs) {
  const result = {};
  const tabsToFetch = [];
  for (const tab of tabs) {
    const cached = getFreshCacheEntry(tab);
    if (cached) {
      result[tab] = cached.data;
    } else {
      tabsToFetch.push(tab);
    }
  }
  if (tabsToFetch.length === 0) return result;

  await ensureSheets();
  const sheets = getSheets();
  const ranges = tabsToFetch.map((tab) => {
    const headers = SCHEMAS[tab];
    return `${tab}!A2:${columnLetter(headers.length)}`;
  });
  const res = await callGoogleApi(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges,
  }), { type: "read" });
  const valueRanges = res.data.valueRanges || [];
  tabsToFetch.forEach((tab, i) => {
    const headers = SCHEMAS[tab];
    const rows = valueRanges[i]?.values || [];
    const parsed = rows
      .map((row, idx) => ({ ...rowToObject(headers, row), _row: idx + 2 }))
      .filter((r) => r.id !== "" && r.id !== undefined);
    result[tab] = parsed;
    setCacheEntry(tab, parsed);
  });
  return result;
}

async function appendRow(tab, obj) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  await callGoogleApi(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [objectToRow(headers, obj)] },
  }), { type: "write" });
  invalidateReadCache(tab);
}

const APPEND_CHUNK_SIZE = 2000;

async function appendRows(tab, objects) {
  await ensureSheets();
  if (objects.length === 0) return;
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  for (let i = 0; i < objects.length; i += APPEND_CHUNK_SIZE) {
    const chunk = objects.slice(i, i + APPEND_CHUNK_SIZE);
    await callGoogleApi(() => sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: chunk.map((o) => objectToRow(headers, o)) },
    }), { type: "write" });
  }
  invalidateReadCache(tab);
}

async function updateRowById(tab, id, patch) {
  await ensureSheets();
  const rows = await getAllRows(tab);
  const target = rows.find((r) => String(r.id) === String(id));
  if (!target) return false;
  await updateRowAtPosition(tab, target._row, { ...target, ...patch });
  return true;
}

// Writes a row a caller has ALREADY fetched (and already knows the sheet
// position of, via its `_row` from an earlier getAllRows/getAllRowsBatch
// call in the SAME request) — skipping the read-then-find that
// updateRowById does internally. A hot path that already loaded a table
// once (e.g. /api/visits already has matchedClient/matchedDoctor from its
// own initial batch fetch) would otherwise pay for that same table again
// just to re-locate a row it's already holding, purely to patch one field —
// real, felt latency on an action a rep is sitting there waiting on.
// `mergedObj` must be the FULL row (already merged with whatever patch is
// wanted), not a partial patch, since this never reads the row back first.
async function updateRowAtPosition(tab, rowNum, mergedObj) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  await callGoogleApi(() => sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${rowNum}:${columnLetter(headers.length)}${rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [objectToRow(headers, mergedObj)] },
  }), { type: "write" });
  invalidateReadCache(tab);
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
  await callGoogleApi(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  }), { type: "write" });
  invalidateReadCache(tab);
}

async function deleteRowById(tab, id) {
  await ensureSheets();
  const sheets = getSheets();
  const rows = await getAllRows(tab);
  const target = rows.find((r) => String(r.id) === String(id));
  if (!target) return false;

  const meta = await callGoogleApi(() => sheets.spreadsheets.get({ spreadsheetId: SHEET_ID }), { type: "read" });
  const sheetProps = meta.data.sheets.find((s) => s.properties.title === tab).properties;

  await callGoogleApi(() => sheets.spreadsheets.batchUpdate({
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
  }), { type: "write" });
  invalidateReadCache(tab);
  return true;
}

async function replaceAllRows(tab, objects) {
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];

  // clear everything below the header row, then write the new rows in one shot
  await callGoogleApi(() => sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${columnLetter(headers.length)}`,
  }), { type: "write" });
  if (objects.length > 0) {
    await callGoogleApi(() => sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: objects.map((o) => objectToRow(headers, o)) },
    }), { type: "write" });
  }
  invalidateReadCache(tab);
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
  const cached = getFreshCacheEntry(tab);
  if (cached) return cached.data;
  await ensureSheets();
  const sheets = getSheets();
  const headers = SCHEMAS[tab];
  const res = await callGoogleApi(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:${columnLetter(headers.length)}`,
  }), { type: "read" });
  const result = res.data.values || [];
  setCacheEntry(tab, result);
  return result;
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
    await callGoogleApi(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: updates },
    }), { type: "write" });
  }
  if (appends.length) {
    await callGoogleApi(() => sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Settings!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends },
    }), { type: "write" });
  }
  invalidateReadCache("Settings");
}

module.exports = {
  ensureSheets,
  getAllRows,
  getAllRowsBatch,
  appendRow,
  appendRows,
  updateRowById,
  updateRowAtPosition,
  batchUpdateRows,
  deleteRowById,
  replaceAllRows,
  getSettings,
  setSettings,
  createRepExportSheet,
  appendToRepExportSheet,
  runAsBackgroundJob,
};
