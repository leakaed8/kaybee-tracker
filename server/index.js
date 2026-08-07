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

async function notifyManagers(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const subs = await db.getAllRows("PushSubscriptions");
    await sendPushToSubscriptions(subs.filter((s) => s.role === "manager"), payload);
  } catch (e) {
    console.error("notifyManagers failed", e);
  }
}

async function notifyRep(repName, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !repName) return;
  try {
    const subs = await db.getAllRows("PushSubscriptions");
    await sendPushToSubscriptions(subs.filter((s) => s.role === "rep" && s.repName === repName), payload);
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
  } else if (payload.startsWith("rep|")) {
    req.role = "rep";
    req.repName = decodeURIComponent(payload.slice(4));
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

function parseOrder(o) {
  return {
    id: o.id,
    clientName: o.clientName,
    visitId: o.visitId || "",
    repName: o.repName || "",
    date: o.date,
    items: JSON.parse(o.items || "[]"),
    total: Number(o.total) || 0,
    status: o.status || "confirmed",
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
  return { id: p.id, repName: p.repName, type: p.type, time: p.time, coords };
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
      setSessionCookie(res, signPayload(`rep|${encodeURIComponent(matched.name)}`), 60 * 60 * 24 * 30);
      return res.json({ ok: true, role: "rep", repName: matched.name });
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
      await telegram.sendMessage(chatId, "That link code wasn't recognized — generate a new one from Settings and try again.");
    } else if (update.callback_query) {
      await handleDigestCallback(update.callback_query);
    }
  } catch (e) {
    console.error("telegram webhook error", e);
  }
});

app.use("/api", requireAuth);

app.get("/api/session", (req, res) => res.json({ role: req.role, repName: req.repName }));

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

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [products, visits, clients, doctors, outreachLog, orders, reps, offers, rawSettings, samples, punchLog] = await Promise.all([
      db.getAllRows("Products"),
      db.getAllRows("Visits"),
      db.getAllRows("Clients"),
      db.getAllRows("Doctors"),
      db.getAllRows("OutreachLog"),
      db.getAllRows("Orders"),
      db.getAllRows("Reps"),
      db.getAllRows("Offers"),
      db.getSettings(),
      db.getAllRows("Samples"),
      db.getAllRows("PunchLog"),
    ]);
    res.json({
      products: products.map(parseProduct),
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
    });
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

app.post("/api/visits", async (req, res) => {
  try {
    const { client, notes, coords, mentionedItems } = req.body;
    if (!client) return res.status(400).json({ error: "client is required" });
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
    res.json(visit);
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

app.post("/api/punch", async (req, res) => {
  try {
    if (!req.repName) return res.status(403).json({ error: "Reps only." });
    const { type, coords } = req.body;
    if (type !== "in" && type !== "out") return res.status(400).json({ error: "type must be 'in' or 'out'" });
    const log = await db.getAllRows("PunchLog");
    const mine = log.filter((p) => p.repName === req.repName).sort((a, b) => new Date(b.time) - new Date(a.time));
    const currentlyIn = mine.length > 0 && mine[0].type === "in";
    if (type === "in" && currentlyIn) return res.status(400).json({ error: "Already punched in." });
    if (type === "out" && !currentlyIn) return res.status(400).json({ error: "Not punched in." });
    const entry = {
      id: `pl${crypto.randomUUID()}`,
      repName: req.repName,
      type,
      time: new Date().toISOString(),
      coordsLat: coords ? coords.lat : "",
      coordsLng: coords ? coords.lng : "",
    };
    await db.appendRow("PunchLog", entry);
    res.json(entry);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { clientName, visitId, items } = req.body;
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
    }));
    const total = cleanItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
    const order = {
      id: `ord${crypto.randomUUID()}`,
      clientName,
      visitId: visitId || "",
      repName: req.repName || "",
      date: new Date().toISOString(),
      items: JSON.stringify(cleanItems),
      total,
      status: "confirmed",
    };
    await db.appendRow("Orders", order);
    notifyManagers({ title: "New order placed", body: `${clientName} — ${total.toFixed(2)}`, url: "/" });
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

app.post("/api/clients", async (req, res) => {
  try {
    const { name, phone, tier, area, assignedRep, registrationNumber, address } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const client = {
      id: `c${crypto.randomUUID()}`,
      name,
      phone: phone || "",
      tier: tier || "B",
      area: area || "",
      assignedRep: assignedRep || "",
      registrationNumber: registrationNumber || "",
      address: address || "",
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
    const ok = await db.updateRowById("Clients", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Client not found" });
    res.json({ ok: true });
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
      telegramLinked: Boolean(r.telegramChatId),
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
    const rep = { id: `rep${crypto.randomUUID()}`, name: name.trim(), passcode, email: email.trim(), exportSheetId };
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
    const ok = await db.updateRowById("Reps", req.params.id, patch);
    if (!ok) return res.status(404).json({ error: "Rep not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/telegram/status", requireManager, async (req, res) => {
  try {
    const configured = telegram.isConfigured();
    const settings = configured ? await db.getSettings() : {};
    res.json({
      configured,
      botUsername: telegramBotUsername || "",
      managerLinked: Boolean(settings.managerTelegramChatId),
    });
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
        registrationNumber: c.registrationNumber || "",
        address: c.address || "",
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
    const { name, hospital, area, phone, specialty, tier, registrationNumber, address } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
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

function daysUntilFromToday(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  d.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

const TIER_CADENCE_DAYS = { A: 14, B: 30, C: 60 };

async function checkExpiryAndOverdueAlerts() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const [products, clients, visits, rawSettings] = await Promise.all([
      db.getAllRows("Products"),
      db.getAllRows("Clients"),
      db.getAllRows("Visits"),
      db.getSettings(),
    ]);
    const newlySent = {};

    for (const p of products) {
      if (!p.expiry) continue;
      const dLeft = daysUntilFromToday(p.expiry);
      if (dLeft <= 30) {
        const key = `alert_expiry_${p.id}`;
        if (!rawSettings[key]) {
          await notifyManagers({ title: "Product expiring soon", body: `${p.name} — ${dLeft}d left`, url: "/" });
          newlySent[key] = "sent";
        }
      }
    }

    for (const c of clients) {
      const matches = visits.filter((v) => v.client.toLowerCase().trim() === c.name.toLowerCase().trim());
      const lastVisit = matches.length
        ? matches.reduce((a, b) => (new Date(b.time) > new Date(a.time) ? b : a), matches[0])
        : null;
      const daysSinceVisit = lastVisit ? Math.round((Date.now() - new Date(lastVisit.time)) / 86400000) : null;
      const cadence = TIER_CADENCE_DAYS[c.tier] || 30;
      const overdue = daysSinceVisit === null || daysSinceVisit > cadence;
      if (overdue) {
        const key = `alert_overdue_${c.id}`;
        if (!rawSettings[key]) {
          const payload = { title: "Client overdue for a visit", body: `${c.name} hasn't been visited in a while`, url: "/" };
          await notifyManagers(payload);
          if (c.assignedRep) await notifyRep(c.assignedRep, payload);
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

// ---------- Monthly "must-sell" Telegram digest ----------
// A product qualifies until real sales-history data is loaded: it must be
// near expiry (red or yellow zone) AND selling slower than the slow-mover
// threshold already used elsewhere in the app. Manager approves via an
// inline Telegram button before anything goes out to reps.

function zoneKeyFor(product) {
  const dLeft = daysUntilFromToday(product.expiry);
  if (dLeft <= 182) return "red";
  if (dLeft <= 365) return "yellow";
  return "green";
}

function turnoverPctFor(product) {
  const qty = Number(product.qty) || 0;
  const sold90 = Number(product.sold90) || 0;
  if (qty <= 0) return 0;
  return Math.round((sold90 / qty) * 100);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function computeMustSellList() {
  const [products, rawSettings] = await Promise.all([db.getAllRows("Products"), db.getSettings()]);
  const slowThreshold = rawSettings.slowThreshold !== undefined ? Number(rawSettings.slowThreshold) : 15;
  return products
    .filter((p) => p.expiry)
    .map((p) => ({
      id: p.id, name: p.name, qty: Number(p.qty) || 0, expiry: p.expiry,
      daysLeft: daysUntilFromToday(p.expiry), turnover: turnoverPctFor(p), zone: zoneKeyFor(p),
    }))
    .filter((p) => (p.zone === "red" || p.zone === "yellow") && p.turnover < slowThreshold)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

function formatDigestMessage(items) {
  if (items.length === 0) {
    return "No must-sell items this month — nothing is both near-expiry and slow-moving right now.";
  }
  const lines = items.slice(0, 30).map((it) =>
    `• <b>${escapeHtml(it.name)}</b> — ${it.qty} units, ${it.daysLeft}d to expiry, ${it.turnover}% turnover/90d`
  );
  const more = items.length > 30 ? `\n…and ${items.length - 30} more.` : "";
  return `📋 <b>This month's focus list</b> (${items.length} item${items.length === 1 ? "" : "s"})\n\n${lines.join("\n")}${more}`;
}

async function dispatchDigestToReps(items) {
  const reps = await db.getAllRows("Reps");
  const message = formatDigestMessage(items);
  for (const rep of reps) {
    if (!rep.telegramChatId) continue;
    try {
      await telegram.sendMessage(rep.telegramChatId, message);
    } catch (e) {
      console.error(`failed to send monthly digest to rep ${rep.name}`, e);
    }
  }
}

async function runMonthlyDigest(month) {
  const items = await computeMustSellList();
  const digest = {
    id: `dg${crypto.randomUUID()}`,
    month,
    status: "pending",
    payload: JSON.stringify(items),
    createdAt: new Date().toISOString(),
  };
  await db.appendRow("MonthlyDigests", digest);

  const settings = await db.getSettings();
  if (!settings.managerTelegramChatId) {
    console.warn("Monthly digest computed but no manager Telegram is linked yet — nothing sent.");
    return;
  }
  if (items.length === 0) {
    await telegram.sendMessage(settings.managerTelegramChatId, formatDigestMessage(items));
    await db.updateRowById("MonthlyDigests", digest.id, { status: "skipped" });
    return;
  }
  await telegram.sendMessage(settings.managerTelegramChatId, formatDigestMessage(items), {
    inline_keyboard: [[
      { text: "✅ Approve — send to reps", callback_data: `approve:${digest.id}` },
      { text: "Skip this month", callback_data: `skip:${digest.id}` },
    ]],
  });
}

async function handleDigestCallback(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const [action, digestId] = (data || "").split(":");
  const digests = await db.getAllRows("MonthlyDigests");
  const digest = digests.find((d) => d.id === digestId);
  if (!digest) { await telegram.answerCallbackQuery(id, "This digest is no longer available."); return; }
  if (digest.status !== "pending") { await telegram.answerCallbackQuery(id, `Already ${digest.status}.`); return; }

  if (action === "approve") {
    await dispatchDigestToReps(JSON.parse(digest.payload || "[]"));
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
if (telegram.isConfigured()) {
  checkMonthlyDigest();
  setInterval(checkMonthlyDigest, MONTHLY_DIGEST_CHECK_INTERVAL_MS);
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
