// Pure aggregation logic for the "Medical Promotion Activity" dashboard —
// deliberately split out from server/index.js (a 17k+ line Express app with
// no db-free test harness available in this environment) so this specific
// function, which carries this feature's entire privacy guarantee and all
// of its correctness, can be exercised with a plain Node script and
// synthetic data instead of relying on code review alone. See
// server/index.js's GET /api/medical-promotion-summary for how this is
// wired into the actual request (auth, tab-visibility gating, reading the
// Sheets tabs) — this file only ever takes already-fetched rows and does
// math on them; it never reads or writes anything itself.
const { beirutDateStr, todayBeirutStr, addDaysToTodayStr } = require("./dateUtils");

function normalizeProductKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// A product's brand (Alfa/Mason) is derivable from its own name prefix for
// every product this company actually carries. Mirrors
// server/index.js's own inferProductCatalogBrand exactly (that one
// backfills ProductCatalog.brand; this one is used as the fallback when a
// mentioned item's name has no match in the catalog's brand map at all).
function inferBrand(name) {
  const n = String(name || "").trim().toLowerCase();
  if (n.startsWith("alfa")) return "Alfa";
  if (n.startsWith("mason")) return "Mason";
  return "";
}

const BRAND_DISPLAY_NAMES = { Alfa: "Alfa Vitamins", Mason: "Mason Natural" };

// A (product, location) group this few distinct doctors make up is itself
// enough to point at a specific doctor in a small territory — these are
// omitted entirely from the output rather than shown with a muddied count.
const MIN_DOCTORS_FOR_DISCLOSURE = 3;

// visitRows/doctors/clients/nutritionists/productCatalog: raw rows exactly
// as db.getAllRows returns them (plain string fields, itemsMentioned still
// JSON-encoded) — this function does its own parsing so the caller doesn't
// need to know this module's internals.
//
// Returns { from, to, rows, suppressedGroups } where every row is
// { product, brand, location, doctorsReached, discussions, lastActivity }
// — no doctor name, rep name, note, address, or individual timestamp ever
// appears anywhere in the return value; that's this function's whole job.
function buildMedicalPromotionSummary({
  visitRows, doctors, clients = [], nutritionists = [], productCatalog = [],
  from, to, brandFilter = "", productFilter = "", locationFilter = "",
  minDoctorsForDisclosure = MIN_DOCTORS_FOR_DISCLOSURE,
}) {
  const resolvedTo = to || todayBeirutStr();
  const resolvedFrom = from || addDaysToTodayStr(-30);
  const brandFilterLower = brandFilter.trim().toLowerCase();
  const productFilterLower = productFilter.trim().toLowerCase();
  const locationFilterLower = locationFilter.trim().toLowerCase();

  // A visit's `client` field is just a name, matched against Doctors by
  // name — same convention used everywhere else in this app. Clients/
  // Nutritionists take precedence on a name collision (same precedence
  // /api/visit-cadence already uses), so a pharmacy or nutritionist visit
  // can never be miscounted here as a doctor one.
  const doctorAreaByName = new Map();
  doctors.forEach((d) => {
    const key = String(d.name || "").trim().toLowerCase();
    if (key) doctorAreaByName.set(key, String(d.area || "").trim());
  });
  const nonDoctorNames = new Set([
    ...clients.map((c) => String(c.name || "").trim().toLowerCase()),
    ...nutritionists.map((n) => String(n.name || "").trim().toLowerCase()),
  ]);

  // Prefers the Product Catalog's own (possibly manually-corrected) brand;
  // falls back to inferring straight from the mentioned item's own name.
  // Never joins by productId: mentionedItems[].productId is a Products
  // (stock/batch) id, a completely different id space from ProductCatalog.
  const catalogBrandByName = new Map();
  productCatalog.forEach((p) => {
    if (p.brand) catalogBrandByName.set(normalizeProductKey(p.name), p.brand);
  });
  const brandFor = (name) => catalogBrandByName.get(normalizeProductKey(name)) || inferBrand(name);

  // group key -> { product (display), brand, area (display), doctors: Set<normalized name>, discussions, lastActivity }
  const groups = new Map();

  for (const row of visitRows) {
    const clientKey = String(row.client || "").trim().toLowerCase();
    if (!clientKey || nonDoctorNames.has(clientKey) || !doctorAreaByName.has(clientKey)) continue;
    const visitDate = beirutDateStr(new Date(row.time));
    if (visitDate < resolvedFrom || visitDate > resolvedTo) continue;

    let items = [];
    try { items = JSON.parse(row.itemsMentioned || "[]"); } catch { items = []; }
    if (!items.length) continue;
    const area = doctorAreaByName.get(clientKey) || "Unassigned";
    if (locationFilterLower && !area.toLowerCase().includes(locationFilterLower)) continue;

    // Dedup within THIS visit by normalized product name — a product
    // mentioned twice under two near-duplicate catalog rows in one visit
    // is still one discussion with the doctor that day, matching this
    // dashboard's own definition ("Discussions: number of recorded visits
    // where the product was selected").
    const seenThisVisit = new Set();
    for (const item of items) {
      const name = String(item.name || "").trim();
      if (!name) continue;
      const brand = brandFor(name);
      if (brandFilterLower && brand.toLowerCase() !== brandFilterLower) continue;
      if (productFilterLower && !name.toLowerCase().includes(productFilterLower)) continue;

      const productKey = normalizeProductKey(name);
      if (seenThisVisit.has(productKey)) continue;
      seenThisVisit.add(productKey);

      const groupKey = `${productKey}::${area.toLowerCase()}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { product: name, brand, area, doctors: new Set(), discussions: 0, lastActivity: visitDate });
      }
      const g = groups.get(groupKey);
      g.doctors.add(clientKey);
      g.discussions += 1;
      if (visitDate > g.lastActivity) g.lastActivity = visitDate;
    }
  }

  let suppressedGroups = 0;
  const rows = [];
  for (const g of groups.values()) {
    if (g.doctors.size < minDoctorsForDisclosure) { suppressedGroups++; continue; }
    rows.push({
      product: g.product,
      brand: BRAND_DISPLAY_NAMES[g.brand] || g.brand || "Other",
      location: g.area,
      doctorsReached: g.doctors.size,
      discussions: g.discussions,
      lastActivity: g.lastActivity,
    });
  }
  rows.sort((a, b) => b.discussions - a.discussions);

  return { from: resolvedFrom, to: resolvedTo, rows, suppressedGroups };
}

module.exports = { buildMedicalPromotionSummary, MIN_DOCTORS_FOR_DISCLOSURE, BRAND_DISPLAY_NAMES, inferBrand, normalizeProductKey };
