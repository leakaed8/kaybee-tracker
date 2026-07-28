const path = require("path");
const crypto = require("crypto");
const express = require("express");
const db = require("./sheetsDb");
const { importedInventory, defaultTemplates } = require("./seedData");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || "kaybee-tracker-default-secret-change-me";

function signRole(role) {
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(role).digest("hex");
  return `${role}.${hmac}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const role = token.slice(0, dotIndex);
  const hmac = token.slice(dotIndex + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(role).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return role;
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
  const role = verifySessionToken(parseCookies(req).kb_session);
  if (!role) return res.status(401).json({ error: "Please log in." });
  req.role = role;
  next();
}

const DEFAULT_SETTINGS = {
  slowThreshold: 15,
  repPhone: "",
  dailyTarget: 3,
  monthlyVisitTarget: 60,
  templates: defaultTemplates,
};

function parseSettings(raw) {
  return {
    slowThreshold: raw.slowThreshold !== undefined ? Number(raw.slowThreshold) : DEFAULT_SETTINGS.slowThreshold,
    repPhone: raw.repPhone !== undefined ? raw.repPhone : DEFAULT_SETTINGS.repPhone,
    dailyTarget: raw.dailyTarget !== undefined ? Number(raw.dailyTarget) : DEFAULT_SETTINGS.dailyTarget,
    monthlyVisitTarget:
      raw.monthlyVisitTarget !== undefined ? Number(raw.monthlyVisitTarget) : DEFAULT_SETTINGS.monthlyVisitTarget,
    templates: raw.templates ? JSON.parse(raw.templates) : DEFAULT_SETTINGS.templates,
  };
}

function parseProduct(p) {
  return { ...p, qty: Number(p.qty) || 0, sold90: Number(p.sold90) || 0 };
}

function parseVisit(v) {
  const coords = v.coordsLat && v.coordsLng ? { lat: v.coordsLat, lng: v.coordsLng } : null;
  return { id: v.id, client: v.client, notes: v.notes, coords, time: v.time };
}

function visitToRow(v) {
  return {
    id: v.id,
    client: v.client,
    notes: v.notes || "",
    coordsLat: v.coords ? v.coords.lat : "",
    coordsLng: v.coords ? v.coords.lng : "",
    time: v.time,
  };
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/login", (req, res) => {
  const { passcode } = req.body || {};
  const managerCode = process.env.MANAGER_PASSCODE;
  const repCode = process.env.REP_PASSCODE;
  let role = null;
  if (managerCode && passcode === managerCode) role = "manager";
  else if (repCode && passcode === repCode) role = "rep";
  if (!role) return res.status(401).json({ error: "Incorrect passcode." });
  setSessionCookie(res, signRole(role), 60 * 60 * 24 * 30);
  res.json({ ok: true, role });
});

app.post("/api/logout", (req, res) => {
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

app.get("/api/session", (req, res) => res.json({ role: req.role }));

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [products, visits, clients, outreachLog, rawSettings] = await Promise.all([
      db.getAllRows("Products"),
      db.getAllRows("Visits"),
      db.getAllRows("Clients"),
      db.getAllRows("OutreachLog"),
      db.getSettings(),
    ]);
    res.json({
      products: products.map(parseProduct),
      visits: visits.map(parseVisit).sort((a, b) => new Date(b.time) - new Date(a.time)),
      clients,
      outreachLog: outreachLog.sort((a, b) => new Date(b.date) - new Date(a.date)),
      settings: parseSettings(rawSettings),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const { name, category, expiry, qty, sold90, description } = req.body;
    if (!name || !expiry) return res.status(400).json({ error: "name and expiry are required" });
    const product = {
      id: `p${crypto.randomUUID()}`,
      name,
      category: category || "Supplement",
      expiry,
      qty: Number(qty) || 0,
      sold90: Number(sold90) || 0,
      description: description || "",
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
    const { client, notes, coords } = req.body;
    if (!client) return res.status(400).json({ error: "client is required" });
    const visit = {
      id: `v${crypto.randomUUID()}`,
      client,
      notes: notes || "",
      coords: coords || null,
      time: new Date().toISOString(),
    };
    await db.appendRow("Visits", visitToRow(visit));
    res.json(visit);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clients", async (req, res) => {
  try {
    const { name, phone, tier, area } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const client = { id: `c${crypto.randomUUID()}`, name, phone: phone || "", tier: tier || "B", area: area || "" };
    await db.appendRow("Clients", client);
    res.json(client);
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
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, () => console.log(`KayBee Tracker server listening on port ${PORT}`));
