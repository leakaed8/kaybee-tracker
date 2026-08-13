const path = require("path");
const crypto = require("crypto");
const express = require("express");
const webpush = require("web-push");
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
  } else if (payload.startsWith("rep|")) {
    // A supervisor is a normal rep account with an extra flag set in
    // Settings — full rep experience (Check-In, Route, punch in/out, own
    // history) plus team-wide Locations/Performance visibility and the
    // ability to comment on any rep's visit. The flag is baked into the
    // signed session at login time (not looked up per-request, to avoid an
    // extra Sheets read on every single API call) — toggling it in Settings
    // takes effect the next time that rep logs in.
    const [encodedName, flag] = payload.slice(4).split("|");
    req.role = "rep";
    req.repName = decodeURIComponent(encodedName);
    req.isSupervisor = flag === "sup";
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
  };
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
      const flag = isSupervisor ? "|sup" : "";
      setSessionCookie(res, signPayload(`rep|${encodeURIComponent(matched.name)}${flag}`), 60 * 60 * 24 * 30);
      return res.json({ ok: true, role: "rep", repName: matched.name, isSupervisor });
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

app.get("/api/session", (req, res) => res.json({ role: req.role, repName: req.repName, isSupervisor: !!req.isSupervisor }));

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

const BOOTSTRAP_TABS = ["Products", "Visits", "Clients", "Doctors", "OutreachLog", "Orders", "Reps", "Offers", "Samples", "PunchLog", "StockMovement", "FollowUps", "Competitors", "CompetitorSightings", "VisitComments", "CompetitorProducts"];

// Google's Sheets API "read requests per minute PER USER" quota (60) is fixed
// and not adjustable — and since this whole app authenticates as one shared
// service account, that limit is split across every rep and manager
// combined, not per person. Batching (above) cut this endpoint from 11
// requests to 2; this cache cuts it further by letting concurrent sessions
// polling within the same few seconds share one Sheets read instead of each
// firing their own. Any write path passes ?fresh=true to skip the cache, so
// a manager who just added something always sees it immediately.
let bootstrapCache = null; // { data, timestamp }
const BOOTSTRAP_CACHE_TTL_MS = 8000;

async function buildBootstrapPayload() {
  const [batch, rawSettings] = await Promise.all([
    db.getAllRowsBatch(BOOTSTRAP_TABS),
    db.getSettings(),
  ]);
  const {
    Products: products, Visits: visits, Clients: clients, Doctors: doctors, OutreachLog: outreachLog,
    Orders: orders, Reps: reps, Offers: offers, Samples: samples, PunchLog: punchLog, StockMovement: stockMovement,
    FollowUps: followUps, Competitors: competitors, CompetitorSightings: competitorSightings,
    VisitComments: visitComments, CompetitorProducts: competitorProducts,
  } = batch;
  const movementIndex = buildMovementIndex(stockMovement);
  return {
    products: products.map((p) => ({ ...parseProduct(p), avgMonthlyMovement: avgMonthlyMovementFor(p.name, movementIndex) })),
    visits: visits.map(parseVisit).sort((a, b) => new Date(b.time) - new Date(a.time)),
    clients,
    doctors,
    outreachLog: outreachLog.sort((a, b) => new Date(b.date) - new Date(a.date)),
    orders: orders.map(parseOrder).sort((a, b) => new Date(b.date) - new Date(a.date)),
    punchLog: punchLog.map(parsePunch).sort((a, b) => new Date(b.time) - new Date(a.time)),
    repNames: reps.map((r) => r.name),
    offers: offers.map(parseOffer),
    settings: parseSettings(rawSettings),
    samples: samples.sort((a, b) => new Date(b.date) - new Date(a.date)),
    followUps: followUps.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)),
    competitors: competitors.sort((a, b) => a.name.localeCompare(b.name)),
    competitorSightings: competitorSightings.sort((a, b) => new Date(b.date) - new Date(a.date)),
    visitComments: visitComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    competitorProducts: competitorProducts.sort((a, b) => a.genericName.localeCompare(b.genericName)),
  };
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const wantsFresh = req.query.fresh === "true";
    if (!wantsFresh && bootstrapCache && Date.now() - bootstrapCache.timestamp < BOOTSTRAP_CACHE_TTL_MS) {
      return res.json(bootstrapCache.data);
    }
    const data = await buildBootstrapPayload();
    bootstrapCache = { data, timestamp: Date.now() };
    res.json(data);
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
    const normalized = products
      .filter((p) => p.name && p.expiry)
      .map((p) => ({
        id: `p${crypto.randomUUID()}`,
        name: String(p.name).trim(),
        category: p.category || "Supplement",
        expiry: p.expiry,
        qty: Number(p.qty) || 0,
        sold90: Number(p.sold90) || 0,
        description: p.description || "",
        price: Number(p.price) || 0,
      }));
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
    if (!coords || !coords.lat || !coords.lng) {
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
    const { entityName, entityType, presetKey, visitId } = req.body;
    const preset = FOLLOWUP_PRESETS[presetKey];
    if (!entityName || !entityType || !preset) {
      return res.status(400).json({ error: "entityName, entityType and a valid presetKey are required" });
    }
    const followUp = {
      id: `fu${crypto.randomUUID()}`,
      entityName,
      entityType,
      repName: req.repName,
      dueDate: addDaysToTodayStr(preset.days),
      status: "pending",
      visitId: visitId || "",
      createdAt: new Date().toISOString(),
    };
    await db.appendRow("FollowUps", followUp);
    res.json(followUp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Flags a scheduled follow-up as needing a sample brought along, so
// checkSampleReminders can nudge the manager to have it ready a couple of
// days ahead of the visit — asked right after the follow-up date is set,
// since that's what the "2 days before" countdown is measured against.
app.patch("/api/followups/:id/sample", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Only reps can update their follow-ups." });
    const { items } = req.body;
    const patch = {
      needsSample: "true",
      sampleItems: Array.isArray(items) && items.length ? JSON.stringify(items) : "",
    };
    const ok = await db.updateRowById("FollowUps", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Follow-up not found" });
    res.json({ ok: true });
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
    // Only a pre-existing unconfirmed auto-close should hold up a new punch-in
    // — not one this same request is about to create below (see next block).
    const hadPreexistingUnconfirmedAutoOut = mine.some((p) => p.type === "out" && p.auto === "true" && p.confirmed !== "true");

    // A dangling "in" from a previous day (missed by the scheduled 9pm
    // auto-close — the free-tier server can be asleep at that exact hour,
    // or it just hasn't run yet today) would otherwise block every future
    // punch-in forever: the server refuses a new "in" while the last one is
    // still open, but the app requires a fresh punch specifically for
    // today. Close it out right now instead of leaving the rep stuck — the
    // rep still ends up seeing a "confirm your punch-out time" prompt for
    // it next time, just not one that blocks getting into today's app.
    if (type === "in" && currentlyIn && beirutDateStr(new Date(mine[0].time)) !== beirutDateStr(new Date())) {
      const staleClose = {
        id: `pl${crypto.randomUUID()}`,
        repName: req.repName,
        type: "out",
        time: new Date().toISOString(),
        coordsLat: "",
        coordsLng: "",
        auto: "true",
        confirmed: "",
      };
      await db.appendRow("PunchLog", staleClose);
      currentlyIn = false;
    }

    if (type === "in" && currentlyIn) return res.status(400).json({ error: "Already punched in." });
    if (type === "out" && !currentlyIn) return res.status(400).json({ error: "Not punched in." });
    if (type === "in" && hadPreexistingUnconfirmedAutoOut) {
      return res.status(400).json({ error: "Confirm yesterday's punch-out time before punching in." });
    }
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

// A rep confirms (or corrects) a punch-out the system auto-recorded because
// they never tapped "Punch out" themselves. Required before they can punch
// in for a new day — see checkMissedPunchOuts below for how these get
// created in the first place.
app.patch("/api/punch/:id/confirm", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const log = await db.getAllRows("PunchLog");
    const entry = log.find((p) => p.id === req.params.id);
    if (!entry) return res.status(404).json({ error: "Punch record not found." });
    if (entry.repName !== req.repName) return res.status(403).json({ error: "Not your punch record." });
    if (entry.auto !== "true") return res.status(400).json({ error: "Only auto-recorded punches need confirming." });
    const patch = { confirmed: "true" };
    const { correctedTime } = req.body;
    if (correctedTime) {
      const d = new Date(correctedTime);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid corrected time." });
      patch.time = d.toISOString();
    }
    const ok = await db.updateRowById("PunchLog", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Punch record not found." });
    res.json({ ok: true });
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
    const cleanItems = items.map((it) => ({
      productId: it.productId || "",
      name: String(it.name || "").trim(),
      qty: Number(it.qty) || 0,
      unitPrice: Number(it.unitPrice) || 0,
      isFree: !!it.isFree,
      originalPrice: Number(it.originalPrice) || 0,
      expiry: it.expiry || "",
    }));
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
    res.json(parseOrder(order));
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
const COMPETITOR_PRODUCT_FIELDS = ["competitorName", "productName", "genericName", "form", "dosage", "packSize", "price", "discountRate", "notes"];

app.post("/api/competitor-products", requireManager, async (req, res) => {
  try {
    const { competitorName, productName, genericName, form, dosage, packSize, price, discountRate, notes } = req.body;
    if (!competitorName || !productName) return res.status(400).json({ error: "competitorName and productName are required" });
    const product = {
      id: `cp${crypto.randomUUID()}`,
      competitorName: String(competitorName).trim(),
      productName: String(productName).trim(),
      genericName: genericName || "",
      form: form || "",
      dosage: dosage || "",
      packSize: packSize || "",
      price: price || "",
      discountRate: discountRate || "",
      notes: notes || "",
      createdAt: new Date().toISOString(),
    };
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
        const product = { id: `cp${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
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

app.patch("/api/competitor-products/:id", requireManager, async (req, res) => {
  try {
    const patch = {};
    for (const key of COMPETITOR_PRODUCT_FIELDS) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    const ok = await db.updateRowById("CompetitorProducts", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Competitor product not found" });
    res.json({ ok: true });
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
    const { name, phone, tier, area, assignedRep, registrationNumber, address, coordsLat, coordsLng, discountRate, nameAr } = req.body;
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
    const { toAdd } = req.body;
    const addList = Array.isArray(toAdd) ? toAdd : [];

    const newClients = addList
      .filter((c) => c.name)
      .map((c) => ({
        id: `c${crypto.randomUUID()}`,
        name: String(c.name).trim(),
        phone: c.phone || "",
        tier: c.tier || "B",
        area: c.area || "",
        assignedRep: c.assignedRep || "",
        registrationNumber: c.registrationNumber || "",
        address: c.address || "",
        nameAr: c.nameAr || "",
      }));

    if (newClients.length > 0) await db.appendRows("Clients", newClients);

    res.json({ ok: true, added: newClients.length });
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

    const newDoctors = addList
      .filter((d) => d.name)
      .map((d) => ({
        id: `doc${crypto.randomUUID()}`,
        name: String(d.name).trim(),
        hospital: d.hospital || "",
        area: d.area || "",
        phone: d.phone || "",
        specialty: d.specialty || "",
        tier: d.tier || "B",
        registrationNumber: d.registrationNumber || "",
        address: d.address || "",
      }));

    if (newDoctors.length > 0) await db.appendRows("Doctors", newDoctors);

    res.json({ ok: true, added: newDoctors.length });
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
  if (followUp.entityType === "pharmacy") {
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
// it from stock) can't happen same-day. sampleReminded guards against
// re-sending if the interval catches the same follow-up more than once
// inside its 2-day window.
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
        await telegram.sendMessage(
          rep.telegramChatId,
          `🔔 Follow-up time: visit <b>${escapeHtml(f.entityName)}</b> today.\n\nAfter your visit, when should the next follow-up be?`,
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
// flagged "auto" and unconfirmed so PunchInGate makes them confirm or
// correct that time before they can punch in for a new day (see
// /api/punch and /api/punch/:id/confirm above).
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
        confirmed: "",
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
