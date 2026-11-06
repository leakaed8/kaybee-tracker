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

// A product's brand (Alfa/Mason) is derivable from its own name for every
// product this company actually carries — but almost always as a
// parenthesized SUFFIX ("Biotin 5000 Mcg 100 Tabs (alfa)"), not a prefix;
// only a handful of names happen to start with the brand word too. Matched
// as a whole word anywhere in the name (word-boundaried, so an unrelated
// word that merely contains "alfa"/"mason" as a substring, like a
// hypothetical "Alfalfa Extract", is never mistaken for the brand). Mirrors
// server/index.js's own inferProductCatalogBrand exactly (that one
// backfills ProductCatalog.brand; this one is used as the fallback when a
// mentioned item's name has no match in the catalog's brand map at all).
function inferBrand(name) {
  const n = String(name || "");
  if (/\balfa\b/i.test(n)) return "Alfa";
  if (/\bmason\b/i.test(n)) return "Mason";
  return "";
}

const BRAND_DISPLAY_NAMES = { Alfa: "Alfa Vitamins", Mason: "Mason Natural" };

// "Beirut" tags along on some area entries ("Beirut Hamra") and not others
// ("Hamra") for what's still the same real neighborhood — every area this
// company tracks is within Beirut anyway, so the word adds no actual
// distinction and is dropped entirely rather than merely reordered. Only
// dropped when something else is left to identify the place by; an area
// that's genuinely just "Beirut" with nothing more specific stays "Beirut"
// instead of collapsing to empty (which would wrongly fall into
// "Unassigned").
const LOCATION_NOISE_WORDS = new Set(["beirut"]);

// A doctor's "area" (free-text territory) can have the same real place
// entered in a different word order ("Beirut Hamra" vs "Hamra Beirut") or
// with a redundant qualifier only sometimes included ("Beirut Hamra" vs
// plain "Hamra") — both otherwise split one location into separate
// groups/dropdown entries. Canonicalized by dropping noise words, then
// sorting whatever's left alphabetically: safe, since this only ever
// merges entries built from the same meaningful word(s) in a different
// order or with/without "Beirut", never two genuinely different place
// names. Always displayed in that same sorted, title-cased order so the
// merged group shows one consistent label no matter which variant a
// doctor's record happened to use.
function canonicalizeLocation(area) {
  const allWords = String(area || "").trim().split(/\s+/).filter(Boolean);
  if (allWords.length === 0) return "";
  const meaningfulWords = allWords.filter((w) => !LOCATION_NOISE_WORDS.has(w.toLowerCase()));
  const words = meaningfulWords.length > 0 ? meaningfulWords : allWords;
  return words
    .map((w) => w.toLowerCase())
    .sort()
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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
    const area = canonicalizeLocation(doctorAreaByName.get(clientKey)) || "Unassigned";
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

module.exports = { buildMedicalPromotionSummary, MIN_DOCTORS_FOR_DISCLOSURE, BRAND_DISPLAY_NAMES, inferBrand, normalizeProductKey, canonicalizeLocation };
