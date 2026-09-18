const path = require("path");
const crypto = require("crypto");
const express = require("express");
const webpush = require("web-push");
const { S3Client, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const db = require("./sheetsDb");
const telegram = require("./telegram");
const { importedInventory, defaultTemplates } = require("./seedData");

const app = express();
app.use(express.json({ limit: "25mb" }));

// Regenerated on every boot and handed to Telegram via setWebhook — Telegram
// echoes it back on every webhook call so we can reject anything that isn't
// genuinely from Telegram, without needing to persist a secret anywhere.
const TELEGRAM_WEBHOOK_SECRET = crypto.randomUUID();
let telegramBotUsername = "";

const FOLLOWUP_PRESETS = {
  "2d": { label: "in 2 days", days: 2 },
  "3d": { label: "in 3 days", days: 3 },
  "1w": { label: "in 1 week", days: 7 },
  "2w": { label: "in 2 weeks", days: 14 },
  "1m": { label: "in 1 month", days: 30 },
};

const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || "kaybee-tracker-default-secret-change-me";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:kaybee-tracker@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function sendPushToSubscriptions(subs, payload) {
  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload)
    )
  ));
  results.forEach((r, i) => {
    if (r.status === "rejected" && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
      db.deleteRowById("PushSubscriptions", subs[i].id).catch(() => {});
    }
  });
}

// `subs`, when passed in, skips the PushSubscriptions read — callers looping
// over many items (e.g. the overdue-clients check) should fetch it once and
// pass it to every call instead of re-reading the sheet per item.
async function notifyManagers(payload, subs) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const allSubs = subs || (await db.getAllRows("PushSubscriptions"));
    await sendPushToSubscriptions(allSubs.filter((s) => s.role === "manager"), payload);
  } catch (e) {
    console.error("notifyManagers failed", e);
  }
}

async function notifyRep(repName, payload, subs) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !repName) return;
  try {
    const allSubs = subs || (await db.getAllRows("PushSubscriptions"));
    await sendPushToSubscriptions(allSubs.filter((s) => s.role === "rep" && s.repName === repName), payload);
  } catch (e) {
    console.error("notifyRep failed", e);
  }
}

// Every rep with push enabled, regardless of name — used for broadcasts
// like "a new training study was added" where there's no single rep to
// target.
async function notifyAllReps(payload, subs) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const allSubs = subs || (await db.getAllRows("PushSubscriptions"));
    await sendPushToSubscriptions(allSubs.filter((s) => s.role === "rep"), payload);
  } catch (e) {
    console.error("notifyAllReps failed", e);
  }
}

function signPayload(payload) {
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payload = token.slice(0, dotIndex);
  const hmac = token.slice(dotIndex + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [`kb_session=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`];
  if (IS_PROD) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAuth(req, res, next) {
  const payload = verifySessionToken(parseCookies(req).kb_session);
  if (!payload) return res.status(401).json({ error: "Please log in." });
  if (payload === "manager") {
    req.role = "manager";
    req.repName = null;
    req.isSupervisor = false;
    req.supplementStoresOnly = false;
    req.medRepOnly = false;
  } else if (payload.startsWith("rep|")) {
    // A supervisor is a normal rep account with an extra flag set in
    // Settings — full rep experience (Check-In, Route, punch in/out, own
    // history) plus team-wide Locations/Performance visibility and the
    // ability to comment on any rep's visit. Both flags are baked into the
    // signed session at login time (not looked up per-request, to avoid an
    // extra Sheets read on every single API call) — toggling either in
    // Settings takes effect the next time that rep logs in. Flags are a
    // comma-separated list so more can be added later without breaking
    // older sessions (an old cookie with no third segment just parses to
    // no flags at all — same as before this field existed).
    const [encodedName, flagsStr] = payload.slice(4).split("|");
    const flags = (flagsStr || "").split(",").filter(Boolean);
    req.role = "rep";
    req.repName = decodeURIComponent(encodedName);
    req.isSupervisor = flags.includes("sup");
    // A rep restricted to supplement stores only — no pharmacy or doctor
    // access anywhere (Check-In, the Pharmacies/Doctors tabs, or the
    // underlying write routes).
    req.supplementStoresOnly = flags.includes("ssonly");
    // A "med rep" restricted to doctors only — no pharmacy or supplement
    // store access anywhere (Check-In, the Pharmacies/Supplement Stores
    // tabs, or the underlying write routes).
    req.medRepOnly = flags.includes("docsonly");
  } else {
    return res.status(401).json({ error: "Please log in." });
  }
  next();
}

function requireManager(req, res, next) {
  if (req.role !== "manager") return res.status(403).json({ error: "Managers only." });
  next();
}

const DEFAULT_SETTINGS = {
  slowThreshold: 15,
  repPhone: "",
  dailyTarget: 3,
  monthlyVisitTarget: 60,
  monthlyRevenueTarget: 10000,
  templates: defaultTemplates,
};

function parseSettings(raw) {
  return {
    slowThreshold: raw.slowThreshold !== undefined ? Number(raw.slowThreshold) : DEFAULT_SETTINGS.slowThreshold,
    repPhone: raw.repPhone !== undefined ? raw.repPhone : DEFAULT_SETTINGS.repPhone,
    dailyTarget: raw.dailyTarget !== undefined ? Number(raw.dailyTarget) : DEFAULT_SETTINGS.dailyTarget,
    monthlyVisitTarget:
      raw.monthlyVisitTarget !== undefined ? Number(raw.monthlyVisitTarget) : DEFAULT_SETTINGS.monthlyVisitTarget,
    monthlyRevenueTarget:
      raw.monthlyRevenueTarget !== undefined ? Number(raw.monthlyRevenueTarget) : DEFAULT_SETTINGS.monthlyRevenueTarget,
    templates: raw.templates ? JSON.parse(raw.templates) : DEFAULT_SETTINGS.templates,
  };
}

// Lightweight keyword tagger for visit notes — no external API, runs at save
// time so the manager's objection-themes chart has real data instead of a
// placeholder. First matching theme wins; empty string means no match.
const OBJECTION_KEYWORDS = [
  { tag: "Price / margin", words: ["price", "expensive", "cost", "margin", "discount", "cheaper", "afford"] },
  { tag: "Slow delivery", words: ["delivery", "late", "delay", "shipment", "arrived late", "backorder"] },
  { tag: "Competitor stocking", words: ["competitor", "already stocks", "other brand", "other supplier", "switched to"] },
  { tag: "Shelf space", words: ["shelf space", "no space", "shelf", "display space"] },
  { tag: "Payment terms", words: ["payment", "credit", "invoice", "payment terms", "due date", "overdue payment"] },
  { tag: "Side effects", words: ["side effect", "tolerability", "adverse"] },
  { tag: "Efficacy concerns", words: ["efficacy", "not effective", "doesn't work", "not working", "bioequivalence"] },
];

function classifyObjection(notes) {
  if (!notes) return "";
  const text = notes.toLowerCase();
  const hit = OBJECTION_KEYWORDS.find(({ words }) => words.some((w) => text.includes(w)));
  return hit ? hit.tag : "";
}

function parseProduct(p) {
  return { ...p, qty: Number(p.qty) || 0, sold90: Number(p.sold90) || 0, price: Number(p.price) || 0 };
}

// Maps a normalized product name to its real average monthly movement,
// computed from however many months of StockMovement data have been
// uploaded so far (missing years just mean fewer months in the average,
// not zero — a product with only 2023+2025 data still gets a real average
// across those 24 months, it just doesn't include 2022/2024).
function buildMovementIndex(rows) {
  const index = new Map();
  rows.forEach((r) => {
    const key = String(r.productName || "").trim().toLowerCase();
    if (!key) return;
    const entry = index.get(key) || { total: 0, count: 0 };
    entry.total += Number(r.qty) || 0;
    entry.count += 1;
    index.set(key, entry);
  });
  return index;
}

function avgMonthlyMovementFor(name, movementIndex) {
  const entry = movementIndex.get(String(name || "").trim().toLowerCase());
  if (!entry || entry.count === 0) return null;
  return entry.total / entry.count;
}

function parseOrder(o) {
  const total = Number(o.total) || 0;
  return {
    id: o.id,
    clientName: o.clientName,
    visitId: o.visitId || "",
    repName: o.repName || "",
    date: o.date,
    items: JSON.parse(o.items || "[]"),
    total,
    status: o.status || "confirmed",
    discountRate: o.discountRate !== "" && o.discountRate !== undefined ? Number(o.discountRate) : 0,
    // Orders placed before this field existed have no netTotal stored —
    // treat their collected amount as the list total rather than 0.
    netTotal: o.netTotal !== "" && o.netTotal !== undefined ? Number(o.netTotal) : total,
    posEntered: o.posEntered === "true",
    posEnteredAt: o.posEnteredAt || "",
    posEnteredBy: o.posEnteredBy || "",
  };
}

function buildCleanOrderItems(items) {
  return (items || []).map((it) => ({
    productId: it.productId || "",
    name: String(it.name || "").trim(),
    qty: Number(it.qty) || 0,
    unitPrice: Number(it.unitPrice) || 0,
    isFree: !!it.isFree,
    originalPrice: Number(it.originalPrice) || 0,
    expiry: it.expiry || "",
    offerId: it.offerId || "",
  }));
}

// An order can carry several independent offers at once (e.g. 8 units under
// 7+1 plus 14 units under 12+2 plus plain items), so each item is tagged
// client-side with which offer group it belongs to ("" for regular/no-offer).
// Re-derive validity per group purely from submitted quantities — never from
// client-sent isFree flags — so a crafted payload can't bypass it. Groups
// referencing an offer that isn't currently active are rejected outright
// (fail closed) rather than silently skipped. Returns an error string, or
// null if every group is valid. Shared by order creation and order editing
// so the two can never drift apart.
async function validateOfferGroups(cleanItems) {
  const offerRows = await db.getAllRows("Offers");
  const todayStr = new Date().toISOString().slice(0, 10);
  const activeOffers = offerRows.map(parseOffer).filter((o) => o.active && (!o.expiresAt || o.expiresAt >= todayStr));
  const activeOfferById = new Map(activeOffers.map((o) => [o.id, o]));
  const groupIds = [...new Set(cleanItems.map((it) => it.offerId).filter(Boolean))];
  for (const offerId of groupIds) {
    const offer = activeOfferById.get(offerId);
    if (!offer) return "One of the selected offers is no longer available. Please review this order's offer groups.";
    const groupQty = cleanItems.filter((it) => it.offerId === offerId).reduce((sum, it) => sum + it.qty, 0);
    const required = offer.buyQty + offer.getQty;
    if (groupQty !== required) {
      return `${offer.label} requires exactly ${required} units. This order currently has ${groupQty} units assigned to it. Please adjust the quantities to ${required} units to continue.`;
    }
  }
  return null;
}

function posEntryButtons(orderId) {
  return {
    inline_keyboard: [[
      { text: "✅ Entered in POS", callback_data: `posenter:${orderId}` },
      { text: "⏳ Not yet", callback_data: `posnotyet:${orderId}` },
    ]],
  };
}

// The Head of Sales doesn't use the in-app "Pending POS" list, so every
// order (new or edited) is pushed to his Telegram with the figures he needs
// plus one-tap buttons — this is his only real workflow for confirming POS
// entry. Fire-and-forget: a missing/unlinked supervisor or a Telegram outage
// should never block the order itself.
function notifySupervisorOrderTelegram(order, cleanItems, total, discountRate, netTotal, headline) {
  db.getAllRows("Reps").then((reps) => {
    const supervisor = reps.find((r) => r.isSupervisor === "true" && r.telegramChatId);
    if (!supervisor) return;
    const itemLines = cleanItems.map((it) => `• ${escapeHtml(it.name)} × ${it.qty}${it.isFree ? " (free)" : ""}`).join("\n");
    const msg = `${headline} <b>${escapeHtml(order.clientName)}</b>\nRep: ${escapeHtml(order.repName || "")}\n${itemLines}\n\nList total: ${total.toFixed(2)}\nDiscount: ${discountRate}%\nCollected: <b>${netTotal.toFixed(2)}</b>`;
    telegram.sendMessage(supervisor.telegramChatId, msg, posEntryButtons(order.id)).catch((e) => console.error("order telegram notify failed", e));
  }).catch((e) => console.error("order telegram notify failed", e));
}

function parseOffer(o) {
  return {
    id: o.id,
    label: o.label,
    buyQty: Number(o.buyQty) || 0,
    getQty: Number(o.getQty) || 0,
    expiresAt: o.expiresAt || "",
    active: o.active !== "false",
  };
}

// --- Training videos (Cloudflare R2) --------------------------------------
// The video files themselves live only in a private Cloudflare R2 bucket —
// never in GitHub, Render, or this app's own database. Only the object's
// key (its filename/path in the bucket) is stored. R2 is S3-compatible, so
// signed URLs are generated with the standard AWS SDK against Cloudflare's
// R2 endpoint — no Cloudflare Stream subscription needed.
const R2_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
// A playback URL is only ever handed to a logged-in employee's own browser
// for one sitting, never persisted or shared — 4 hours comfortably covers
// watching a short video plus the quiz without being a standing, reusable
// link. Reopening the tab later just signs a fresh one.
const TRAINING_PLAYBACK_TOKEN_TTL_SECONDS = 4 * 60 * 60;

let r2Client = null;
function getR2Client() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 isn't configured — set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return r2Client;
}

// Confirms the pasted object key is real before saving it — catches a typo
// in the admin form immediately instead of only surfacing it the first time
// an employee tries to watch.
async function verifyR2ObjectExists(key) {
  if (!R2_BUCKET_NAME) throw new Error("R2 isn't configured — set R2_BUCKET_NAME.");
  const client = getR2Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
      throw new Error(`No object named "${key}" was found in the R2 bucket. Check the file name matches exactly what you uploaded.`);
    }
    throw e;
  }
}

// Presigned R2 URLs are computed locally (AWS SigV4 over the object key +
// expiry) — no network round-trip to Cloudflare needed to mint one, unlike
// Stream's token API.
async function createTrainingPlaybackUrl(video) {
  if (!R2_BUCKET_NAME) throw new Error("R2 isn't configured — set R2_BUCKET_NAME.");
  const client = getR2Client();
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: video.r2ObjectKey });
  const url = await getSignedUrl(client, command, { expiresIn: TRAINING_PLAYBACK_TOKEN_TTL_SECONDS });
  return { url, expiresAt: Date.now() + TRAINING_PLAYBACK_TOKEN_TTL_SECONDS * 1000 };
}

function validateTrainingQuiz(quiz) {
  if (!Array.isArray(quiz) || quiz.length === 0) return "quiz must be a non-empty array";
  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i];
    if (!q || typeof q !== "object") return `quiz[${i}] must be an object`;
    if (!q.question || typeof q.question !== "string") return `quiz[${i}] is missing a question`;
    if (q.type === "scenario") {
      if (!q.model_answer || typeof q.model_answer !== "string") return `quiz[${i}] (scenario) is missing model_answer`;
    } else if (q.type === "multiple_choice") {
      if (!Array.isArray(q.options) || q.options.length < 2) return `quiz[${i}] (multiple_choice) needs at least 2 options`;
      if (!Number.isInteger(q.correct_answer) || q.correct_answer < 0 || q.correct_answer >= q.options.length) {
        return `quiz[${i}] (multiple_choice) correct_answer must be a valid index into options`;
      }
    } else {
      return `quiz[${i}] has an unknown type "${q.type}" — expected "scenario" or "multiple_choice"`;
    }
  }
  return null;
}

// r2ObjectKey is left out of every response by default — reps only ever
// get a short-lived signed playback URL, never the raw bucket key. A
// manager editing a video is the one exception (includeR2Key), since they
// need to see/change which file a video points to.
function parseTrainingVideo(v, { includeQuiz = false, includeR2Key = false } = {}) {
  const out = { id: v.id, title: v.title, createdAt: v.createdAt };
  if (includeQuiz) {
    try { out.quiz = JSON.parse(v.quiz || "[]"); } catch { out.quiz = []; }
  }
  if (includeR2Key) out.r2ObjectKey = v.r2ObjectKey;
  return out;
}

function parseTrainingProgress(p) {
  let quizResponses = [];
  try { quizResponses = JSON.parse(p.quizResponses || "[]"); } catch { quizResponses = []; }
  return { id: p.id, employeeId: p.employeeId, videoId: p.videoId, completedAt: p.completedAt, quizResponses };
}

function parseTrainingStudy(s) {
  return { id: s.id, title: s.title, url: s.url, notes: s.notes || "", createdAt: s.createdAt, nutrient: s.nutrient || "", createdBy: s.createdBy || "" };
}

function parsePunch(p) {
  const coords = p.coordsLat && p.coordsLng ? { lat: p.coordsLat, lng: p.coordsLng } : null;
  return {
    id: p.id, repName: p.repName, type: p.type, time: p.time, coords,
    auto: p.auto === "true",
    confirmed: p.confirmed === "true",
  };
}

function parseVisit(v) {
  const coords = v.coordsLat && v.coordsLng ? { lat: v.coordsLat, lng: v.coordsLng } : null;
  let mentionedItems = [];
  if (v.itemsMentioned) {
    try { mentionedItems = JSON.parse(v.itemsMentioned); } catch { mentionedItems = []; }
  }
  return {
    id: v.id, client: v.client, notes: v.notes, coords, time: v.time, repName: v.repName || "",
    mentionedItems, objectionTag: v.objectionTag || "",
  };
}
// Same formula as haversineKm in client/src/helpers.js — used here to check
// a check-in's GPS against the pharmacy's own saved location, so a mismatch
// gets flagged to the manager immediately instead of only being visible if
// someone happens to look at the Locations tab later.
function haversineKmServer(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const LOCATION_MISMATCH_KM = 1;

async function geocodeAddress(address) {
  if (!address || !process.env.GOOGLE_MAPS_SERVER_KEY) return null;
  try {
    const query = encodeURIComponent(`${address}, Lebanon`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_SERVER_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "OK" && data.results[0]) {
      const { lat, lng } = data.results[0].geometry.location;
      return { lat, lng };
    }
    console.warn(`Geocoding failed for "${address}": ${data.status}`);
    return null;
  } catch (e) {
    console.error("geocodeAddress error", e.message);
    return null;
  }
}
function visitToRow(v) {
  return {
    id: v.id,
    client: v.client,
    notes: v.notes || "",
    coordsLat: v.coords ? v.coords.lat : "",
    coordsLng: v.coords ? v.coords.lng : "",
    time: v.time,
    repName: v.repName || "",
    itemsMentioned: v.mentionedItems && v.mentionedItems.length ? JSON.stringify(v.mentionedItems) : "",
    objectionTag: v.objectionTag || "",
  };
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/login", async (req, res) => {
  try {
    const { passcode } = req.body || {};
    const managerCode = process.env.MANAGER_PASSCODE;
    const legacyRepCode = process.env.REP_PASSCODE;

    if (managerCode && passcode === managerCode) {
      setSessionCookie(res, signPayload("manager"), 60 * 60 * 24 * 30);
      return res.json({ ok: true, role: "manager" });
    }
    if (legacyRepCode && passcode === legacyRepCode) {
      setSessionCookie(res, signPayload("rep|"), 60 * 60 * 24 * 30);
      return res.json({ ok: true, role: "rep", repName: "" });
    }

    const reps = await db.getAllRows("Reps");
    const matched = reps.find((r) => r.passcode === passcode);
    if (matched) {
      const isSupervisor = matched.isSupervisor === "true";
      const supplementStoresOnly = matched.supplementStoresOnly === "true";
      const medRepOnly = matched.medRepOnly === "true";
      const flags = [isSupervisor ? "sup" : "", supplementStoresOnly ? "ssonly" : "", medRepOnly ? "docsonly" : ""].filter(Boolean).join(",");
      setSessionCookie(res, signPayload(`rep|${encodeURIComponent(matched.name)}|${flags}`), 60 * 60 * 24 * 30);
      return res.json({ ok: true, role: "rep", repName: matched.name, isSupervisor, supplementStoresOnly, medRepOnly });
    }

    res.status(401).json({ error: "Incorrect passcode." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/logout", (req, res) => {
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
});

// Telegram calls this directly (no session cookie), so it must sit before the
// auth gate below. The secret-token header is how we confirm a request is
// genuinely from Telegram and not someone guessing the URL.
app.post("/api/telegram/webhook", async (req, res) => {
  res.sendStatus(200); // ack immediately; Telegram retries on anything else
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_WEBHOOK_SECRET) return;
  try {
    const update = req.body || {};
    if (update.message?.text?.startsWith("/start")) {
      const code = update.message.text.split(" ")[1];
      const chatId = String(update.message.chat.id);
      if (!code) return;
      const reps = await db.getAllRows("Reps");
      const rep = reps.find((r) => r.telegramLinkCode === code);
      if (rep) {
        await db.updateRowById("Reps", rep.id, { telegramChatId: chatId });
        await telegram.sendMessage(chatId, `You're linked, ${rep.name}! You'll get your monthly focus list here.`);
        return;
      }
      const settings = await db.getSettings();
      if (settings.managerTelegramLinkCode === code) {
        await db.setSettings({ managerTelegramChatId: chatId });
        await telegram.sendMessage(chatId, "Manager account linked! You'll get the monthly digest here for approval before it goes to reps.");
        return;
      }
      await telegram.sendMessage(chatId, "That link code wasn't recognized — generate a new one and try again.");
    } else if (update.callback_query) {
      const data = update.callback_query.data || "";
      if (data.startsWith("fu")) {
        await handleFollowUpCallback(update.callback_query);
      } else if (data.startsWith("orddel") || data.startsWith("ordkeep")) {
        await handleOrderDeleteCallback(update.callback_query);
      } else if (data.startsWith("posenter") || data.startsWith("posnotyet")) {
        await handlePosEntryCallback(update.callback_query);
      } else if (data.startsWith("keeprep") || data.startsWith("changerep")) {
        await handleReassignmentCallback(update.callback_query);
      } else {
        await handleDigestCallback(update.callback_query);
      }
    }
  } catch (e) {
    console.error("telegram webhook error", e);
  }
});

app.use("/api", requireAuth);

app.get("/api/session", (req, res) => res.json({ role: req.role, repName: req.repName, isSupervisor: !!req.isSupervisor, supplementStoresOnly: !!req.supplementStoresOnly, medRepOnly: !!req.medRepOnly }));

app.get("/api/push/vapid-public-key", (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY || "" }));

app.post("/api/push/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Invalid subscription" });
    const existing = await db.getAllRows("PushSubscriptions");
    const already = existing.find((s) => s.endpoint === subscription.endpoint);
    if (already) return res.json({ ok: true });
    const record = {
      id: `push${crypto.randomUUID()}`,
      role: req.role,
      repName: req.repName || "",
      endpoint: subscription.endpoint,
      p256dh: subscription.keys?.p256dh || "",
      auth: subscription.keys?.auth || "",
    };
    await db.appendRow("PushSubscriptions", record);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Bootstrap used to be one 16-tab dump, polled by every open session every
// 30s. Growing any single tab via an Excel import (Clients to 3000+ rows,
// CompetitorProducts, StockMovement across years) slowed that whole batched
// read down for everyone, since it was all one Sheets request. Split into
// two tiers instead:
//  - "Live" tabs are small and either change often or gate the app itself
//    (punch state) — these stay on the fast poll.
//  - "Reference" tabs (Products/Clients/Doctors) are needed broadly for
//    search/autocomplete but tolerate being a few minutes stale — these get
//    their own much slower poll (see REFERENCE_POLL_INTERVAL_MS client-side).
// Everything else that used to ride along in bootstrap (Visits, Orders,
// Samples, OutreachLog, PunchLog's full history, CompetitorSightings,
// VisitComments, CompetitorProducts) is dropped entirely in favor of scoped,
// on-demand endpoints fetched only by the specific view that needs them.
const LIVE_BOOTSTRAP_TABS = ["Reps", "Offers", "Competitors", "PunchLog"];
const REFERENCE_BOOTSTRAP_TABS = ["Products", "Clients", "Doctors", "ProductCatalog"];

// See the comment above BOOTSTRAP_CACHE_TTL_MS's old location: this cache
// lets concurrent sessions polling within the same few seconds share one
// Sheets read instead of each firing their own. ?fresh=true (used by
// withSync after a write) skips it so the person who just wrote something
// sees it immediately.
//
// Only the rep-independent raw rows are cached here — myLastPunch is
// per-rep, so it's reshaped fresh from the (possibly cached) PunchLog rows
// on every request instead of being baked into a cache shared across every
// session (which would leak one rep's punch state into another rep's
// response).
let liveBootstrapRawCache = null; // { data, timestamp }
const LIVE_BOOTSTRAP_CACHE_TTL_MS = 8000;
let referenceBootstrapCache = null; // { data, timestamp }
const REFERENCE_BOOTSTRAP_CACHE_TTL_MS = 3 * 60 * 1000;

async function fetchLiveBootstrapRaw() {
  const [batch, rawSettings, outreachRows] = await Promise.all([
    db.getAllRowsBatch(LIVE_BOOTSTRAP_TABS),
    db.getSettings(),
    db.getAllRows("OutreachLog"),
  ]);
  return { batch, rawSettings, outreachRows };
}

function shapeLiveBootstrap(raw, repName) {
  const { Reps: reps, Offers: offers, Competitors: competitors, PunchLog: punchLog } = raw.batch;

  // Only the current rep's own last punch is needed to gate the app / drive
  // the punch button — never the whole team's history (that's now
  // LocationsView's own on-demand fetch). Managers have no repName, so this
  // is just null for them.
  const myPunchRows = punchLog.filter((p) => p.repName === repName);
  const myLastPunch = myPunchRows.length
    ? parsePunch(myPunchRows.reduce((latest, p) => (new Date(p.time) > new Date(latest.time) ? p : latest)))
    : null;

  // Nothing in the app reads outreach history — only "how many contacted
  // today" — so this stays a full read server-side (Sheets can't filter by
  // date on its own) but ships as a single number, not the ever-growing log.
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOutreachCount = raw.outreachRows.filter((o) => o.date === todayStr).length;

  return {
    repNames: reps.map((r) => r.name),
    offers: offers.map(parseOffer),
    competitors: competitors.sort((a, b) => a.name.localeCompare(b.name)),
    settings: parseSettings(raw.rawSettings),
    myLastPunch,
    todayOutreachCount,
  };
}

async function buildReferenceBootstrapPayload() {
  const [batch, stockMovement] = await Promise.all([
    db.getAllRowsBatch(REFERENCE_BOOTSTRAP_TABS),
    db.getAllRows("StockMovement"),
  ]);
  const { Products: products, Clients: clients, Doctors: doctors, ProductCatalog: productCatalog } = batch;
  const movementIndex = buildMovementIndex(stockMovement);
  return {
    products: products.map((p) => ({ ...parseProduct(p), avgMonthlyMovement: avgMonthlyMovementFor(p.name, movementIndex) })),
    clients,
    doctors,
    productCatalog,
  };
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const wantsFresh = req.query.fresh === "true";
    let raw;
    if (!wantsFresh && liveBootstrapRawCache && Date.now() - liveBootstrapRawCache.timestamp < LIVE_BOOTSTRAP_CACHE_TTL_MS) {
      raw = liveBootstrapRawCache.data;
    } else {
      raw = await fetchLiveBootstrapRaw();
      liveBootstrapRawCache = { data: raw, timestamp: Date.now() };
    }
    res.json(shapeLiveBootstrap(raw, req.repName));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/bootstrap/reference", async (req, res) => {
  try {
    // This is the general Product Catalog data every tab reads (Settings,
    // Stock, the Competitors "compare with our product" tool) — seeded here
    // too so the Mason/ALFA master list shows up regardless of which tab a
    // user opens first, not only after visiting Recall.
    await ensureOurProductsMasterDataSeeded();
    const wantsFresh = req.query.fresh === "true";
    if (!wantsFresh && referenceBootstrapCache && Date.now() - referenceBootstrapCache.timestamp < REFERENCE_BOOTSTRAP_CACHE_TTL_MS) {
      return res.json(referenceBootstrapCache.data);
    }
    const data = await buildReferenceBootstrapPayload();
    referenceBootstrapCache = { data, timestamp: Date.now() };
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Scoped, on-demand replacements for what used to ride along in the old
// 16-tab bootstrap dump. Each of these still does a full Sheets read under
// the hood (Sheets has no server-side query support), but the *response* is
// a small, filtered slice — that's the actual fix, since these are fetched
// only by the specific view/moment that needs them instead of shipped to
// every open session on a fixed timer.

app.get("/api/visits", async (req, res) => {
  try {
    const { client, repName, limit, all } = req.query;
    const [rows, commentRows] = await Promise.all([
      db.getAllRows("Visits"),
      db.getAllRows("VisitComments"),
    ]);
    let visits = rows.map(parseVisit).sort((a, b) => new Date(b.time) - new Date(a.time));
    if (client) {
      const key = String(client).toLowerCase().trim();
      visits = visits.filter((v) => v.client.toLowerCase().trim() === key);
    }
    if (repName) visits = visits.filter((v) => v.repName === repName);
    const total = visits.length;
    // Dashboard/Performance need the true complete history to compute
    // per-account overdue status and monthly aggregates correctly — capping
    // that would silently produce wrong numbers. Reserved for
    // manager/supervisor views that fetch once on tab-open, not polled.
    const wantsAll = all === "true" && (req.role === "manager" || req.isSupervisor);
    if (!wantsAll) visits = visits.slice(0, clampLimit(limit, 20, 200));

    const commentsByVisit = new Map();
    commentRows.forEach((c) => {
      const list = commentsByVisit.get(c.visitId) || [];
      list.push({ id: c.id, authorName: c.authorName, text: c.text, createdAt: c.createdAt });
      commentsByVisit.set(c.visitId, list);
    });
    const withComments = visits.map((v) => ({
      ...v,
      comments: (commentsByVisit.get(v.id) || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    }));
    res.json({ visits: withComments, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Also the endpoint the new Order History view (see the tab === "orders"
// switch) is built on — repName/client/product/from/to narrow it, page+limit
// paginate it. Consumers that just want "the last N for X" (Check-In's
// recent orders, OrderBuilder's other-recent-orders-for-this-product) omit
// page and get page 1 of their requested limit, same result as before.
app.get("/api/orders", async (req, res) => {
  try {
    const { repName, client, product, from, to, page, limit, all, posStatus } = req.query;
    const rows = await db.getAllRows("Orders");
    let orders = rows.map(parseOrder).sort((a, b) => new Date(b.date) - new Date(a.date));
    if (repName) orders = orders.filter((o) => o.repName === repName);
    if (client) {
      const key = String(client).toLowerCase().trim();
      orders = orders.filter((o) => (o.clientName || "").toLowerCase().includes(key));
    }
    if (product) {
      const key = String(product).toLowerCase().trim();
      orders = orders.filter((o) => o.items.some((it) => (it.name || "").toLowerCase().includes(key)));
    }
    if (from) orders = orders.filter((o) => new Date(o.date) >= new Date(from));
    if (to) orders = orders.filter((o) => new Date(o.date) <= new Date(`${to}T23:59:59`));
    // Pending POS never resets on a schedule — it's just "has posEntered
    // been stamped yet," so an order placed weeks ago and never entered
    // still shows up here indefinitely.
    if (posStatus === "pending") orders = orders.filter((o) => !o.posEntered);
    if (posStatus === "entered") orders = orders.filter((o) => o.posEntered);

    const total = orders.length;
    // Same "give me the true complete set" escape hatch as /api/visits, for
    // Dashboard/Performance's revenue-aggregation math.
    if (all === "true" && (req.role === "manager" || req.isSupervisor)) {
      return res.json({ orders, total, page: 1, limit: total });
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = clampLimit(limit, 25, 100);
    const start = (pageNum - 1) * pageSize;
    res.json({ orders: orders.slice(start, start + pageSize), total, page: pageNum, limit: pageSize });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/samples", async (req, res) => {
  try {
    const { doctorName, visitId, limit } = req.query;
    const rows = await db.getAllRows("Samples");
    let samples = rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (doctorName) {
      const key = String(doctorName).toLowerCase().trim();
      samples = samples.filter((s) => s.doctorName.toLowerCase().trim() === key);
    }
    if (visitId) samples = samples.filter((s) => s.visitId === visitId);
    res.json({ samples: samples.slice(0, clampLimit(limit, 50, 500)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Manager/supervisor-only: the full team punch history LocationsView used
// to get for free out of bootstrap. Fetched by that view itself now, not
// polled. Not requireManager — supervisors get team-wide Locations access
// too (see the visit-comments route above for the same rule).
app.get("/api/punch-log", async (req, res) => {
  try {
    if (req.role !== "manager" && !(req.role === "rep" && req.isSupervisor)) {
      return res.status(403).json({ error: "Managers and supervisors only." });
    }
    const { repName, limit } = req.query;
    const rows = await db.getAllRows("PunchLog");
    let log = rows.map(parsePunch).sort((a, b) => new Date(b.time) - new Date(a.time));
    if (repName && repName !== "all") log = log.filter((p) => p.repName === repName);
    res.json({ punchLog: log.slice(0, clampLimit(limit, 200, 1000)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/outreach-log/today", async (req, res) => {
  try {
    const rows = await db.getAllRows("OutreachLog");
    const todayStr = new Date().toISOString().slice(0, 10);
    const entries = rows.filter((o) => o.date === todayStr);
    res.json({ entries });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/competitor-sightings", async (req, res) => {
  try {
    const { client, visitId, limit } = req.query;
    const rows = await db.getAllRows("CompetitorSightings");
    let sightings = rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (client) {
      const key = String(client).toLowerCase().trim();
      sightings = sightings.filter((s) => (s.client || "").toLowerCase().trim() === key);
    }
    if (visitId) sightings = sightings.filter((s) => s.visitId === visitId);
    res.json({ sightings: sightings.slice(0, clampLimit(limit, 200, 500)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Server-side search replaces CompetitorsView's old full-array fetch +
// client-side filter — the direct fix for the second unbounded/Excel-import-
// grown list identified alongside Orders.
app.get("/api/competitor-products", async (req, res) => {
  try {
    // Seeded in this order regardless of entry point (a rep may open
    // Competitors before ever opening Recall) — competitor/product-catalog
    // seeding depends on the B12 our-products already existing, both for
    // the anchor-product linking step and for the Mason/ALFA enrichment
    // matches below.
    await ensureRecallCategoriesSeeded();
    await ensureRecallB12Seeded();
    await ensureB12ProductDataSeeded();
    await ensureCompetitorMasterDataSeeded();
    await ensureOurProductsMasterDataSeeded();
    const { q, limit } = req.query;
    const rows = await db.getAllRows("CompetitorProducts");
    let products = rows.sort((a, b) => a.genericName.localeCompare(b.genericName));
    if (q) {
      const key = String(q).toLowerCase().trim();
      products = products.filter((p) =>
        (p.genericName || "").toLowerCase().includes(key) ||
        (p.productName || "").toLowerCase().includes(key) ||
        (p.competitorName || "").toLowerCase().includes(key) ||
        (p.ingredients || "").toLowerCase().includes(key)
      );
    }
    res.json({ competitorProducts: products.slice(0, clampLimit(limit, 200, 500)), total: products.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const { name, category, expiry, qty, sold90, description, price } = req.body;
    if (!name || !expiry) return res.status(400).json({ error: "name and expiry are required" });
    const product = {
      id: `p${crypto.randomUUID()}`,
      name,
      category: category || "Supplement",
      expiry,
      qty: Number(qty) || 0,
      sold90: Number(sold90) || 0,
      description: description || "",
      price: Number(price) || 0,
    };
    await db.appendRow("Products", product);
    res.json(product);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    await db.deleteRowById("Products", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/products/import-sample", async (req, res) => {
  try {
    await db.replaceAllRows("Products", importedInventory);
    res.json({ ok: true, count: importedInventory.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/products/import-bulk", async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "No products provided" });
    }
    // This is a full stock refresh (qty/price/expiry all come fresh from the
    // sheet), but the dosage/pack-size/ingredient details a rep tags on in
    // the app live only in this table — carry them over so a routine
    // re-import doesn't wipe out details entered since the last one, and so
    // the id stays stable for anything already referencing it (order line
    // items, samples). A "batch" here is product + expiry, not just the
    // product — the exact same item legitimately appears as two rows with
    // two different expiry dates (an older batch on the shelf and a newer
    // one just delivered), so expiry must be part of the match key or two
    // real batches collapse onto one row on re-import. Matched by SKU+expiry
    // first when the sheet provides a SKU — that survives a product being
    // renamed — falling back to name+expiry for sheets without a SKU column.
    const existing = await db.getAllRows("Products");
    const batchKey = (identifier, expiry) => `${String(identifier || "").trim().toLowerCase()}::${String(expiry || "").trim()}`;
    const existingBySku = new Map(existing.filter((p) => p.sku).map((p) => [batchKey(p.sku, p.expiry), p]));
    const existingByName = new Map(existing.map((p) => [batchKey(p.name, p.expiry), p]));
    const normalized = products
      .filter((p) => p.name && p.expiry)
      .map((p) => {
        const sku = p.sku ? String(p.sku).trim() : "";
        const prior = (sku && existingBySku.get(batchKey(sku, p.expiry))) || existingByName.get(batchKey(p.name, p.expiry));
        return {
          id: prior ? prior.id : `p${crypto.randomUUID()}`,
          name: String(p.name).trim(),
          category: p.category || "Supplement",
          expiry: p.expiry,
          qty: Number(p.qty) || 0,
          sold90: Number(p.sold90) || 0,
          description: p.description || "",
          price: Number(p.price) || 0,
          form: prior?.form || "",
          packSize: prior?.packSize || "",
          unitsPerDay: prior?.unitsPerDay || "",
          ingredients: prior?.ingredients || "",
          updatedBy: prior?.updatedBy || "",
          updatedAt: prior?.updatedAt || "",
          sku: sku || prior?.sku || "",
        };
      });
    if (normalized.length === 0) {
      return res.status(400).json({ error: "None of the rows had both a name and an expiry date" });
    }
    await db.replaceAllRows("Products", normalized);
    res.json({ ok: true, count: normalized.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Product Catalog (manager-curated master list, decoupled from Stock) ----------
// Stock (the Products tab above) tracks per-batch qty + expiry and gets
// fully replaced on every re-import, so it's the wrong place to hang
// dosage/pack-size/ingredient details a manager wants to keep permanently.
// This is a separate, independent list — every product the company
// carries, regardless of what's currently in stock or which batch/expiry —
// and it's what "Compare with our product" under Competitors reads from.
app.post("/api/product-catalog", requireManager, async (req, res) => {
  try {
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: "Product name is required." });
    const validationError = validateCompetitorProductNumbers(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const product = {
      id: `pc${crypto.randomUUID()}`,
      name: String(req.body.name).trim(),
      price: req.body.price === "" || req.body.price == null ? "" : Number(req.body.price),
      form: req.body.form || "",
      packSize: req.body.packSize === "" || req.body.packSize == null ? "" : Number(req.body.packSize),
      unitsPerDay: req.body.unitsPerDay === "" || req.body.unitsPerDay == null ? "" : Number(req.body.unitsPerDay),
      ingredients: normalizeIngredients(req.body.ingredients),
      notes: req.body.notes || "",
      sku: req.body.sku || "",
      createdBy: req.repName || "Manager",
      createdAt: new Date().toISOString(),
      updatedBy: "",
      updatedAt: "",
    };
    await db.appendRow("ProductCatalog", product);
    res.json(product);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/product-catalog/:id", requireManager, async (req, res) => {
  try {
    if (req.body.name !== undefined && !String(req.body.name).trim()) return res.status(400).json({ error: "Product name is required." });
    const validationError = validateCompetitorProductNumbers(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const patch = { updatedBy: req.repName || "Manager", updatedAt: new Date().toISOString() };
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.price !== undefined) patch.price = req.body.price === "" ? "" : Number(req.body.price);
    if (req.body.form !== undefined) patch.form = req.body.form || "";
    if (req.body.packSize !== undefined) patch.packSize = req.body.packSize === "" ? "" : Number(req.body.packSize);
    if (req.body.unitsPerDay !== undefined) patch.unitsPerDay = req.body.unitsPerDay === "" ? "" : Number(req.body.unitsPerDay);
    if (req.body.ingredients !== undefined) patch.ingredients = normalizeIngredients(req.body.ingredients);
    if (req.body.notes !== undefined) patch.notes = req.body.notes || "";
    if (req.body.sku !== undefined) patch.sku = req.body.sku || "";
    const ok = await db.updateRowById("ProductCatalog", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Product not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/product-catalog/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("ProductCatalog", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Additive, not a full replace like Stock's import — this is a growing
// master list, not a snapshot of "what's on the shelf right now", so a
// partial re-export shouldn't delete products left out of it. Matches by
// name (case-insensitive): an existing product gets its price refreshed
// (if the sheet provides one) while keeping whatever details a manager
// already filled in; a name not seen before is added as a new product.
app.post("/api/product-catalog/import-bulk", requireManager, async (req, res) => {
  try {
    const { products } = req.body;
    const rows = Array.isArray(products) ? products.filter((p) => p.name && String(p.name).trim()) : [];
    if (rows.length === 0) return res.status(400).json({ error: "No products provided" });

    const existing = await db.getAllRows("ProductCatalog");
    const existingByName = new Map(existing.map((p) => [String(p.name).trim().toLowerCase(), p]));
    const seen = new Set();
    const toAdd = [];
    const toUpdate = [];
    for (const row of rows) {
      const key = String(row.name).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const prior = existingByName.get(key);
      if (prior) {
        if (row.price !== undefined && row.price !== "" && row.price !== null) {
          toUpdate.push({ id: prior.id, price: Number(row.price) || 0 });
        }
      } else {
        toAdd.push({
          id: `pc${crypto.randomUUID()}`,
          name: String(row.name).trim(),
          price: row.price === "" || row.price == null ? "" : Number(row.price) || 0,
          form: "", packSize: "", unitsPerDay: "", ingredients: "", notes: "",
          createdBy: `${req.repName || "Manager"} (Excel import)`,
          createdAt: new Date().toISOString(),
          updatedBy: "", updatedAt: "",
        });
      }
    }
    if (toAdd.length > 0) await db.appendRows("ProductCatalog", toAdd);
    for (const u of toUpdate) await db.updateRowById("ProductCatalog", u.id, { price: u.price });
    res.json({ ok: true, added: toAdd.length, updated: toUpdate.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Stock movement (multi-year monthly sales history) ----------
// Past years lock once imported so they can't be silently overwritten; the
// current year never locks since it's uploaded incrementally as the year
// progresses.
app.get("/api/stock-movement/status", requireManager, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const lockedYears = settings.stockMovementLockedYears ? JSON.parse(settings.stockMovementLockedYears) : [];
    const rows = await db.getAllRows("StockMovement");
    const countByYear = {};
    rows.forEach((r) => { countByYear[r.year] = (countByYear[r.year] || 0) + 1; });
    res.json({ lockedYears, countByYear });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/stock-movement/import", requireManager, async (req, res) => {
  try {
    const { year, rows } = req.body;
    const yearNum = Number(year);
    if (!yearNum || !Array.isArray(rows)) return res.status(400).json({ error: "year and rows are required" });
    const currentYear = new Date().getFullYear();
    const settings = await db.getSettings();
    const lockedYears = settings.stockMovementLockedYears ? JSON.parse(settings.stockMovementLockedYears) : [];
    if (yearNum !== currentYear && lockedYears.includes(yearNum)) {
      return res.status(400).json({ error: `${yearNum} is already imported and locked.` });
    }
    const cleanRows = rows
      .filter((r) => r.productName && r.month)
      .map((r) => ({
        id: `sm${crypto.randomUUID()}`,
        productName: String(r.productName).trim(),
        year: yearNum,
        month: Number(r.month),
        qty: Number(r.qty) || 0,
      }));
    const existing = await db.getAllRows("StockMovement");
    const kept = existing.filter((r) => Number(r.year) !== yearNum);
    await db.replaceAllRows("StockMovement", [...kept, ...cleanRows]);
    if (yearNum !== currentYear && !lockedYears.includes(yearNum)) {
      await db.setSettings({ stockMovementLockedYears: JSON.stringify([...lockedYears, yearNum]) });
    }
    res.json({ ok: true, count: cleanRows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// A locked year can be deliberately reopened (e.g. the wrong file was
// uploaded, or corrected data arrived later) — this only removes the lock so
// the next import for that year is allowed through; it doesn't touch the
// data already stored, which the next import will fully replace as usual.
app.post("/api/stock-movement/unlock", requireManager, async (req, res) => {
  try {
    const yearNum = Number(req.body.year);
    if (!yearNum) return res.status(400).json({ error: "year is required" });
    const settings = await db.getSettings();
    const lockedYears = settings.stockMovementLockedYears ? JSON.parse(settings.stockMovementLockedYears) : [];
    await db.setSettings({ stockMovementLockedYears: JSON.stringify(lockedYears.filter((y) => y !== yearNum)) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Pharmacy sales ledger (drives the Telegram "pick up" list) ----
// A snapshot of which pharmacy holds how many units of which expiry-dated
// batch — net of any returns — computed client-side from an exported sales
// ledger and uploaded here as a full replacement each time (not additive
// like Stock Movement, since each export is already the full picture as of
// now).
app.get("/api/pharmacy-sales/status", requireManager, async (req, res) => {
  try {
    const rows = await db.getAllRows("PharmacySales");
    res.json({ rowCount: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/pharmacy-sales/import", requireManager, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows is required" });
    const cleanRows = rows
      .filter((r) => r.productName && r.pharmacyName && r.expiry)
      .map((r) => ({
        id: `ps${crypto.randomUUID()}`,
        productName: String(r.productName).trim(),
        pharmacyName: String(r.pharmacyName).trim(),
        expiry: r.expiry,
        qty: Number(r.qty) || 0,
      }));
    await db.replaceAllRows("PharmacySales", cleanRows);
    res.json({ ok: true, count: cleanRows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/visits", async (req, res) => {
  try {
    const { client, notes, coords, mentionedItems, competitorName, competitorNotes } = req.body;
    if (!client) return res.status(400).json({ error: "client is required" });
    // Enforced server-side too, not just disabled in the UI — a visit with
    // no location proves nothing about whether the rep was actually there.
    // (The Telegram "Sign in" follow-up flow creates visits through a
    // separate internal path, not this route, so it's unaffected.)
    // TEMPORARY: the Head of Sales (isSupervisor) is exempted while Rabih's
    // phone's location permissions get sorted out — remove this carve-out
    // (and the matching one in CheckInView client-side) once that's fixed.
    if ((!coords || !coords.lat || !coords.lng) && !req.isSupervisor) {
      return res.status(400).json({ error: "GPS location is required to log a visit." });
    }

    // A visit must point at a real Pharmacies/Doctors record, not a name
    // typed on the spot — otherwise it has no tier, address, or assigned
    // rep behind it. New clients get added properly via their own tab.
    const [allClients, allDoctors] = await Promise.all([db.getAllRows("Clients"), db.getAllRows("Doctors")]);
    const matchedClient = allClients.find((c) => c.name.toLowerCase().trim() === client.toLowerCase().trim());
    const matchedDoctor = allDoctors.find((d) => d.name.toLowerCase().trim() === client.toLowerCase().trim());
    if (!matchedClient && !matchedDoctor) {
      return res.status(400).json({ error: `"${client}" isn't in the system yet — add it in the Pharmacies or Doctors tab first.` });
    }
    // Enforced here too, not just hidden in Check-In's toggle — a rep
    // restricted to supplement stores shouldn't be able to log a pharmacy
    // or doctor visit by calling the API directly either.
    if (req.supplementStoresOnly) {
      const isAllowed = matchedClient && (matchedClient.type || "pharmacy") === "supplement_store";
      if (!isAllowed) {
        return res.status(403).json({ error: "Your account is limited to supplement stores." });
      }
    }
    // Enforced here too, not just hidden in Check-In's toggle — a med rep
    // restricted to doctors shouldn't be able to log a pharmacy or
    // supplement store visit by calling the API directly either.
    if (req.medRepOnly && !matchedDoctor) {
      return res.status(403).json({ error: "Your account is limited to doctors." });
    }

    const visit = {
      id: `v${crypto.randomUUID()}`,
      client,
      notes: notes || "",
      coords: coords || null,
      time: new Date().toISOString(),
      repName: req.repName || "",
      mentionedItems: Array.isArray(mentionedItems) ? mentionedItems : [],
      objectionTag: classifyObjection(notes),
    };
    const row = visitToRow(visit);
    await db.appendRow("Visits", row);
    if (req.repName) {
      const reps = await db.getAllRows("Reps");
      const rep = reps.find((r) => r.name === req.repName);
      if (rep?.exportSheetId) await db.appendToRepExportSheet(rep.exportSheetId, row);
    }

    // A pharmacy visited with no assigned rep yet gets claimed by whoever
    // just logged the first visit to it — "anything made there gets
    // assigned to that user." If it's already assigned to someone else,
    // leave the assignment alone but flag it so both the rep (in the
    // response) and the manager (via push) know this crosses territories.
    let assignedRepWarning = null;
    if (req.repName) {
      if (matchedClient) {
        if (!matchedClient.assignedRep) {
          await db.updateRowById("Clients", matchedClient.id, { assignedRep: req.repName });
        } else if (matchedClient.assignedRep !== req.repName) {
          assignedRepWarning = matchedClient.assignedRep;
          notifyManagers({
            title: "Cross-rep pharmacy visit",
            body: `${req.repName} visited ${matchedClient.name}, which is assigned to ${matchedClient.assignedRep}`,
            url: "/",
          });
          db.getSettings().then((settings) => {
            if (!settings.managerTelegramChatId) return;
            telegram.sendMessage(
              settings.managerTelegramChatId,
              `⚠️ <b>${escapeHtml(req.repName)}</b> visited <b>${escapeHtml(matchedClient.name)}</b>, which is assigned to <b>${escapeHtml(matchedClient.assignedRep)}</b>.\n\nKeep the current assignment, or move it to ${escapeHtml(req.repName)}?`,
              { inline_keyboard: [[
                { text: `Keep ${matchedClient.assignedRep}`, callback_data: `keeprep:${matchedClient.id}` },
                { text: `Change to ${req.repName}`, callback_data: `changerep:${matchedClient.id}:${req.repName}` },
              ]] }
            );
          }).catch((e) => console.error("cross-rep telegram notify failed", e));
        }
      }
    }

    // Cross-checks the check-in GPS against the pharmacy's own saved
    // location (geocoded address or a GPS fix from when it was added) —
    // this is what actually answers "were they really there," not just
    // that some GPS was captured. Only meaningful once the pharmacy has a
    // saved location of its own to compare against.
    if (matchedClient?.coordsLat && matchedClient?.coordsLng && coords?.lat && coords?.lng) {
      const distanceKm = haversineKmServer(Number(coords.lat), Number(coords.lng), Number(matchedClient.coordsLat), Number(matchedClient.coordsLng));
      if (distanceKm > LOCATION_MISMATCH_KM) {
        notifyManagers({
          title: "Check-in location mismatch",
          body: `${req.repName || "A rep"} checked in at ${matchedClient.name} but is ${distanceKm.toFixed(1)}km from its known location.`,
          url: "/",
        });
      }
    }

    const sampleRows = visit.mentionedItems
      .filter((it) => it.sampleStatus === "gave" || it.sampleStatus === "next_visit")
      .map((it) => ({
        id: `s${crypto.randomUUID()}`,
        doctorName: visit.client,
        productName: it.name,
        productId: it.productId,
        status: it.sampleStatus,
        repName: req.repName || "",
        visitId: visit.id,
        date: visit.time,
      }));
    if (sampleRows.length) await db.appendRows("Samples", sampleRows);

    if (competitorName && String(competitorName).trim()) {
      await db.appendRow("CompetitorSightings", {
        id: `cs${crypto.randomUUID()}`,
        visitId: visit.id,
        client: visit.client,
        repName: req.repName || "",
        competitorName: String(competitorName).trim(),
        notes: competitorNotes || "",
        date: visit.time,
      });
    }

    res.json({ ...visit, assignedRepWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Lets a rep go back and fix up the visit they just logged (forgot a note,
// forgot to flag a competitor, forgot an item mentioned) without it turning
// into a second, duplicate visit — Check-In's Back button routes here
// rather than re-submitting POST /api/visits. Client/coords/time are never
// touched here; only content a rep might realistically have missed.
app.patch("/api/visits/:id", async (req, res) => {
  try {
    const visits = await db.getAllRows("Visits");
    const visit = visits.find((v) => v.id === req.params.id);
    if (!visit) return res.status(404).json({ error: "Visit not found." });
    // A rep can fix up their own just-logged visit; not rewrite someone
    // else's — same boundary as who's allowed to delete one.
    if (req.role !== "manager" && visit.repName !== req.repName) {
      return res.status(403).json({ error: "You can only edit your own visits." });
    }

    const { notes, mentionedItems, competitorName, competitorNotes } = req.body;
    const patch = {};
    if (notes !== undefined) {
      patch.notes = notes || "";
      patch.objectionTag = classifyObjection(notes);
    }
    if (Array.isArray(mentionedItems)) {
      patch.itemsMentioned = mentionedItems.length ? JSON.stringify(mentionedItems) : "";
    }
    if (Object.keys(patch).length > 0) {
      await db.updateRowById("Visits", req.params.id, patch);
    }

    // A newly-flagged sample (added on this edit, not present at creation)
    // still gets its own Samples row, mirroring POST /api/visits — existing
    // sample rows are left alone, this only ever adds one, never removes.
    if (Array.isArray(mentionedItems)) {
      const existingSamples = await db.getAllRows("Samples");
      const alreadyLogged = new Set(existingSamples.filter((s) => s.visitId === req.params.id).map((s) => s.productId));
      const newSampleRows = mentionedItems
        .filter((it) => (it.sampleStatus === "gave" || it.sampleStatus === "next_visit") && !alreadyLogged.has(it.productId))
        .map((it) => ({
          id: `s${crypto.randomUUID()}`,
          doctorName: visit.client,
          productName: it.name,
          productId: it.productId,
          status: it.sampleStatus,
          repName: visit.repName || "",
          visitId: req.params.id,
          date: visit.time,
        }));
      if (newSampleRows.length) await db.appendRows("Samples", newSampleRows);
    }

    // Same idea for a competitor sighting flagged on this edit — only added
    // if one wasn't already logged for this visit; never overwritten.
    if (competitorName && String(competitorName).trim()) {
      const existingSightings = await db.getAllRows("CompetitorSightings");
      const already = existingSightings.some((s) => s.visitId === req.params.id);
      if (!already) {
        await db.appendRow("CompetitorSightings", {
          id: `cs${crypto.randomUUID()}`,
          visitId: req.params.id,
          client: visit.client,
          repName: visit.repName || "",
          competitorName: String(competitorName).trim(),
          notes: competitorNotes || "",
          date: visit.time,
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Pharmacy sample-giving, asked right after the order question in Check-In
// — separate from the doctor "items mentioned" flow above (which predates
// quantity tracking), so this is the one place item + qty samples get
// recorded. Reuses the Samples sheet's "doctorName" column as a generic
// recipient-name field — same underlying data, just also used for
// pharmacies now.
app.post("/api/samples", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const { entityName, visitId, items } = req.body;
    if (!entityName || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "entityName and at least one item are required" });
    }
    const now = new Date().toISOString();
    const rows = items
      .filter((it) => it.name && Number(it.qty) > 0)
      .map((it) => ({
        id: `s${crypto.randomUUID()}`,
        doctorName: entityName,
        productName: it.name,
        productId: it.productId || "",
        status: "gave",
        repName: req.repName,
        visitId: visitId || "",
        date: now,
        qty: Number(it.qty),
      }));
    if (rows.length === 0) return res.status(400).json({ error: "No valid items to save." });
    await db.appendRows("Samples", rows);
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/followups", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Only reps can schedule follow-ups." });
    const { entityName, entityType, presetKey, days: customDays, visitId, smartiObjective } = req.body;
    if (!entityName || !entityType) {
      return res.status(400).json({ error: "entityName and entityType are required" });
    }
    // Either a preset (2d/1w/1m/…) or a rep-typed custom day count — never
    // both. Custom is capped at a year out so a typo (e.g. an extra digit)
    // can't silently schedule a follow-up decades in the future.
    let days;
    if (presetKey) {
      const preset = FOLLOWUP_PRESETS[presetKey];
      if (!preset) return res.status(400).json({ error: "Invalid presetKey" });
      days = preset.days;
    } else {
      days = Number(customDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return res.status(400).json({ error: "Custom follow-up must be a whole number of days between 1 and 365." });
      }
    }
    const followUp = {
      id: `fu${crypto.randomUUID()}`,
      entityName,
      entityType,
      repName: req.repName,
      dueDate: addDaysToTodayStr(days),
      status: "pending",
      visitId: visitId || "",
      createdAt: new Date().toISOString(),
      // Doctors only — the rep's own stated goal for the *next* visit,
      // carried forward so the Telegram reminder when it comes due can
      // remind them what they committed to, not just that a visit is due.
      smartiObjective: entityType === "doctor" && smartiObjective ? String(smartiObjective).trim() : "",
    };
    await db.appendRow("FollowUps", followUp);

    // For doctors, pull whichever items the rep already tagged "Give next
    // visit" in step 1 (Samples rows with status=next_visit) and stamp them
    // onto the follow-up automatically — no separate question to the rep,
    // since step 1's tagging already answered it. checkSampleReminders uses
    // this to tell the manager what to have ready, 2 days out.
    if (entityType === "doctor") {
      const samples = await db.getAllRows("Samples");
      const matches = samples.filter((s) => s.doctorName.toLowerCase().trim() === entityName.toLowerCase().trim());
      const latestByProduct = new Map();
      matches.forEach((s) => {
        const existing = latestByProduct.get(s.productId);
        if (!existing || new Date(s.date) > new Date(existing.date)) latestByProduct.set(s.productId, s);
      });
      const items = [...latestByProduct.values()]
        .filter((s) => s.status === "next_visit")
        .map((s) => ({ productId: s.productId, name: s.productName }));
      if (items.length) {
        await db.updateRowById("FollowUps", followUp.id, {
          needsSample: "true",
          sampleItems: JSON.stringify(items),
        });
      }
    }

    res.json(followUp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Recorded as its own FollowUps row (status "stopped") rather than mutating
// an existing one, same as the Telegram "🚫 Not interested — stop" path —
// keeps a full timeline per entity instead of overwriting history. The
// optional reason is what lets the visit-frequency analysis later explain
// *why* a pharmacy/doctor dropped off, not just that it did.
app.post("/api/followups/stop", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Only reps can do this." });
    const { entityName, entityType, reason, visitId } = req.body;
    if (!entityName || !entityType) {
      return res.status(400).json({ error: "entityName and entityType are required" });
    }
    const followUp = {
      id: `fu${crypto.randomUUID()}`,
      entityName,
      entityType,
      repName: req.repName,
      dueDate: "",
      status: "stopped",
      visitId: visitId || "",
      createdAt: new Date().toISOString(),
      stopReason: (reason || "").trim(),
    };
    await db.appendRow("FollowUps", followUp);
    res.json(followUp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/visits/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Visits", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// A supervisor (or manager) can leave a note on any rep's visit — "you
// should've asked about X here" — right from the Locations view where
// they're already looking at who visited what. The visiting rep gets a push
// notification and sees it back in their own Check-In history.
app.post("/api/visits/:id/comments", async (req, res) => {
  try {
    if (req.role !== "manager" && !(req.role === "rep" && req.isSupervisor)) {
      return res.status(403).json({ error: "Managers and supervisors only." });
    }
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Comment text is required." });
    const visits = await db.getAllRows("Visits");
    const visit = visits.find((v) => v.id === req.params.id);
    if (!visit) return res.status(404).json({ error: "Visit not found." });

    const comment = {
      id: `vc${crypto.randomUUID()}`,
      visitId: req.params.id,
      authorName: req.role === "manager" ? "Manager" : req.repName,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("VisitComments", comment);
    if (visit.repName) {
      notifyRep(visit.repName, {
        title: "New comment on your visit",
        body: `${comment.authorName} commented on your visit to ${visit.client}`,
        url: "/",
      });
    }
    res.json(comment);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/punch", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const { type, coords } = req.body;
    if (type !== "in" && type !== "out") return res.status(400).json({ error: "type must be 'in' or 'out'" });
    const log = await db.getAllRows("PunchLog");
    const mine = log.filter((p) => p.repName === req.repName).sort((a, b) => new Date(b.time) - new Date(a.time));
    let currentlyIn = mine.length > 0 && mine[0].type === "in";

    // A dangling "in" from a previous day (missed by the scheduled 9pm
    // auto-close — the free-tier server can be asleep at that exact hour,
    // or it just hasn't run yet today) would otherwise block every future
    // punch-in forever: the server refuses a new "in" while the last one is
    // still open, but the app requires a fresh punch specifically for
    // today. Close it out right now instead of leaving the rep stuck.
    // Previously this — and the scheduled 9pm auto-close — flagged the
    // closed entry as needing the rep's confirmation before a new punch-in
    // was allowed, checked against their *entire* punch history. That
    // full-history check was the actual bug: the client only ever showed a
    // confirm screen for the single latest punch, so an older unconfirmed
    // entry (e.g. from an earlier stale-close) left a rep permanently
    // blocked here with no UI able to resolve it. Auto-closes are now just
    // accepted outright — no confirmation step, nothing to get stuck on.
    if (type === "in" && currentlyIn && beirutDateStr(new Date(mine[0].time)) !== beirutDateStr(new Date())) {
      const staleClose = {
        id: `pl${crypto.randomUUID()}`,
        repName: req.repName,
        type: "out",
        time: new Date().toISOString(),
        coordsLat: "",
        coordsLng: "",
        auto: "true",
        confirmed: "true",
      };
      await db.appendRow("PunchLog", staleClose);
      currentlyIn = false;
    }

    if (type === "in" && currentlyIn) return res.status(400).json({ error: "Already punched in." });
    if (type === "out" && !currentlyIn) return res.status(400).json({ error: "Not punched in." });
    const entry = {
      id: `pl${crypto.randomUUID()}`,
      repName: req.repName,
      type,
      time: new Date().toISOString(),
      coordsLat: coords ? coords.lat : "",
      coordsLng: coords ? coords.lng : "",
      auto: "",
      confirmed: "true",
    };
    await db.appendRow("PunchLog", entry);
    if (type === "in") {
      db.getSettings().then((settings) => {
        if (!settings.managerTelegramChatId) return;
        const timeStr = new Date(entry.time).toLocaleTimeString("en-US", { timeZone: "Asia/Beirut", hour: "numeric", minute: "2-digit" });
        telegram.sendMessage(settings.managerTelegramChatId, `🟢 ${req.repName} punched in at ${timeStr}.`)
          .catch((e) => console.error("punch-in telegram notify failed", e));
      }).catch((e) => console.error("punch-in telegram notify failed", e));
    }
    res.json(entry);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { clientName, visitId, items, discountRate } = req.body;
    if (!clientName || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "clientName and at least one item are required" });
    }
    // Same restriction as visit creation — a rep limited to supplement
    // stores can't place an order against a pharmacy via the API either.
    if (req.supplementStoresOnly) {
      const allClients = await db.getAllRows("Clients");
      const matchedClient = allClients.find((c) => c.name.toLowerCase().trim() === clientName.toLowerCase().trim());
      const isAllowed = matchedClient && (matchedClient.type || "pharmacy") === "supplement_store";
      if (!isAllowed) {
        return res.status(403).json({ error: "Your account is limited to supplement stores." });
      }
    }
    // A med rep restricted to doctors never has a pharmacy/supplement store
    // to place an order against — doctors don't take orders at all.
    if (req.medRepOnly) {
      return res.status(403).json({ error: "Your account is limited to doctors and can't place orders." });
    }
    const cleanItems = buildCleanOrderItems(items);

    const offerError = await validateOfferGroups(cleanItems);
    if (offerError) return res.status(400).json({ error: offerError });

    const total = cleanItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);

    // The pharmacy's negotiated trade discount (22.5%, 35%, or a one-off
    // exception) comes off the list-price total on top of any buy-X-get-Y
    // offer already baked into the free items above — that's what actually
    // gets collected, and it's what "sales" should mean in every report.
    // The rep can override the pharmacy's standard rate for this one order
    // (an exception) by sending a different discountRate explicitly.
    let appliedDiscountRate = Number(discountRate) || 0;
    if (discountRate === undefined || discountRate === null || discountRate === "") {
      const clients = await db.getAllRows("Clients");
      const matchedClient = clients.find((c) => c.name.toLowerCase().trim() === clientName.toLowerCase().trim());
      appliedDiscountRate = matchedClient?.discountRate ? Number(matchedClient.discountRate) : 0;
    }
    const netTotal = total * (1 - appliedDiscountRate / 100);

    const order = {
      id: `ord${crypto.randomUUID()}`,
      clientName,
      visitId: visitId || "",
      repName: req.repName || "",
      date: new Date().toISOString(),
      items: JSON.stringify(cleanItems),
      total,
      status: "confirmed",
      discountRate: appliedDiscountRate,
      netTotal,
    };
    await db.appendRow("Orders", order);
    notifyManagers({ title: "New order placed", body: `${clientName} — ${netTotal.toFixed(2)} collected (list ${total.toFixed(2)})`, url: "/" });
    notifySupervisorOrderTelegram(order, cleanItems, total, appliedDiscountRate, netTotal, "🧾 New order —");
    res.json(parseOrder(order));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Lets the rep who placed an order fix a mistake themselves — wrong
// quantity, missing item, wrong discount — without going through the
// manager-approval delete flow. Only allowed while the Head of Sales hasn't
// entered it in the POS yet: once posEntered is true the order is locked,
// since by then it may already be reflected in real accounting/inventory.
app.patch("/api/orders/:id", async (req, res) => {
  try {
    const orders = await db.getAllRows("Orders");
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.posEntered === "true") {
      return res.status(403).json({ error: "This order has already been entered in POS and can no longer be edited." });
    }
    if (order.status === "deletion_requested") {
      return res.status(400).json({ error: "This order has a pending deletion request — resolve that first." });
    }
    if (req.role !== "manager" && order.repName !== req.repName) {
      return res.status(403).json({ error: "You can only edit your own orders." });
    }

    const { items, discountRate } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    const cleanItems = buildCleanOrderItems(items);

    const offerError = await validateOfferGroups(cleanItems);
    if (offerError) return res.status(400).json({ error: offerError });

    const total = cleanItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
    const appliedDiscountRate = discountRate === undefined || discountRate === null || discountRate === ""
      ? Number(order.discountRate) || 0
      : Number(discountRate) || 0;
    const netTotal = total * (1 - appliedDiscountRate / 100);

    const patch = { items: JSON.stringify(cleanItems), total, discountRate: appliedDiscountRate, netTotal };
    await db.updateRowById("Orders", order.id, patch);
    const updated = { ...order, ...patch };
    notifySupervisorOrderTelegram(updated, cleanItems, total, appliedDiscountRate, netTotal, "✏️ Order updated —");
    res.json(parseOrder(updated));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders/:id/request-delete", async (req, res) => {
  try {
    const ok = await db.updateRowById("Orders", req.params.id, { status: "deletion_requested" });
    if (!ok) return res.status(404).json({ error: "Order not found" });
    notifyManagers({ title: "Order deletion requested", body: "A rep asked to delete an order — review in the Orders tab.", url: "/" });

    const orders = await db.getAllRows("Orders");
    const order = orders.find((o) => o.id === req.params.id);
    if (order) {
      const settings = await db.getSettings();
      const msg = `🗑 <b>${escapeHtml(req.repName || "A rep")}</b> asked to delete the order for <b>${escapeHtml(order.clientName)}</b> (${(Number(order.total) || 0).toFixed(2)}).`;
      const buttons = {
        inline_keyboard: [[
          { text: "🗑 Delete", callback_data: `orddel:${order.id}` },
          { text: "Keep it", callback_data: `ordkeep:${order.id}` },
        ]],
      };
      if (settings.managerTelegramChatId) {
        telegram.sendMessage(settings.managerTelegramChatId, msg, buttons).catch((e) => console.error("order-delete telegram (manager) failed", e));
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders/:id/approve-delete", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Orders", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders/:id/deny-delete", requireManager, async (req, res) => {
  try {
    const ok = await db.updateRowById("Orders", req.params.id, { status: "confirmed" });
    if (!ok) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/orders/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Orders", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Internal POS-entry confirmation — restricted to the Head of Sales (the
// rep flagged as supervisor), not the manager, per explicit request. Only
// ever touches these three fields: never the order's items, pricing,
// discount, total, or status. Doesn't reset on any schedule — an order
// stays "Pending POS" indefinitely until this is called.
app.patch("/api/orders/:id/pos-entered", async (req, res) => {
  try {
    if (!(req.role === "rep" && req.isSupervisor)) {
      return res.status(403).json({ error: "Only the Head of Sales can mark an order as POS entered." });
    }
    const patch = {
      posEntered: "true",
      posEnteredAt: new Date().toISOString(),
      posEnteredBy: req.repName || "",
    };
    const ok = await db.updateRowById("Orders", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true, ...patch });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/offers", requireManager, async (req, res) => {
  try {
    const { label, buyQty, getQty, expiresAt } = req.body;
    if (!label || !buyQty || !getQty) return res.status(400).json({ error: "label, buyQty and getQty are required" });
    const offer = {
      id: `offer${crypto.randomUUID()}`,
      label: String(label).trim(),
      buyQty: Number(buyQty),
      getQty: Number(getQty),
      expiresAt: expiresAt || "",
      active: "true",
    };
    await db.appendRow("Offers", offer);
    res.json(parseOffer(offer));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/offers/:id", requireManager, async (req, res) => {
  try {
    const patch = {};
    if (req.body.active !== undefined) patch.active = req.body.active ? "true" : "false";
    const ok = await db.updateRowById("Offers", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Offer not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/offers/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Offers", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Training videos ------------------------------------------------------
// Video files are never uploaded through this app — a manager uploads the
// file directly into the private R2 bucket via the Cloudflare dashboard,
// then pastes its object key (filename) here along with the quiz JSON.
// This app never stores or serves the video itself, only that key and the
// quiz.
app.get("/api/training-videos", async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingVideos");
    const videos = rows.map((v) => parseTrainingVideo(v)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/training-videos/:id", async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingVideos");
    const video = rows.find((v) => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: "Training video not found" });
    res.json(parseTrainingVideo(video, { includeQuiz: true, includeR2Key: req.role === "manager" }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/training-videos", requireManager, async (req, res) => {
  try {
    const { title, r2ObjectKey, quiz } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
    if (!r2ObjectKey || !String(r2ObjectKey).trim()) {
      return res.status(400).json({ error: "r2ObjectKey is required" });
    }
    const quizError = validateTrainingQuiz(quiz);
    if (quizError) return res.status(400).json({ error: quizError });

    const cleanKey = String(r2ObjectKey).trim();
    await verifyR2ObjectExists(cleanKey);

    const video = {
      id: `tv${crypto.randomUUID()}`,
      title: String(title).trim(),
      r2ObjectKey: cleanKey,
      quiz: JSON.stringify(quiz),
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("TrainingVideos", video);
    res.json(parseTrainingVideo(video));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Lets a manager fix a mistake — a typo in the title, the wrong file
// pasted, a correction to the quiz JSON — without deleting and re-adding
// the video (which would lose its completion history, since progress rows
// reference this video's id). Each field is optional; only what's sent
// gets changed.
app.patch("/api/admin/training-videos/:id", requireManager, async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingVideos");
    const video = rows.find((v) => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: "Training video not found" });

    const { title, r2ObjectKey, quiz } = req.body;
    const patch = {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: "title can't be empty" });
      patch.title = String(title).trim();
    }
    if (r2ObjectKey !== undefined) {
      const cleanKey = String(r2ObjectKey).trim();
      if (!cleanKey) return res.status(400).json({ error: "r2ObjectKey can't be empty" });
      await verifyR2ObjectExists(cleanKey);
      patch.r2ObjectKey = cleanKey;
    }
    if (quiz !== undefined) {
      const quizError = validateTrainingQuiz(quiz);
      if (quizError) return res.status(400).json({ error: quizError });
      patch.quiz = JSON.stringify(quiz);
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });

    await db.updateRowById("TrainingVideos", video.id, patch);
    res.json(parseTrainingVideo({ ...video, ...patch }, { includeQuiz: true, includeR2Key: true }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Deliberately doesn't touch TrainingProgress rows referencing this video —
// completion history stays as a record of what an employee actually did,
// same as deleting an Offer doesn't retroactively change past orders that
// used it.
app.delete("/api/admin/training-videos/:id", requireManager, async (req, res) => {
  try {
    const ok = await db.deleteRowById("TrainingVideos", req.params.id);
    if (!ok) return res.status(404).json({ error: "Training video not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Any logged-in employee (rep or manager) can request a playback URL for
// any training video — there's no per-employee video assignment, everyone
// sees the same catalog. What's actually restricted is that this is the
// ONLY way to get a working URL at all: the token is short-lived and minted
// fresh per request, tied to nothing but "someone with a valid session
// asked for it right now."
app.get("/api/training-videos/:id/playback-url", async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingVideos");
    const video = rows.find((v) => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: "Training video not found" });
    const { url, expiresAt } = await createTrainingPlaybackUrl(video);
    res.json({ url, expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/training-videos/:id/complete", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Employees only." });
    const videos = await db.getAllRows("TrainingVideos");
    const video = videos.find((v) => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: "Training video not found" });
    const { quizResponses } = req.body;
    if (!Array.isArray(quizResponses)) return res.status(400).json({ error: "quizResponses must be an array" });

    // Retaking a video's quiz overwrites the same progress row rather than
    // piling up duplicates — "completed" is a single current fact per
    // employee per video, and the latest attempt is what matters.
    const progressRows = await db.getAllRows("TrainingProgress");
    const existing = progressRows.find((p) => p.employeeId === req.repName && p.videoId === video.id);
    const patch = { completedAt: new Date().toISOString(), quizResponses: JSON.stringify(quizResponses) };
    if (existing) {
      await db.updateRowById("TrainingProgress", existing.id, patch);
      return res.json(parseTrainingProgress({ ...existing, ...patch }));
    }
    const progress = { id: `tp${crypto.randomUUID()}`, employeeId: req.repName, videoId: video.id, ...patch };
    await db.appendRow("TrainingProgress", progress);
    res.json(parseTrainingProgress(progress));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Reps see only their own completion history (their quiz answers are their
// own); managers/supervisors get the team-wide view needed to actually
// track who completed what, matching the same access rule used for
// Locations and Performance.
app.get("/api/training-progress", async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingProgress");
    let progress = rows.map(parseTrainingProgress);
    if (!(req.role === "manager" || req.isSupervisor)) {
      progress = progress.filter((p) => p.employeeId === req.repName);
    }
    res.json({ progress });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Training studies ------------------------------------------------------
// A manager-curated reference list of external study links (PubMed, journal
// pages, etc.) reps can consult while pitching a product — no content is
// hosted here, just a title, the URL, and an optional note on why it's
// relevant.
app.get("/api/training-studies", async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingStudies");
    const studies = rows.map(parseTrainingStudy).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ studies });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Open to any logged-in employee (not just managers) — reps are the ones
// out finding relevant studies, same reasoning as opening up the
// competitor product list. Editing/deleting stays manager-only below.
app.post("/api/admin/training-studies", async (req, res) => {
  try {
    const { title, url, notes, nutrient } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
    if (!url || !String(url).trim()) return res.status(400).json({ error: "url is required" });
    let cleanUrl = String(url).trim();
    if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = `https://${cleanUrl}`;
    try { new URL(cleanUrl); } catch { return res.status(400).json({ error: "That doesn't look like a valid URL." }); }

    const study = {
      id: `ts${crypto.randomUUID()}`,
      title: String(title).trim(),
      url: cleanUrl,
      notes: notes ? String(notes).trim() : "",
      nutrient: nutrient ? String(nutrient).trim() : "",
      createdBy: req.repName || (req.role === "manager" ? "Manager" : ""),
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("TrainingStudies", study);
    const nutrientNote = study.nutrient ? ` (${study.nutrient})` : "";
    notifyAllReps({ title: "New training study added", body: `"${study.title}"${nutrientNote} was just added to Training Studies.`, url: "/" });
    res.json(parseTrainingStudy(study));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/admin/training-studies/:id", requireManager, async (req, res) => {
  try {
    const rows = await db.getAllRows("TrainingStudies");
    const study = rows.find((s) => s.id === req.params.id);
    if (!study) return res.status(404).json({ error: "Study not found" });

    const { title, url, notes, nutrient } = req.body;
    const patch = {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: "title can't be empty" });
      patch.title = String(title).trim();
    }
    if (url !== undefined) {
      let cleanUrl = String(url).trim();
      if (!cleanUrl) return res.status(400).json({ error: "url can't be empty" });
      if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = `https://${cleanUrl}`;
      try { new URL(cleanUrl); } catch { return res.status(400).json({ error: "That doesn't look like a valid URL." }); }
      patch.url = cleanUrl;
    }
    if (notes !== undefined) patch.notes = String(notes).trim();
    if (nutrient !== undefined) patch.nutrient = String(nutrient).trim();
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });

    await db.updateRowById("TrainingStudies", study.id, patch);
    res.json(parseTrainingStudy({ ...study, ...patch }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/training-studies/:id", requireManager, async (req, res) => {
  try {
    const ok = await db.deleteRowById("TrainingStudies", req.params.id);
    if (!ok) return res.status(404).json({ error: "Study not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Fired when a rep opens a study's link — lets the every-other-day training
// nudge (below) know which studies a rep has already gotten to, the same
// way TrainingProgress tracks video completion. One row per employee per
// study; re-opening just bumps viewedAt rather than piling up duplicates.
app.post("/api/training-studies/:id/viewed", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Employees only." });
    const studies = await db.getAllRows("TrainingStudies");
    const study = studies.find((s) => s.id === req.params.id);
    if (!study) return res.status(404).json({ error: "Study not found" });

    const views = await db.getAllRows("TrainingStudyViews");
    const existing = views.find((v) => v.employeeId === req.repName && v.studyId === study.id);
    const viewedAt = new Date().toISOString();
    if (existing) {
      await db.updateRowById("TrainingStudyViews", existing.id, { viewedAt });
    } else {
      await db.appendRow("TrainingStudyViews", { id: `tsv${crypto.randomUUID()}`, employeeId: req.repName, studyId: study.id, viewedAt });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Open to any employee, not just managers — a narrow, single-field version
// of the full (manager-only) edit below, specifically so the backlog of
// untagged studies can get tagged quickly by whoever notices one, without
// needing full edit rights over the title/URL/notes.
app.patch("/api/training-studies/:id/nutrient", async (req, res) => {
  try {
    const { nutrient } = req.body;
    if (!nutrient || !String(nutrient).trim()) return res.status(400).json({ error: "nutrient is required" });
    const ok = await db.updateRowById("TrainingStudies", req.params.id, { nutrient: String(nutrient).trim() });
    if (!ok) return res.status(404).json({ error: "Study not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Competitors are a manager-curated master list (name + supplier + offer
// details) — reps pick from it (or type a name that isn't listed yet) when
// logging a sighting during Check-In, they don't add to the list directly.
// Keeps the list clean instead of accumulating rep-typed duplicates/typos.
app.post("/api/competitors", requireManager, async (req, res) => {
  try {
    const { name, supplierName, supplierContact, offerDetails, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const competitor = {
      id: `comp${crypto.randomUUID()}`,
      name: String(name).trim(),
      supplierName: supplierName || "",
      supplierContact: supplierContact || "",
      offerDetails: offerDetails || "",
      notes: notes || "",
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("Competitors", competitor);
    res.json(competitor);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/competitors/:id", requireManager, async (req, res) => {
  try {
    const patch = {};
    for (const key of ["name", "supplierName", "supplierContact", "offerDetails", "notes"]) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    const ok = await db.updateRowById("Competitors", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Competitor not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/competitors/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Competitors", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// A competitor's actual product catalog (brand, active ingredient/generic
// name, dose, pack size, price, and whatever discount they offer on it) —
// separate from the Competitors master list above so reps can search it by
// generic name while out in the field ("magnesium" -> every competitor
// brand that has one, with prices) instead of digging through free-text
// offer notes. Same manager-curated / rep-read-and-search governance as
// the master list.
// RULE (locked): never add a retailer stock-status field to this list —
// availability/inStock/outOfStock/soldOut/stockStatus have no place on a
// competitor product. Both routes below build the stored row by reading
// ONLY the fields named here, so an unlisted field in a request body
// (e.g. someone sending "availability") is never persisted regardless —
// this allowlist IS the enforcement, not just a convention. Retailer-
// specific data (price at a specific site, source URL, research date)
// belongs on RecallRetailerListings, one row per (product × retailer),
// never folded into this master row.
const COMPETITOR_PRODUCT_FIELDS = [
  "competitorName", "productName", "genericName", "form", "dosage", "packSize", "price", "discountRate", "notes", "unitsPerDay",
];
// Secondary/advanced fields — optional, shown behind "More product details"
// client-side. Kept as plain strings; none of them feed the cost math.
// coaAvailability is Certificate-of-Analysis availability (a documentation
// field) — unrelated to retailer stock availability; do not conflate them.
const COMPETITOR_PRODUCT_DETAIL_FIELDS = [
  "manufacturer", "manufacturingCountry", "ingredientOrigin", "gmp", "thirdPartyCertification",
  "coaAvailability", "contaminantTesting", "expiryDate", "evidenceReferences", "otherIngredients",
];

// `ingredients` is a JSON-encoded array of {name, form, amount, unit},
// entered client-side via a repeatable ingredient list — validated and
// re-stringified here rather than trusted verbatim from the request body.
function normalizeIngredients(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list
    .filter((i) => i && String(i.name || "").trim())
    .map((i) => ({
      name: String(i.name).trim(),
      form: String(i.form || "").trim(),
      amount: i.amount === "" || i.amount === null || i.amount === undefined ? "" : Number(i.amount),
      unit: String(i.unit || "").trim(),
    }));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

// Shared by both the required-fields (create) and partial (edit) checks —
// only validates whichever numeric fields are actually present in `body`.
function validateCompetitorProductNumbers(body) {
  if (body.price !== undefined && body.price !== "" && body.price !== null) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) return "Public price can't be negative.";
  }
  if (body.packSize !== undefined && body.packSize !== "" && body.packSize !== null) {
    const packSize = Number(body.packSize);
    if (!Number.isFinite(packSize) || packSize <= 0) return "Pack size must be greater than zero.";
  }
  if (body.discountRate !== undefined && body.discountRate !== "" && body.discountRate !== null) {
    const discount = Number(body.discountRate);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) return "Supplier discount must be between 0 and 100.";
  }
  if (body.unitsPerDay !== undefined && body.unitsPerDay !== "" && body.unitsPerDay !== null) {
    const upd = Number(body.unitsPerDay);
    if (!Number.isFinite(upd) || upd <= 0) return "Units per day must be greater than zero.";
  }
  if (Array.isArray(body.ingredients)) {
    for (const ing of body.ingredients) {
      if (ing && ing.amount !== undefined && ing.amount !== "" && ing.amount !== null && !Number.isFinite(Number(ing.amount))) {
        return `"${ing.name || "Ingredient"}" needs a valid numeric amount.`;
      }
    }
  }
  return null;
}

// RULE (locked): dosage form is part of a product's identity, never a
// detail to infer from its name — "Mason Calcium + D3 Tablet" and
// "...Chewable" are two separate, real products, not a naming variant of
// one product or a source conflict to resolve. `form` here is always
// whatever was explicitly typed/selected (client-side: a FORM_OPTIONS
// dropdown), sourced from a label/manufacturer/retailer page — never
// parsed or guessed from productName. Any future product-matching/dedup
// logic must treat two records with the same name but different `form`
// values as different products, not duplicates to merge.
function validateCompetitorProductCreate(body) {
  if (!body.competitorName || !String(body.competitorName).trim()) return "Brand is required.";
  if (!body.productName || !String(body.productName).trim()) return "Product name is required.";
  return validateCompetitorProductNumbers(body);
}

// Any logged-in employee (not just managers) can add a competitor product —
// this is the field's shared price-list database, and reps are the ones
// actually out there spotting new competitor products.
app.post("/api/competitor-products", async (req, res) => {
  try {
    const validationError = validateCompetitorProductCreate(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { competitorName, productName, form, notes, ingredients } = req.body;
    const ingredientsJson = normalizeIngredients(ingredients);
    const parsedIngredients = ingredientsJson ? JSON.parse(ingredientsJson) : [];
    // genericName/dosage stay populated from the first ingredient so
    // existing search/sort (which key off genericName) and any old client
    // code keep working — the structured `ingredients` field is the source
    // of truth for anything with more than one active ingredient.
    const genericName = req.body.genericName || parsedIngredients[0]?.name || "";
    const dosage = req.body.dosage || (parsedIngredients[0]?.amount !== "" && parsedIngredients[0]?.amount != null
      ? `${parsedIngredients[0].amount}${parsedIngredients[0].unit || ""}`
      : "");

    const product = { id: `cp${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
    for (const key of COMPETITOR_PRODUCT_FIELDS) product[key] = req.body[key] || "";
    for (const key of COMPETITOR_PRODUCT_DETAIL_FIELDS) product[key] = req.body[key] || "";
    product.competitorName = String(competitorName).trim();
    product.productName = String(productName).trim();
    product.form = form || "";
    product.notes = notes || "";
    product.genericName = genericName;
    product.dosage = dosage;
    product.ingredients = ingredientsJson;
    product.createdBy = req.repName || (req.role === "manager" ? "Manager" : "");
    product.updatedBy = "";
    product.updatedAt = "";

    await db.appendRow("CompetitorProducts", product);
    res.json(product);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Bulk upload: a manager builds this out from an Excel sheet on the client
// (item name, number of pills, type of pills, dose per pill, public price,
// supplier offer...); the client maps columns and sends parsed rows here.
app.post("/api/competitor-products/import-bulk", requireManager, async (req, res) => {
  try {
    const { products } = req.body;
    const addList = Array.isArray(products) ? products : [];

    const newProducts = addList
      .filter((p) => p.competitorName && p.productName)
      .map((p) => {
        const product = { id: `cp${crypto.randomUUID()}`, createdAt: new Date().toISOString(), createdBy: `${req.repName || "Manager"} (Excel import)` };
        for (const key of COMPETITOR_PRODUCT_FIELDS) product[key] = p[key] || "";
        product.competitorName = String(product.competitorName).trim();
        product.productName = String(product.productName).trim();
        return product;
      });

    if (newProducts.length > 0) await db.appendRows("CompetitorProducts", newProducts);
    res.json({ ok: true, added: newProducts.length, skipped: addList.length - newProducts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Open to any logged-in employee, same as adding — editing/completing a
// competitor product entry is part of building out the shared price list,
// not a manager-only action. Every edit stamps who made it (updatedBy),
// shown in the app so the team can see who last touched an entry.
app.patch("/api/competitor-products/:id", async (req, res) => {
  try {
    if (req.body.competitorName !== undefined && !String(req.body.competitorName).trim()) {
      return res.status(400).json({ error: "Brand is required." });
    }
    if (req.body.productName !== undefined && !String(req.body.productName).trim()) {
      return res.status(400).json({ error: "Product name is required." });
    }
    const validationError = validateCompetitorProductNumbers(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const patch = {};
    for (const key of COMPETITOR_PRODUCT_FIELDS) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    for (const key of COMPETITOR_PRODUCT_DETAIL_FIELDS) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (req.body.ingredients !== undefined) patch.ingredients = normalizeIngredients(req.body.ingredients);
    if (patch.competitorName !== undefined) patch.competitorName = String(patch.competitorName).trim();
    if (patch.productName !== undefined) patch.productName = String(patch.productName).trim();
    patch.updatedBy = req.repName || (req.role === "manager" ? "Manager" : "");
    patch.updatedAt = new Date().toISOString();

    const ok = await db.updateRowById("CompetitorProducts", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Competitor product not found" });
    res.json({ ok: true, patch });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/competitor-products/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("CompetitorProducts", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clients", async (req, res) => {
  try {
    const { name, phone, tier, area, assignedRep, registrationNumber, address, coordsLat, coordsLng, discountRate, nameAr, type } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const resolvedAssignedRep = req.repName ? req.repName : (assignedRep || "");

    // A GPS fix taken on-site is more accurate than geocoding a typed
    // address, so it wins whenever the rep captured one.
    const coords = coordsLat && coordsLng ? { lat: coordsLat, lng: coordsLng } : await geocodeAddress(address);

    const client = {
      id: `c${crypto.randomUUID()}`,
      name,
      phone: phone || "",
      tier: tier || "B",
      area: area || "",
      assignedRep: resolvedAssignedRep,
      registrationNumber: registrationNumber || "",
      address: address || "",
      coordsLat: coords ? coords.lat : "",
      coordsLng: coords ? coords.lng : "",
      discountRate: discountRate || "",
      nameAr: nameAr || "",
      // "pharmacy" is the default for both new rows with no type sent and
      // every pre-existing row (blank cell) — supplement stores are the
      // only other value, kept in the same table/routes/order-flow so they
      // get everything a pharmacy gets (orders, offers, discount, GPS
      // check-in) for free, just filtered into their own tab and Check-In
      // toggle by this field.
      type: type === "supplement_store" ? "supplement_store" : "pharmacy",
    };
    await db.appendRow("Clients", client);
    res.json(client);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/clients/:id", requireManager, async (req, res) => {
  try {
    const patch = {};
    if (req.body.assignedRep !== undefined) patch.assignedRep = req.body.assignedRep;
    if (req.body.discountRate !== undefined) patch.discountRate = req.body.discountRate;
    if (req.body.nameAr !== undefined) patch.nameAr = req.body.nameAr;
    const ok = await db.updateRowById("Clients", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Client not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Rep-accessible, but deliberately narrow: only fills in fields that are
// currently blank. A rep filling gaps in an existing record (phone,
// address, registration number) is fine; overwriting something a manager
// already entered is not — that still goes through the manager-only PATCH
// above.
const CLIENT_FILLABLE_FIELDS = ["phone", "address", "registrationNumber", "area", "nameAr"];
app.patch("/api/clients/:id/complete-info", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const clients = await db.getAllRows("Clients");
    const existing = clients.find((c) => c.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Client not found" });
    const patch = {};
    for (const field of CLIENT_FILLABLE_FIELDS) {
      if (!existing[field] && req.body[field]) patch[field] = String(req.body[field]).trim();
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing new to add." });
    await db.updateRowById("Clients", existing.id, patch);
    res.json({ ok: true, patch });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const DOCTOR_FILLABLE_FIELDS = ["phone", "address", "registrationNumber", "area", "hospital", "specialty"];
app.patch("/api/doctors/:id/complete-info", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const doctors = await db.getAllRows("Doctors");
    const existing = doctors.find((d) => d.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Doctor not found" });
    const patch = {};
    for (const field of DOCTOR_FILLABLE_FIELDS) {
      if (!existing[field] && req.body[field]) patch[field] = String(req.body[field]).trim();
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing new to add." });
    await db.updateRowById("Doctors", existing.id, patch);
    res.json({ ok: true, patch });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reps", requireManager, async (req, res) => {
  try {
    const reps = await db.getAllRows("Reps");
    res.json(reps.map((r) => ({
      id: r.id, name: r.name, passcode: r.passcode, email: r.email || "", exportSheetId: r.exportSheetId || "",
      telegramLinked: Boolean(r.telegramChatId), isSupervisor: r.isSupervisor === "true",
      supplementStoresOnly: r.supplementStoresOnly === "true",
      medRepOnly: r.medRepOnly === "true",
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reps", requireManager, async (req, res) => {
  try {
    const { name, passcode, email } = req.body;
    if (!name || !passcode || !email) return res.status(400).json({ error: "name, passcode, and email are required" });
    let exportSheetId = "";
    try {
      exportSheetId = await db.createRepExportSheet(name.trim(), email.trim());
    } catch (e) {
      console.error("Couldn't create visits export sheet", e.message);
    }
    const rep = { id: `rep${crypto.randomUUID()}`, name: name.trim(), passcode, email: email.trim(), exportSheetId, isSupervisor: "false" };
    await db.appendRow("Reps", rep);
    res.json(rep);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/reps/:id", requireManager, async (req, res) => {
  try {
    const patch = {};
    if (req.body.email !== undefined) patch.email = req.body.email.trim();
    if (req.body.isSupervisor !== undefined) patch.isSupervisor = req.body.isSupervisor ? "true" : "false";
    // Mutually exclusive — a rep restricted to supplement stores only can't
    // also be restricted to doctors only, since that would leave nothing
    // they're allowed to visit. Turning one on clears the other.
    if (req.body.supplementStoresOnly !== undefined) {
      patch.supplementStoresOnly = req.body.supplementStoresOnly ? "true" : "false";
      if (req.body.supplementStoresOnly) patch.medRepOnly = "false";
    }
    if (req.body.medRepOnly !== undefined) {
      patch.medRepOnly = req.body.medRepOnly ? "true" : "false";
      if (req.body.medRepOnly) patch.supplementStoresOnly = "false";
    }
    const ok = await db.updateRowById("Reps", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Rep not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// No requireManager here — reps need to check their own link status too.
// Nothing returned is sensitive: a boolean or two and the bot's public username.
app.get("/api/telegram/status", async (req, res) => {
  try {
    const configured = telegram.isConfigured();
    if (!configured) return res.json({ configured: false });
    const settings = await db.getSettings();
    const result = { configured, botUsername: telegramBotUsername || "", managerLinked: Boolean(settings.managerTelegramChatId) };
    if (req.repName) {
      const reps = await db.getAllRows("Reps");
      const rep = reps.find((r) => r.name === req.repName);
      result.repLinked = Boolean(rep?.telegramChatId);
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Lets a rep generate their own link code, unlike the manager-only
// /api/reps/:id/telegram-link-code — a rep doesn't have (and shouldn't need)
// their own Reps row's internal id.
app.post("/api/reps/me/telegram-link-code", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    if (!telegram.isConfigured()) return res.status(400).json({ error: "Telegram isn't configured on the server yet." });
    const reps = await db.getAllRows("Reps");
    const rep = reps.find((r) => r.name === req.repName);
    if (!rep) return res.status(404).json({ error: "Rep not found" });
    const code = crypto.randomBytes(4).toString("hex");
    await db.updateRowById("Reps", rep.id, { telegramLinkCode: code });
    res.json({ code, botUsername: telegramBotUsername });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/telegram/send-digest-now", requireManager, async (req, res) => {
  try {
    if (!telegram.isConfigured()) return res.status(400).json({ error: "Telegram isn't configured on the server yet." });
    const settings = await db.getSettings();
    if (!settings.managerTelegramChatId) return res.status(400).json({ error: "Link your own Telegram first." });
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    await runMonthlyDigest(thisMonth);
    await db.setSettings({ lastMonthlyDigestMonth: thisMonth });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reps/:id/telegram-link-code", requireManager, async (req, res) => {
  try {
    if (!telegram.isConfigured()) return res.status(400).json({ error: "Telegram isn't configured on the server yet." });
    const code = crypto.randomBytes(4).toString("hex");
    const ok = await db.updateRowById("Reps", req.params.id, { telegramLinkCode: code });
    if (!ok) return res.status(404).json({ error: "Rep not found" });
    res.json({ code, botUsername: telegramBotUsername });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings/telegram-link-code", requireManager, async (req, res) => {
  try {
    if (!telegram.isConfigured()) return res.status(400).json({ error: "Telegram isn't configured on the server yet." });
    const code = crypto.randomBytes(4).toString("hex");
    await db.setSettings({ managerTelegramLinkCode: code });
    res.json({ code, botUsername: telegramBotUsername });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reps/:id/create-export-sheet", requireManager, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });
    const reps = await db.getAllRows("Reps");
    const rep = reps.find((r) => r.id === req.params.id);
    if (!rep) return res.status(404).json({ error: "Rep not found" });
    // Save the email first so it isn't lost if sheet creation below fails.
    await db.updateRowById("Reps", req.params.id, { email: email.trim() });
    const exportSheetId = await db.createRepExportSheet(rep.name, email.trim());
    await db.updateRowById("Reps", req.params.id, { exportSheetId });
    res.json({ ok: true, exportSheetId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reps/me/export-sheet", async (req, res) => {
  try {
    if (!req.repName) return res.json({ exportSheetId: "" });
    const reps = await db.getAllRows("Reps");
    const rep = reps.find((r) => r.name === req.repName);
    res.json({ exportSheetId: rep?.exportSheetId || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/reps/:id", requireManager, async (req, res) => {
  try {
    await db.deleteRowById("Reps", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clients/import-bulk", requireManager, async (req, res) => {
  try {
    const { toAdd, type } = req.body;
    const addList = Array.isArray(toAdd) ? toAdd : [];
    // One import batch is always one category — an Excel file of supplement
    // stores has no per-row "type" column to map, so this applies to the
    // whole batch rather than being read per row.
    const resolvedType = type === "supplement_store" ? "supplement_store" : "pharmacy";

    // Dedup authoritatively here, not just in the browser — the client's
    // "existing pharmacies" copy is a snapshot that can lag behind (loaded
    // once per session, not polled), and multiple managers can import
    // overlapping files around the same time. Guards against both the
    // already-in-the-sheet case and duplicates within this same submitted
    // chunk.
    const existing = await db.getAllRows("Clients");
    const existingNames = new Set(existing.map((c) => c.name.toLowerCase().trim()));
    const seenInRequest = new Set();

    const newClients = [];
    let skipped = 0;
    addList.filter((c) => c.name).forEach((c) => {
      const key = String(c.name).toLowerCase().trim();
      if (existingNames.has(key) || seenInRequest.has(key)) { skipped++; return; }
      seenInRequest.add(key);
      newClients.push({
        id: `c${crypto.randomUUID()}`,
        name: String(c.name).trim(),
        phone: c.phone || "",
        tier: c.tier || "B",
        area: c.area || "",
        assignedRep: c.assignedRep || "",
        registrationNumber: c.registrationNumber || "",
        address: c.address || "",
        nameAr: c.nameAr || "",
        type: resolvedType,
      });
    });

    if (newClients.length > 0) await db.appendRows("Clients", newClients);

    res.json({ ok: true, added: newClients.length, skipped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/clients/:id", async (req, res) => {
  try {
    await db.deleteRowById("Clients", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ClientsView shows nothing until a rep searches, then needs last-visit
// (for the overdue badge) and total collected revenue for each matched
// pharmacy. Rather than N separate requests per visible row (or shipping
// the whole Visits/Orders history to the client just to derive this),
// the view sends the names it's currently showing and gets back one
// small, computed map — a single full Visits+Orders scan server-side,
// same cost as before, but the response is only as big as the search.
app.post("/api/clients/visit-stats", async (req, res) => {
  try {
    const names = Array.isArray(req.body.names) ? req.body.names.map((n) => String(n).toLowerCase().trim()) : [];
    if (names.length === 0) return res.json({ stats: {} });
    const nameSet = new Set(names);
    const [visitRows, orderRows] = await Promise.all([db.getAllRows("Visits"), db.getAllRows("Orders")]);
    const stats = {};
    names.forEach((n) => { stats[n] = { lastVisit: null, revenue: 0 }; });
    visitRows.forEach((v) => {
      const key = String(v.client || "").toLowerCase().trim();
      if (!nameSet.has(key)) return;
      if (!stats[key].lastVisit || new Date(v.time) > new Date(stats[key].lastVisit)) stats[key].lastVisit = v.time;
    });
    orderRows.forEach((o) => {
      const key = String(o.clientName || "").toLowerCase().trim();
      if (!nameSet.has(key)) return;
      const total = Number(o.total) || 0;
      const netTotal = o.netTotal !== "" && o.netTotal !== undefined ? Number(o.netTotal) : total;
      stats[key].revenue += netTotal;
    });
    res.json({ stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/doctors", async (req, res) => {
  try {
    const { name, hospital, area, phone, specialty, tier, registrationNumber, address, coordsLat, coordsLng } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const coords = coordsLat && coordsLng ? { lat: coordsLat, lng: coordsLng } : await geocodeAddress(address);
    const doctor = {
      id: `doc${crypto.randomUUID()}`,
      name,
      hospital: hospital || "",
      area: area || "",
      phone: phone || "",
      specialty: specialty || "",
      tier: tier || "B",
      registrationNumber: registrationNumber || "",
      address: address || "",
      coordsLat: coords ? coords.lat : "",
      coordsLng: coords ? coords.lng : "",
    };
    await db.appendRow("Doctors", doctor);
    res.json(doctor);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/doctors/import-bulk", requireManager, async (req, res) => {
  try {
    const { toAdd } = req.body;
    const addList = Array.isArray(toAdd) ? toAdd : [];

    // See the matching comment in /api/clients/import-bulk — dedup must be
    // authoritative here, not just in the browser's (possibly stale) copy.
    const existing = await db.getAllRows("Doctors");
    const existingNames = new Set(existing.map((d) => d.name.toLowerCase().trim()));
    const seenInRequest = new Set();

    const newDoctors = [];
    let skipped = 0;
    addList.filter((d) => d.name).forEach((d) => {
      const key = String(d.name).toLowerCase().trim();
      if (existingNames.has(key) || seenInRequest.has(key)) { skipped++; return; }
      seenInRequest.add(key);
      newDoctors.push({
        id: `doc${crypto.randomUUID()}`,
        name: String(d.name).trim(),
        hospital: d.hospital || "",
        area: d.area || "",
        phone: d.phone || "",
        specialty: d.specialty || "",
        tier: d.tier || "B",
        registrationNumber: d.registrationNumber || "",
        address: d.address || "",
      });
    });

    if (newDoctors.length > 0) await db.appendRows("Doctors", newDoctors);

    res.json({ ok: true, added: newDoctors.length, skipped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/doctors/:id", async (req, res) => {
  try {
    await db.deleteRowById("Doctors", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Same idea as /api/clients/visit-stats: DoctorsView needs last-visit and
// the "give next visit" sample badge per doctor currently on screen, in one
// scan instead of one request per row.
app.post("/api/doctors/visit-stats", async (req, res) => {
  try {
    const names = Array.isArray(req.body.names) ? req.body.names.map((n) => String(n).toLowerCase().trim()) : [];
    if (names.length === 0) return res.json({ stats: {} });
    const nameSet = new Set(names);
    const [visitRows, sampleRows] = await Promise.all([db.getAllRows("Visits"), db.getAllRows("Samples")]);
    const stats = {};
    names.forEach((n) => { stats[n] = { lastVisit: null, pendingSamples: [] }; });
    visitRows.forEach((v) => {
      const key = String(v.client || "").toLowerCase().trim();
      if (!nameSet.has(key)) return;
      if (!stats[key].lastVisit || new Date(v.time) > new Date(stats[key].lastVisit)) stats[key].lastVisit = v.time;
    });
    const latestByDoctorProduct = new Map();
    sampleRows.forEach((s) => {
      const key = String(s.doctorName || "").toLowerCase().trim();
      if (!nameSet.has(key)) return;
      const mapKey = `${key}::${s.productId}`;
      const existing = latestByDoctorProduct.get(mapKey);
      if (!existing || new Date(s.date) > new Date(existing.date)) latestByDoctorProduct.set(mapKey, s);
    });
    latestByDoctorProduct.forEach((s) => {
      if (s.status !== "next_visit") return;
      const key = String(s.doctorName || "").toLowerCase().trim();
      stats[key].pendingSamples.push({ productName: s.productName });
    });
    res.json({ stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Per-entity visit cadence — total visits, when last, and the average gap
// between visits — the numbers behind "am I visiting this pharmacy/doctor
// too often or not enough." Deliberately hands back raw numbers rather than
// an "overdue" verdict: Pharmacies/Doctors already compute that client-side
// from TIER_CADENCE (helpers.js), so this stays the one source of truth
// rather than a second, possibly-drifting copy of that logic.
//
// Scope: manager/supervisor gets every entity across the whole team; a
// plain rep gets only their own — anything they've personally logged a
// visit to, plus any pharmacy assigned to them (even one they haven't
// visited yet, since "never visited" is exactly the kind of gap this is
// for). Doctors have no assignedRep field, so a rep's doctor list here is
// visit-history-only.
app.get("/api/visit-cadence", async (req, res) => {
  try {
    const isTeamWide = req.role === "manager" || req.isSupervisor;
    if (!isTeamWide && !req.repName) return res.status(403).json({ error: "Reps only." });

    const [visitRows, followUpRows, clients, doctors] = await Promise.all([
      db.getAllRows("Visits"),
      db.getAllRows("FollowUps"),
      db.getAllRows("Clients"),
      db.getAllRows("Doctors"),
    ]);

    const visitsByEntity = new Map(); // key -> { name, times: [] }
    visitRows.forEach((v) => {
      if (!isTeamWide && v.repName !== req.repName) return;
      const key = String(v.client || "").toLowerCase().trim();
      if (!key) return;
      if (!visitsByEntity.has(key)) visitsByEntity.set(key, { name: v.client, times: [] });
      visitsByEntity.get(key).times.push(v.time);
    });

    // Latest "stopped" event per entity, only counted if nothing has been
    // visited since — a later visit means the rep resumed, so it reads as
    // active again rather than stuck showing a stale stop reason forever.
    const stopByEntity = new Map();
    followUpRows.filter((f) => f.status === "stopped").forEach((f) => {
      const key = String(f.entityName || "").toLowerCase().trim();
      const existing = stopByEntity.get(key);
      if (!existing || new Date(f.createdAt) > new Date(existing.createdAt)) stopByEntity.set(key, f);
    });

    const entities = new Map(); // key -> { name, type, assignedRep, tier }
    visitsByEntity.forEach((v, key) => {
      const client = clients.find((c) => c.name.toLowerCase().trim() === key);
      const doctor = !client && doctors.find((d) => d.name.toLowerCase().trim() === key);
      entities.set(key, {
        name: v.name,
        type: client ? "pharmacy" : doctor ? "doctor" : "pharmacy",
        assignedRep: client?.assignedRep || "",
        tier: client?.tier || doctor?.tier || "",
      });
    });
    clients.forEach((c) => {
      if (!isTeamWide && c.assignedRep !== req.repName) return;
      const key = c.name.toLowerCase().trim();
      if (!entities.has(key)) entities.set(key, { name: c.name, type: "pharmacy", assignedRep: c.assignedRep || "", tier: c.tier || "" });
    });
    if (isTeamWide) {
      doctors.forEach((d) => {
        const key = d.name.toLowerCase().trim();
        if (!entities.has(key)) entities.set(key, { name: d.name, type: "doctor", assignedRep: "", tier: d.tier || "" });
      });
    }

    const cadence = [...entities.entries()].map(([key, info]) => {
      const times = (visitsByEntity.get(key)?.times || []).slice().sort((a, b) => new Date(a) - new Date(b));
      const totalVisits = times.length;
      const firstVisit = totalVisits ? times[0] : null;
      const lastVisit = totalVisits ? times[times.length - 1] : null;
      let avgDaysBetweenVisits = null;
      if (totalVisits >= 2) {
        const spanDays = (new Date(lastVisit) - new Date(firstVisit)) / 86400000;
        avgDaysBetweenVisits = Math.round((spanDays / (totalVisits - 1)) * 10) / 10;
      }
      const stop = stopByEntity.get(key);
      const stopped = !!stop && (!lastVisit || new Date(stop.createdAt) > new Date(lastVisit));
      return {
        entityName: info.name,
        entityType: info.type,
        tier: info.tier,
        assignedRep: info.assignedRep,
        totalVisits,
        firstVisit,
        lastVisit,
        avgDaysBetweenVisits,
        stopped,
        stopReason: stopped ? (stop.stopReason || "") : "",
        stopDate: stopped ? stop.createdAt : "",
      };
    });

    res.json({ cadence });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/outreach-log", async (req, res) => {
  try {
    const { name, date, templateIndex } = req.body;
    const entry = {
      id: `o${crypto.randomUUID()}`,
      name: name || "Unnamed",
      date: date || new Date().toISOString().slice(0, 10),
      templateIndex: templateIndex ?? 0,
    };
    await db.appendRow("OutreachLog", entry);
    res.json(entry);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/settings", async (req, res) => {
  try {
    const patch = { ...req.body };
    if (patch.templates) patch.templates = JSON.stringify(patch.templates);
    await db.setSettings(patch);
    const raw = await db.getSettings();
    res.json(parseSettings(raw));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Recall (medical rep training/knowledge-reference module) ----------
// Structure only — no clinical content ships here. Recall sits on top of
// ProductCatalog (the master product list); it never duplicates it or
// touches Products/Stock. See server/sheetsDb.js for the new tabs' schemas.

// Fixed, stable slug ids — not auto-incrementing row numbers — so a category
// can be referenced safely from RepCategoryAssignments/RecallIngredients
// even if rows get reordered in the sheet.
const RECALL_CATEGORIES_SEED = [
  { id: "b-vitamins-b12", name: "B Vitamins / B12" },
  { id: "vitamin-d", name: "Vitamin D" },
  { id: "vitamin-c", name: "Vitamin C" },
  { id: "magnesium", name: "Magnesium" },
  { id: "calcium", name: "Calcium" },
  { id: "iron", name: "Iron" },
  { id: "zinc", name: "Zinc" },
  { id: "omega-3", name: "Omega-3" },
  { id: "coq10", name: "CoQ10" },
  { id: "multivitamins", name: "Multivitamins" },
  { id: "probiotics", name: "Probiotics" },
  { id: "collagen", name: "Collagen" },
  { id: "hair-skin-nails", name: "Hair / Skin / Nails" },
  { id: "joint-bone-mobility", name: "Joint / Bone / Mobility" },
  { id: "immune-support", name: "Immune Support" },
  { id: "womens-health", name: "Women's Health" },
  { id: "mens-health", name: "Men's Health" },
  { id: "heart-cardiovascular", name: "Heart / Cardiovascular" },
  { id: "digestive-gut-health", name: "Digestive / Gut Health" },
  { id: "liver-detox-metabolic", name: "Liver / Detox / Metabolic" },
  { id: "weight-management", name: "Weight Management" },
  { id: "sports-nutrition-performance", name: "Sports Nutrition & Performance" },
  { id: "sleep-stress-mood", name: "Sleep / Stress / Mood" },
  { id: "eye-health-vision", name: "Eye Health & Vision" },
  { id: "brain-cognitive-health-memory", name: "Brain / Cognitive Health & Memory" },
  { id: "respiratory-allergy-seasonal-support", name: "Respiratory / Allergy / Seasonal Support" },
];

// Idempotent — checks before inserting, per the "no duplicates" rule. Runs
// on first request rather than at deploy time, since this dev environment
// has no credentials to write to the real production Sheet directly; this
// makes the real deploy self-seed the first time anyone opens Recall.
let recallCategoriesSeedChecked = false;
async function ensureRecallCategoriesSeeded() {
  if (recallCategoriesSeedChecked) return;
  const existing = await db.getAllRows("RecallCategories");
  const existingIds = new Set(existing.map((c) => c.id));
  const missing = RECALL_CATEGORIES_SEED.filter((c) => !existingIds.has(c.id));
  if (missing.length) {
    await db.appendRows("RecallCategories", missing.map((c, i) => ({
      id: c.id, name: c.name, description: "", displayOrder: existing.length + i + 1, active: "true",
    })));
  }
  recallCategoriesSeedChecked = true;
}

// Taxonomy values only — how a product is administered, not clinical
// content. Deliberately NOT auto-assigned to any existing product: a
// product's dosage form must eventually trace to a label/manufacturer/
// retailer source, so until that's entered explicitly it stays NOT
// VERIFIED rather than guessed from the product name.
const RECALL_DOSAGE_FORMS_SEED = [
  "Tablet", "Capsule", "Softgel", "Chewable", "Gummy", "Lozenge", "Quick-Dissolve", "Sublingual",
  "Effervescent", "Powder", "Sachet", "Liquid", "Syrup", "Drop", "Spray", "Oral Solution", "Injection",
  "Intramuscular", "Intravenous", "Topical", "Cream", "Gel", "Patch",
].map((name) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""), name }));

let recallDosageFormsSeedChecked = false;
async function ensureRecallDosageFormsSeeded() {
  if (recallDosageFormsSeedChecked) return;
  const existing = await db.getAllRows("RecallDosageForms");
  const existingIds = new Set(existing.map((f) => f.id));
  const missing = RECALL_DOSAGE_FORMS_SEED.filter((f) => !existingIds.has(f.id));
  if (missing.length) {
    // route/releaseType/administrationMethod/description are left blank —
    // only the name was given; nothing about route or release mechanism
    // should be inferred without a source.
    await db.appendRows("RecallDosageForms", missing.map((f) => ({
      id: f.id, name: f.name, route: "", releaseType: "", administrationMethod: "", description: "",
    })));
  }
  recallDosageFormsSeedChecked = true;
}

app.get("/api/recall/dosage-forms", async (req, res) => {
  try {
    await ensureRecallDosageFormsSeeded();
    const forms = await db.getAllRows("RecallDosageForms");
    res.json({ dosageForms: forms.map((f) => ({ id: f.id, name: f.name })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- B12 vertical slice (Recall Phase 2) ----------
// The FIRST real Recall content. Populated only with what was explicitly
// given (named sources, named rules/claims) — never with plausible-sounding
// textbook detail the user didn't state, even where such detail is common
// knowledge. Several evidence topics below are intentionally left with an
// empty `result` and evidenceLevel "NOT_VERIFIED": the user named these as
// topics to cover, but their actual content lives in source documents
// (the NIH ODS fact sheet, NICE NG239) this server cannot fetch — see the
// implementation report for the full list of what's populated vs. pending.
const B12_SOURCES_SEED = [
  {
    id: "src-nih-ods-b12", sourceType: "NIH", sourceName: "NIH Office of Dietary Supplements",
    title: "Vitamin B12 Fact Sheet for Health Professionals",
    url: "https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/",
    sourceQuality: "Government health authority fact sheet",
    notes: "Source URL as given; content used here is limited to what was explicitly stated in the request, not independently re-fetched.",
  },
  {
    id: "src-nice-ng239", sourceType: "Clinical guideline", sourceName: "NICE",
    title: "Vitamin B12 deficiency in over 16s (NG239)",
    url: "https://www.nice.org.uk/guidance/ng239",
    sourceQuality: "National clinical guideline",
    notes: "Named as a core source; no specific guideline recommendation from it has been transcribed here yet.",
  },
  {
    id: "src-pmid-29543316", sourceType: "Systematic review (Cochrane)", sourceName: "Cochrane",
    title: "Oral vitamin B12 versus intramuscular vitamin B12 for vitamin B12 deficiency",
    pmid: "29543316", url: "https://pubmed.ncbi.nlm.nih.gov/29543316/",
    sourceQuality: "Cochrane systematic review",
    notes: "PMID as given by the requester. URL mechanically derived from the standard PubMed URL pattern for this PMID, not independently fetched/verified in this session.",
  },
  {
    id: "src-pmid-14616423", sourceType: "Study", sourceName: "PubMed",
    title: "Sublingual versus oral vitamin B12",
    pmid: "14616423", url: "https://pubmed.ncbi.nlm.nih.gov/14616423/",
    sourceQuality: "Not specified by requester",
    notes: "PMID as given by the requester. URL mechanically derived from the standard PubMed URL pattern for this PMID, not independently fetched/verified in this session.",
  },
  {
    id: "src-repknowledge-drug-nutrient", sourceType: "Internal reference", sourceName: "KayBee reference content",
    title: "Drug & Nutrient Depletion data (client/src/repKnowledge.js)",
    url: "", sourceQuality: "Existing in-app reference, not independently re-verified in this phase",
    notes: "Already-existing content in this app, reused rather than duplicated per the 'connect to the existing Drug-Nutrient Interaction architecture' instruction.",
  },
];

// Evidence-level assignment methodology (not specified by the requester,
// so applied here using a standard, disclosed convention rather than left
// to guesswork): Cochrane systematic review = A; guideline/fact-sheet
// synthesis and single studies of unstated design = B. Flagged in the
// implementation report for review/override.
const B12_EVIDENCE_SEED = [
  { topic: "A. What vitamin B12 is", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "Vitamin B12 (cobalamin) is a water-soluble vitamin required for red blood cell formation, neurological function, and DNA synthesis." },
  { topic: "B. Cyanocobalamin", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "Cyanocobalamin is a synthetic form of B12 commonly used in supplements and fortified foods; the body converts it into the metabolically active coenzyme forms." },
  { topic: "C. Methylcobalamin", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "Methylcobalamin is one of the two metabolically active coenzyme forms of vitamin B12." },
  { topic: "D. Hydroxocobalamin", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "Hydroxocobalamin is a form of B12 that the body converts into the metabolically active coenzyme forms." },
  { topic: "E. Adenosylcobalamin", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "Adenosylcobalamin (5-deoxyadenosylcobalamin) is one of the two metabolically active coenzyme forms of vitamin B12." },
  { topic: "F. Oral B12 absorption", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
  { topic: "G. High-dose oral B12 and passive diffusion", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    result: "High-dose oral vitamin B12 can still be absorbed through passive diffusion even when intrinsic-factor-mediated absorption is limited." },
  { topic: "H. Oral vs sublingual/quick-dissolve", sourceId: "src-nih-ods-b12", evidenceLevel: "B",
    comparator: "Oral vs. sublingual/quick-dissolve B12",
    result: "Current evidence has not established that supplemental B12 form (e.g., sublingual/quick-dissolve vs. oral) changes efficacy." },
  { topic: "H. Oral vs sublingual/quick-dissolve", sourceId: "src-pmid-14616423", evidenceLevel: "B",
    comparator: "Oral vs. sublingual B12", studyType: "Clinical study",
    result: "Cited comparative study of sublingual vs. oral B12 replacement, consistent with no established efficacy advantage for either route." },
  { topic: "I. Oral vs intramuscular B12", sourceId: "src-pmid-29543316", evidenceLevel: "A", studyType: "Systematic review",
    comparator: "Oral vs. intramuscular B12",
    result: "Cochrane systematic review comparing oral and intramuscular vitamin B12 for treating B12 deficiency. Route selection should account for clinical context (cause of deficiency, malabsorption, surgical history, severity, neurological involvement) rather than assuming the two are universally interchangeable." },
  { topic: "J. B12 deficiency", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
  { topic: "K. Causes of B12 deficiency", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
  { topic: "L. Malabsorption", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
  { topic: "M. Metformin and B12", sourceId: "src-repknowledge-drug-nutrient", evidenceLevel: "B",
    result: "Existing KayBee reference content lists Vitamin B12 among nutrients depleted by oral hypoglycemic (diabetes) medication." },
  { topic: "N. Acid-suppressing medicines and B12", sourceId: "src-repknowledge-drug-nutrient", evidenceLevel: "B",
    result: "Existing KayBee reference content: H2 antagonists deplete vitamin B12 (along with calcium, folic acid, iron, vitamin D); proton-pump inhibitors deplete vitamin B12 (along with magnesium)." },
  { topic: "O. Neurological manifestations of deficiency", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
  { topic: "P. Hematological manifestations of deficiency", sourceId: "src-nih-ods-b12", evidenceLevel: "NOT_VERIFIED", result: "" },
];

const B12_INTERACTIONS_SEED = [
  {
    drugName: "Metformin", drugClass: "Biguanide (oral hypoglycemic)", direction: "depletes",
    clinicalSignificance: "Associated with reduced vitamin B12 status with long-term use.",
    evidenceLevel: "B", sourceId: "src-repknowledge-drug-nutrient",
    pharmacistCheckpoint: "Consider B12 status with long-term metformin use.",
  },
  {
    drugName: "Proton pump inhibitors (PPIs)", drugClass: "Acid-suppressing medication", direction: "depletes",
    clinicalSignificance: "Reduced gastric acid may impair release of B12 from food/protein, lowering B12 status.",
    evidenceLevel: "B", sourceId: "src-repknowledge-drug-nutrient",
    pharmacistCheckpoint: "Consider B12 status with long-term PPI use.",
  },
  {
    drugName: "H2-receptor antagonists", drugClass: "Acid-suppressing medication", direction: "depletes",
    clinicalSignificance: "Reduced gastric acid may impair release of B12 from food/protein, lowering B12 status.",
    evidenceLevel: "B", sourceId: "src-repknowledge-drug-nutrient",
    pharmacistCheckpoint: "Consider B12 status with long-term H2-antagonist use.",
  },
];

const B12_QUIZ_SEED = [
  {
    question: "Which of the following is a metabolically active B12 form?",
    optionA: "Methylcobalamin", optionB: "Sodium ascorbate", optionC: "Calcium carbonate", optionD: "Folic acid",
    correctAnswer: "A",
    explanation: "Methylcobalamin (and adenosylcobalamin) are the metabolically active coenzyme forms of B12; cyanocobalamin and hydroxocobalamin are converted by the body into these active forms.",
    sourceIds: "src-nih-ods-b12",
  },
  {
    question: "Is methylcobalamin proven to have superior absorption compared with cyanocobalamin?",
    optionA: "Yes, always", optionB: "No — current evidence has not established a difference", optionC: "Only at high doses", optionD: "Only sublingually",
    correctAnswer: "B",
    explanation: "NIH ODS states there is no evidence that absorption rates of supplemental B12 differ by form.",
    sourceIds: "src-nih-ods-b12",
  },
  {
    question: "Is sublingual B12 proven more effective than oral B12?",
    optionA: "Yes", optionB: "No — evidence suggests no efficacy difference", optionC: "Only for deficiency", optionD: "Only quick-dissolve forms",
    correctAnswer: "B",
    explanation: "NIH ODS states evidence suggests no difference in efficacy between oral and sublingual B12.",
    sourceIds: "src-nih-ods-b12,src-pmid-14616423",
  },
  {
    question: "Why can high-dose oral B12 still be absorbed when intrinsic-factor-mediated absorption is impaired?",
    optionA: "It cannot be absorbed", optionB: "A small amount is absorbed through passive diffusion", optionC: "It converts to injectable form", optionD: "Stomach acid is not required",
    correctAnswer: "B",
    explanation: "A small amount of B12 can be absorbed through passive diffusion, independent of intrinsic factor, which is why high-dose oral B12 can still work even when intrinsic-factor-mediated absorption is limited.",
    sourceIds: "src-nih-ods-b12",
  },
];

let recallB12SeedChecked = false;
async function ensureRecallB12Seeded() {
  if (recallB12SeedChecked) return;
  const existing = await db.getAllRows("RecallIngredients");
  if (!existing.some((i) => i.id === "vitamin-b12")) {
    const sources = await db.getAllRows("RecallResearchSources");
    const existingSourceIds = new Set(sources.map((s) => s.id));
    const newSources = B12_SOURCES_SEED.filter((s) => !existingSourceIds.has(s.id));
    if (newSources.length) {
      await db.appendRows("RecallResearchSources", newSources.map((s) => ({
        id: s.id, sourceType: s.sourceType, sourceName: s.sourceName, title: s.title, authors: "", journal: "",
        pmid: s.pmid || "", pmcid: "", doi: "", url: s.url || "", publicationYear: "", sourceDate: "",
        sourceQuality: s.sourceQuality || "", notes: s.notes || "",
      })));
    }

    await db.appendRow("RecallIngredients", {
      id: "vitamin-b12", categoryId: "b-vitamins-b12", name: "Vitamin B12", commonName: "Cobalamin", scientificName: "",
      description: "Vitamin B12 (cobalamin) is a water-soluble vitamin required for red blood cell formation, neurological function, and DNA synthesis.",
      physiologicalRole: "Cofactor for enzymes involved in red blood cell formation, neurological function, and DNA synthesis.",
      clinicalUses: "Prevention and treatment of vitamin B12 deficiency.",
      evidenceSummary: "See linked Clinical Evidence records for topic-specific evidence; this field intentionally does not summarize into a single verdict.",
      evidenceLevel: "NOT_VERIFIED",
      precautions: "", contraindications: "", drugInteractionSummary: "See linked Drug Interactions.",
      clinicalCheckpoints: [
        "Is B12 deficiency documented or suspected?",
        "What is the suspected cause?",
        "Is the patient taking metformin?",
        "Is the patient taking a PPI or H2 blocker?",
        "Is malabsorption suspected?",
        "History of bariatric/gastric surgery?",
        "Neurological symptoms?",
        "Hematological findings?",
        "Dietary risk?",
      ].join("\n"),
      repQuickTakeaway: [
        "What is B12? A water-soluble vitamin needed for red blood cells, nerve function, and DNA synthesis.",
        "Major forms: cyanocobalamin, methylcobalamin, hydroxocobalamin, adenosylcobalamin — cyanocobalamin and hydroxocobalamin are converted by the body into the two active coenzyme forms (methylcobalamin, adenosylcobalamin).",
        "Cyanocobalamin vs methylcobalamin: different forms, not a better-vs-worse comparison — no established difference in absorption by form.",
        "Oral vs sublingual: evidence suggests no efficacy difference.",
        "Oral vs injection: route depends on clinical context (cause, malabsorption, severity, neurological involvement) — not universally interchangeable, but not automatically one-size-fits-all either.",
        "Why high-dose oral B12 can work: a small amount is absorbed via passive diffusion even without intrinsic factor.",
        "Medicines linked to lower B12 status: metformin, PPIs, H2-receptor antagonists.",
        "Before discussing B12: check for documented/suspected deficiency, cause, relevant medications, malabsorption risk, and symptoms — see Clinical Checkpoints.",
      ].join("\n"),
      whatNotToClaim: [
        "Do not claim methylcobalamin is universally better than cyanocobalamin.",
        "Do not claim methylcobalamin is proven to be better absorbed.",
        "Do not claim sublingual B12 is proven superior to oral B12.",
        "Do not claim higher-dose B12 is automatically more effective.",
        "Do not claim injections are always superior.",
        "Do not claim B12 gives energy to everyone.",
        "Do not claim B12 treats neuropathy regardless of deficiency status.",
        "Do not claim B12 prevents disease in people who are not deficient.",
      ].join("\n"),
      lastReviewed: new Date().toISOString().slice(0, 10),
    });

    await db.appendRows("RecallIngredientForms", [
      { id: "b12-form-cyanocobalamin", ingredientId: "vitamin-b12", formName: "Cyanocobalamin", chemicalName: "", formType: "chemical form",
        compoundAmount: "", activeAmount: "", unit: "", conversionRequired: "true",
        absorptionNotes: "", metabolicNotes: "Converted by the body into the metabolically active coenzyme forms.",
        clinicalEvidence: "", evidenceComparison: "No established difference in absorption vs. other supplemental B12 forms (NIH ODS).",
        documentedAdvantages: "", documentedLimitations: "", sourceIds: "src-nih-ods-b12", lastReviewed: new Date().toISOString().slice(0, 10) },
      { id: "b12-form-methylcobalamin", ingredientId: "vitamin-b12", formName: "Methylcobalamin", chemicalName: "", formType: "chemical form",
        compoundAmount: "", activeAmount: "", unit: "", conversionRequired: "false",
        absorptionNotes: "", metabolicNotes: "One of the two metabolically active coenzyme forms.",
        clinicalEvidence: "", evidenceComparison: "No established difference in absorption vs. other supplemental B12 forms (NIH ODS).",
        documentedAdvantages: "", documentedLimitations: "", sourceIds: "src-nih-ods-b12", lastReviewed: new Date().toISOString().slice(0, 10) },
      { id: "b12-form-hydroxocobalamin", ingredientId: "vitamin-b12", formName: "Hydroxocobalamin", chemicalName: "", formType: "chemical form",
        compoundAmount: "", activeAmount: "", unit: "", conversionRequired: "true",
        absorptionNotes: "", metabolicNotes: "Converted by the body into the metabolically active coenzyme forms.",
        clinicalEvidence: "", evidenceComparison: "No established difference in absorption vs. other supplemental B12 forms (NIH ODS).",
        documentedAdvantages: "", documentedLimitations: "", sourceIds: "src-nih-ods-b12", lastReviewed: new Date().toISOString().slice(0, 10) },
      { id: "b12-form-adenosylcobalamin", ingredientId: "vitamin-b12", formName: "Adenosylcobalamin", chemicalName: "5-Deoxyadenosylcobalamin", formType: "chemical form",
        compoundAmount: "", activeAmount: "", unit: "", conversionRequired: "false",
        absorptionNotes: "", metabolicNotes: "One of the two metabolically active coenzyme forms.",
        clinicalEvidence: "", evidenceComparison: "No established difference in absorption vs. other supplemental B12 forms (NIH ODS).",
        documentedAdvantages: "", documentedLimitations: "", sourceIds: "src-nih-ods-b12", lastReviewed: new Date().toISOString().slice(0, 10) },
    ]);

    await db.appendRows("RecallClinicalEvidence", B12_EVIDENCE_SEED.map((e) => ({
      id: `ce-b12-${crypto.randomUUID()}`, ingredientId: "vitamin-b12", productId: "", formId: "",
      condition: e.topic, population: "", intervention: "", dose: "", route: "", duration: "",
      comparator: e.comparator || "", outcome: "", result: e.result || "", clinicalSignificance: "",
      evidenceLevel: e.evidenceLevel, studyType: e.studyType || "", sourceId: e.sourceId,
      publicationYear: "", lastReviewed: new Date().toISOString().slice(0, 10),
    })));

    await db.appendRows("RecallDrugInteractions", B12_INTERACTIONS_SEED.map((i) => ({
      id: `di-b12-${crypto.randomUUID()}`, ingredientId: "vitamin-b12", drugName: i.drugName, drugClass: i.drugClass,
      direction: i.direction, mechanism: "", clinicalSignificance: i.clinicalSignificance, timing: "",
      evidenceLevel: i.evidenceLevel, pharmacistCheckpoint: i.pharmacistCheckpoint, sourceId: i.sourceId,
      lastReviewed: new Date().toISOString().slice(0, 10),
    })));

    await db.appendRows("RecallQuizQuestions", B12_QUIZ_SEED.map((q) => ({
      id: `qz-b12-${crypto.randomUUID()}`, categoryId: "b-vitamins-b12", ingredientId: "vitamin-b12",
      question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
      correctAnswer: q.correctAnswer, explanation: q.explanation, sourceIds: q.sourceIds, active: "true",
    })));
  }
  recallB12SeedChecked = true;
}

// ---------- B12 product data layer (Recall Phase 2C) ----------
// Populates the Mason/ALFA ("our products") and Lebanese-competitor B12
// product records using ONLY the facts given in the Phase 2C request. Any
// field not explicitly given is left blank on the record and named in that
// record's own missingFields list instead — never guessed. Matching against
// an existing record happens by NAME at request time (the same idempotent,
// self-healing pattern as every other Recall seed in this file), since this
// environment has no live Sheets credentials to look up a real existing ID
// directly; see the implementation report for that disclosed limitation.
const B12_OUR_PRODUCTS_SEED = [
  {
    matchName: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    catalog: {
      name: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
      price: 34, form: "Quick-Dissolve", packSize: 100, unitsPerDay: "",
      // Structured (not free text) so the general Settings -> Product
      // Catalog ingredients editor can display/edit it like any other
      // product's ingredients, not just show a blob of text.
      ingredients: JSON.stringify([{ name: "Vitamin B12 (Cyanocobalamin)", form: "", amount: 1000, unit: "mcg" }]),
      // Corrected from an earlier 31.12 figure once confirmed: that was the
      // pre-VAT price, and 34 is the real, tax-inclusive (TTC) selling
      // price — the same basis used for every other Mason/ALFA price in
      // this file, not a second disagreeing source.
      notes: "Price confirmed as 34 (TTC, VAT-inclusive) — matches the Mason/ALFA product list import. Administration: dissolves under the tongue, as explicitly stated.",
    },
    link: {
      chemicalForm: "Cyanocobalamin", compoundAmount: 1000, activeAmount: "", unit: "mcg",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "PARTIALLY_VERIFIED",
      notes: "Administration: dissolves under the tongue, as explicitly stated (not assumed from 'Quick-Dissolve' alone).",
      missingFields: "serving size, recommended daily use, complete ingredient list, exact manufacturer source URL, exact retailer source URL, SKU",
    },
  },
  {
    matchName: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
    catalog: {
      name: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
      price: 30.50, form: "Quick-Dissolve", packSize: 30, unitsPerDay: "",
      ingredients: JSON.stringify([{ name: "Vitamin B12 (Cyanocobalamin)", form: "", amount: 5000, unit: "mcg" }]),
      notes: "Price is a previously documented Lebanese price, pending re-verification. Administration: dissolves under the tongue, as explicitly stated.",
    },
    link: {
      chemicalForm: "Cyanocobalamin", compoundAmount: 5000, activeAmount: "", unit: "mcg",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "PARTIALLY_VERIFIED",
      notes: "Administration: dissolves under the tongue, as explicitly stated (not assumed from 'Quick-Dissolve' alone).",
      missingFields: "serving size, recommended daily use, complete ingredient list, exact source URL, SKU",
    },
  },
  {
    matchName: "Mason Natural Vitamin B12 500 mcg",
    catalog: {
      name: "Mason Natural Vitamin B12 500 mcg",
      price: 30.80, form: "Tablet", packSize: 100, unitsPerDay: "",
      // Calcium's amount is not verified — left blank rather than guessed;
      // it still appears as its own named ingredient row for a manager to
      // fill in once known, instead of being buried in free text.
      ingredients: JSON.stringify([
        { name: "Vitamin B12", form: "", amount: 500, unit: "mcg" },
        { name: "Calcium", form: "", amount: "", unit: "" },
      ]),
      notes: "Price is a previously documented price, pending re-verification. Chemical form is not verified — not assumed.",
    },
    link: {
      chemicalForm: "", compoundAmount: 500, activeAmount: "", unit: "mcg",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "PARTIALLY_VERIFIED",
      notes: "Includes calcium per previously documented product identity — a distinct SKU from the plain B12-only products above.",
      missingFields: "chemical form, serving size, recommended daily use, complete ingredients, exact source URL, SKU",
    },
  },
  {
    matchName: "Mason Natural Vitamin B12 100 mcg",
    catalog: {
      name: "Mason Natural Vitamin B12 100 mcg",
      price: 20.56, form: "Tablet", packSize: 100, unitsPerDay: "",
      ingredients: JSON.stringify([{ name: "Vitamin B12", form: "", amount: 100, unit: "mcg" }]),
      notes: "Price is a previously documented price, pending re-verification. Chemical form is not verified — not assumed.",
    },
    link: {
      chemicalForm: "", compoundAmount: 100, activeAmount: "", unit: "mcg",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "PARTIALLY_VERIFIED",
      notes: "",
      missingFields: "chemical form, serving size, recommended daily use, complete ingredients, exact source URL, SKU",
    },
  },
  {
    matchName: "ALFA B-Complex Formula",
    catalog: {
      name: "ALFA B-Complex Formula",
      price: 24.20, form: "Tablet", packSize: 100, unitsPerDay: 1,
      // Named ingredients only — amounts were never given and are not
      // guessed; each stays its own row (amount blank) for a manager to
      // fill in once verified.
      ingredients: JSON.stringify([
        "Thiamine", "Riboflavin", "Niacinamide", "Vitamin B6", "Folic Acid", "Vitamin B12", "Biotin", "Pantothenate",
      ].map((name) => ({ name, form: "", amount: "", unit: "" }))),
      notes: "Price is a previously documented Lebanese price, pending re-verification.",
    },
    link: {
      // B12 amount and chemical form must NOT be inferred for this product.
      chemicalForm: "", compoundAmount: "", activeAmount: "", unit: "",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "PARTIALLY_VERIFIED",
      notes: "B-complex formula; B12 is one of several listed ingredients.",
      missingFields: "B12 amount, B12 chemical form, complete ingredient amounts, dosage/release information if not verified, exact source URL, SKU if applicable",
    },
  },
];

const B12_COMPETITOR_PRODUCTS_SEED = [
  {
    competitorName: "Suplima", productName: "CoBalance-12",
    genericName: "Cyanocobalamin", form: "Tablet", dosage: "5,000 mcg", packSize: 30,
    notes: "Recommended use: 1 tablet/day.",
    missingFields: "complete ingredients, serving size if different from daily use, exact source URL, SKU",
    retailerListings: [{ retailer: "Nicolas Care", displayedPrice: 25, currency: "USD",
      notes: "Price previously documented. This product remains included even if the retailer page previously showed it as sold out/unavailable — availability is not tracked here." }],
    compareWith: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (5,000 mcg) and same chemical form (Cyanocobalamin) as Mason's 5,000 mcg product; dosage form (tablet) is not confirmed as Quick-Dissolve for this competitor product.",
  },
  {
    competitorName: "Green Made", productName: "Cobalin",
    genericName: "Methylcobalamin", form: "Capsule", dosage: "1,000 mcg", packSize: 30,
    notes: "Recommended use: 1-3 capsules/day.",
    missingFields: "complete ingredients, serving size, exact source URLs, SKU",
    retailerListings: [
      { retailer: "Sohati Care", displayedPrice: 12.45, currency: "USD", notes: "Price previously documented." },
      { retailer: "Nicolas Care", displayedPrice: "", currency: "", notes: "Previously identified on this retailer; price and source URL not verified in this research pass." },
    ],
    compareWith: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (1,000 mcg) as Mason's 1,000 mcg product; different chemical form (Methylcobalamin vs. Cyanocobalamin) and different dosage form (capsule vs. Quick-Dissolve tablet).",
  },
  {
    competitorName: "Citrelax", productName: "B Complete",
    genericName: "Methylcobalamin", form: "Capsule", dosage: "100 mcg", packSize: 30,
    notes: "Recommended use: 1 capsule/day.",
    missingFields: "complete ingredient list, serving size, exact source URL, SKU",
    retailerListings: [{ retailer: "Skin Society", displayedPrice: 17.85, currency: "USD", notes: "Price previously documented." }],
    compareWith: "Mason Natural Vitamin B12 100 mcg",
    comparisonNotes: "Same labeled B12 amount (100 mcg) as Mason's 100 mcg product; Mason's chemical form is not verified, so a chemical-form comparison isn't possible yet.",
  },
  {
    competitorName: "Tribion", productName: "Tribion (oral syrup)",
    genericName: "Cyanocobalamin", form: "Oral Solution", dosage: "1,000 mcg", packSize: "10 mL x 10 vials",
    notes: "Recommended use: 1 vial/day. Also contains folate 600 mcg as Quatrefolic.",
    missingFields: "retailer/source not specified, exact price, complete ingredient list, exact source URL, SKU",
    retailerListings: [],
    compareWith: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (1,000 mcg) and chemical form (Cyanocobalamin) as Mason's 1,000 mcg product; different dosage form (oral liquid vial vs. Quick-Dissolve tablet). Tribion also contains folate, which Mason's B12 product is not documented to contain.",
  },
  {
    competitorName: "Advancis", productName: "Neuro+",
    genericName: "", form: "Tablet", dosage: "", packSize: 30,
    notes: "Recommended use: 1 tablet at breakfast, may increase to 2/day.",
    missingFields: "B12 amount, B12 chemical form, complete ingredients, retailer/source not specified, exact source URL, SKU",
    retailerListings: [],
    compareWith: "ALFA B-Complex Formula",
    comparisonNotes: "Both are multi-ingredient formulas; B12 amount and chemical form are not yet verified for either product.",
  },
  {
    competitorName: "Sundown", productName: "Vitamin B12 1,000 mcg",
    genericName: "", form: "", dosage: "1,000 mcg", packSize: 120,
    notes: "",
    missingFields: "chemical form, dosage form, complete ingredients, serving size, recommended daily use, retailer/source not specified, exact source URL, SKU",
    retailerListings: [],
    compareWith: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (1,000 mcg) as Mason's 1,000 mcg product; Sundown's chemical form and dosage form are not verified, so no further comparison is possible yet.",
  },
  {
    competitorName: "NOW", productName: "B-12 5,000 mcg + Folic Acid",
    genericName: "Cyanocobalamin", form: "Lozenge", dosage: "5,000 mcg", packSize: 60,
    notes: "Recommended use: 1 lozenge/day. Also contains folic acid.",
    missingFields: "complete ingredient list, exact source URL, SKU",
    retailerListings: [{ retailer: "Nicolas Care", displayedPrice: 20, currency: "USD", notes: "Price previously documented." }],
    compareWith: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (5,000 mcg) and chemical form (Cyanocobalamin) as Mason's 5,000 mcg product; different dosage form (lozenge vs. Quick-Dissolve tablet). This product also contains folic acid, which Mason's B12 product is not documented to contain.",
  },
  {
    // Manufacturer-only reference: no Lebanese retailer listing has been
    // verified for this product, so per the Phase 2C instruction, no
    // RecallRetailerListings row is created for it (see retailerListings: []).
    competitorName: "NOW", productName: "Methyl B-12 5,000 mcg",
    genericName: "Methylcobalamin", form: "Lozenge", dosage: "5,000 mcg", packSize: "",
    notes: "No Lebanese retailer listing has been verified for this product — recorded as a manufacturer product reference only, not a Lebanese market listing.",
    missingFields: "pack size, complete ingredient list, Lebanese retailer listing (not yet verified), exact source URL, SKU",
    retailerListings: [],
    compareWith: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
    comparisonNotes: "Same labeled B12 amount (5,000 mcg) as Mason's 5,000 mcg product; different chemical form (Methylcobalamin vs. Cyanocobalamin).",
  },
];

let recallB12ProductDataSeedChecked = false;
async function ensureB12ProductDataSeeded() {
  if (recallB12ProductDataSeedChecked) return;
  const norm = (s) => String(s || "").trim().toLowerCase();

  // ---- Our products: match-or-create in ProductCatalog, then link ----
  const catalog = await db.getAllRows("ProductCatalog");
  const productIdByName = new Map(catalog.map((p) => [norm(p.name), p.id]));
  const newCatalogRows = [];
  const ourProductIds = new Map(); // matchName -> id

  for (const item of B12_OUR_PRODUCTS_SEED) {
    const existingId = productIdByName.get(norm(item.matchName));
    if (existingId) {
      ourProductIds.set(item.matchName, existingId);
    } else {
      const id = `pc${crypto.randomUUID()}`;
      newCatalogRows.push({
        id, name: item.catalog.name, price: item.catalog.price, form: item.catalog.form,
        packSize: item.catalog.packSize, unitsPerDay: item.catalog.unitsPerDay,
        ingredients: item.catalog.ingredients, notes: item.catalog.notes,
        createdBy: "Recall B12 product seed", createdAt: new Date().toISOString(), updatedBy: "", updatedAt: "",
      });
      ourProductIds.set(item.matchName, id);
    }
  }
  if (newCatalogRows.length) await db.appendRows("ProductCatalog", newCatalogRows);

  // Search for OTHER existing ALFA products that already contain B12 — per
  // instruction, match rather than invent additional ALFA products.
  // Best-effort name/ingredient text search; excludes the B-Complex product
  // already handled above.
  const alfaBComplexId = ourProductIds.get("ALFA B-Complex Formula");
  const otherAlfaB12 = catalog.filter((p) =>
    p.id !== alfaBComplexId && /alfa/i.test(p.name || "") && /\bb-?12\b|cobalamin/i.test(p.ingredients || "")
  );

  const productLinks = await db.getAllRows("RecallProductIngredients");
  const linkedProductIds = new Set(productLinks.filter((l) => l.ingredientId === "vitamin-b12").map((l) => l.productId));
  const newLinks = [];
  for (const item of B12_OUR_PRODUCTS_SEED) {
    const productId = ourProductIds.get(item.matchName);
    if (linkedProductIds.has(productId)) continue;
    newLinks.push({
      id: `pi-b12-${crypto.randomUUID()}`, productId, ingredientId: "vitamin-b12",
      chemicalForm: item.link.chemicalForm, compoundAmount: item.link.compoundAmount, activeAmount: item.link.activeAmount,
      unit: item.link.unit, servingSize: item.link.servingSize, dailyAmount: item.link.dailyAmount,
      amountBasis: item.link.amountBasis, sourceId: item.link.sourceId, verificationStatus: item.link.verificationStatus,
      notes: item.link.notes, missingFields: item.link.missingFields,
    });
  }
  for (const p of otherAlfaB12) {
    if (linkedProductIds.has(p.id)) continue;
    newLinks.push({
      id: `pi-b12-${crypto.randomUUID()}`, productId: p.id, ingredientId: "vitamin-b12",
      chemicalForm: "", compoundAmount: "", activeAmount: "", unit: "",
      servingSize: "", dailyAmount: "", amountBasis: "", sourceId: "", verificationStatus: "NOT_VERIFIED",
      notes: "Found via an existing-catalog search for other ALFA products containing B12; fields not independently re-verified in this phase.",
      missingFields: "B12 amount, B12 chemical form, serving size, recommended daily use, complete ingredients, exact source URL, SKU",
    });
  }
  if (newLinks.length) await db.appendRows("RecallProductIngredients", newLinks);

  // ---- Competitor products: match-or-create in CompetitorProducts ----
  const competitorProducts = await db.getAllRows("CompetitorProducts");
  const competitorIdByKey = new Map(competitorProducts.map((p) => [`${norm(p.competitorName)}|${norm(p.productName)}`, p.id]));
  const newCompetitorRows = [];
  const competitorIds = new Map(); // "brand|product" -> id

  for (const item of B12_COMPETITOR_PRODUCTS_SEED) {
    const key = `${norm(item.competitorName)}|${norm(item.productName)}`;
    const existingId = competitorIdByKey.get(key);
    if (existingId) {
      competitorIds.set(key, existingId);
    } else {
      const id = `cp${crypto.randomUUID()}`;
      const row = { id, createdAt: new Date().toISOString(), createdBy: "Recall B12 product seed", updatedBy: "", updatedAt: "" };
      for (const f of COMPETITOR_PRODUCT_FIELDS) row[f] = "";
      for (const f of COMPETITOR_PRODUCT_DETAIL_FIELDS) row[f] = "";
      row.competitorName = item.competitorName;
      row.productName = item.productName;
      row.genericName = item.genericName || "";
      row.form = item.form || "";
      row.dosage = item.dosage || "";
      row.packSize = item.packSize || "";
      // Price stays on the retailer listing, not the master product — see
      // Phase 2C rule 12 ("prices belong to retailer listings").
      row.price = "";
      row.notes = item.notes || "";
      row.researchStatus = "PARTIALLY_VERIFIED";
      row.missingFields = item.missingFields || "";
      newCompetitorRows.push(row);
      competitorIds.set(key, id);
    }
  }
  if (newCompetitorRows.length) await db.appendRows("CompetitorProducts", newCompetitorRows);

  // ---- Retailer listings: one row per (competitor product x retailer) ----
  const existingListings = await db.getAllRows("RecallRetailerListings");
  const listingKey = (competitorProductId, retailer) => `${competitorProductId}|${norm(retailer)}`;
  const existingListingKeys = new Set(existingListings.map((l) => listingKey(l.competitorProductId, l.retailer)));
  const newListings = [];
  for (const item of B12_COMPETITOR_PRODUCTS_SEED) {
    const key = `${norm(item.competitorName)}|${norm(item.productName)}`;
    const competitorProductId = competitorIds.get(key);
    for (const listing of item.retailerListings || []) {
      if (!APPROVED_RETAILERS.includes(listing.retailer)) continue;
      if (existingListingKeys.has(listingKey(competitorProductId, listing.retailer))) continue;
      newListings.push({
        id: `rl-b12-${crypto.randomUUID()}`, competitorProductId, retailer: listing.retailer,
        // No source URL was provided for any listing in this research pass —
        // left blank rather than invented; recorded as missing on the
        // competitor product's own missingFields list instead.
        sourceUrl: "", displayedPrice: listing.displayedPrice === "" ? "" : listing.displayedPrice,
        currency: listing.currency || "", researchDate: "", notes: listing.notes || "",
        createdBy: "Recall B12 product seed", createdAt: new Date().toISOString(),
      });
    }
  }
  if (newListings.length) await db.appendRows("RecallRetailerListings", newListings);

  // ---- Comparison relationships (existing architecture — no ranking) ----
  const existingRels = await db.getAllRows("RecallCompetitorRelationships");
  const relKey = (a, b) => `${a}|${b}`;
  const existingRelKeys = new Set(existingRels.map((r) => relKey(r.ourProductId, r.competitorProductId)));
  const newRels = [];
  for (const item of B12_COMPETITOR_PRODUCTS_SEED) {
    const key = `${norm(item.competitorName)}|${norm(item.productName)}`;
    const competitorProductId = competitorIds.get(key);
    const ourProductId = ourProductIds.get(item.compareWith);
    if (!ourProductId || !competitorProductId) continue;
    if (existingRelKeys.has(relKey(ourProductId, competitorProductId))) continue;
    newRels.push({
      id: `cr-b12-${crypto.randomUUID()}`, ourProductId, competitorProductId,
      comparisonType: "dose-and-form-comparison", notes: item.comparisonNotes || "",
      sourceIds: "", createdAt: new Date().toISOString(),
    });
  }
  if (newRels.length) await db.appendRows("RecallCompetitorRelationships", newRels);

  recallB12ProductDataSeedChecked = true;
}

// ---------- Recall: competitor master data (categories beyond B12) ----------
// Transcribed verbatim from a user-provided Lebanese-market research file
// (73 source rows across ~27 categories). Every NOT VERIFIED / blank field
// from that source stays blank here — never guessed. Two rows needed
// special handling: an exact duplicate (Webber Naturals Calma-D, listed
// under both "Vitamin D" and "Vitamin D / calcium / magnesium") was merged
// into one product record, and one row (Green Made Cobalin 1000 mcg)
// already existed from the earlier B12 seed, so it only appears in
// enrichments (filling in its retailer listing's missing sourceUrl), not
// as a new product. judgmentCalls records every non-mechanical call made
// while transcribing (brand/product-name splits, price ranges, a couple of
// retailer/URL mismatches in the source itself) for review.
//
// IMPORTANT — linking: a competitor product only shows up under a Recall
// category's own "Competitors" table once linked (RecallCompetitorRelationships)
// against one of that category's OWN products. Only b-vitamins-b12 has
// our-products (Mason/ALFA) loaded so far, so only this seed's
// b-vitamins-b12 items are auto-linked below. Every other category's
// competitor products are created and fully populated (visible/editable
// under the Competitors tab) but stay unlinked until Mason/ALFA data exists
// for that category — then linking is a one-click action via the existing
// "Link to Recall category" / "Add existing competitor" UI.
const COMPETITOR_MASTER_SEED = {
  newProducts: [
    // --- B-complex / B vitamins -> b-vitamins-b12 ---
    {
      categoryId: "b-vitamins-b12",
      competitorName: "HealthAid",
      productName: "Vitamin B Complex",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/energy-supplements",
      retailer: "Nicolas Care",
      displayedPrice: 24.42,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "PiLeJe",
      productName: "Neurobiane",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 18.83,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "Health Aid",
      productName: "Neuroforte Multivitamin",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 28.86,
    },

    // --- B12 -> b-vitamins-b12 ---
    // (Green Made Cobalin 1000 mcg / Sohati Care omitted here - see enrichments)
    {
      categoryId: "b-vitamins-b12",
      competitorName: "Green Made",
      productName: "Cobalin SL 5000 mcg",
      genericName: "Methylcobalamin",
      form: "",
      dosage: "5,000 mcg",
      packSize: "",
      notes:
        "Recommended use: 1 tablet/week. Pack size conflict: source page shows '10 capsules/tablets' (wording conflict) - left unrecorded, see raw text here.",
      sourceUrl: "https://sohaticare.com/products/cobalin-sl",
      retailer: "Sohati Care",
      displayedPrice: 16.85,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "NOW",
      productName: "B12 1000 mcg Lozenges",
      genericName: "",
      form: "Lozenge",
      dosage: "1,000 mcg",
      packSize: "",
      notes: "Recommended use: Not verified from current source. Pack size: Not verified.",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 13,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "NOW",
      productName: "B12 5000 mcg Lozenges",
      genericName: "",
      form: "Lozenge",
      dosage: "5,000 mcg",
      packSize: "",
      notes:
        "Recommended use: Not verified from current source. Pack size: Not verified. Possible overlap with existing NOW 5,000 mcg B12 entries (NOW B-12 5,000 mcg + Folic Acid Lozenge, or NOW Methyl B-12 5,000 mcg Lozenge), but NOT confirmed the same SKU - this source only says 'Vitamin B12 5,000 mcg' with no mention of folic acid or methyl-/cyano- form, so kept as its own separate entry.",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 19,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "Medvial",
      productName: "Cobast",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 19,
    },
    {
      categoryId: "b-vitamins-b12",
      competitorName: "Dietaroma",
      productName: "Mix B12",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vendors?q=dietaroma",
      retailer: "Nicolas Care",
      displayedPrice: 15,
    },

    // --- Multivitamin -> multivitamins ---
    {
      categoryId: "multivitamins",
      competitorName: "ESI",
      productName: "Multicomplex Senior 30 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes:
        "Recommended use: Daily dose shown on product page. Broad multivitamin/mineral; detailed daily nutrient profile previously captured but not itemized here. Retailer/URL mismatch: source table lists retailer as 'Nicolas Care', but the source URL is mazenonline.com - retailer recorded as 'Mazen Online' to match the URL, per explicit instruction for this row.",
      sourceUrl: "https://mazenonline.com/collections/esi/products/multicomplex-senior-1",
      retailer: "Mazen Online",
      displayedPrice: 16,
    },
    {
      categoryId: "multivitamins",
      competitorName: "Advancis",
      productName: "Essential Vitamins 30 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/multivitamin",
      retailer: "Nicolas Care",
      displayedPrice: 20.33,
    },
    {
      categoryId: "multivitamins",
      competitorName: "Vitabiotics",
      productName: "Wellwoman",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Women's multivitamin/mineral. Serving/dosage and pack size not fully captured from source.",
      sourceUrl: "https://nicolas-care.com/collections/multivitamin",
      retailer: "Nicolas Care",
      displayedPrice: 21.64,
    },
    {
      categoryId: "multivitamins",
      competitorName: "Webber Naturals",
      productName: "MultiSure Men 60 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "Men's multivitamin/mineral. Recommended use not fully captured.",
      sourceUrl: "https://nicolas-care.com/collections/multivitamin",
      retailer: "Nicolas Care",
      displayedPrice: 28,
    },
    {
      categoryId: "multivitamins",
      competitorName: "Valuemed",
      productName: "Centramin Multivitamin 30 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes: "Adult multivitamin/mineral. Recommended use not fully captured.",
      sourceUrl: "https://nicolas-care.com/collections/multivitamin",
      retailer: "Nicolas Care",
      displayedPrice: 10,
    },
    {
      categoryId: "multivitamins",
      competitorName: "Green Made",
      productName: "MaxiVit 15 caps",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 15,
      notes: "",
      sourceUrl: "https://sohaticare.com/products/maxivit-15-caps",
      retailer: "Sohati Care",
      displayedPrice: 9.45,
    },
    {
      categoryId: "multivitamins",
      competitorName: "PiLeJe",
      productName: "Multibiane 30 capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://sohaticare.com/products/pileje-multibiane",
      retailer: "Sohati Care",
      displayedPrice: 11.75,
    },

    // --- Folic acid / prenatal & conception -> womens-health ---
    {
      categoryId: "womens-health",
      competitorName: "Pregnacare",
      productName: "30 Tabs",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes:
        "Recommended use: Not fully captured. Contains 19 vitamins/minerals; folic acid 400 mcg; vitamin D 10 mcg.",
      sourceUrl: "https://sohaticare.com/products/pregnacare",
      retailer: "Sohati Care",
      displayedPrice: 20,
    },
    {
      categoryId: "womens-health",
      competitorName: "Pregnacare",
      productName: "Conception",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://sohaticare.com/products/pregnacare-conception",
      retailer: "Sohati Care",
      displayedPrice: "",
    },

    // --- Folic acid / iron -> iron ---
    {
      categoryId: "iron",
      competitorName: "Webber Naturals",
      productName: "Acifer Complex iron & folic acid 60 Cap",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://mazenonline.com/en-iraq/collections/supplements-1",
      retailer: "Mazen Online",
      displayedPrice: 19,
    },

    // --- Folic acid (no qualifier) -> b-vitamins-b12 ---
    {
      categoryId: "b-vitamins-b12",
      competitorName: "Folate",
      productName: "Folic Acid 800 mcg - 100 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "800 mcg",
      packSize: 100,
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },

    // --- Vitamin D -> vitamin-d ---
    {
      categoryId: "vitamin-d",
      competitorName: "Nutrilabs",
      productName: "NuD3 10000 IU 30 capsules",
      genericName: "",
      form: "Capsule",
      dosage: "10000 IU",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamin-d",
      retailer: "Nicolas Care",
      displayedPrice: 14,
    },
    {
      categoryId: "vitamin-d",
      competitorName: "Webber Naturals",
      productName: "Calma-D Forte 60 tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamin-d",
      retailer: "Nicolas Care",
      displayedPrice: 25,
    },
    {
      categoryId: "vitamin-d",
      competitorName: "Solgar",
      productName: "D3 400 IU 100 softgels",
      genericName: "",
      form: "Softgel",
      dosage: "400 IU",
      packSize: 100,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamin-d",
      retailer: "Nicolas Care",
      displayedPrice: 39.8,
    },
    {
      // Deduped: this row appears twice in the source table, identically,
      // once under "Vitamin D" and once under "Vitamin D / calcium / magnesium".
      // Treated as ONE product; category set to Vitamin D (its first listing).
      categoryId: "vitamin-d",
      competitorName: "Webber Naturals",
      productName: "Calma-D 60 tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 60,
      notes:
        "Recommended use: 1-2 tablets/day. Contains calcium 500 mg elemental + magnesium 250 mg elemental + vitamin D3 200 IU. NOTE: this row appears twice in the source table (once under 'Vitamin D', once under 'Vitamin D / calcium / magnesium') with identical name/retailer/price/URL - deduplicated into a single entry here; it is equally relevant to the Calcium/Magnesium category.",
      sourceUrl: "https://mazenonline.com/products/calma-d-1",
      retailer: "Mazen Online",
      displayedPrice: 20,
    },
    {
      categoryId: "vitamin-d",
      competitorName: "Fresh Pharma",
      productName: "Acti-D 30 tablets",
      genericName: "",
      form: "Tablet",
      dosage: "1,000 IU",
      packSize: 30,
      notes: "Recommended use: Not verified.",
      sourceUrl: "https://mazenonline.com/products/acti-d-30-tablets",
      retailer: "Mazen Online",
      displayedPrice: 22,
    },
    {
      categoryId: "vitamin-d",
      competitorName: "NOW",
      productName: "D3 Max Potency 50,000 IU",
      genericName: "Vitamin D3",
      form: "",
      dosage: "50,000 IU",
      packSize: "",
      notes: "Recommended use: Not verified. Pack size: Not verified.",
      sourceUrl: "https://mazenonline.com/ar-iraq/products/vitamin-d-3-max-potency-50-000-iu",
      retailer: "Mazen Online",
      displayedPrice: 13,
    },

    // --- Vitamin D / calcium -> calcium ---
    {
      categoryId: "calcium",
      competitorName: "Osteocare",
      productName: "Chewable",
      genericName: "",
      form: "Chewable",
      dosage: "",
      packSize: "",
      notes:
        "Recommended use: Adults 2/day. Contains vitamin D + calcium + magnesium + zinc + copper + manganese + selenium + boron. Pack size ambiguous/conflicting: source shows '3 tablets' alongside 'Adults 2/day' dosing guidance.",
      sourceUrl: "https://sohaticare.com/products/osteocare",
      retailer: "Sohati Care",
      displayedPrice: 13,
    },

    // --- Magnesium -> magnesium ---
    {
      categoryId: "magnesium",
      competitorName: "Magnesium B6",
      productName: "30 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes: "Recommended use: Not fully captured. Contains magnesium + vitamin B6.",
      sourceUrl: "https://sohaticare.com/products/magnesium-b6-30-tablets",
      retailer: "Sohati Care",
      displayedPrice: 8.55,
    },
    {
      categoryId: "magnesium",
      competitorName: "Magnesal",
      productName: "Plus x30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "Recommended use: Not fully captured. Magnesium combination formula (specific ingredients not itemized).",
      sourceUrl: "https://sohaticare.com/products/magnesal-plus",
      retailer: "Sohati Care",
      displayedPrice: 12.5,
    },
    {
      categoryId: "magnesium",
      competitorName: "MagneCalm",
      productName: "60 capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "Recommended use: Not fully captured. Magnesium formula (specific ingredients not itemized).",
      sourceUrl: "https://sohaticare.com/products/magnecalm",
      retailer: "Sohati Care",
      displayedPrice: 21.85,
    },
    {
      categoryId: "magnesium",
      competitorName: "Green Made",
      productName: "SupraMag 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "Recommended use: Not fully captured. Magnesium formula (specific ingredients not itemized).",
      sourceUrl: "https://nicolas-care.com/collections/essential-vitamins?page=2",
      retailer: "Nicolas Care",
      displayedPrice: 14.86,
    },
    {
      categoryId: "magnesium",
      competitorName: "Sole Pharma",
      productName: "Magnefol 30 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes: "Recommended use: Not fully captured. Magnesium + folate combination formula.",
      sourceUrl: "https://nicolas-care.com/collections/essential-vitamins?page=2",
      retailer: "Nicolas Care",
      displayedPrice: 15.54,
    },
    {
      categoryId: "magnesium",
      competitorName: "Polski Lek",
      productName: "Magnesium Cardio 60 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 60,
      notes: "Recommended use: Not fully captured. Magnesium cardiovascular-support formula.",
      sourceUrl: "https://nicolas-care.com/collections/essential-vitamins?page=2",
      retailer: "Nicolas Care",
      displayedPrice: 20,
    },

    // --- Omega-3 -> omega-3 ---
    {
      categoryId: "omega-3",
      competitorName: "Excellium",
      productName: "Omega 3 60 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "Recommended use: Not fully captured. EPA/DHA details need product-page verification.",
      sourceUrl: "https://sohaticare.com/products/omega-3-excellium-60-capsules",
      retailer: "Sohati Care",
      displayedPrice: 11.77,
    },
    {
      categoryId: "omega-3",
      competitorName: "Advancis",
      productName: "Omega-3 Super EPA 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "Recommended use: Not fully captured. EPA-focused omega-3 formula.",
      sourceUrl: "https://sohaticare.com/collections/omega-3-supplements",
      retailer: "Sohati Care",
      displayedPrice: 22.92,
    },
    {
      categoryId: "omega-3",
      competitorName: "Advancis",
      productName: "Omega 3 Junior",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Recommended use: Not fully captured. Pack size not fully captured. Omega-3 junior (children's) formula.",
      sourceUrl: "https://sohaticare.com/products/omega-3-junior",
      retailer: "Sohati Care",
      displayedPrice: 17.92,
    },

    // --- Omega-3 / flax -> omega-3 ---
    {
      categoryId: "omega-3",
      competitorName: "Alfa 369",
      productName: "Omega 369 Organic Flax Oil 1000 mg",
      genericName: "",
      form: "",
      dosage: "1000 mg",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },

    // --- Collagen -> collagen ---
    {
      categoryId: "collagen",
      competitorName: "Grass-fed Collagen with Probiotic",
      productName: "",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes:
        "Recommended use: 1 scoop. Contains hydrolyzed collagen peptides 10 g + hyaluronic acid 50 mg + 10 probiotic strains + biotin 30 mcg. Pack size not fully captured. Retailer/URL mismatch: source table lists retailer as 'Sohati Care', but the source URL is mazenonline.com - retailer recorded as given ('Sohati Care'), mismatch flagged for review.",
      sourceUrl: "https://mazenonline.com/ar-iraq/products/grass-fed-collagen-with-probiotic",
      retailer: "Sohati Care",
      displayedPrice: 60,
    },
    {
      categoryId: "collagen",
      competitorName: "Pure",
      productName: "Collagen Plus 4000MG",
      genericName: "",
      form: "",
      dosage: "4000 mg",
      packSize: "",
      notes: "",
      sourceUrl: "https://sohaticare.com/products/pure-collagen-plus-4000mg",
      retailer: "Sohati Care",
      displayedPrice: 43.29,
    },
    {
      categoryId: "collagen",
      competitorName: "ESI",
      productName: "Biocollagenix 120 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 120,
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/food-supplements",
      retailer: "Mazen Online",
      displayedPrice: 49,
    },
    {
      categoryId: "collagen",
      competitorName: "Trenker",
      productName: "NC2 Native Collagen II 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vendors?q=trenker",
      retailer: "Nicolas Care",
      displayedPrice: 35,
    },

    // --- Biotin -> hair-skin-nails ---
    {
      categoryId: "hair-skin-nails",
      competitorName: "Dietpharm",
      productName: "Biotin x30 Tabs",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://sohaticare.com/products/biotin-x30-tabs",
      retailer: "Sohati Care",
      displayedPrice: 9.92,
    },
    {
      categoryId: "hair-skin-nails",
      competitorName: "Green Made",
      productName: "HMS D-Biotin 100mg",
      genericName: "",
      form: "",
      dosage: "100 mg",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/nerves",
      retailer: "Mazen Online",
      displayedPrice: 27.81,
    },

    // --- Biotin / hair -> hair-skin-nails ---
    {
      categoryId: "hair-skin-nails",
      competitorName: "Arkopharma",
      productName: "Forcapil Hair & Nails",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Public price shown as a range: $17.76-$36.63 (likely reflects multiple pack sizes/variants); no single clean price recorded.",
      sourceUrl: "https://mazenonline.com/en-iraq/collections/supplements-1",
      retailer: "Mazen Online",
      displayedPrice: "",
    },

    // --- Hair / skin / nails -> hair-skin-nails ---
    {
      categoryId: "hair-skin-nails",
      competitorName: "Dietaroma",
      productName: "Capilea Strong Hair & Nails 60 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vendors?q=dietaroma",
      retailer: "Nicolas Care",
      displayedPrice: 27,
    },

    // --- Apple cider vinegar -> digestive-gut-health ---
    {
      categoryId: "digestive-gut-health",
      competitorName: "Holland & Barrett",
      productName: "Apple Cider Vinegar",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/en-iraq/products/t-apple-cider-vinegar",
      retailer: "Mazen Online",
      displayedPrice: 20,
    },
    {
      categoryId: "digestive-gut-health",
      competitorName: "NOW",
      productName: "Apple Cider Vinegar 450 mg 180 Veg Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "450 mg",
      packSize: 180,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/digestive-enzymes",
      retailer: "Nicolas Care",
      displayedPrice: 30,
    },
    {
      categoryId: "digestive-gut-health",
      competitorName: "21st Century",
      productName: "Apple Cider Vinegar 300 mg - 250 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "300 mg",
      packSize: 250,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamins-supplements?page=2",
      retailer: "Nicolas Care",
      displayedPrice: 33.3,
    },
    {
      categoryId: "digestive-gut-health",
      competitorName: "Swanson",
      productName: "Apple Vinegar 120 Tabs",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 120,
      notes: "",
      sourceUrl: "https://nicolas-care.com/products/swanson-apple-vinegar-120-tabs",
      retailer: "Nicolas Care",
      displayedPrice: 39.33,
    },

    // --- Ashwagandha -> sleep-stress-mood ---
    {
      categoryId: "sleep-stress-mood",
      competitorName: "Biotech USA",
      productName: "Ashwagandha 60 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/stress-relief",
      retailer: "Nicolas Care",
      displayedPrice: 18.62,
    },
    {
      categoryId: "sleep-stress-mood",
      competitorName: "Novadiet",
      productName: "Ashwagandha",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Public price shown as 'From $23' (starting price; exact price not captured).",
      sourceUrl: "https://nicolas-care.com/collections/stress-support",
      retailer: "Nicolas Care",
      displayedPrice: "",
    },
    {
      categoryId: "sleep-stress-mood",
      competitorName: "Marinas",
      productName: "Ashwagandha",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/vendors?q=Marinas",
      retailer: "Mazen Online",
      displayedPrice: 22,
    },

    // --- 5-HTP -> sleep-stress-mood ---
    {
      categoryId: "sleep-stress-mood",
      competitorName: "Solaray",
      productName: "5-HTP with Vitamin C 100 mg 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "100 mg",
      packSize: 30,
      notes: "Dosage '100 mg' as listed in product name - unclear whether this refers to the 5-HTP or the vitamin C content; not further verified.",
      sourceUrl: "https://nicolas-care.com/collections/stress-support",
      retailer: "Nicolas Care",
      displayedPrice: 52.46,
    },

    // --- Melatonin -> sleep-stress-mood ---
    {
      categoryId: "sleep-stress-mood",
      competitorName: "Vitarmonyl",
      productName: "Melaforte Melatonin 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://sohaticare.com/products/melaforte-melatonin-30-capsules",
      retailer: "Sohati Care",
      displayedPrice: 7.7,
    },

    // --- Calcium/Magnesium/Zinc -> calcium ---
    {
      categoryId: "calcium",
      competitorName: "Sundown",
      productName: "Calcium, Magnesium & Zinc 100 Caplets",
      genericName: "",
      form: "Caplet",
      dosage: "",
      packSize: 100,
      notes: "",
      sourceUrl: "https://mazenonline.com/en-iraq/collections/supplements-1",
      retailer: "Mazen Online",
      displayedPrice: 17.01,
    },
    {
      categoryId: "calcium",
      competitorName: "Calcium Magnesium & Zinc",
      productName: "Caplets",
      genericName: "",
      form: "Caplet",
      dosage: "",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },

    // --- Vitamin C -> vitamin-c ---
    {
      categoryId: "vitamin-c",
      competitorName: "Juvamine",
      productName: "Vitamin C 1000 mg 30 Effervescent Tablets",
      genericName: "",
      form: "Effervescent",
      dosage: "1000 mg",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamins-supplements",
      retailer: "Nicolas Care",
      displayedPrice: 9.99,
    },
    {
      categoryId: "vitamin-c",
      competitorName: "Biorga",
      productName: "Sana+ Vita C Extra 1000 mg 20 Effervescent Tablets",
      genericName: "",
      form: "Effervescent",
      dosage: "1,000 mg",
      packSize: 20,
      notes: "Recommended use: Not verified.",
      sourceUrl: "https://nicolas-care.com/collections/immune-support",
      retailer: "Nicolas Care",
      displayedPrice: 8.33,
    },
    {
      categoryId: "vitamin-c",
      competitorName: "Solaray",
      productName: "Buffered Vitamin C 800 mg 100 VegCaps",
      genericName: "",
      form: "Capsule",
      dosage: "800 mg",
      packSize: 100,
      notes: "Recommended use: Not verified. Buffered vitamin C formulation.",
      sourceUrl: "https://nicolas-care.com/collections/immune-support",
      retailer: "Nicolas Care",
      displayedPrice: 41.63,
    },

    // --- CoQ10 -> coq10 ---
    {
      categoryId: "coq10",
      competitorName: "Advancis",
      productName: "Coenzyme Q10 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/advancis",
      retailer: "Nicolas Care",
      displayedPrice: 21,
    },
    {
      categoryId: "coq10",
      competitorName: "Med-Vial",
      productName: "Mega Q10 30 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamins-supplements?page=2",
      retailer: "Nicolas Care",
      displayedPrice: 30,
    },
    {
      categoryId: "coq10",
      competitorName: "Webber Naturals",
      productName: "QuTen Forte 30 Softgels",
      genericName: "",
      form: "Softgel",
      dosage: "",
      packSize: 30,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vitamins-supplements",
      retailer: "Nicolas Care",
      displayedPrice: 36,
    },

    // --- Turmeric/curcumin -> joint-bone-mobility ---
    {
      categoryId: "joint-bone-mobility",
      competitorName: "Turmera",
      productName: "",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured'). Single-word product name in source; no distinguishable brand/product split available.",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },

    // --- Probiotic -> probiotics ---
    {
      categoryId: "probiotics",
      competitorName: "Green Made",
      productName: "ProbioLife",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/food-supplements",
      retailer: "Mazen Online",
      displayedPrice: 10.86,
    },
    {
      categoryId: "probiotics",
      competitorName: "Priotic",
      productName: "Plus",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://nicolas-care.com/products/3761-sku-3761-1",
      retailer: "Nicolas Care",
      displayedPrice: 9.99,
    },

    // --- Memory / ginkgo -> brain-cognitive-health-memory ---
    {
      categoryId: "brain-cognitive-health-memory",
      competitorName: "Dietaroma",
      productName: "Capital Memoire 40 Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 40,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vendors?q=dietaroma",
      retailer: "Nicolas Care",
      displayedPrice: 25,
    },

    // --- Memory -> brain-cognitive-health-memory ---
    {
      categoryId: "brain-cognitive-health-memory",
      competitorName: "Lifeplan",
      productName: "AlzAid 60 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://mazenonline.com/collections/fatigue-energy",
      retailer: "Mazen Online",
      displayedPrice: 9.99,
    },

    // --- Joint -> joint-bone-mobility ---
    {
      categoryId: "joint-bone-mobility",
      competitorName: "Trenker",
      productName: "Biocondil 60 Tablets",
      genericName: "",
      form: "Tablet",
      dosage: "",
      packSize: 60,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/vendors?q=trenker",
      retailer: "Nicolas Care",
      displayedPrice: 34,
    },
    {
      categoryId: "joint-bone-mobility",
      competitorName: "Arthrosamine",
      productName: "Plus",
      genericName: "",
      form: "",
      dosage: "",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },
    {
      categoryId: "joint-bone-mobility",
      competitorName: "Chondrosamine",
      productName: "900mg",
      genericName: "",
      form: "",
      dosage: "900 mg",
      packSize: "",
      notes: "Public price not captured from source (listed as 'Not captured').",
      sourceUrl: "https://skinsociety.me/pages/avada-sitemap-products",
      retailer: "Skin Society",
      displayedPrice: "",
    },

    // --- Weight management -> weight-management ---
    {
      categoryId: "weight-management",
      competitorName: "NOW",
      productName: "Glucomannan 180 Veg Capsules",
      genericName: "",
      form: "Capsule",
      dosage: "",
      packSize: 180,
      notes: "",
      sourceUrl: "https://nicolas-care.com/collections/digestive-enzymes",
      retailer: "Nicolas Care",
      displayedPrice: 40,
    },
    {
      categoryId: "weight-management",
      competitorName: "Sweet Bear",
      productName: "Fat Burner Gummies",
      genericName: "",
      form: "Gummy",
      dosage: "",
      packSize: "",
      notes: "",
      sourceUrl: "https://nicolas-care.com/products/sweet-bear-fat-burner-gummies",
      retailer: "Nicolas Care",
      displayedPrice: 33.3,
    },
  ],

  enrichments: [
    {
      competitorKey: "Green Made|Cobalin",
      retailer: "Sohati Care",
      field: "sourceUrl",
      value: "https://sohaticare.com/products/cobalin-1000-mcg",
    },
  ],

  judgmentCalls: [
    "ROW COUNT DISCREPANCY: the source table as given contains 73 data rows, not 94 as stated in the task instructions. Verified by manual line-by-line enumeration and by summing per-category subtotals (both give 73). Proceeded with the actual 73 rows: 71 newProducts + 1 enrichment + 1 merged-duplicate-pair-counted-once = 73.",
    "'Pregnacare 30 Tabs' / 'Pregnacare Conception': no separate company brand given in source, so 'Pregnacare' was used as competitorName and the remainder as productName.",
    "'Magnesium B6 30 Tablets': no distinguishable brand token in source; used 'Magnesium B6' as competitorName and '30 Tablets' as productName.",
    "'Magnesal Plus x30 Capsules' and 'MagneCalm 60 capsules': treated the leading single word as competitorName ('Magnesal', 'MagneCalm') with the remainder as productName, though these read more like single fused brand+product names.",
    "'Omega 3 Excellium 60 Capsules': assumed 'Excellium' is the brand (placed after the category word 'Omega 3' in the source string) and set competitorName='Excellium', productName='Omega 3 60 Capsules' — word order is unusual and this split is uncertain.",
    "'Grass-fed Collagen with Probiotic': no brand token identifiable; used the full descriptive name as competitorName and left productName empty.",
    "'Pure Collagen Plus 4000MG': treated 'Pure' as competitorName and 'Collagen Plus 4000MG' as productName; 'Pure' may not be an actual distinct brand.",
    "'Calcium Magnesium & Zinc Caplets' and 'Turmera': no brand/product split possible (single descriptive phrase or single word) — competitorName set to the full name (or the single word), productName left empty for 'Turmera'.",
    "'Priotic Plus' and 'Arthrosamine Plus': split as competitorName + 'Plus' product line; could alternatively be a single fused brand name.",
    "'Chondrosamine 900mg': productName kept verbatim as '900mg' while dosage field normalized to '900 mg'.",
    "Form 'Caplet' used for 'Caplets' (Sundown Calcium/Magnesium/Zinc; generic Calcium Magnesium & Zinc Caplets) even though the task's form-mapping example list did not explicitly include 'Caplet' — treated as an unambiguous, clearly stated dosage form analogous to the listed examples.",
    "genericName 'Vitamin D3' was recorded for 'NOW D3 Max Potency 50,000 IU' (verified details column explicitly says 'Vitamin D3 50,000 IU'), but genericName was left blank for plain 'Vitamin D' or 'Vitamin B12' mentions elsewhere (rows for Fresh Pharma Acti-D, NOW B12 Lozenges) since those don't specify a distinct vitamer/ester — this line is a judgment call on what counts as a sufficiently specific 'chemical/generic' name.",
    "'ESI Multicomplex Senior 30 Tablets': per the explicit task exception, retailer was recorded as 'Mazen Online' (matching the source URL) instead of the table's literal 'Nicolas Care', with a note flagging the mismatch.",
    "'Grass-fed Collagen with Probiotic' also has a retailer/URL mismatch (table says 'Sohati Care', URL is mazenonline.com), but since the task only specified an explicit override for the ESI Multicomplex Senior row, the literal table retailer ('Sohati Care') was kept here and the mismatch was only flagged in notes rather than overridden.",
    "Webber Naturals Calma-D 60 tablets (Vitamin D / Vitamin D+calcium+magnesium duplicate pair): merged into a single entry under categoryId 'vitamin-d' (its first listing), with a note that it is equally relevant to the Calcium/Magnesium category.",
  ],
};

let competitorMasterDataSeedChecked = false;
// Reconciles an incoming fact set against an already-existing record —
// fills in whichever fields are currently blank, and records an open
// RecallFieldConflicts row for any field where the two sources actually
// disagree. Never overwrites a value that's already there, and never picks
// a winner itself. Used whenever a seed's "this already exists" match
// shouldn't mean "nothing more to learn from this row" — a pre-existing
// record (from an earlier seed, or a manager's own prior data entry) is
// very often only partially filled in.
function reconcileRecordFields({ entityType, entityId, existing, incoming, sourceLabel, existingConflictKeys }) {
  const patch = {};
  const conflicts = [];
  for (const [field, rawValue] of Object.entries(incoming)) {
    if (rawValue === "" || rawValue == null) continue; // nothing new to contribute for this field
    const existingValue = existing[field];
    const existingFilled = existingValue !== "" && existingValue != null;
    if (!existingFilled) {
      patch[field] = rawValue;
    } else if (String(existingValue) !== String(rawValue)) {
      const conflictKey = `${entityType}|${entityId}|${field}`;
      if (existingConflictKeys.has(conflictKey)) continue; // already flagged on an earlier run
      existingConflictKeys.add(conflictKey);
      conflicts.push({
        id: `fc-recon-${crypto.randomUUID()}`, entityType, entityId, fieldName: field,
        sourceALabel: "Existing data", sourceAValue: String(existingValue),
        sourceBLabel: sourceLabel, sourceBValue: String(rawValue),
        status: "CONFLICT", notes: "", createdAt: new Date().toISOString(),
        resolution: "", resolvedBy: "", resolvedAt: "",
      });
    }
  }
  return { patch, conflicts };
}

async function ensureCompetitorMasterDataSeeded() {
  if (competitorMasterDataSeedChecked) return;
  // Self-sufficient rather than trusting every call site to sequence
  // prerequisites correctly — this seed's B12-category linking step needs
  // the B12 our-products to already exist. All three are idempotent
  // (no-op after their first run), so calling them here is always safe.
  await ensureRecallCategoriesSeeded();
  await ensureRecallB12Seeded();
  await ensureB12ProductDataSeeded();
  const norm = (s) => String(s || "").trim().toLowerCase();

  const existingProducts = await db.getAllRows("CompetitorProducts");
  const productIdByKey = new Map(existingProducts.map((p) => [`${norm(p.competitorName)}|${norm(p.productName)}`, p.id]));

  // ---- Enrichments: fill a blank field on an already-existing record ----
  // (only ever fills a currently-blank field — never overwrites a value
  // that's already there, per the "never silently overwrite" rule).
  const existingListings = await db.getAllRows("RecallRetailerListings");
  for (const enr of COMPETITOR_MASTER_SEED.enrichments) {
    const productId = productIdByKey.get(norm(enr.competitorKey));
    if (!productId) continue; // the record it refers to doesn't exist — skip rather than guess
    if (enr.field === "sourceUrl" && enr.retailer) {
      const listing = existingListings.find((l) => l.competitorProductId === productId && norm(l.retailer) === norm(enr.retailer));
      if (listing && !listing.sourceUrl) {
        await db.updateRowById("RecallRetailerListings", listing.id, { sourceUrl: enr.value });
      }
    }
  }

  // ---- New competitor products + retailer listings ----
  // A name match against an EXISTING row (from an earlier seed, or a
  // manager's own prior data entry — this table can predate this seed
  // entirely) is never just skipped: whatever fields are still blank on
  // that record get filled in, and a genuine disagreement is recorded as an
  // open conflict, never silently overwritten.
  const existingConflictRows = await db.getAllRows("RecallFieldConflicts");
  const existingConflictKeys = new Set(existingConflictRows.map((c) => `${c.entityType}|${c.entityId}|${c.fieldName}`));
  const newProductRows = [];
  const newListingRows = [];
  const reconcilePatches = [];
  const newConflictRows = [];
  const createdIdByKey = new Map();
  const listingKey = (competitorProductId, retailer) => `${competitorProductId}|${norm(retailer)}`;
  const existingListingByKey = new Map(existingListings.map((l) => [listingKey(l.competitorProductId, l.retailer), l]));

  for (const item of COMPETITOR_MASTER_SEED.newProducts) {
    const key = `${norm(item.competitorName)}|${norm(item.productName)}`;
    const existingId = productIdByKey.get(key) || createdIdByKey.get(key);

    if (existingId) {
      const existingRow = existingProducts.find((p) => p.id === existingId);
      if (existingRow) {
        const { patch, conflicts } = reconcileRecordFields({
          entityType: "CompetitorProducts", entityId: existingId, existing: existingRow,
          incoming: { genericName: item.genericName, form: item.form, dosage: item.dosage, packSize: item.packSize, sourceUrl: item.sourceUrl },
          sourceLabel: "Competitor master data import", existingConflictKeys,
        });
        if (Object.keys(patch).length) {
          patch.updatedBy = "Recall competitor master data seed"; patch.updatedAt = new Date().toISOString();
          reconcilePatches.push({ id: existingId, patch });
        }
        newConflictRows.push(...conflicts);
      }
    } else {
      const id = `cp${crypto.randomUUID()}`;
      const row = { id, createdAt: new Date().toISOString(), createdBy: "Recall competitor master data seed", updatedBy: "", updatedAt: "" };
      for (const f of COMPETITOR_PRODUCT_FIELDS) row[f] = "";
      for (const f of COMPETITOR_PRODUCT_DETAIL_FIELDS) row[f] = "";
      row.competitorName = item.competitorName;
      row.productName = item.productName;
      row.genericName = item.genericName || "";
      row.form = item.form || "";
      row.dosage = item.dosage || "";
      row.packSize = item.packSize;
      // Price stays on the retailer listing, not the master product — see
      // Phase 2C rule 12 ("prices belong to retailer listings").
      row.price = "";
      row.notes = item.notes || "";
      row.researchStatus = "PARTIALLY_VERIFIED";
      row.missingFields = "";
      row.sourceLabel = "";
      row.sourceUrl = item.sourceUrl || "";
      newProductRows.push(row);
      createdIdByKey.set(key, id);
    }

    if (!item.retailer) continue;
    const targetId = existingId || createdIdByKey.get(key);
    const existingListing = existingListingByKey.get(listingKey(targetId, item.retailer));
    if (!existingListing) {
      newListingRows.push({
        id: `rl-cm-${crypto.randomUUID()}`, competitorProductId: targetId, retailer: item.retailer,
        sourceUrl: item.sourceUrl || "", displayedPrice: item.displayedPrice === "" ? "" : item.displayedPrice,
        currency: item.displayedPrice === "" ? "" : "USD", researchDate: "", notes: "",
        createdBy: "Recall competitor master data seed", createdAt: new Date().toISOString(),
      });
    } else {
      const { patch, conflicts } = reconcileRecordFields({
        entityType: "RecallRetailerListings", entityId: existingListing.id, existing: existingListing,
        incoming: { displayedPrice: item.displayedPrice, sourceUrl: item.sourceUrl },
        sourceLabel: "Competitor master data import", existingConflictKeys,
      });
      if (Object.keys(patch).length) {
        patch.updatedBy = "Recall competitor master data seed";
        reconcilePatches.push({ id: existingListing.id, patch, table: "RecallRetailerListings" });
      }
      newConflictRows.push(...conflicts);
    }
  }
  if (newProductRows.length) await db.appendRows("CompetitorProducts", newProductRows);
  if (newListingRows.length) await db.appendRows("RecallRetailerListings", newListingRows);
  for (const { id, patch, table } of reconcilePatches) await db.updateRowById(table || "CompetitorProducts", id, patch);
  if (newConflictRows.length) await db.appendRows("RecallFieldConflicts", newConflictRows);

  // ---- Link the B12/B-complex products into the b-vitamins-b12 category ----
  // (the only category with our-products loaded so far — see header note).
  // Any one of Mason/ALFA's B12 products serves as the anchor product a
  // relationship must point at; the Analysis/Competitors tables no longer
  // group rows by "compared against X" (see the Recall simplification
  // pass), so which specific our-product is picked has no visible effect.
  const links = await db.getAllRows("RecallProductIngredients");
  const b12ProductIds = [...new Set(links.filter((l) => l.ingredientId === "vitamin-b12").map((l) => l.productId))];
  const anchorProductId = b12ProductIds[0];
  if (anchorProductId) {
    const existingRels = await db.getAllRows("RecallCompetitorRelationships");
    const existingRelKeys = new Set(existingRels.map((r) => `${r.ourProductId}|${r.competitorProductId}`));
    const newRels = [];
    for (const item of COMPETITOR_MASTER_SEED.newProducts) {
      if (item.categoryId !== "b-vitamins-b12") continue;
      const key = `${norm(item.competitorName)}|${norm(item.productName)}`;
      const competitorProductId = productIdByKey.get(key) || createdIdByKey.get(key);
      if (!competitorProductId) continue;
      const relKey = `${anchorProductId}|${competitorProductId}`;
      if (existingRelKeys.has(relKey)) continue;
      newRels.push({
        id: `cr-cm-${crypto.randomUUID()}`, ourProductId: anchorProductId, competitorProductId,
        comparisonType: "dose-and-form-comparison", notes: "", sourceIds: "", createdAt: new Date().toISOString(),
      });
      existingRelKeys.add(relKey);
    }
    if (newRels.length) await db.appendRows("RecallCompetitorRelationships", newRels);
  }

  competitorMasterDataSeedChecked = true;
}

// ---------- Recall: our own product catalog (Mason + ALFA master list) ----------
// Transcribed from a user-provided Excel export (100 rows: 55 Alfa Vitamins
// + 45 Mason, once fully researched — an earlier version of this file had
// no dose/serving/pack/URL data for any Mason row; this one does).
// Ingredient/dose text is kept VERBATIM as given, never split into
// separate name/amount/unit facts by guesswork — the source column already
// states the full fact as one string, and re-parsing it risks
// mis-attributing an amount to the wrong nutrient.
const OUR_PRODUCTS_MASTER_SEED = [
  {
    name: "ALFA ALFAHYDROXY FAT BURNER & WEIGHT CONTROL 90CAPS",
    price: 29.4,
    form: "Capsule",
    packSize: 90,
    ingredients: "[{\"name\": \"Chromium 400 mcg + 225 mg bitter orange + 225 mg apple cider vinegar powder + 195 mg garcinia + 90 mg green tea + 90 mg uva ursi + 90 mg cascara + 45 mg caffeine + 45 mg grapefruit\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/alfahydroxy-90-capsules",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Alflexil 60 Caps",
    price: 24.54,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"glucosamine sulfate 1500 mg + chondroitin sulfate 750 mg + MSM 300 mg + collagen hydrolysate 300 mg + hyaluronic acid 10 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/alflexil-glucosamine-60-capsules",
    notes: "Labeled serving size: 4 capsules.",
  },
  {
    name: "ALFA Apple Cider Vinegar 1000 Mg 60 Caps.",
    price: 22.5,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"1000 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/apple-cider-vinegar",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA ASHWAGANDHA 2100MG 60 CAPS",
    price: 40.4,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"2,100 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/ashwagandha",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Biotin 10,000 Mcg 60 Tabs",
    price: 32.12,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"10,000 mcg biotin/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/biotin-10000-mcg-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Biotin 5000 Mcg 100 Tabs",
    price: 29,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"5,000 mcg biotin/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/biotin-5000-mcg",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Calcium Magnesium Zinc + Vit.d",
    price: 22.5,
    form: "",
    packSize: "",
    ingredients: "[{\"name\": \"Ca 300 mg + Mg 133 mg + Zn 5 mg + D3 3.325 mcg (133 IU)/caplet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/calcium-magnesium-zinc",
    notes: "Labeled serving size: 1 caplet.",
  },
  {
    name: "ALFA Chromium Picolinate 400 Mcg 100tab",
    price: 19.6,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Chromium 400 mcg + calcium 92 mg/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/chromium-picolinate",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Co Q-10 100mg 30 Softgels",
    price: 62,
    form: "Softgel",
    packSize: 30,
    ingredients: "[{\"name\": \"CoQ10 100 mg (ubiquinone)/softgel\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/coq10-30-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "ALFA Cod Liver Oil 100 Softgels",
    price: 32,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A 1,250 IU + Vitamin D 135 IU + cod liver oil 415 mg/softgel; EPA 32 mg + DHA 32 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/cod-liver-oil",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "ALFA Collagen C Hydrolysate 3000mg With C 1000mg Pouches",
    price: 83.38,
    form: "Sachet/Pouch",
    packSize: "",
    ingredients: "[]",
    sourceUrl: "",
    notes: "",
  },
  {
    name: "ALFA Collagen Hydrolysate+c 60 Caps",
    price: 24.15,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin C 90 mg + Biotin 1,000 mcg + Collagen hydrolysate 1,000 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "",
    notes: "Source URL field held page-title text instead of a link (\"CollagenC Hydrolysate + Biotin Supplement | Alfa Vitamins Store\") - left out. Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Dhea 50 Mg 60 Caps.",
    price: 18,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"DHEA 50 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/dhea",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Echinacea 1200mg 90 Capsules",
    price: 24.4,
    form: "Capsule",
    packSize: 90,
    ingredients: "[{\"name\": \"Echinacea purpurea 1,200 mg/3 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/echinacea",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Folic Acid 800mcg 100 tabs",
    price: 19.6,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Folic acid 800 mcg (1,360 mcg DFE)/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/folic-acid",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Garlic (odorless) 2000 Mg 100 Softgel",
    price: 26.2,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Garlic oil concentrate 20 mg equivalent to 2,000 mg odorless garlic/2 softgels\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/garlic-odorless",
    notes: "Labeled serving size: 2 softgels.",
  },
  {
    name: "ALFA Ginkgo Biloba 120 Mg 60 Caps.",
    price: 22.9,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Ginkgo biloba extract 120 mg/capsule\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/ginkgo-biloba-60",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA Ginseng & Ginkgo Biloba 90 Caps",
    price: 23.9,
    form: "Capsule",
    packSize: 90,
    ingredients: "[{\"name\": \"Korean ginseng powder 600 mg + ginkgo powder 100 mg + ginkgo extract 60 mg/2 tablets\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/ginseng-ginkgo",
    notes: "Labeled serving size: 2 tablets.",
  },
  {
    name: "ALFA HAIR NAILS SKIN 60 CAPS",
    price: 24,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Multiple vitamins/minerals including B12, biotin, zinc and copper; exact amounts not captured in page text\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/hair-skin-nails-60-capsules",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Korean Ginseng 1000 mg 60 Caps",
    price: 22.35,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Korean ginseng 1,000 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/korean-ginseng-1000-mg-60-capsules",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Libi Max 30 Caps",
    price: 29.8,
    form: "Capsule",
    packSize: 30,
    ingredients: "[{\"name\": \"Vitamin B6: 5 mg (as pyridoxine hydrochloride)\\nProprietary Blend: 800 mg\\nHorny goat weed\\nGuarana extract (seed)\\nMaca (root)\\nHydrolyzed collagen:\\nL-Arginine\\nL-Lysine\\nL-Glutamic acid\\nL-Proline\\nL-Glycine\\nL-Alanine\\nL-Cystine\\nL-Valine\\nL-Methionine\\nL-Isoleucine\\nL-Leucine\\nL-Tyrosine\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/libimax-aphrodisiac-30-capsules",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA MAGNESIUM + MELATONIN 60 CAPS",
    price: 35,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Magnesium citrate + magnesium oxide blend 1,400 mg = 420 mg elemental Mg + melatonin 10 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/magnesium-plus-melatonin-10-mg-60-capsules",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA MAGNESIUM + VITAMIN B6",
    price: 21.65,
    form: "",
    packSize: "",
    ingredients: "[{\"name\": \"Magnesium oxide 500 mg = 300 mg elemental Mg + vitamin B6 50 mg/capsule\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/magnesium-plus-b-6-500-mg-100-tablets",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA MAGNESIUM CITRATE 60 CAPS",
    price: 31.9,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Magnesium citrate + magnesium oxide blend 1,400 mg = 420 mg elemental Mg + L-taurine 150 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/magnesium-citrate",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA MAGNESIUM GLYCINATE 2500mg 90CAPS",
    price: 47.53,
    form: "Capsule",
    packSize: 90,
    ingredients: "[{\"name\": \"Magnesium glycinate 2,500 mg (350 mg elemental Mg )\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/magnesium-glycinate",
    notes: "Labeled serving size: 3 veggie capsules.",
  },
  {
    name: "ALFA Maximum Amino 60 Capsules",
    price: 32,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Soy Protein Isolate\\nAmino acid profile per serving (2 capsules):\\nAlanine \\u2014 38 mg\\nArginine \\u2014 68 mg\\nAspartic Acid \\u2014 104 mg\\nCystine \\u2014 12 mg\\nGlutamic Acid \\u2014 171 mg\\nGlycine \\u2014 37 mg\\nHistidine \\u2014 23 mg\\nIsoleucine \\u2014 44 mg\\nLeucine \\u2014 73 mg\\nLysine \\u2014 56 mg\\nMethionine \\u2014 12 mg\\nPhenylalanine \\u2014 47 mg\\nProline \\u2014 46 mg\\nSerine \\u2014 47 mg\\nThreonine \\u2014 35 mg\\nTryptophan \\u2014 12 mg\\nTyrosine \\u2014 35 mg\\nValine \\u2014 45 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/amino-supplement-anti-catabolic-muscle-builder",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Maximum Bcaa 100 Capsules",
    price: 31.5,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"L-Leucine \\u2014 500 mg\\nL-Isoleucine \\u2014 320 mg\\nL-Valine \\u2014 440 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/bcaa-100-capsules-muscle-mass-builder",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Maximum CLA 2000 Mg 100 Softgels",
    price: 47,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Safflower oil 2,000 mg; typically 80% CLA (serving size not captured)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/cla-2000mg",
    notes: "Labeled serving size: 2 Softgels.",
  },
  {
    name: "ALFA Maximum Creatine 1200 Mg 100 Caps.",
    price: 45.7,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"Creatine monohydrate 1,200 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/creatine-1200-mg-pre-workout-supplement-muscle-growth",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Maximum L-arginine 1000mc 100 Caps",
    price: 31,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"L-arginine 1,000 mg (as L-arginine HCl)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/l-arginine-1000-mg-muscle-mass-builder-pre-workout-supplement",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Maximum L-carnitine 500 Mg 60 Caps",
    price: 31.2,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"L-carnitine 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA Maximum L-glutamine 1000mg 100 Capsules",
    price: 30.32,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"L-glutamine 1,000 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/maximum-l-glutamine-1000-mg-100-capsules",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Memorin 60 Caps.",
    price: 21,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin B1 (as thiamine mononitrate): 100 mg \\u2014 6,667% DV\\nVitamin B6 (as pyridoxine hydrochloride): 15 mg \\u2014 750% DV\\nFolic Acid (as folate): 500 mcg \\u2014 125% DV\\nVitamin B12 (as cyanocobalamin): 500 mcg \\u2014 8,333% DV\\nCalcium (as calcium glycerophosphate): 3 mg \\u2014 <1% DV\\nGinkgo Biloba Powder (leaves): 300 mg\\nGlutamic Acid: 200 mg\\nCholine Bitartrate: 50 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/memory-supplement-memorin",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA Milk Thistle 500 mg 120 Capsules",
    price: 32.4,
    form: "Capsule",
    packSize: 120,
    ingredients: "[{\"name\": \"Milk thistle extract 500 mg/capsule\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/milk-thistle-800mg-120caps",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA MULTI COMPLEX SENIOR 100 CAPS",
    price: 27.5,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A (as acetate) \\u2014 1,500 mcg RAE (5,000 IU)\\nVitamin C (as calcium ascorbate) \\u2014 67 mg\\nVitamin D3 (as cholecalciferol) \\u2014 30 mcg (1,200 IU)\\nVitamin E (as d-alpha tocopheryl succinate) \\u2014 13.5 mg (30 IU)\\nVitamin K (as phytonadione) \\u2014 80 mcg\\nVitamin B1 (as thiamine mononitrate) \\u2014 1.5 mg\\nVitamin B2 (as riboflavin) \\u2014 1.7 mg\\nVitamin B3 (as niacinamide) \\u2014 20 mg\\nVitamin B6 (as pyridoxine hydrochloride) \\u2014 2 mg\\nFolate (as folic acid) \\u2014 667 mcg DFE\\nVitamin B12 (as cyanocobalamin) \\u2014 6 mcg\\nBiotin \\u2014 300 mcg\\nPantothenic Acid (as d-calcium pantothenate) \\u2014 10 mg\\nCalcium (as calcium citrate) \\u2014 300 mg\\nIron (as ferrous fumarate) \\u2014 18 mg\\nPhosphorus (as dicalcium phosphate) \\u2014 22.5 mg\\nIodine (as potassium iodide) \\u2014 150 mcg\\nMagnesium (as magnesium oxide) \\u2014 25 mg\\nZinc (as zinc oxide) \\u2014 10 mg\\nSelenium (as selenomethionine) \\u2014 70 mcg\\nCopper (as copper oxide) \\u2014 2 mg\\nManganese (as manganese sulfate) \\u2014 2 mg\\nChromium (as chromium picolinate) \\u2014 120 mcg\\nMolybdenum (as sodium molybdate) \\u2014 75 mcg\\nBoron (as boron amino acid chelate) \\u2014 50 mcg\\nGrape Seed Extract \\u2014 20 mg\\nSoy Flavonoid Extract (soybean seed) \\u2014 20 mg\\nGinkgo Biloba Extract (Ginkgo biloba leaves) \\u2014 20 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/multi-complex-senior",
    notes: "Labeled serving size: 2 Tablets.",
  },
  {
    name: "ALFA Multi Men 100 Tabs",
    price: 28,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A (as acetate) \\u2014 5,000 IU\\nVitamin C (as ascorbic acid) \\u2014 60 mg\\nVitamin D (as cholecalciferol) \\u2014 400 IU\\nVitamin E (as dl-alpha tocopheryl acetate) \\u2014 30 IU\\nVitamin K (as phytonadione) \\u2014 80 mcg\\nVitamin B1 (as thiamine mononitrate) \\u2014 1.5 mg\\nVitamin B2 (as riboflavin) \\u2014 1.7 mg\\nVitamin B3 (as niacinamide) \\u2014 20 mg\\nVitamin B6 (as pyridoxine hydrochloride) \\u2014 2 mg\\nFolate (as folic acid) \\u2014 400 mcg\\nVitamin B12 (as cyanocobalamin) \\u2014 6 mcg\\nBiotin \\u2014 300 mcg\\nPantothenic Acid (as dicalcium pantothenate) \\u2014 10 mg\\nCalcium (as dicalcium phosphate) \\u2014 126 mg\\nIron (as ferrous fumarate) \\u2014 18 mg\\nPhosphorus (as dicalcium phosphate) \\u2014 97 mg\\nIodine (as potassium iodide) \\u2014 150 mcg\\nMagnesium (as magnesium oxide) \\u2014 25 mg\\nZinc (as zinc oxide) \\u2014 15 mg\\nSelenium (as selenium amino acid chelate) \\u2014 70 mcg\\nCopper (as copper oxide) \\u2014 2 mg\\nManganese (as manganese sulfate) \\u2014 2 mg\\nChromium (as chromium picolinate) \\u2014 120 mcg\\nMolybdenum (as molybdenum amino acid chelate) \\u2014 75 mcg\\nBoron (as boron amino acid chelate) \\u2014 150 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/multi-men",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Multi Women 100 Tabs",
    price: 28,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A (as acetate) \\u2014 5,000 IU\\nVitamin C (as ascorbic acid) \\u2014 60 mg\\nVitamin D (as cholecalciferol) \\u2014 400 IU\\nVitamin E (as dl-alpha tocopheryl acetate) \\u2014 30 IU\\nVitamin K (as phytonadione) \\u2014 80 mcg\\nVitamin B1 (as thiamine mononitrate) \\u2014 1.5 mg\\nVitamin B2 (as riboflavin) \\u2014 1.7 mg\\nVitamin B3 (as niacinamide) \\u2014 20 mg\\nVitamin B6 (as pyridoxine hydrochloride) \\u2014 2 mg\\nFolate (as folic acid) \\u2014 800 mcg\\nVitamin B12 (as cyanocobalamin) \\u2014 6 mcg\\nBiotin \\u2014 300 mcg\\nPantothenic Acid (as dicalcium pantothenate) \\u2014 10 mg\\nCalcium (as dicalcium phosphate) \\u2014 162 mg\\nIron (as ferrous fumarate) \\u2014 18 mg\\nPhosphorus (as dicalcium phosphate) \\u2014 125 mg\\nIodine (as potassium iodide) \\u2014 150 mcg\\nMagnesium (as magnesium oxide) \\u2014 25 mg\\nZinc (as zinc oxide) \\u2014 15 mg\\nSelenium (as selenium amino acid chelate) \\u2014 70 mcg\\nCopper (as copper oxide) \\u2014 2 mg\\nManganese (as manganese sulfate) \\u2014 2 mg\\nChromium (as chromium picolinate) \\u2014 120 mcg\\nMolybdenum (as molybdenum amino acid chelate) \\u2014 75 mcg\\nBoron (as boron amino acid chelate) \\u2014 150 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/multi-women",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Multivitamins GUMMIES Adult",
    price: 32,
    form: "Gummy",
    packSize: "",
    ingredients: "[{\"name\": \"Vitamin A (as acetate) \\u2014 450 mcg RAE\\nVitamin C (as ascorbic acid) \\u2014 36 mg\\nVitamin D (as cholecalciferol) \\u2014 25 mcg\\nVitamin E (as dl-alpha tocopheryl acetate) \\u2014 15 mg\\nNiacin (as niacinamide) \\u2014 8 mg NE\\nVitamin B6 (as pyridoxine HCl) \\u2014 1.7 mg\\nFolate (as folic acid) \\u2014 400 mcg DFE (240 mcg folic acid)\\nVitamin B12 (as cyanocobalamin) \\u2014 4.8 mcg\\nBiotin \\u2014 30 mcg\\nPantothenic Acid (as d-calcium pantothenate) \\u2014 3 mg\\nSodium (as sodium citrate) \\u2014 5 mg\\nInositol \\u2014 1.5 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/multivitamins-gummies",
    notes: "Labeled serving size: 2 gummies.",
  },
  {
    name: "ALFA NAD+ PLUS RESVERATROL 60 CAPS",
    price: 81,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"NAD+ 600 mg + nicotinamide ribose 300 mg + resveratrol 100 mg/3 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/nad-plus-resveratrol",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA NIACIN 500mg 60 TABS",
    price: 25,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Niacin 500 mg + inositol 100 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/niacin-vitamin-b3",
    notes: "Labeled serving size: 2 tablets.",
  },
  {
    name: "ALFA Omega 3.6.9 Flax Oil 1000 Mg",
    price: 23.6,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Alpha-Linolenic Acid (Omega-3) \\u2014 500 mg\\nLinoleic Acid (Omega-6) \\u2014 120 mg\\nOleic Acid (Omega-9) \\u2014 150 mg\\nOther Fatty Acids and Phytonutrients \\u2014 72 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "",
    notes: "Source URL field held page-title text instead of a link (\"Alfa 369 - Omega 369 - Flax Oil 1000 mg - 100 Softgels | Alfa Vitamins \u2013 Alfa Vitamins Store\") - left out. Labeled serving size: 1 softgel .",
  },
  {
    name: "ALFA Omega-3 Fish Oil 60 Softgels",
    price: 32,
    form: "Softgel",
    packSize: 60,
    ingredients: "[{\"name\": \"Fish oil 1,000 mg + omega-3 300 mg + EPA 180 mg + DHA 120 mg/softgel (60-count label)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/omega-3-fish-oil-1000-mg",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "ALFA Resveratrol 500 Mg 60 Caps",
    price: 48,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Polygonum cuspidatum extract 1,000 mg equivalent to 500 mg resveratrol/3 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/resveratrol",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Salmon Oil Omega 3 100 Softgels",
    price: 46,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Salmon oil 1,000 mg/softgel; EPA/DHA listed on label but exact amounts not captured\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/salmon-oil-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "ALFA Saw Palmetto 60 capsules",
    price: 22.74,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Saw palmetto extract 200 mg + saw palmetto powder 100 mg/2 capsules\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/saw-palmetto",
    notes: "Labeled serving size: 2 capsules.",
  },
  {
    name: "ALFA SELENIUM 200 MCG 100 CAPS",
    price: 24,
    form: "Capsule",
    packSize: 100,
    ingredients: "[{\"name\": \"Selenium 200 mcg/capsule (selenium amino acid chelate)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/selenium",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "ALFA Soy Lecithin Soy Bean 1200mg 100 Softgels",
    price: 38.4,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Soy lecithin 1,200 mg/softgel\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/soy-lecithin-1200-mg-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "ALFA SPIRULINA 2000mg 60 tabs",
    price: 20.9,
    form: "Tablet",
    packSize: 60,
    ingredients: "[]",
    sourceUrl: "",
    notes: "",
  },
  {
    name: "ALFA Super Gummy Bears 60 Gummies",
    price: 32.1,
    form: "Gummy",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin A (as retinyl acetate) \\u2014 1,248 IU\\nVitamin C (as ascorbic acid) \\u2014 9 mg\\nVitamin D (as cholecalciferol) \\u2014 30 IU\\nVitamin E (as dl-alpha tocopheryl acetate) \\u2014 7.5 IU\\nVitamin B6 (as pyridoxine hydrochloride) \\u2014 0.35 mg\\nFolate (as folic acid) \\u2014 120 mcg\\nVitamin B12 (as cyanocobalamin) \\u2014 2 mcg\\nBiotin \\u2014 30 mcg\\nVitamin B5 (as calcium pantothenate) \\u2014 2.5 mg\\nIodine (as potassium iodide) \\u2014 18.5 mcg\\nZinc (as zinc citrate) \\u2014 1.1 mg\\nCholine Bitartrate \\u2014 5 mcg\\nInositol \\u2014 5 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "",
    notes: "Source URL field held page-title text instead of a link (\"Multivitamin Gummy Bears - Kids Complete Vitamins \u2013 Alfa Vitamins Store\") - left out. Labeled serving size: 1 gummy.",
  },
  {
    name: "ALFA TURMERIC CURCUMIN 2000MG 90 CAPS",
    price: 38.5,
    form: "Capsule",
    packSize: 90,
    ingredients: "[{\"name\": \"Turmeric Powder (Curcuma longa L.) (root) \\u2014 1,800 mg\\nTurmeric Extract (Curcuma longa L.) (root) \\u2014 200 mg\\nBlack Pepper Powder (Piper nigrum) (fruit) \\u2014 10 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "",
    notes: "Labeled serving size: 3 capsules.",
  },
  {
    name: "ALFA Vitamin B-1 100 MG 100 TABS",
    price: 24.4,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B1 100 mg/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/vitamin-b1-supplement-blood-circulation-metabolism-digestive-system-muscle-antioxidant",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Vitamin B-2 50 Mg 100 Tablets",
    price: 20.36,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B2 (riboflavin) 50 mg/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/vitamin-b2",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Vitamin B-6 100 MG 100 TABLETS",
    price: 20.4,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B6 100 mg + calcium 48 mg/tablet\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/vitamin-b6-100mg-100-tabs",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "ALFA Vitamin E-400 100 Softgels",
    price: 40.1,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin E 180 mg (400 IU), dl-alpha tocopheryl acetate/softgel\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://alfavitamins.com/products/vitamin-e-400-iu-with-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural BERBERINE CEYLON CINNAMON COMPLEX 60 CAPSULES",
    price: 57.5,
    form: "Veggie Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"200 mg Berberine-Ceylon Complex + 2 mg BioPerine black pepper extract\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-berberine-ceylon-cinnamon-complex-spports-normal-glucose-metabolism-heart-health-weight-management-60-veggie-capsules",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Beta Carotene Vit A",
    price: 34.4,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A 3,750 mcg, as 100% beta-carotene\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-a-beta-carotene-25-000-iu-supports-healthy-vision-cell-function-immune-function-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Calcium 500+vit D3 - Oyster Shell 60 tabs",
    price: 16.4,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Calcium 500 mg from oyster shell + Vitamin D3 400 IU\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-calcium-500-mg-oyster-shell-with-vitamin-d3-strengthens-muscle-function-supports-healthy-bones-and-overall-health-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Calcium 600MG 100tab",
    price: 28,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Calcium 600 mg as calcium carbonate\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-calcium-600-mg-strengthens-muscle-function-supports-healthy-bones-and-overall-health-100-tablets/",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Calcium Citrate+vit.d3 60 Caplets",
    price: 27.3,
    form: "Caplet",
    packSize: 60,
    ingredients: "[{\"name\": \"Calcium 315 mg as calcium citrate + Vitamin D3 5 mcg (200 IU)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-calcium-citrate-plus-vitamin-d3-strengthens-muscle-function-supports-healthy-bones-and-overall-health-60-caplets/",
    notes: "Labeled serving size: 1 caplet.",
  },
  {
    name: "Mason Natural Calcium Magnesium Zinc100tab",
    price: 22.5,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Calcium 334 mg + Magnesium 134 mg + Zinc 5 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-calcium-magnesium-zinc-supports-healthy-bones-enhances-muscle-and-nerve-function-immune-system-booster-100-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Chewable Calcium 600 + Vitamin D3 100tab",
    price: 32,
    form: "Chewable",
    packSize: 100,
    ingredients: "[{\"name\": \"Calcium 600 mg + Vitamin D3 10 mcg (400 IU)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-calcium-600-mg-with-vitamin-d3-supports-healthy-bones-strengthens-muscle-function-coffee-mocha-flavor-100-chewables/",
    notes: "Labeled serving size: 1 chewable.",
  },
  {
    name: "Mason Natural Chewable Papaya 100tab",
    price: 21,
    form: "Chewable",
    packSize: 100,
    ingredients: "[{\"name\": \"Pancreatin 40 mg + Papain 10 mg + Papaya fruit powder 10 mg + Bromelain 6 mg + Amylase 4 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-papaya-digestive-enzyme-complex-healthy-digestive-function-promotes-nutrient-absorption-peach-flavor-100-chewables",
    notes: "Labeled serving size: 1 chewable.",
  },
  {
    name: "Mason Natural Chromium Picolinate 200mcg 100tab",
    price: 27.3,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Chromium 200 mcg as Chromax chromium picolinate + Calcium 51 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-chromium-picolinate-200-mcg-with-calcium-healthy-fat-metabolism-blood-sugar-support-100-tablets/",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Cod Liver Oil 100 Softgels",
    price: 34.5,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Cod liver oil 415 mg + Vitamin A 1,250 IU + Vitamin D3 135 IU\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-cod-liver-oil-plus-vitamin-a-d3-healthy-heart-and-brain-function-improved-immunity-supports-overall-health-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Daily Multi Vitamins Iron Free 100 Tabs",
    price: 24.5,
    form: "Caplet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin A \\u2014 900 mcg RAE (3,000 IU)\\nVitamin C \\u2014 60 mg\\nVitamin D3 (cholecalciferol) \\u2014 10 mcg (400 IU)\\nVitamin E \\u2014 13.5 mg (30 IU)\\nVitamin B1 (thiamine) \\u2014 1.5 mg\\nVitamin B2 (riboflavin) \\u2014 1.7 mg\\nNiacin \\u2014 20 mg NE\\nVitamin B6 \\u2014 2 mg\\nFolate \\u2014 667 mcg DFE (400 mcg folic acid)\\nVitamin B12 (cyanocobalamin) \\u2014 6 mcg\\nPantothenic Acid \\u2014 10 mg\\nCalcium \\u2014 21 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitrum-50-adult-multi-iron-free-vitamins-a-c-d-e-k-b-folate-calcium-iron-zinc-potassium-magnesium-100-tablets",
    notes: "Labeled serving size: 1 caplet.",
  },
  {
    name: "Mason Natural Fat Burner 60 Tab",
    price: "",
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Calcium \\u2014 180 mg\\nChromium \\u2014 200 mcg\\nGarcinia Cambogia \\u2014 500 mg\\nGriffonia Seed Extract \\u2014 50 mg\\nThermogenic Herbal Blend \\u2014 600 mg\\nYerba Mate Extract \\u2014 amount not individually stated\\nGuarana Seed Extract \\u2014 amount not individually stated (supplying 40 mg caffeine)\\nGreen Tea Extract \\u2014 amount not individually stated\\nGreen Coffee Extract \\u2014 amount not individually stated\\nCinnulin PF\\u00ae (cinnamon bark extract) \\u2014 amount not individually stated\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-fat-burner-with-garcinia-cambogia-chromium-picolinate-5-htp-thermogenic-herbals-appetite-suppressant-weight-loss-supplement-60-tablets",
    notes: "Price shown as 0 in the source file (likely not yet entered, not a genuine free price) - left blank. Labeled serving size: 2 tablets.",
  },
  {
    name: "Mason Natural Folic Acid 400mcg 100 tabs",
    price: 15.75,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Folic acid 400 mcg (667 mcg folate)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-folic-acid-400-mcg-100-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Ginger 500 Mg 60 Caps.",
    price: 22.2,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Whole herb ginger 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-whole-herb-ginger-500-mg-natural-herbal-supplement-60-capsules",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Highly Concentrated Cranberry with Probiotic 60 tabs",
    price: 40,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin C (as ascorbic acid) \\u2014 30 mg\\nCalcium (as dicalcium phosphate) \\u2014 80 mg\\nCranberry Fruit Concentrate (Vaccinium macrocarpon) \\u2014 480 mg\\n120 mg of 4:1 fruit concentrate\\nCranberry Fruit Powder \\u2014 20 mg\\nBacillus coagulans \\u2014 100 million CFU (at time of manufacture)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-cranberry-with-probiotic-calcium-and-vitamin-c-highly-concentrated-supports-antioxidant-and-immune-health-maintains-a-healthy-urinary-system-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Korean Ginseng 100 Caps",
    price: 31,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Korean ginseng 1,000 mg total: 600 mg red ginseng root + 400 mg white ginseng extract + Calcium 110 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-korean-ginseng-1000-mg-supports-overall-energy-and-performance-improved-endurance-and-vitality-60-tablets/",
    notes: "Labeled serving size: 1 daily serving.",
  },
  {
    name: "Mason Natural Little Animals Children's Chewable",
    price: 18.65,
    form: "Chewable",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin A \\u2014 750 mcg RAE (2,500 IU)\\nVitamin C \\u2014 60 mg\\nVitamin D \\u2014 10 mcg (400 IU)\\nVitamin E \\u2014 7 mg (15 IU)\\nVitamin B1 (thiamine) \\u2014 1.5 mg\\nVitamin B2 (riboflavin) \\u2014 1.2 mg\\nNiacin \\u2014 13.5 mg NE\\nVitamin B6 \\u2014 1.5 mg\\nFolate \\u2014 500 mcg DFE (300 mcg folic acid)\\nVitamin B12 \\u2014 4 mcg\\nTotal Carbohydrate \\u2014 <1 g\\nTotal Sugars \\u2014 <1 g\\nAdded Sugars \\u2014 1 g\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-little-animals-kids-chewable-multivitamins-animal-shaped-childrens-daily-multivitamin-with-vitamin-a-c-d-b1-b2-b3-b6-folate-b12-60-tablets",
    notes: "Labeled serving size: 1 chewable.",
  },
  {
    name: "Mason Natural Maca 500 Mg 60 Caps",
    price: 32,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Maca 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-maca-500-mg-improved-stamina-endurance-enhanced-performance-and-vitality-60-capsules/",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural MAGNESIUM CITRATE 250MG 60 SOFTGELS",
    price: 44,
    form: "Softgel",
    packSize: 60,
    ingredients: "[{\"name\": \"Magnesium citrate 250 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/magnesium-citrate-250-mg-fast-absorption-60softgels",
    notes: "Labeled serving size: 2 softgels.",
  },
  {
    name: "Mason Natural Magnesium Gluconate 550mg 100tab",
    price: 25.4,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"30 mg elemental magnesium (from 500 mg magnesium gluconate)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-magnesium-gluconate-550-mg-healthy-heart-and-nervous-system-improved-muscle-function-and-blood-pressure-levels-100-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural MAGNESIUM GLYCINATE with BIOPERINE 60 CAPSULES",
    price: 44.65,
    form: "Caplet",
    packSize: 60,
    ingredients: "[{\"name\": \"Magnesium glycinate 240 mg + BioPerine 2 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/collections/mason-natural-mineral-supplements",
    notes: "Labeled serving size: Not verified.",
  },
  {
    name: "Mason Natural MEGA BIOTIN 10000 MCG 50 SOFTGELS",
    price: 58.8,
    form: "Softgel",
    packSize: 50,
    ingredients: "[{\"name\": \"Biotin 10,000 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-mega-biotin-10000-mcg-extra-strength-beauty-supplement-for-healthy-hair-skin-nails-50-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Melatonin 3mg 60 Tabs",
    price: 21,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Melatonin 3 mg + Vitamin B6 1 mg + Calcium 55 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-melatonin-3-mg-with-b6-and-calcium-natural-sleep-aid-supports-healthy-sleep-rest-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Melatonin 5mg 60 Tabs",
    price: 29,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Melatonin 5 mg + Vitamin B6 1 mg + Calcium 55 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-melatonin-5-mg-with-b6-and-calcium-natural-sleep-aid-supports-healthy-sleep-rest-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Milk Thistle 500 Mg 60 Caps.",
    price: 28.3,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Milk thistle whole herb 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-milk-thistle-500-mg-support-healthy-liver-function-cleanse-and-detox-herbal-dietary-supplement-60-capsules",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Moringa 500mg 60caps",
    price: 40,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Moringa 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-moringa-500-mg-supports-energy-metabolism-and-inflammatory-response-antioxidant-immune-support-herbal-supplement-60-capsules/",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural MUSHROOM POWER EGCG & MATCHA 60 SOFTGELS",
    price: 89,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Calcium 50 mg + Green Tea Extract 300 mg (95% EGCG) + Shiitake 100 mg + Maitake 100 mg + Reishi 100 mg + Matcha 10 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://www.masonvitamins.com/products/mason-natural-mushroom-power-with-95-egcg-matcha-for-optimal-wellness-stress-support-and-healthy-inflammatory-response-60-plant-based-tablets/",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural N-Acetyl-L-Cysteine (NAC) 60 caps",
    price: 47,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"N-acetyl-L-cysteine 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-nac-n-acetyl-l-cysteine-500-mg-supports-cellular-health-immune-system-booster-for-general-wellness-60-capsules",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Odor Free Garlic 100cap",
    price: 20.6,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Garlic oil 500 mg (Allium sativum)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-garlic-oil-500-mg-odorless-allium-sativum-supplement-supports-healthy-circulatory-function-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Omega-3 Fish Oil 60 Caps",
    price: 33.1,
    form: "Softgel",
    packSize: 60,
    ingredients: "[{\"name\": \"Fish oil 1,000 mg providing EPA 180 mg + DHA 120 mg = 300 mg omega-3\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-fish-oil-1-000-mg-with-300-mg-omega-3-healthy-heart-supports-circulatory-function-improved-cardiovascular-health-60-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Selenium 200mcg 60tab",
    price: "",
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Selenium 200 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-selenium-200-mcg-antioxidant-supplement-for-immune-support-prostate-health-essential-trace-mineral-60-tablets/",
    notes: "Price shown as 0 in the source file (likely not yet entered, not a genuine free price) - left blank. Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Stress B-Complex 60 Tab",
    price: 29.55,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin C (as ascorbic acid) \\u2014 500 mg\\nVitamin E (as dl-alpha tocopheryl acetate) \\u2014 13.5 mg (30 IU)\\nVitamin B1 (as thiamine mononitrate) \\u2014 10 mg\\nVitamin B2 (riboflavin) \\u2014 10 mg\\nNiacin (as niacinamide) \\u2014 100 mg NE\\nVitamin B6 (as pyridoxine hydrochloride) \\u2014 5 mg\\nFolate \\u2014 667 mcg DFE (400 mcg folic acid)\\nVitamin B12 (as cyanocobalamin) \\u2014 12 mcg\\nBiotin \\u2014 45 mcg\\nPantothenic Acid (as d-calcium pantothenate) \\u2014 20 mg\\nCalcium (as dicalcium phosphate) \\u2014 77 mg\\nZinc (as zinc sulfate) \\u2014 24 mg\\nCopper (as cupric oxide) \\u2014 3 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-stress-b-complex-with-antioxidants-zinc-healthy-energy-metabolism-improved-immune-health-dual-action-formula-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural TURMERIC 500MG WITH BLACK PEPPER 60 SOFTGELS",
    price: 45,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Turmeric 500 mg total (450 mg turmeric powder + 50 mg turmeric extract) + BioPerine 2.5 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/turmeric-500-mg-with-bioperine",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Valerian Root 60 Cap",
    price: 24.1,
    form: "Capsule",
    packSize: 60,
    ingredients: "[{\"name\": \"Valerian root 500 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-valerian-root-500-mg-natural-sleep-aid-promotes-healthy-and-restful-sleep-herbal-supplement-60-capsules/",
    notes: "Labeled serving size: 1 capsule.",
  },
  {
    name: "Mason Natural Vitamin B-1 250mg 100 tabs",
    price: 37,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B1 (thiamine) 250 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-b1-thiamin-250-mg-healthy-conversion-of-food-into-energy-supports-nerve-and-immune-health-100-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin B12 100 mcg",
    price: 20.56,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B12 100 mcg + Calcium 83 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-b12-100-mcg-with-calcium-healthy-conversion-of-food-into-energy-supports-nerve-function-and-health-100-tablets/",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    price: 34,
    form: "Quick-Dissolve",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B12 1,000 mcg as cyanocobalamin\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-b12-1000-mcg-with-calcium-extended-release-healthy-conversion-of-food-into-energy-supports-nerve-function-and-health-200-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin B12 5,000 mcg Quick Dissolve",
    price: 30.5,
    form: "Quick-Dissolve",
    packSize: 30,
    ingredients: "[{\"name\": \"Vitamin B12 5,000 mcg as cyanocobalamin\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/collections/mason-natural-energy-metabolism-supplements/products/mason-natural-vitamin-b12-5-000-mcg-cyanocobalamin-supports-conversion-of-food-into-energy-dissolves-under-tongue-raspberry-flavor-30-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin B12 500 mcg",
    price: 30.8,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B12 500 mcg + Calcium 65 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-b12-500-mcg-with-calcium-healthy-conversion-of-food-into-energy-supports-nerve-function-and-health-100-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin B-6 50 Mg 100tab",
    price: 19.5,
    form: "Tablet",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin B6 50 mg as pyridoxine HCl + Calcium 36 mg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-b6-50-mg-with-calcium-healthy-heart-supports-muscle-and-nerve-function-improved-energy-metabolism-100-tablets/",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin C 1,000 mg plus Rose Hips and Bioflavonoids Complex 60 tablets",
    price: 37,
    form: "Tablet",
    packSize: 60,
    ingredients: "[{\"name\": \"Vitamin C 1,000 mg as ascorbic acid + 64 mg of blend: rose hips/citrus bioflavonoids/rutin/acerola/hesperidin\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-c-1-000-mg-plus-rose-hips-and-bioflavonoids-complex-supports-a-healthy-immune-system-antioxidant-and-essential-nutrient-60-tablets",
    notes: "Labeled serving size: 1 tablet.",
  },
  {
    name: "Mason Natural Vitamin D3 1000 CHEWABLE Tabs",
    price: 29,
    form: "Chewable",
    packSize: 50,
    ingredients: "[{\"name\": \"Vitamin D3 25 mcg (1,000 IU)\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-d3-25-mcg-1000-iu-supports-overall-health-strengthens-bones-and-muscles-peach-vanilla-flavor-50-chewables",
    notes: "Labeled serving size: 1 chewable.",
  },
  {
    name: "Mason Natural Vitamin E-1000 50 Softgels",
    price: 45,
    form: "Softgel",
    packSize: 50,
    ingredients: "[{\"name\": \"Vitamin E 450 mg (1,000 IU) as dl-alpha tocopheryl acetate\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-e-450-mg-1-000-iu-antioxidant-and-essential-nutrient-healthy-immune-system-skin-and-eyes-whole-body-supplement-50-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Vitamin E-400 *100 Softgels",
    price: 34,
    form: "Softgel",
    packSize: 100,
    ingredients: "[{\"name\": \"Vitamin E 180 mg (400 IU) as dl-alpha tocopheryl acetate\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-vitamin-e-180-mg-400-iu-antioxidant-and-essential-nutrient-healthy-immune-system-skin-and-eyes-whole-body-supplement-100-softgels",
    notes: "Labeled serving size: 1 softgel.",
  },
  {
    name: "Mason Natural Women's Daily Formula 90caplets",
    price: 32,
    form: "Caplet",
    packSize: 90,
    ingredients: "[{\"name\": \"Vitamin A \\u2014 750 mcg RAE (2,500 IU)\\nVitamin C (as ascorbic acid) \\u2014 60 mg\\nVitamin D3 (cholecalciferol) \\u2014 25 mcg (1,000 IU)\\nVitamin E (d-alpha tocopheryl acetate) \\u2014 10 mg (22.5 IU)\\nVitamin K (phytonadione) \\u2014 25 mcg\\nVitamin B1 (thiamine mononitrate) \\u2014 1.5 mg\\nVitamin B2 (riboflavin) \\u2014 1.7 mg\\nNiacinamide (Vitamin B3) \\u2014 10 mg NE\\nVitamin B6 (pyridoxine hydrochloride) \\u2014 2 mg\\nFolate \\u2014 667 mcg DFE (400 mcg folic acid)\\nVitamin B12 (cyanocobalamin) \\u2014 6 mcg\\nBiotin \\u2014 30 mcg\\nPantothenic Acid (d-calcium pantothenate) \\u2014 5 mg\\nCalcium (calcium carbonate) \\u2014 500 mg\\nIron (ferrous fumarate) \\u2014 18 mg\\nMagnesium (magnesium oxide) \\u2014 50 mg\\nZinc (zinc oxide) \\u2014 15 mg\\nSelenium (sodium selenate) \\u2014 20 mcg\\nCopper (cupric sulfate) \\u2014 2 mg\\nManganese (sulfate) \\u2014 2 mg\\nChromium (chromic chloride) \\u2014 120 mcg\", \"form\": \"\", \"amount\": \"\", \"unit\": \"\"}]",
    sourceUrl: "https://masonnatural.com/products/mason-natural-womens-daily-multi-formula-with-21-essential-vitamins-and-nutrients-supports-general-wellness-and-overall-health-90-caplets",
    notes: "Labeled serving size: 1 caplet.",
  },
];


// The Mason B12 rows (100 mcg / 500 mcg / 1,000 mcg / 5,000 mcg) now carry
// full research data too, and flow through the normal new-products loop
// above like everything else — their raw name text ("...Sublingual...")
// is overridden to the already-established canonical catalog name so
// reconcileRecordFields() matches and reconciles them there (an earlier
// version of this file had no dose/serving/form data for Mason at all,
// which is why they used to need bespoke handling here; that data — and
// with it, an earlier "Sublingual vs Quick-Dissolve" conflict this seed
// used to record from name-text alone — turned out to just be incomplete,
// not a real disagreement, once the real "Dosage form" column came in).
//
// ALFA B-Complex Formula still needs its own entry: the new source gives
// every ingredient's exact amount (including the B12 amount, 10 mcg — one
// of the two facts the original seed explicitly flagged as missing), and
// filling that in also means updating the RecallProductIngredients link's
// compoundAmount, which the generic ProductCatalog-only reconciliation
// above doesn't touch.
const OUR_PRODUCTS_EXISTING_MATCH_ENRICHMENTS = {
  "ALFA B-Complex Formula": {
    ingredients: JSON.stringify([
      { name: "Thiamine", form: "", amount: 10, unit: "mg" },
      { name: "Riboflavin", form: "", amount: 10, unit: "mg" },
      { name: "Niacinamide", form: "", amount: 40, unit: "mg" },
      { name: "Vitamin B6", form: "", amount: 10, unit: "mg" },
      { name: "Folic Acid", form: "", amount: 400, unit: "mcg" },
      { name: "Vitamin B12", form: "", amount: 10, unit: "mcg" },
      { name: "Biotin", form: "", amount: 300, unit: "mcg" },
      { name: "Pantothenate", form: "", amount: 10, unit: "mg" },
    ]),
    notesAppend: "Ingredient amounts confirmed via Mason/ALFA product list import (per tablet). Folate labeled as 680 mcg DFE (400 mcg folic acid) — folic acid amount recorded as 400 mcg.",
    linkCompoundAmount: 10,
    linkUnit: "mcg",
  },
};

// Corrected knowledge, not a second disagreeing source: a field where an
// earlier seed run (or a pre-existing live record) may still hold a value
// that's since been directly confirmed wrong by the person who owns this
// data. Applied during reconciliation below instead of left as an open
// CONFLICT for a manager to click through -- but still recorded (as an
// already-RESOLVED conflict, both values kept) rather than silently
// overwritten with no trace.
const OUR_PRODUCTS_CONFIRMED_RESOLUTIONS = [
  {
    productName: "Mason Natural Vitamin B12 1,000 mcg Quick Dissolve",
    fieldName: "price",
    confirmedValue: 34,
    resolution: "31.12 was the pre-VAT price; 34 is the real tax-inclusive (TTC) selling price used throughout the Mason/ALFA import (31.12 x 1.11 VAT ~= 34) -- confirmed directly, not a genuine second source.",
  },
];

let ourProductsMasterDataSeedChecked = false;
async function ensureOurProductsMasterDataSeeded() {
  if (ourProductsMasterDataSeedChecked) return;
  // Self-sufficient for the same reason as ensureCompetitorMasterDataSeeded
  // above — the enrichment/conflict matching below needs the B12 seed's
  // Mason/ALFA catalog rows to already exist.
  await ensureRecallCategoriesSeeded();
  await ensureRecallB12Seeded();
  await ensureB12ProductDataSeeded();
  const norm = (s) => String(s || "").trim().toLowerCase();

  const catalog = await db.getAllRows("ProductCatalog");
  const catalogIdByName = new Map(catalog.map((p) => [norm(p.name), p.id]));

  // ---- New products: reconcile a name match instead of skipping ----
  // A match here can be an earlier seed's own row OR pre-existing data that
  // predates any of this — either way, fill in whatever's still blank
  // rather than treating "already exists" as "nothing more to learn".
  const existingConflictRowsPC = await db.getAllRows("RecallFieldConflicts");
  const existingConflictKeysPC = new Set(existingConflictRowsPC.map((c) => `${c.entityType}|${c.entityId}|${c.fieldName}`));
  const newRows = [];
  const reconcilePatchesPC = [];
  const newConflictRowsPC = [];
  for (const item of OUR_PRODUCTS_MASTER_SEED) {
    const existingId = catalogIdByName.get(norm(item.name));
    if (existingId) {
      const existingRow = catalog.find((p) => p.id === existingId);
      if (existingRow) {
        const { patch, conflicts } = reconcileRecordFields({
          entityType: "ProductCatalog", entityId: existingId, existing: existingRow,
          incoming: { price: item.price, form: item.form, packSize: item.packSize },
          sourceLabel: "Mason/ALFA product list import", existingConflictKeys: existingConflictKeysPC,
        });
        // Apply any confirmed correction directly instead of leaving it as
        // an open conflict — see OUR_PRODUCTS_CONFIRMED_RESOLUTIONS above.
        const settledConflicts = conflicts.map((conflict) => {
          const resolved = OUR_PRODUCTS_CONFIRMED_RESOLUTIONS.find(
            (r) => norm(r.productName) === norm(item.name) && r.fieldName === conflict.fieldName
          );
          if (!resolved) return conflict;
          patch[conflict.fieldName] = resolved.confirmedValue;
          return {
            ...conflict, status: "RESOLVED", resolution: resolved.resolution,
            resolvedBy: "Mason/ALFA product list import (confirmed)", resolvedAt: new Date().toISOString(),
          };
        });
        // Ingredients is a JSON array, not a plain field — handled
        // separately so an existing "[]" (semantically empty) doesn't get
        // treated as a filled value by the generic string comparison above.
        const currentIngredients = (() => { try { return JSON.parse(existingRow.ingredients || "[]"); } catch { return []; } })();
        if (currentIngredients.length === 0 && item.ingredients) patch.ingredients = item.ingredients;
        if (Object.keys(patch).length) {
          patch.updatedBy = "Mason/ALFA product list import"; patch.updatedAt = new Date().toISOString();
          reconcilePatchesPC.push({ id: existingId, patch });
        }
        newConflictRowsPC.push(...settledConflicts);
      }
      continue;
    }
    newRows.push({
      id: `pc${crypto.randomUUID()}`, name: item.name, price: item.price,
      form: item.form, packSize: item.packSize, unitsPerDay: "",
      ingredients: item.ingredients, notes: item.notes,
      createdBy: "Mason/ALFA product list import", createdAt: new Date().toISOString(),
      updatedBy: "", updatedAt: "",
    });
  }
  if (newRows.length) await db.appendRows("ProductCatalog", newRows);
  for (const { id, patch } of reconcilePatchesPC) await db.updateRowById("ProductCatalog", id, patch);
  if (newConflictRowsPC.length) await db.appendRows("RecallFieldConflicts", newConflictRowsPC);

  // ---- Enrichment: fill blank fields on an already-existing product ----
  for (const [productName, enrich] of Object.entries(OUR_PRODUCTS_EXISTING_MATCH_ENRICHMENTS)) {
    const productId = catalogIdByName.get(norm(productName));
    if (!productId) continue;
    const product = catalog.find((p) => p.id === productId);
    const currentIngredients = (() => { try { return JSON.parse(product.ingredients || "[]"); } catch { return []; } })();
    const hasAnyAmount = currentIngredients.some((i) => i.amount !== "" && i.amount != null);
    const patch = {};
    if (!hasAnyAmount) {
      patch.ingredients = enrich.ingredients;
      patch.notes = [product.notes, enrich.notesAppend].filter(Boolean).join(" ");
    }
    if (Object.keys(patch).length) {
      patch.updatedBy = "Mason/ALFA product list import";
      patch.updatedAt = new Date().toISOString();
      await db.updateRowById("ProductCatalog", productId, patch);
    }

    const links = await db.getAllRows("RecallProductIngredients");
    const link = links.find((l) => l.productId === productId);
    if (link && !isFieldFilled(link.compoundAmount) && enrich.linkCompoundAmount) {
      await db.updateRowById("RecallProductIngredients", link.id, {
        compoundAmount: enrich.linkCompoundAmount, unit: enrich.linkUnit,
      });
      await recomputeOurProductResearchStatus(link.id);
    }
  }

  ourProductsMasterDataSeedChecked = true;
}

// ---------- Recall Phase 2D: research status derivation + editing ----------
// A record's researchStatus/missingFields are ALWAYS derived here from its
// own current field values — never accepted verbatim from a client patch.
// This is what keeps "VERIFIED" meaningful (a manager can't just declare
// it) and keeps the missing-information checklist honest as fields get
// filled in. These required-field lists are this phase's own definition —
// the architecture didn't previously specify one — and are disclosed here
// (and in the implementation report) for review/override.
const OUR_PRODUCT_REQUIRED_FIELDS = [
  { key: "chemicalForm", label: "chemical form" },
  { key: "compoundAmount", label: "amount" },
  { key: "dosageForm", label: "dosage form" },
  { key: "servingSize", label: "serving size" },
  { key: "dailyAmount", label: "recommended daily use" },
  { key: "ingredients", label: "complete ingredients" },
  { key: "sourceUrl", label: "manufacturer source URL" },
  { key: "sku", label: "SKU" },
];
const COMPETITOR_PRODUCT_REQUIRED_FIELDS = [
  { key: "genericName", label: "chemical form" },
  { key: "dosage", label: "amount" },
  { key: "form", label: "dosage form" },
  { key: "packSize", label: "pack size" },
  { key: "ingredients", label: "complete ingredients" },
  { key: "sourceUrl", label: "manufacturer source URL" },
  { key: "sku", label: "SKU" },
];

function isFieldFilled(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "[]";
  return true;
}

// hasOpenConflict: true if any RecallFieldConflicts row for this record still
// has status "CONFLICT" (not yet resolved).
function deriveResearchStatus(record, requiredFields, hasOpenConflict) {
  if (hasOpenConflict) return "CONFLICT";
  const presentCount = requiredFields.filter((f) => isFieldFilled(record[f.key])).length;
  if (presentCount === 0) return "INCOMPLETE";
  if (presentCount === requiredFields.length) return "VERIFIED";
  return "PARTIALLY_VERIFIED";
}

function computeMissingFieldLabels(record, requiredFields, extra = []) {
  const missing = requiredFields.filter((f) => !isFieldFilled(record[f.key])).map((f) => f.label);
  extra.forEach(({ present, label }) => { if (!present) missing.push(label); });
  return missing;
}

function conflictsFor(allConflicts, entityType, entityId) {
  return allConflicts.filter((c) => c.entityType === entityType && c.entityId === entityId);
}

function hasOpenConflictOn(allConflicts, entityType, entityId, fieldName) {
  return allConflicts.some((c) => c.entityType === entityType && c.entityId === entityId && c.status === "CONFLICT" && (!fieldName || c.fieldName === fieldName));
}

// Recomputes and persists researchStatus/missingFields for a competitor
// product from its OWN current row data plus whether any retailer listing
// for it has a sourceUrl (retailer source is tracked as a missing-info item
// even though it isn't one of the fields that gates VERIFIED status — a
// manufacturer-only reference product, per Phase 2C, legitimately has none).
async function recomputeCompetitorResearchStatus(id) {
  const [products, conflicts, listings] = await Promise.all([
    db.getAllRows("CompetitorProducts"),
    db.getAllRows("RecallFieldConflicts"),
    db.getAllRows("RecallRetailerListings"),
  ]);
  const product = products.find((p) => p.id === id);
  if (!product) return null;
  const hasConflict = hasOpenConflictOn(conflicts, "CompetitorProducts", id);
  const researchStatus = deriveResearchStatus(product, COMPETITOR_PRODUCT_REQUIRED_FIELDS, hasConflict);
  const hasRetailerSource = listings.some((l) => l.competitorProductId === id && String(l.sourceUrl || "").trim());
  const missingFields = computeMissingFieldLabels(product, COMPETITOR_PRODUCT_REQUIRED_FIELDS, [
    { present: hasRetailerSource, label: "retailer source URL" },
  ]).join(", ");
  await db.updateRowById("CompetitorProducts", id, { researchStatus, missingFields });
  return { researchStatus, missingFields };
}

// Same idea for an our-product link — merges the RecallProductIngredients
// row with its ProductCatalog row's shared fields (dosage form/ingredients
// live on ProductCatalog, not the link) before deriving status.
async function recomputeOurProductResearchStatus(linkId) {
  const [links, catalog, conflicts] = await Promise.all([
    db.getAllRows("RecallProductIngredients"),
    db.getAllRows("ProductCatalog"),
    db.getAllRows("RecallFieldConflicts"),
  ]);
  const link = links.find((l) => l.id === linkId);
  if (!link) return null;
  const product = catalog.find((p) => p.id === link.productId);
  const merged = { ...link, dosageForm: product?.form || "", ingredients: product?.ingredients || "", sku: product?.sku || "" };
  const hasConflict = hasOpenConflictOn(conflicts, "RecallProductIngredients", linkId) || hasOpenConflictOn(conflicts, "ProductCatalog", link.productId);
  const researchStatus = deriveResearchStatus(merged, OUR_PRODUCT_REQUIRED_FIELDS, hasConflict);
  const missingFields = computeMissingFieldLabels(merged, OUR_PRODUCT_REQUIRED_FIELDS).join(", ");
  await db.updateRowById("RecallProductIngredients", linkId, { verificationStatus: researchStatus, missingFields });
  return { researchStatus, missingFields };
}

// One combined read per page load (categories + the three empty-for-now
// knowledge tabs used to compute counts), rather than one Sheets call per
// category — the whole point of Phase J's performance rule.
app.get("/api/recall/categories", async (req, res) => {
  try {
    await ensureRecallCategoriesSeeded();
    await ensureRecallB12Seeded();
    await ensureB12ProductDataSeeded();
    await ensureCompetitorMasterDataSeeded();
    await ensureOurProductsMasterDataSeeded();
    const [categories, ingredients, productIngredients, evidence, assignments] = await Promise.all([
      db.getAllRows("RecallCategories"),
      db.getAllRows("RecallIngredients"),
      db.getAllRows("RecallProductIngredients"),
      db.getAllRows("RecallClinicalEvidence"),
      req.repName ? db.getAllRows("RepCategoryAssignments") : Promise.resolve([]),
    ]);
    const ingredientIdsByCategory = new Map();
    ingredients.forEach((ing) => {
      const list = ingredientIdsByCategory.get(ing.categoryId) || [];
      list.push(ing.id);
      ingredientIdsByCategory.set(ing.categoryId, list);
    });
    const result = categories
      .filter((c) => c.active !== "false")
      .sort((a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0))
      .map((c) => {
        const ingredientIds = new Set(ingredientIdsByCategory.get(c.id) || []);
        const productIds = new Set(
          productIngredients.filter((pi) => ingredientIds.has(pi.ingredientId)).map((pi) => pi.productId)
        );
        const evidenceCount = evidence.filter((e) => ingredientIds.has(e.ingredientId)).length;
        return {
          id: c.id, name: c.name, description: c.description || "", displayOrder: Number(c.displayOrder) || 0,
          productCount: productIds.size,
          knowledgeCount: ingredientIds.size,
          evidenceCount,
        };
      });
    const myAssignedCategoryIds = req.repName
      ? assignments.filter((a) => a.repId === req.repName).map((a) => a.categoryId)
      : [];
    res.json({ categories: result, myAssignedCategoryIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// A single detail bundle for one category — every section the category
// page needs, computed from currently-empty tables. Sections legitimately
// show real empty arrays right now; the client renders each as an
// empty-state message rather than fabricating placeholder content.
app.get("/api/recall/categories/:id", async (req, res) => {
  try {
    await ensureRecallCategoriesSeeded();
    await ensureRecallB12Seeded();
    await ensureB12ProductDataSeeded();
    await ensureCompetitorMasterDataSeeded();
    await ensureOurProductsMasterDataSeeded();
    const [categories, ingredients, forms, productIngredients, evidence, interactions, quiz, catalog, competitorRels, competitorProducts, retailerListings, fieldConflicts, sources] = await Promise.all([
      db.getAllRows("RecallCategories"),
      db.getAllRows("RecallIngredients"),
      db.getAllRows("RecallIngredientForms"),
      db.getAllRows("RecallProductIngredients"),
      db.getAllRows("RecallClinicalEvidence"),
      db.getAllRows("RecallDrugInteractions"),
      db.getAllRows("RecallQuizQuestions"),
      db.getAllRows("ProductCatalog"),
      db.getAllRows("RecallCompetitorRelationships"),
      db.getAllRows("CompetitorProducts"),
      db.getAllRows("RecallRetailerListings"),
      db.getAllRows("RecallFieldConflicts"),
      db.getAllRows("RecallResearchSources"),
    ]);
    const category = categories.find((c) => c.id === req.params.id);
    if (!category) return res.status(404).json({ error: "Recall category not found." });

    const categoryIngredients = ingredients.filter((ing) => ing.categoryId === category.id);
    const ingredientIds = new Set(categoryIngredients.map((ing) => ing.id));
    const ingredientForms = forms.filter((f) => ingredientIds.has(f.ingredientId));
    const links = productIngredients.filter((pi) => ingredientIds.has(pi.ingredientId));
    const linkByProductId = new Map(links.map((pi) => [pi.productId, pi]));
    const productIds = new Set(links.map((pi) => pi.productId));
    const splitFields = (s) => (s ? s.split(",").map((v) => v.trim()).filter(Boolean) : []);
    // Our products, enriched with this category's ingredient-link facts
    // (amount, chemical form, research status, missing fields, edit
    // metadata) — additive fields on top of the raw ProductCatalog row, not
    // a replacement for it. researchStatus/missingFields are DERIVED live
    // from current data on every read (Phase 2D), not just whatever was
    // last written, so the checklist can never go stale.
    const products = catalog.filter((p) => productIds.has(p.id)).map((p) => {
      const link = linkByProductId.get(p.id);
      // sku lives on the ProductCatalog row itself (p.sku, already present
      // via the ...p spread below) — also editable under Settings ->
      // Product Catalog — not on the Recall-specific link.
      const merged = { ...(link || {}), dosageForm: p.form || "", ingredients: p.ingredients || "", sku: p.sku || "" };
      const hasConflict = hasOpenConflictOn(fieldConflicts, "RecallProductIngredients", link?.id) || hasOpenConflictOn(fieldConflicts, "ProductCatalog", p.id);
      const researchStatus = link ? deriveResearchStatus(merged, OUR_PRODUCT_REQUIRED_FIELDS, hasConflict) : "";
      const missingFields = link ? computeMissingFieldLabels(merged, OUR_PRODUCT_REQUIRED_FIELDS) : [];
      return {
        ...p,
        linkId: link?.id || "",
        chemicalForm: link?.chemicalForm || "",
        compoundAmount: link?.compoundAmount || "",
        unit: link?.unit || "",
        servingSize: link?.servingSize || "",
        dailyAmount: link?.dailyAmount || "",
        manufacturer: link?.manufacturer || "",
        sourceLabel: link?.sourceLabel || "",
        sourceUrl: link?.sourceUrl || "",
        verificationStatus: researchStatus,
        linkNotes: link?.notes || "",
        missingFields,
        conflicts: [
          ...conflictsFor(fieldConflicts, "RecallProductIngredients", link?.id),
          ...conflictsFor(fieldConflicts, "ProductCatalog", p.id),
        ],
      };
    });
    // Competitor products linked to this category via a comparison
    // relationship to one of our products above — enriched with the full
    // competitor product record and its retailer listings (never an
    // availability/stock field; see RecallRetailerListings schema comment).
    const competitorProductById = new Map(competitorProducts.map((p) => [p.id, p]));
    const listingsByCompetitorId = new Map();
    retailerListings.forEach((l) => {
      const list = listingsByCompetitorId.get(l.competitorProductId) || [];
      list.push(l);
      listingsByCompetitorId.set(l.competitorProductId, list);
    });
    const competitors = competitorRels
      .filter((r) => productIds.has(r.ourProductId))
      .map((r) => {
        const cp = competitorProductById.get(r.competitorProductId);
        const cpListings = listingsByCompetitorId.get(r.competitorProductId) || [];
        const hasRetailerSource = cpListings.some((l) => String(l.sourceUrl || "").trim());
        const hasConflict = cp ? hasOpenConflictOn(fieldConflicts, "CompetitorProducts", cp.id) : false;
        const researchStatus = cp ? deriveResearchStatus(cp, COMPETITOR_PRODUCT_REQUIRED_FIELDS, hasConflict) : "";
        const missingFields = cp
          ? computeMissingFieldLabels(cp, COMPETITOR_PRODUCT_REQUIRED_FIELDS, [{ present: hasRetailerSource, label: "retailer source URL" }])
          : [];
        return {
          id: r.id,
          comparisonType: r.comparisonType,
          notes: r.notes || "",
          ourProductId: r.ourProductId,
          competitorProduct: cp
            ? {
                id: cp.id, competitorName: cp.competitorName, productName: cp.productName,
                genericName: cp.genericName || "", form: cp.form || "", dosage: cp.dosage || "", packSize: cp.packSize || "",
                ingredients: cp.ingredients || "", sku: cp.sku || "", manufacturer: cp.manufacturer || "",
                sourceLabel: cp.sourceLabel || "", sourceUrl: cp.sourceUrl || "",
                researchStatus, notes: cp.notes || "",
                missingFields,
                conflicts: conflictsFor(fieldConflicts, "CompetitorProducts", cp.id),
              }
            : null,
          retailerListings: cpListings.map((l) => ({
            id: l.id, retailer: l.retailer, displayedPrice: l.displayedPrice, currency: l.currency,
            sourceUrl: l.sourceUrl || "", notes: l.notes || "",
          })),
        };
      })
      .filter((c) => c.competitorProduct);
    const categoryEvidence = evidence.filter((e) => ingredientIds.has(e.ingredientId));
    const categoryInteractions = interactions.filter((i) => ingredientIds.has(i.ingredientId));
    const categoryQuiz = quiz.filter((q) => q.categoryId === category.id && q.active !== "false");

    // A compact study-citation list, not a copy of the evidence section —
    // only sources with a real PMID (an actual PubMed/NCBI study, not a
    // fact-sheet/internal reference) that this category's evidence
    // actually cites. studyType/key finding are pulled from the linked
    // RecallClinicalEvidence row(s) already on file — nothing new
    // researched or invented here, just surfaced as its own compact list
    // with a link out to the real source instead of buried in prose.
    const categorySourceIds = new Set(categoryEvidence.map((e) => e.sourceId).filter(Boolean));
    const references = sources
      .filter((s) => categorySourceIds.has(s.id) && String(s.pmid || "").trim())
      .map((s) => {
        const relatedEvidence = categoryEvidence.filter((e) => e.sourceId === s.id);
        return {
          id: s.id,
          title: s.title,
          pmid: s.pmid,
          url: s.url || `https://pubmed.ncbi.nlm.nih.gov/${s.pmid}/`,
          sourceName: s.sourceName || "",
          journal: s.journal || "",
          publicationYear: s.publicationYear || "",
          studyType: relatedEvidence.find((e) => e.studyType)?.studyType || "",
          keyFinding: relatedEvidence.map((e) => e.result).filter(Boolean).join(" ") || "",
        };
      });

    res.json({
      category: { id: category.id, name: category.name, description: category.description || "" },
      ingredients: categoryIngredients,
      ingredientForms,
      products,
      competitors,
      evidence: categoryEvidence,
      interactions: categoryInteractions,
      references,
      quizAvailable: categoryQuiz.length > 0,
      quizQuestionCount: categoryQuiz.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/recall/assignments", requireManager, async (req, res) => {
  try {
    const { repName } = req.query;
    if (!repName) return res.status(400).json({ error: "repName is required" });
    const assignments = await db.getAllRows("RepCategoryAssignments");
    const categoryIds = assignments.filter((a) => a.repId === repName).map((a) => a.categoryId);
    res.json({ categoryIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Replace-set semantics, matching the checkbox-list UI a manager actually
// uses (pick a rep, check/uncheck boxes, Save) — simpler and less
// error-prone than separate add/remove endpoints, and only ever touches
// this one rep's rows; every other rep's assignments are left untouched.
app.post("/api/recall/assignments", requireManager, async (req, res) => {
  try {
    const { repName, categoryIds } = req.body;
    if (!repName) return res.status(400).json({ error: "repName is required" });
    const validCategoryIds = new Set(RECALL_CATEGORIES_SEED.map((c) => c.id));
    const cleanIds = [...new Set(Array.isArray(categoryIds) ? categoryIds : [])].filter((id) => validCategoryIds.has(id));

    const existing = await db.getAllRows("RepCategoryAssignments");
    const keptForOtherReps = existing.filter((a) => a.repId !== repName);
    const now = new Date().toISOString();
    const newRowsForThisRep = cleanIds.map((categoryId) => ({
      id: `rca${crypto.randomUUID()}`,
      repId: repName,
      categoryId,
      assignedBy: req.repName || "Manager",
      createdAt: now,
    }));
    await db.replaceAllRows("RepCategoryAssignments", [...keptForOtherReps, ...newRowsForThisRep]);
    res.json({ ok: true, count: newRowsForThisRep.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// The only four sources approved for the Lebanese competitor-product
// research effort. A listing naming anything else is rejected outright —
// this is the actual enforcement of "approved sources," not just a comment.
const APPROVED_RETAILERS = ["Skin Society", "Mazen Online", "Nicolas Care", "Sohati Care"];

app.get("/api/recall/retailer-listings", async (req, res) => {
  try {
    const { competitorProductId } = req.query;
    const listings = await db.getAllRows("RecallRetailerListings");
    const filtered = competitorProductId ? listings.filter((l) => l.competitorProductId === competitorProductId) : listings;
    res.json({ listings: filtered });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// One row per (competitor master product × retailer) — see the schema
// comment in sheetsDb.js. Deliberately reads only the fields named here:
// a caller sending "availability"/"inStock"/etc. in the body has it
// silently ignored, the same allowlist enforcement used for competitor
// products above. sourceUrl is a citation, not a live connection — no
// polling or refresh job ever touches this table.
// Open to any authenticated employee (not just managers) — completing
// Lebanese competitor research is explicitly a shared rep+manager task;
// this table only ever attaches to CompetitorProducts, never to our own
// products, so it can't be used to touch the (still manager-only) Product
// Catalog.
app.post("/api/recall/retailer-listings", async (req, res) => {
  try {
    const { competitorProductId, retailer, sourceUrl, displayedPrice, currency, researchDate, notes } = req.body;
    if (!competitorProductId || !String(competitorProductId).trim()) return res.status(400).json({ error: "competitorProductId is required." });
    if (!APPROVED_RETAILERS.includes(retailer)) {
      return res.status(400).json({ error: `retailer must be one of: ${APPROVED_RETAILERS.join(", ")}` });
    }
    if (!sourceUrl || !String(sourceUrl).trim()) return res.status(400).json({ error: "sourceUrl is required — a listing is only as good as its citation." });

    const competitorProducts = await db.getAllRows("CompetitorProducts");
    if (!competitorProducts.some((p) => p.id === competitorProductId)) {
      return res.status(404).json({ error: "That competitor product doesn't exist — add the master product first." });
    }

    const listing = {
      id: `rl${crypto.randomUUID()}`,
      competitorProductId,
      retailer,
      sourceUrl: String(sourceUrl).trim(),
      displayedPrice: displayedPrice === "" || displayedPrice == null ? "" : Number(displayedPrice),
      currency: currency || "",
      researchDate: researchDate || new Date().toISOString().slice(0, 10),
      notes: notes || "",
      createdBy: req.repName || "Manager",
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("RecallRetailerListings", listing);
    res.json(listing);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/recall/field-conflicts", async (req, res) => {
  try {
    const { entityType, entityId } = req.query;
    const conflicts = await db.getAllRows("RecallFieldConflicts");
    const filtered = conflicts.filter((c) => (!entityType || c.entityType === entityType) && (!entityId || c.entityId === entityId));
    res.json({ conflicts: filtered });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Recording a conflict always keeps BOTH source values — there is no code
// path here that lets one source's value silently win. If a caller can't
// supply two distinct sourced values, it isn't a conflict; it's a single
// (possibly still-unverified) value on the record itself.
// Any employee can record a conflict found on COMPETITOR research (shared
// task); a conflict on OUR products (ProductCatalog/RecallProductIngredients)
// stays manager-only, same as editing those records directly.
app.post("/api/recall/field-conflicts", async (req, res) => {
  try {
    const { entityType, entityId, fieldName, sourceALabel, sourceAValue, sourceBLabel, sourceBValue, notes } = req.body;
    if (!entityType || !entityId || !fieldName) return res.status(400).json({ error: "entityType, entityId, and fieldName are required." });
    if (entityType !== "CompetitorProducts" && req.role !== "manager") {
      return res.status(403).json({ error: "Managers only." });
    }
    if (sourceAValue === undefined || sourceAValue === null || sourceAValue === "" || sourceBValue === undefined || sourceBValue === null || sourceBValue === "") {
      return res.status(400).json({ error: "Both sourceAValue and sourceBValue are required — a conflict needs two disagreeing sourced values, not one." });
    }
    const conflict = {
      id: `fc${crypto.randomUUID()}`,
      entityType, entityId, fieldName,
      sourceALabel: sourceALabel || "", sourceAValue: String(sourceAValue),
      sourceBLabel: sourceBLabel || "", sourceBValue: String(sourceBValue),
      status: "CONFLICT",
      notes: notes || "",
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("RecallFieldConflicts", conflict);
    res.json(conflict);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Recall research/edit routes ----------
// These are DELIBERATELY separate from the app's existing, rep-open
// /api/competitor-products/:id and /api/product-catalog/:id routes (used
// for the day-to-day shared price list) — kept as their own routes so
// Recall's derived-status/missing-fields recompute always runs on save.
// Competitor research is open to any employee (any authenticated user
// reaches this line — see requireAuth mounted globally at the top of the
// file); OUR products (Product Catalog) stay manager-only below.
const RECALL_COMPETITOR_RESEARCH_FIELDS = ["genericName", "form", "dosage", "packSize", "manufacturer", "sku", "sourceLabel", "sourceUrl", "notes"];

app.patch("/api/recall/competitor-research/:id", async (req, res) => {
  try {
    const products = await db.getAllRows("CompetitorProducts");
    const existing = products.find((p) => p.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Competitor product not found." });

    const patch = {};
    for (const key of RECALL_COMPETITOR_RESEARCH_FIELDS) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (req.body.ingredients !== undefined) patch.ingredients = normalizeIngredients(req.body.ingredients);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No editable fields provided." });
    patch.updatedBy = req.repName || "Manager";
    patch.updatedAt = new Date().toISOString();

    await db.updateRowById("CompetitorProducts", req.params.id, patch);
    const derived = await recomputeCompetitorResearchStatus(req.params.id);
    res.json({ ok: true, ...derived });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Edits an "our product" — the RecallProductIngredients link's own facts
// (chemicalForm, amount, sourcing, ...) and, optionally in the same
// request, the shared ProductCatalog fields (name/dosage form/pack
// size/ingredients) that live on the master product record. Never creates
// a new product or link — 404s if the link id doesn't already exist.
// sku lives on ProductCatalog (the general master-product record — a
// manager can also see/edit it under Settings -> Product Catalog), not on
// this Recall-specific link, so it belongs in the catalog field list below.
const RECALL_OUR_PRODUCT_LINK_FIELDS = ["chemicalForm", "compoundAmount", "activeAmount", "unit", "servingSize", "dailyAmount", "amountBasis", "manufacturer", "sourceLabel", "sourceUrl", "linkNotes"];
const RECALL_OUR_PRODUCT_CATALOG_FIELDS = ["name", "price", "form", "packSize", "unitsPerDay", "ingredients", "catalogNotes", "sku"];

app.patch("/api/recall/our-products/:linkId", requireManager, async (req, res) => {
  try {
    const links = await db.getAllRows("RecallProductIngredients");
    const link = links.find((l) => l.id === req.params.linkId);
    if (!link) return res.status(404).json({ error: "Recall product link not found." });

    const linkPatch = {};
    for (const key of RECALL_OUR_PRODUCT_LINK_FIELDS) {
      if (req.body[key] !== undefined) linkPatch[key === "linkNotes" ? "notes" : key] = req.body[key];
    }
    const catalogPatch = {};
    for (const key of RECALL_OUR_PRODUCT_CATALOG_FIELDS) {
      if (req.body[key] !== undefined) catalogPatch[key === "catalogNotes" ? "notes" : key] = req.body[key];
    }
    if (Object.keys(linkPatch).length === 0 && Object.keys(catalogPatch).length === 0) {
      return res.status(400).json({ error: "No editable fields provided." });
    }

    if (Object.keys(linkPatch).length) await db.updateRowById("RecallProductIngredients", req.params.linkId, linkPatch);
    if (Object.keys(catalogPatch).length) {
      const catalogValidationError = validateCompetitorProductNumbers(catalogPatch);
      if (catalogValidationError) return res.status(400).json({ error: catalogValidationError });
      if (catalogPatch.ingredients !== undefined) catalogPatch.ingredients = normalizeIngredients(catalogPatch.ingredients);
      catalogPatch.updatedBy = req.repName || "Manager";
      catalogPatch.updatedAt = new Date().toISOString();
      await db.updateRowById("ProductCatalog", link.productId, catalogPatch);
    }

    const derived = await recomputeOurProductResearchStatus(req.params.linkId);
    res.json({ ok: true, ...derived });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Edits an EXISTING retailer listing (price/URL/notes/retailer) — never
// creates a new one. Same allowlist-only field handling as the POST route
// above, so a caller sending "availability"/"inStock"/etc. is silently
// ignored, not stored. Open to any employee — see the POST route's comment.
app.patch("/api/recall/retailer-listings/:id", async (req, res) => {
  try {
    const listings = await db.getAllRows("RecallRetailerListings");
    if (!listings.some((l) => l.id === req.params.id)) return res.status(404).json({ error: "Retailer listing not found." });
    const { retailer, sourceUrl, displayedPrice, currency, notes } = req.body;
    if (retailer !== undefined && !APPROVED_RETAILERS.includes(retailer)) {
      return res.status(400).json({ error: `retailer must be one of: ${APPROVED_RETAILERS.join(", ")}` });
    }
    const patch = {};
    if (retailer !== undefined) patch.retailer = retailer;
    if (sourceUrl !== undefined) patch.sourceUrl = String(sourceUrl).trim();
    if (displayedPrice !== undefined) patch.displayedPrice = displayedPrice === "" ? "" : Number(displayedPrice);
    if (currency !== undefined) patch.currency = currency;
    if (notes !== undefined) patch.notes = notes;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No editable fields provided." });

    await db.updateRowById("RecallRetailerListings", req.params.id, patch);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Resolving a conflict picks ONE source's value onto the actual record —
// an explicit, auditable action, never automatic. The conflict row itself
// is kept (status flipped to RESOLVED, not deleted) so both original
// source values stay visible as history. Any employee can resolve a
// COMPETITOR conflict; a conflict on OUR products stays manager-only.
app.patch("/api/recall/field-conflicts/:id/resolve", async (req, res) => {
  try {
    const { resolution } = req.body;
    if (resolution !== "A" && resolution !== "B") return res.status(400).json({ error: "resolution must be 'A' or 'B'." });
    const conflicts = await db.getAllRows("RecallFieldConflicts");
    const conflict = conflicts.find((c) => c.id === req.params.id);
    if (!conflict) return res.status(404).json({ error: "Conflict not found." });
    if (conflict.status !== "CONFLICT") return res.status(400).json({ error: "This conflict has already been resolved." });

    const chosenValue = resolution === "A" ? conflict.sourceAValue : conflict.sourceBValue;
    const targetTable = conflict.entityType;
    if (!["CompetitorProducts", "RecallProductIngredients", "ProductCatalog", "RecallRetailerListings"].includes(targetTable)) {
      return res.status(400).json({ error: `Cannot resolve a conflict on entityType "${targetTable}" — unsupported table.` });
    }
    // Retailer-listing conflicts (a price/URL discrepancy on one retailer's
    // listing) are competitor research, same as CompetitorProducts itself —
    // open to any employee, matching the shared editing rule for that data.
    if (!["CompetitorProducts", "RecallRetailerListings"].includes(targetTable) && req.role !== "manager") {
      return res.status(403).json({ error: "Managers only." });
    }
    const applied = await db.updateRowById(targetTable, conflict.entityId, { [conflict.fieldName]: chosenValue });
    if (!applied) return res.status(404).json({ error: "The record this conflict refers to no longer exists." });

    await db.updateRowById("RecallFieldConflicts", req.params.id, {
      status: "RESOLVED", resolution, resolvedBy: req.repName || "Manager", resolvedAt: new Date().toISOString(),
    });

    if (targetTable === "CompetitorProducts") await recomputeCompetitorResearchStatus(conflict.entityId);
    res.json({ ok: true, appliedValue: chosenValue });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Which of OUR products actually belong to a Recall category (have a
// RecallProductIngredients link) — this is the picker used to attach an
// existing competitor product to a category, since a category's
// membership is defined entirely by its our-products, not by the
// competitor product itself. Open to any employee, matching the shared
// competitor-research editing rule.
app.get("/api/recall/linkable-products", async (req, res) => {
  try {
    const [links, catalog, ingredients, categories] = await Promise.all([
      db.getAllRows("RecallProductIngredients"),
      db.getAllRows("ProductCatalog"),
      db.getAllRows("RecallIngredients"),
      db.getAllRows("RecallCategories"),
    ]);
    const catalogById = new Map(catalog.map((p) => [p.id, p]));
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const seen = new Set();
    const products = [];
    for (const link of links) {
      if (seen.has(link.productId)) continue;
      const product = catalogById.get(link.productId);
      const ingredient = ingredientById.get(link.ingredientId);
      const category = ingredient ? categoryById.get(ingredient.categoryId) : null;
      if (!product || !category) continue;
      seen.add(link.productId);
      products.push({ ourProductId: product.id, productName: product.name, categoryId: category.id, categoryName: category.name });
    }
    res.json({ products });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Every existing competitor<->our-product comparison link, enriched with
// the category it puts the competitor product under — used by the
// Competitors tab to show "Already in Recall under: <category>" per row.
app.get("/api/recall/competitor-relationships", async (req, res) => {
  try {
    const [rels, catalog, links, ingredients, categories] = await Promise.all([
      db.getAllRows("RecallCompetitorRelationships"),
      db.getAllRows("ProductCatalog"),
      db.getAllRows("RecallProductIngredients"),
      db.getAllRows("RecallIngredients"),
      db.getAllRows("RecallCategories"),
    ]);
    const catalogById = new Map(catalog.map((p) => [p.id, p]));
    const ingredientIdByProductId = new Map(links.map((l) => [l.productId, l.ingredientId]));
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const relationships = rels.map((r) => {
      const ingredientId = ingredientIdByProductId.get(r.ourProductId);
      const ingredient = ingredientId ? ingredientById.get(ingredientId) : null;
      const category = ingredient ? categoryById.get(ingredient.categoryId) : null;
      return {
        id: r.id, competitorProductId: r.competitorProductId, ourProductId: r.ourProductId,
        ourProductName: catalogById.get(r.ourProductId)?.name || "",
        categoryId: category?.id || "", categoryName: category?.name || "",
      };
    });
    res.json({ relationships });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Attaches an EXISTING competitor product to a Recall category by linking
// it against one of that category's our-products. Never creates a new
// competitor product or category here — both must already exist. Open to
// any employee: attaching research to a category is a research-completion
// action, same as editing the competitor product's own fields.
app.post("/api/recall/competitor-relationships", async (req, res) => {
  try {
    const { competitorProductId, ourProductId, comparisonType, notes } = req.body;
    if (!competitorProductId || !ourProductId) {
      return res.status(400).json({ error: "competitorProductId and ourProductId are required." });
    }
    const [competitorProducts, links, existingRels] = await Promise.all([
      db.getAllRows("CompetitorProducts"),
      db.getAllRows("RecallProductIngredients"),
      db.getAllRows("RecallCompetitorRelationships"),
    ]);
    if (!competitorProducts.some((p) => p.id === competitorProductId)) {
      return res.status(404).json({ error: "Competitor product not found." });
    }
    if (!links.some((l) => l.productId === ourProductId)) {
      return res.status(400).json({ error: "That product is not part of any Recall category." });
    }
    const already = existingRels.find((r) => r.ourProductId === ourProductId && r.competitorProductId === competitorProductId);
    if (already) return res.json({ ok: true, id: already.id, alreadyLinked: true });

    const row = {
      id: `cr-${crypto.randomUUID()}`, ourProductId, competitorProductId,
      comparisonType: comparisonType || "dose-and-form-comparison", notes: notes || "",
      sourceIds: "", createdAt: new Date().toISOString(),
    };
    await db.appendRows("RecallCompetitorRelationships", [row]);
    res.json({ ok: true, id: row.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Removes a competitor product from a category's comparison — an
// undo/structural action, so kept manager-only (unlike editing the
// competitor product's own research fields, which stays open to all
// employees). This never deletes the competitor product itself, only the
// link putting it under this category.
app.delete("/api/recall/competitor-relationships/:id", requireManager, async (req, res) => {
  try {
    const rels = await db.getAllRows("RecallCompetitorRelationships");
    if (!rels.some((r) => r.id === req.params.id)) return res.status(404).json({ error: "Link not found." });
    await db.deleteRowById("RecallCompetitorRelationships", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    // index.html must always be re-checked so phones/PWAs don't get stuck on an
    // old build referencing JS/CSS file names that no longer exist after a deploy.
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(clientDist, "index.html"));
});

// See the matching comment in client/src/helpers.js — a plain "YYYY-MM-DD"
// string must not round-trip through UTC before being compared, or it can
// shift a day depending on the server process's local timezone.
function daysUntilFromToday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  date.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((date - now) / 86400000);
}

// Same local-date-components approach as above, applied in reverse: builds a
// "YYYY-MM-DD" string N days from today without a UTC round-trip.
function addDaysToTodayStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TIER_CADENCE_DAYS = { A: 14, B: 30, C: 60 };

async function checkExpiryAndOverdueAlerts() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const [products, clients, visits, rawSettings, subs] = await Promise.all([
      db.getAllRows("Products"),
      db.getAllRows("Clients"),
      db.getAllRows("Visits"),
      db.getSettings(),
      db.getAllRows("PushSubscriptions"),
    ]);
    const newlySent = {};

    for (const p of products) {
      if (!p.expiry) continue;
      const dLeft = daysUntilFromToday(p.expiry);
      if (dLeft <= 30) {
        const key = `alert_expiry_${p.id}`;
        if (!rawSettings[key]) {
          await notifyManagers({ title: "Product expiring soon", body: `${p.name} — ${dLeft}d left`, url: "/" }, subs);
          newlySent[key] = "sent";
        }
      }
    }

    // A client only becomes "overdue" once it has had a first visit AND has
    // a rep assigned — a freshly bulk-imported list (never visited, often
    // not yet assigned) must not immediately flood everyone with alerts.
    for (const c of clients) {
      if (!c.assignedRep) continue;
      const matches = visits.filter((v) => v.client.toLowerCase().trim() === c.name.toLowerCase().trim());
      const lastVisit = matches.length
        ? matches.reduce((a, b) => (new Date(b.time) > new Date(a.time) ? b : a), matches[0])
        : null;
      if (!lastVisit) continue;
      const daysSinceVisit = Math.round((Date.now() - new Date(lastVisit.time)) / 86400000);
      const cadence = TIER_CADENCE_DAYS[c.tier] || 30;
      if (daysSinceVisit > cadence) {
        const key = `alert_overdue_${c.id}`;
        if (!rawSettings[key]) {
          const payload = { title: "Client overdue for a visit", body: `${c.name} hasn't been visited in a while`, url: "/" };
          await notifyManagers(payload, subs);
          await notifyRep(c.assignedRep, payload, subs);
          newlySent[key] = "sent";
        }
      }
    }

    if (Object.keys(newlySent).length > 0) await db.setSettings(newlySent);
  } catch (e) {
    console.error("checkExpiryAndOverdueAlerts failed", e);
  }
}

const ALERT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  checkExpiryAndOverdueAlerts();
  setInterval(checkExpiryAndOverdueAlerts, ALERT_CHECK_INTERVAL_MS);
}

// ---------- Every-other-day training nudge (alternating video/study) ----------
// Keeps every rep gently cycling through the training catalog: every 2 days
// they get pushed toward one item they haven't finished yet, alternating
// between a Training Video and a Training Study. State (when each rep was
// last nudged, and which type is next) lives in one Settings row so it
// survives restarts — this function just runs hourly and asks "has it been
// >= 2 days since this rep's last nudge?" rather than trying to schedule
// exact 48h timers per rep.
const TRAINING_NUDGE_INTERVAL_DAYS = 2;

async function checkTrainingNudges() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const [reps, videos, videoProgress, studies, studyViews, subs, rawSettings] = await Promise.all([
      db.getAllRows("Reps"),
      db.getAllRows("TrainingVideos"),
      db.getAllRows("TrainingProgress"),
      db.getAllRows("TrainingStudies"),
      db.getAllRows("TrainingStudyViews"),
      db.getAllRows("PushSubscriptions"),
      db.getSettings(),
    ]);
    const state = rawSettings.trainingNudgeState ? JSON.parse(rawSettings.trainingNudgeState) : {};
    const sortedVideos = [...videos].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const sortedStudies = [...studies].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const now = Date.now();
    let anyNudged = false;

    for (const rep of reps) {
      const repState = state[rep.name];
      const dueForNudge = !repState || (now - new Date(repState.lastSentAt).getTime()) / 86400000 >= TRAINING_NUDGE_INTERVAL_DAYS;
      if (!dueForNudge) continue;

      const nudgeType = repState?.nextType === "study" ? "study" : "video";
      let payload;
      if (nudgeType === "video") {
        const completedIds = new Set(videoProgress.filter((p) => p.employeeId === rep.name).map((p) => p.videoId));
        const pick = sortedVideos.find((v) => !completedIds.has(v.id));
        payload = pick
          ? { title: "Training reminder", body: `Watch "${pick.title}" under Training Videos when you get a chance.`, url: "/" }
          : { title: "Training reminder", body: "Take a moment to revisit a video under Training Videos.", url: "/" };
      } else {
        const viewedIds = new Set(studyViews.filter((v) => v.employeeId === rep.name).map((v) => v.studyId));
        const pick = sortedStudies.find((s) => !viewedIds.has(s.id));
        payload = pick
          ? { title: "Training reminder", body: `Read "${pick.title}" under Training Studies when you get a chance.`, url: "/" }
          : { title: "Training reminder", body: "Take a moment to revisit a study under Training Studies.", url: "/" };
      }

      await notifyRep(rep.name, payload, subs);
      state[rep.name] = { lastSentAt: new Date().toISOString(), nextType: nudgeType === "video" ? "study" : "video" };
      anyNudged = true;
    }

    if (anyNudged) await db.setSettings({ trainingNudgeState: state });
  } catch (e) {
    console.error("checkTrainingNudges failed", e);
  }
}

const TRAINING_NUDGE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  checkTrainingNudges();
  setInterval(checkTrainingNudges, TRAINING_NUDGE_CHECK_INTERVAL_MS);
}

// ---------- Monthly Telegram digest: Pick up vs Stress to sell ----------
// Two focused, actionable lists instead of one long wall of text (a single
// list mixing everything was too big for reps to actually read):
//   - Pick up: expires within 3 months — pharmacies won't take these, so
//     the move is to collect the stock back, not push more sales.
//   - Stress to sell: expires within a year AND moving slowly — still
//     sellable, but needs proactive pushing before it becomes a pick-up item.
// The manager approves via inline buttons before anything reaches reps; both
// the manager's and each rep's message stay short, with buttons to drill
// into either list's detail on demand.

// Prefers the real average from uploaded StockMovement history; falls back
// to the 90-day-sales proxy for any product with no matching movement data.
function turnoverPctFor(product, avgMonthlyMovement) {
  const qty = Number(product.qty) || 0;
  if (qty <= 0) return 0;
  const sold90Equivalent = avgMonthlyMovement != null ? avgMonthlyMovement * 3 : Number(product.sold90) || 0;
  return Math.round((sold90Equivalent / qty) * 100);
}

// Projects whether current stock will clear before the item expires. Mirrors
// isAtRisk in client/src/helpers.js.
function isAtRiskFor(product, daysLeft, avgMonthlyMovement) {
  if (daysLeft <= 0) return false;
  const qty = Number(product.qty) || 0;
  if (qty <= 0) return false;
  const monthlyMovement = avgMonthlyMovement != null ? avgMonthlyMovement : (Number(product.sold90) || 0) / 3;
  const monthsToSellThrough = monthlyMovement > 0 ? qty / monthlyMovement : Infinity;
  const monthsUntilExpiry = daysLeft / 30.44;
  return monthsToSellThrough > monthsUntilExpiry;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PICKUP_WINDOW_DAYS = 90; // 3 months out
const PICKUP_GRACE_DAYS = -30; // still surface a batch briefly after it expires
const STRESS_WINDOW_DAYS = 365; // 1 year

// Pick-up items come from the uploaded PharmacySales ledger — real sales of
// specific expiry-dated batches to specific pharmacies — not from KayBee's
// own warehouse stock. That's the point: it tells a rep exactly which
// pharmacy is sitting on stock that's about to expire, not just that some
// SKU somewhere is expiring soon. Matched against Clients by name (trimmed,
// case-insensitive) to find the assignedRep; unmatched names still show up
// for the manager but can't be routed to a specific rep.
async function computeDigestLists(rawSettings) {
  const [products, movementRows, pharmacySales, clients] = await Promise.all([
    db.getAllRows("Products"),
    db.getAllRows("StockMovement"),
    db.getAllRows("PharmacySales"),
    db.getAllRows("Clients"),
  ]);
  const movementIndex = buildMovementIndex(movementRows);
  const slowThreshold = rawSettings.slowThreshold !== undefined ? Number(rawSettings.slowThreshold) : 15;
  const clientIndex = new Map(clients.map((c) => [String(c.name || "").trim().toLowerCase(), c]));

  const pickup = [];
  for (const row of pharmacySales) {
    if (!row.expiry) continue;
    const daysLeft = daysUntilFromToday(row.expiry);
    if (daysLeft < PICKUP_GRACE_DAYS || daysLeft > PICKUP_WINDOW_DAYS) continue;
    const client = clientIndex.get(String(row.pharmacyName || "").trim().toLowerCase());
    pickup.push({
      id: row.id,
      productName: row.productName,
      pharmacyName: row.pharmacyName,
      qty: Number(row.qty) || 0,
      expiry: row.expiry,
      daysLeft,
      assignedRep: client?.assignedRep || null,
    });
  }
  pickup.sort((a, b) => a.daysLeft - b.daysLeft);

  const stress = [];
  for (const p of products) {
    if (!p.expiry) continue;
    const daysLeft = daysUntilFromToday(p.expiry);
    if (daysLeft < 0) continue; // already expired — nothing left to push
    const avgMovement = avgMonthlyMovementFor(p.name, movementIndex);
    if (daysLeft <= STRESS_WINDOW_DAYS && (turnoverPctFor(p, avgMovement) < slowThreshold || isAtRiskFor(p, daysLeft, avgMovement))) {
      stress.push({ id: p.id, name: p.name, qty: Number(p.qty) || 0, expiry: p.expiry, daysLeft, turnover: turnoverPctFor(p, avgMovement) });
    }
  }
  stress.sort((a, b) => a.daysLeft - b.daysLeft);
  return { pickup, stress };
}

// forRepName narrows the pick-up count to that rep's own assigned
// pharmacies; omit it (manager view) to count every pick-up item.
function formatSummaryMessage({ pickup, stress }, forRepName) {
  const pickupCount = forRepName ? pickup.filter((it) => it.assignedRep === forRepName).length : pickup.length;
  if (pickupCount === 0 && stress.length === 0) {
    return "No items to flag this month — nothing is near enough to expiry or slow enough to need action.";
  }
  return (
    `📋 <b>This month's focus</b>\n\n` +
    `📦 <b>${pickupCount}</b> item${pickupCount === 1 ? "" : "s"} to pick up from pharmacies (expiring within 3 months)\n` +
    `📣 <b>${stress.length}</b> item${stress.length === 1 ? "" : "s"} to stress-sell (expiring within a year, moving slowly)\n\n` +
    `Tap a list below for details.`
  );
}

function formatCategoryDetail(items, title, isPickup) {
  if (items.length === 0) return `${title}: nothing to show.`;
  const lines = items.slice(0, 40).map((it) =>
    isPickup
      ? `• <b>${escapeHtml(it.productName)}</b> — ${it.qty} units at <b>${escapeHtml(it.pharmacyName)}</b>, ${it.daysLeft}d to expiry`
      : `• <b>${escapeHtml(it.name)}</b> — ${it.qty} units, ${it.daysLeft}d to expiry, ${it.turnover}% turnover/90d`
  );
  const more = items.length > 40 ? `\n…and ${items.length - 40} more.` : "";
  return `${title} (${items.length})\n\n${lines.join("\n")}${more}`;
}

function categoryButtons(digestId, { pickup, stress }, forRepName) {
  const pickupCount = forRepName ? pickup.filter((it) => it.assignedRep === forRepName).length : pickup.length;
  return [
    { text: `📦 Pick up (${pickupCount})`, callback_data: `pickup:${digestId}` },
    { text: `📣 Stress to sell (${stress.length})`, callback_data: `stress:${digestId}` },
  ];
}

async function dispatchDigestToReps(digestId, lists) {
  const reps = await db.getAllRows("Reps");
  for (const rep of reps) {
    if (!rep.telegramChatId) continue;
    const message = formatSummaryMessage(lists, rep.name);
    const replyMarkup = { inline_keyboard: [categoryButtons(digestId, lists, rep.name)] };
    try {
      await telegram.sendMessage(rep.telegramChatId, message, replyMarkup);
    } catch (e) {
      console.error(`failed to send monthly digest to rep ${rep.name}`, e);
    }
  }
}

async function runMonthlyDigest(month) {
  const settings = await db.getSettings();
  const lists = await computeDigestLists(settings);
  const digest = {
    id: `dg${crypto.randomUUID()}`,
    month,
    status: "pending",
    payload: JSON.stringify(lists),
    createdAt: new Date().toISOString(),
  };
  await db.appendRow("MonthlyDigests", digest);

  if (!settings.managerTelegramChatId) {
    console.warn("Monthly digest computed but no manager Telegram is linked yet — nothing sent.");
    return;
  }
  const summary = formatSummaryMessage(lists);
  if (lists.pickup.length === 0 && lists.stress.length === 0) {
    await telegram.sendMessage(settings.managerTelegramChatId, summary);
    await db.updateRowById("MonthlyDigests", digest.id, { status: "skipped" });
    return;
  }
  await telegram.sendMessage(settings.managerTelegramChatId, summary, {
    inline_keyboard: [
      categoryButtons(digest.id, lists),
      [
        { text: "✅ Approve — send to reps", callback_data: `approve:${digest.id}` },
        { text: "Skip this month", callback_data: `skip:${digest.id}` },
      ],
    ],
  });
}

// Looks up who's tapping a button so pick-up drill-downs can be scoped to
// that person: the manager sees every pharmacy, a rep sees only their own.
async function resolveTelegramRequester(chatId) {
  if (!chatId) return null;
  const [reps, settings] = await Promise.all([db.getAllRows("Reps"), db.getSettings()]);
  if (settings.managerTelegramChatId && String(settings.managerTelegramChatId) === String(chatId)) {
    return { role: "manager" };
  }
  const rep = reps.find((r) => String(r.telegramChatId) === String(chatId));
  return rep ? { role: "rep", repName: rep.name } : null;
}

async function handleOrderDeleteCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, orderId] = (data || "").split(":");
  const orders = await db.getAllRows("Orders");
  const order = orders.find((o) => o.id === orderId);
  if (!order) { await telegram.answerCallbackQuery(id, "This order is no longer available."); return; }
  if (order.status !== "deletion_requested") { await telegram.answerCallbackQuery(id, "Already handled."); return; }

  if (action === "orddel") {
    await db.deleteRowById("Orders", order.id);
    await telegram.answerCallbackQuery(id, "Order deleted.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `Deleted the order for ${order.clientName}.`);
  } else if (action === "ordkeep") {
    await db.updateRowById("Orders", order.id, { status: "confirmed" });
    await telegram.answerCallbackQuery(id, "Kept.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `Kept the order for ${order.clientName}.`);
  }
}

// The Head of Sales's one-tap confirmation that an order has (or hasn't
// yet) been keyed into the real POS system — his actual workflow, since he
// doesn't use the in-app "Pending POS" list. "Not yet" just acknowledges;
// the order is already in the pending state by default, nothing to change.
async function handlePosEntryCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, orderId] = (data || "").split(":");
  const orders = await db.getAllRows("Orders");
  const order = orders.find((o) => o.id === orderId);
  if (!order) { await telegram.answerCallbackQuery(id, "This order is no longer available."); return; }

  if (action === "posenter") {
    if (order.posEntered === "true") { await telegram.answerCallbackQuery(id, "Already marked as entered."); return; }
    const requester = await resolveTelegramRequester(message?.chat?.id);
    await db.updateRowById("Orders", order.id, {
      posEntered: "true",
      posEnteredAt: new Date().toISOString(),
      posEnteredBy: requester?.repName || "Telegram",
    });
    await telegram.answerCallbackQuery(id, "Marked as entered in POS ✅");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `✅ Order for ${order.clientName} marked as entered in POS.`);
  } else if (action === "posnotyet") {
    await telegram.answerCallbackQuery(id, "Okay — noted as not entered yet.");
  }
}

// A rep visiting a pharmacy assigned to someone else prompts the manager to
// pick a side, right from the Telegram alert, instead of having to open the
// app and use the Pharmacies tab's assign-rep dropdown.
async function handleReassignmentCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, clientId, newRep] = (data || "").split(":");
  const clients = await db.getAllRows("Clients");
  const client = clients.find((c) => c.id === clientId);
  if (!client) { await telegram.answerCallbackQuery(id, "This pharmacy is no longer available."); return; }

  if (action === "keeprep") {
    await telegram.answerCallbackQuery(id, "Kept as-is.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `${client.name} stays assigned to ${client.assignedRep}.`);
    return;
  }
  if (action === "changerep" && newRep) {
    await db.updateRowById("Clients", client.id, { assignedRep: newRep });
    await telegram.answerCallbackQuery(id, "Reassigned.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `${client.name} is now assigned to ${newRep}.`);
  }
}

async function handleDigestCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, digestId] = (data || "").split(":");
  const digests = await db.getAllRows("MonthlyDigests");
  const digest = digests.find((d) => d.id === digestId);
  if (!digest) { await telegram.answerCallbackQuery(id, "This digest is no longer available."); return; }

  const lists = JSON.parse(digest.payload || '{"pickup":[],"stress":[]}');

  if (action === "pickup" || action === "stress") {
    await telegram.answerCallbackQuery(id, "Here's the list");
    const title = action === "pickup" ? "📦 Pick up from pharmacies" : "📣 Stress to sell";
    if (message?.chat?.id) {
      let items = lists[action];
      if (action === "pickup") {
        const requester = await resolveTelegramRequester(message.chat.id);
        if (requester?.role === "rep") items = items.filter((it) => it.assignedRep === requester.repName);
      }
      await telegram.sendMessage(message.chat.id, formatCategoryDetail(items, title, action === "pickup"));
    }
    return;
  }

  if (digest.status !== "pending") { await telegram.answerCallbackQuery(id, `Already ${digest.status}.`); return; }

  if (action === "approve") {
    await dispatchDigestToReps(digest.id, lists);
    await db.updateRowById("MonthlyDigests", digest.id, { status: "approved" });
    await telegram.answerCallbackQuery(id, "Sent to reps!");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, "✅ Approved — sent to all linked reps.");
  } else if (action === "skip") {
    await db.updateRowById("MonthlyDigests", digest.id, { status: "skipped" });
    await telegram.answerCallbackQuery(id, "Skipped this month.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, "Skipped — nothing sent to reps this month.");
  }
}

const MONTHLY_DIGEST_DAY = 1; // runs on the 1st of each month, at most once
async function checkMonthlyDigest() {
  if (!telegram.isConfigured()) return;
  try {
    const now = new Date();
    if (now.getDate() !== MONTHLY_DIGEST_DAY) return;
    const settings = await db.getSettings();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (settings.lastMonthlyDigestMonth === thisMonth) return;
    await runMonthlyDigest(thisMonth);
    await db.setSettings({ lastMonthlyDigestMonth: thisMonth });
  } catch (e) {
    console.error("checkMonthlyDigest failed", e);
  }
}

const MONTHLY_DIGEST_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// --- Visit follow-ups ---------------------------------------------------
// A rep can schedule a follow-up (2d/3d/1w/2w/1m from now) right after
// logging a visit. When the due date arrives, the owning rep gets a
// Telegram reminder with buttons to reschedule again (same presets) or stop
// entirely. Each rep only ever sees their own follow-ups' reminders — the
// reminder is sent to that rep's own linked Telegram chat, never anyone
// else's — matching the existing per-rep data isolation.

function followUpButtons(followUpId) {
  return [
    [
      { text: "✅ Sign in (visited)", callback_data: `fusignin:${followUpId}` },
      { text: "⏰ Snooze 2 days", callback_data: `fusnooze:${followUpId}` },
    ],
    [{ text: "🚫 Not interested — stop", callback_data: `fustop:${followUpId}` }],
  ];
}

// The re-ask sent right after "Sign in" — same idea as the original
// scheduling step in the app (a short list of presets), just compact since
// it's a Telegram message rather than a full form.
function rescheduleButtons(followUpId) {
  return [
    [
      { text: "In 2 days", callback_data: `fu2d:${followUpId}` },
      { text: "In 1 week", callback_data: `fu1w:${followUpId}` },
      { text: "In 1 month", callback_data: `fu1m:${followUpId}` },
    ],
    [{ text: "No follow-up needed", callback_data: `fudone:${followUpId}` }],
  ];
}

// Minimal visit record for the "Sign in" button on a follow-up reminder —
// registers today's visit straight from Telegram so the rep doesn't have to
// separately open the app and re-log something they just confirmed. Order
// and sample details still go through the app's own Check-In flow (Step 3
// there already has the searchable item dropdown and stock-aware order
// builder — rebuilding that inside Telegram's button-only UI isn't
// practical), so this deliberately only covers the visit itself.
async function createVisitFromFollowUp(followUp) {
  const visit = {
    id: `v${crypto.randomUUID()}`,
    client: followUp.entityName,
    notes: "",
    coords: null,
    time: new Date().toISOString(),
    repName: followUp.repName,
    mentionedItems: [],
    objectionTag: "",
  };
  const row = visitToRow(visit);
  await db.appendRow("Visits", row);
  const reps = await db.getAllRows("Reps");
  const rep = reps.find((r) => r.name === followUp.repName);
  if (rep?.exportSheetId) await db.appendToRepExportSheet(rep.exportSheetId, row);
  if (followUp.entityType !== "doctor") {
    const clients = await db.getAllRows("Clients");
    const matchedClient = clients.find((c) => c.name.toLowerCase().trim() === followUp.entityName.toLowerCase().trim());
    if (matchedClient && !matchedClient.assignedRep) {
      await db.updateRowById("Clients", matchedClient.id, { assignedRep: followUp.repName });
    }
  }
  return visit;
}

// A separate, earlier heads-up than checkFollowUpReminders — that one tells
// the REP the visit is due today; this tells the MANAGER a couple of days
// out that a sample needs to be ready, since prep (ordering it in, pulling
// it from stock) can't happen same-day. needsSample/sampleItems are stamped
// automatically from step 1's "Give next visit" tagging when the follow-up
// is scheduled (see POST /api/followups) — the rep is never asked a second
// time. sampleReminded guards against re-sending if the interval catches
// the same follow-up more than once inside its 2-day window.
async function checkSampleReminders() {
  if (!telegram.isConfigured()) return;
  try {
    const settings = await db.getSettings();
    if (!settings.managerTelegramChatId) return;
    const followUps = await db.getAllRows("FollowUps");
    const due = followUps.filter((f) =>
      f.needsSample === "true" &&
      !f.sampleReminded &&
      f.status !== "stopped" && f.status !== "done" &&
      daysUntilFromToday(f.dueDate) <= 2 && daysUntilFromToday(f.dueDate) >= 0
    );
    for (const f of due) {
      let items = [];
      try { items = JSON.parse(f.sampleItems || "[]"); } catch { items = []; }
      const itemsText = items.length ? items.map((it) => (it.qty > 1 ? `${it.name} ×${it.qty}` : it.name)).join(", ") : "a sample";
      try {
        await telegram.sendMessage(
          settings.managerTelegramChatId,
          `🎁 Sample reminder: <b>${escapeHtml(f.repName)}</b> is due to visit <b>${escapeHtml(f.entityName)}</b> on ${f.dueDate} and will need to bring <b>${escapeHtml(itemsText)}</b> — please have it ready.`
        );
        notifyManagers({
          title: "Sample needed soon",
          body: `${f.repName} visits ${f.entityName} on ${f.dueDate} — needs ${itemsText}`,
          url: "/",
        }).catch(() => {});
        await db.updateRowById("FollowUps", f.id, { sampleReminded: "true" });
      } catch (e) {
        console.error(`failed to send sample reminder for ${f.entityName}`, e);
      }
    }
  } catch (e) {
    console.error("checkSampleReminders failed", e);
  }
}

async function checkFollowUpReminders() {
  if (!telegram.isConfigured()) return;
  try {
    const [followUps, reps] = await Promise.all([db.getAllRows("FollowUps"), db.getAllRows("Reps")]);
    const due = followUps.filter((f) => f.status === "pending" && daysUntilFromToday(f.dueDate) <= 0);
    for (const f of due) {
      const rep = reps.find((r) => r.name === f.repName);
      if (!rep?.telegramChatId) continue;
      try {
        const objectiveLine = f.smartiObjective
          ? `\n\n🎯 Your Next SMARTI Objective from last visit:\n${escapeHtml(f.smartiObjective)}`
          : "";
        await telegram.sendMessage(
          rep.telegramChatId,
          `🔔 Reminder to follow up: visit <b>${escapeHtml(f.entityName)}</b> today.${objectiveLine}\n\nAfter your visit, when should the next follow-up be?`,
          { inline_keyboard: followUpButtons(f.id) }
        );
        await db.updateRowById("FollowUps", f.id, { status: "reminded" });
      } catch (e) {
        console.error(`failed to send follow-up reminder for ${f.entityName}`, e);
      }
    }
  } catch (e) {
    console.error("checkFollowUpReminders failed", e);
  }
}

async function handleFollowUpCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, followUpId] = (data || "").split(":");
  const followUps = await db.getAllRows("FollowUps");
  const followUp = followUps.find((f) => f.id === followUpId);
  if (!followUp) { await telegram.answerCallbackQuery(id, "This follow-up is no longer available."); return; }

  if (action === "fustop") {
    await db.updateRowById("FollowUps", followUp.id, { status: "stopped" });
    await telegram.answerCallbackQuery(id, "Got it — no more follow-ups.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `Marked ${followUp.entityName} as no longer interested. No more reminders.`);
    return;
  }

  if (action === "fusnooze") {
    await db.updateRowById("FollowUps", followUp.id, { status: "done" });
    await db.appendRow("FollowUps", {
      id: `fu${crypto.randomUUID()}`,
      entityName: followUp.entityName,
      entityType: followUp.entityType,
      repName: followUp.repName,
      dueDate: addDaysToTodayStr(2),
      status: "pending",
      visitId: followUp.visitId,
      createdAt: new Date().toISOString(),
    });
    await telegram.answerCallbackQuery(id, "Snoozed 2 days.");
    if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `Follow-up with ${followUp.entityName} snoozed — you'll hear again in 2 days.`);
    return;
  }

  if (action === "fusignin") {
    const visit = await createVisitFromFollowUp(followUp);
    await db.updateRowById("FollowUps", followUp.id, { status: "done", visitId: visit.id });
    await telegram.answerCallbackQuery(id, "Visit logged!");
    if (message?.chat?.id) {
      await telegram.sendMessage(
        message.chat.id,
        `✅ Logged today's visit to <b>${escapeHtml(followUp.entityName)}</b> — it's in Today's visits in the app.\n\n` +
          `If an order was placed or a sample was given, add that in the app's Check-In flow (it has the item list and stock check Telegram can't do).\n\n` +
          `Need another follow-up?`,
        { inline_keyboard: rescheduleButtons(followUp.id) }
      );
    }
    return;
  }

  if (action === "fudone") {
    await telegram.answerCallbackQuery(id, "Got it — no follow-up scheduled.");
    return;
  }

  const preset = FOLLOWUP_PRESETS[action.replace(/^fu/, "")];
  if (!preset) { await telegram.answerCallbackQuery(id, "Unknown action."); return; }

  await db.appendRow("FollowUps", {
    id: `fu${crypto.randomUUID()}`,
    entityName: followUp.entityName,
    entityType: followUp.entityType,
    repName: followUp.repName,
    dueDate: addDaysToTodayStr(preset.days),
    status: "pending",
    visitId: followUp.visitId,
    createdAt: new Date().toISOString(),
  });
  await telegram.answerCallbackQuery(id, `Follow-up scheduled ${preset.label}.`);
  if (message?.chat?.id) await telegram.sendMessage(message.chat.id, `Follow-up with ${followUp.entityName} scheduled ${preset.label}.`);
}

const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// --- Monthly visits + follow-ups summary ---------------------------------
// Separate from the must-sell digest above (different topic, different
// audience emphasis): each rep gets their own activity stats, and the
// manager gets a full team rollup. All the source data is fetched once
// up front and the per-rep stats are computed in-memory, rather than
// looping a Sheets read per rep, to stay well under the fixed 60
// reads/minute quota shared by the whole team.
async function runMonthlyVisitsSummary(month) {
  const [visits, orders, followUps, reps, clients, doctors, settings] = await Promise.all([
    db.getAllRows("Visits"),
    db.getAllRows("Orders"),
    db.getAllRows("FollowUps"),
    db.getAllRows("Reps"),
    db.getAllRows("Clients"),
    db.getAllRows("Doctors"),
    db.getSettings(),
  ]);

  const pharmacyNames = new Set(clients.map((c) => c.name.toLowerCase().trim()));
  const doctorNames = new Set(doctors.map((d) => d.name.toLowerCase().trim()));

  const [y, m] = month.split("-").map(Number);
  const inMonth = (dateStr) => {
    const d = new Date(dateStr);
    return d.getFullYear() === y && d.getMonth() + 1 === m;
  };
  // What actually gets collected after the pharmacy's negotiated discount —
  // orders placed before this field existed have no netTotal stored, so
  // their list total is the best available stand-in.
  const netOf = (o) => (o.netTotal !== "" && o.netTotal !== undefined ? Number(o.netTotal) : Number(o.total) || 0);

  const statsByRep = {};
  for (const rep of reps) {
    const repVisits = visits.filter((v) => v.repName === rep.name && inMonth(v.time));
    const pharmacyVisits = repVisits.filter((v) => pharmacyNames.has(v.client.toLowerCase().trim())).length;
    const doctorVisits = repVisits.filter((v) => doctorNames.has(v.client.toLowerCase().trim())).length;
    const repOrders = orders.filter((o) => o.repName === rep.name && inMonth(o.date));
    const repFollowUps = followUps.filter((f) => f.repName === rep.name && inMonth(f.createdAt));
    statsByRep[rep.name] = {
      visits: repVisits.length,
      pharmacyVisits,
      doctorVisits,
      orders: repOrders.length,
      orderValue: repOrders.reduce((sum, o) => sum + netOf(o), 0),
      followUpsScheduled: repFollowUps.length,
      followUpsStopped: followUps.filter((f) => f.repName === rep.name && f.status === "stopped" && inMonth(f.createdAt)).length,
      followUpsPending: followUps.filter((f) => f.repName === rep.name && (f.status === "pending" || f.status === "reminded")).length,
    };
  }

  for (const rep of reps) {
    if (!rep.telegramChatId) continue;
    const s = statsByRep[rep.name];
    const msg =
      `📊 <b>Your ${month} summary</b>\n\n` +
      `Visits logged: <b>${s.visits}</b> (${s.pharmacyVisits} pharmacies, ${s.doctorVisits} doctors)\n` +
      `Orders placed: <b>${s.orders}</b> — sales collected: <b>${s.orderValue.toLocaleString()}</b>\n` +
      `Follow-ups scheduled: <b>${s.followUpsScheduled}</b>\n` +
      `Follow-ups stopped: <b>${s.followUpsStopped}</b>\n` +
      `Follow-ups still pending: <b>${s.followUpsPending}</b>`;
    try {
      await telegram.sendMessage(rep.telegramChatId, msg);
    } catch (e) {
      console.error(`failed to send monthly visits summary to rep ${rep.name}`, e);
    }
  }

  if (settings.managerTelegramChatId) {
    const lines = reps.map((rep) => {
      const s = statsByRep[rep.name];
      return `• <b>${escapeHtml(rep.name)}</b> — ${s.visits} visits (${s.pharmacyVisits} pharmacies, ${s.doctorVisits} doctors), ${s.orders} orders, <b>${s.orderValue.toLocaleString()}</b> collected, ${s.followUpsScheduled} follow-ups (${s.followUpsPending} pending)`;
    });
    const teamTotal = reps.reduce((sum, rep) => sum + statsByRep[rep.name].orderValue, 0);
    const teamMsg = `📊 <b>Team ${month} summary</b>\n\n${lines.join("\n") || "No reps linked yet."}\n\nTeam total collected: <b>${teamTotal.toLocaleString()}</b>`;
    try {
      await telegram.sendMessage(settings.managerTelegramChatId, teamMsg);
    } catch (e) {
      console.error("failed to send monthly team summary to manager", e);
    }
  }
}

const MONTHLY_VISITS_SUMMARY_DAY = 1; // same day as the must-sell digest, separate message
async function checkMonthlyVisitsSummary() {
  if (!telegram.isConfigured()) return;
  try {
    const now = new Date();
    if (now.getDate() !== MONTHLY_VISITS_SUMMARY_DAY) return;
    const settings = await db.getSettings();
    // Fires on the 1st, so the month that just ended (not the one that just
    // started, which on day 1 has nothing in it yet) is the one to report.
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    if (settings.lastMonthlyVisitsSummaryMonth === prevMonth) return;
    await runMonthlyVisitsSummary(prevMonth);
    await db.setSettings({ lastMonthlyVisitsSummaryMonth: prevMonth });
  } catch (e) {
    console.error("checkMonthlyVisitsSummary failed", e);
  }
}

// A rep who forgets to punch out leaves an open "in" forever, which quietly
// breaks anything relying on punch state (and just looks like the app is
// stuck). Once a day, past the cutoff hour, close out anyone still open —
// flagged "auto" for the audit trail/manager Telegram note below. This used
// to also require the rep to confirm or correct that time before punching
// in again (a blocking screen in PunchInGate) — removed because it was
// itself becoming a stuck screen for reps: confirmed:"true" from the start
// means the auto-close is just accepted, no gate, no correction step.
const PUNCH_AUTO_CLOSE_HOUR = 21; // 9pm Beirut
const PUNCH_AUTO_CLOSE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
function beirutDateStr(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Beirut" }); // yyyy-mm-dd, sorts/compares cleanly
}
async function checkMissedPunchOuts() {
  try {
    const now = new Date();
    const beirutHour = Number(now.toLocaleString("en-US", { timeZone: "Asia/Beirut", hour: "2-digit", hour12: false }));
    if (beirutHour < PUNCH_AUTO_CLOSE_HOUR) return;
    const todayStr = beirutDateStr(now);
    const settings = await db.getSettings();
    if (settings.lastPunchAutoCloseDate === todayStr) return;
    const [log, reps] = await Promise.all([db.getAllRows("PunchLog"), db.getAllRows("Reps")]);
    for (const rep of reps) {
      const mine = log.filter((p) => p.repName === rep.name).sort((a, b) => new Date(b.time) - new Date(a.time));
      const last = mine[0];
      if (!last || last.type !== "in") continue;
      const entry = {
        id: `pl${crypto.randomUUID()}`,
        repName: rep.name,
        type: "out",
        time: now.toISOString(),
        coordsLat: "",
        coordsLng: "",
        auto: "true",
        confirmed: "true",
      };
      await db.appendRow("PunchLog", entry);
      if (settings.managerTelegramChatId) {
        const timeStr = now.toLocaleTimeString("en-US", { timeZone: "Asia/Beirut", hour: "numeric", minute: "2-digit" });
        telegram.sendMessage(settings.managerTelegramChatId, `⏰ ${rep.name} didn't punch out — auto-closed at ${timeStr}.`)
          .catch((e) => console.error("missed punch-out telegram notify failed", e));
      }
    }
    await db.setSettings({ lastPunchAutoCloseDate: todayStr });
  } catch (e) {
    console.error("checkMissedPunchOuts failed", e);
  }
}
checkMissedPunchOuts();
setInterval(checkMissedPunchOuts, PUNCH_AUTO_CLOSE_CHECK_INTERVAL_MS);

if (telegram.isConfigured()) {
  checkMonthlyDigest();
  checkFollowUpReminders();
  checkSampleReminders();
  checkMonthlyVisitsSummary();
  setInterval(checkMonthlyDigest, MONTHLY_DIGEST_CHECK_INTERVAL_MS);
  setInterval(checkFollowUpReminders, FOLLOWUP_CHECK_INTERVAL_MS);
  setInterval(checkSampleReminders, FOLLOWUP_CHECK_INTERVAL_MS);
  setInterval(checkMonthlyVisitsSummary, MONTHLY_DIGEST_CHECK_INTERVAL_MS);
  telegram.getMe().then((me) => { telegramBotUsername = me.username; }).catch((e) => console.error("telegram getMe failed", e));
  if (process.env.RENDER_EXTERNAL_URL) {
    telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/api/telegram/webhook`, TELEGRAM_WEBHOOK_SECRET)
      .catch((e) => console.error("telegram setWebhook failed", e));
  }
}

// Render's free tier sleeps after ~15 minutes with no inbound traffic. A self
// request through the public URL (not localhost) counts as real traffic and
// resets that timer, keeping the service warm without any external pinger.
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_PING_URL) {
  setInterval(() => {
    fetch(`${SELF_PING_URL}/api/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

app.listen(PORT, () => console.log(`KayBee Tracker server listening on port ${PORT}`));
