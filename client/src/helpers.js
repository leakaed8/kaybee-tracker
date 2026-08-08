// A plain "YYYY-MM-DD" string should mean the same calendar day no matter who
// views it. `new Date("YYYY-MM-DD")` parses that as UTC midnight, and every
// display/comparison method that follows (toLocaleDateString, setHours, ...)
// converts to the VIEWER's local timezone — so anyone west of UTC sees it
// roll back a day (e.g. "2026-09-01" reads as "31 Aug 2026"). Building the
// date directly from its Y/M/D parts sidesteps that UTC round-trip entirely.
const parseDateOnly = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const daysUntil = (dateStr) => {
  const d = parseDateOnly(dateStr);
  const now = new Date();
  d.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
};

export const fmtDate = (dateStr) => {
  const d = parseDateOnly(dateStr);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const turnoverPct = (sold90, qty) => {
  if (qty <= 0) return 0;
  return Math.round((sold90 / qty) * 100);
};

// Three-bucket expiry zone, same for every role: red (<=6mo), yellow
// (6-12mo), green (>1yr out). Slow-moving stock is tracked separately via
// isSlowMover — it's an orthogonal signal (sales velocity), not a 4th zone.
export const zoneFor = (product) => {
  const dLeft = daysUntil(product.expiry);
  if (dLeft <= 182) return { key: "red", label: "Red zone", sub: "Expires within 6 months", color: "#B33A3A" };
  if (dLeft <= 365) return { key: "yellow", label: "Yellow zone", sub: "Expires within a year", color: "#D9A441" };
  return { key: "green", label: "Green zone", sub: "More than a year out", color: "#4C7A5E" };
};

// Once real Stock Movement history exists for a product (avgMonthlyMovement,
// attached server-side in /api/bootstrap by matching product name against
// uploaded monthly data), it replaces the 90-day-sales proxy everywhere
// movement matters — turnover%, slow-mover, and at-risk all read from here.
export const effectiveSold90 = (product) =>
  product.avgMonthlyMovement != null ? product.avgMonthlyMovement * 3 : Number(product.sold90) || 0;

export const isSlowMover = (product, slowThreshold) => turnoverPct(effectiveSold90(product), product.qty) < slowThreshold;

// Projects whether current stock will clear before the item expires — an
// early-warning signal independent of the red/yellow/green calendar zones,
// since a product can look "safe" (green, >1yr out) today and still be
// mathematically doomed to expire unsold if it's moving too slowly for how
// much is left.
export const isAtRisk = (product) => {
  const dLeft = daysUntil(product.expiry);
  if (dLeft <= 0) return false;
  const qty = Number(product.qty) || 0;
  if (qty <= 0) return false;
  const monthlyMovement = product.avgMonthlyMovement != null ? product.avgMonthlyMovement : (Number(product.sold90) || 0) / 3;
  const monthsToSellThrough = monthlyMovement > 0 ? qty / monthlyMovement : Infinity;
  const monthsUntilExpiry = dLeft / 30.44;
  return monthsToSellThrough > monthsUntilExpiry;
};

export const lifecyclePct = (product) => {
  const totalDays = 730;
  const dLeft = daysUntil(product.expiry);
  return Math.max(0, Math.min(100, 100 - (dLeft / totalDays) * 100));
};

export const TIER_CADENCE = { A: 14, B: 30, C: 60 };

export const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const daysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.round((new Date() - new Date(dateStr)) / 86400000);
};

// Composite 0-100 priority score for pharmacies/doctors — higher means visit
// them sooner. Combines tier weight, how overdue they are relative to their
// cadence, and revenue/engagement history so reps can triage a long list.
export const computeLeadScore = ({ tier, days, cadence, revenue = 0, engagement = 0 }) => {
  const tierPoints = { A: 40, B: 25, C: 12 }[tier] ?? 20;
  const overdueRatio = days === null ? 1.5 : Math.min(2, days / Math.max(cadence, 1));
  const urgencyPoints = Math.min(35, Math.round(overdueRatio * 20));
  const revenuePoints = Math.min(15, Math.round(revenue / 200));
  const engagementPoints = Math.min(10, Math.round(engagement * 5));
  return Math.max(0, Math.min(100, tierPoints + urgencyPoints + revenuePoints + engagementPoints));
};

const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Handles the three shapes a spreadsheet cell can hand back: a JS Date (xlsx
// parses formatted date cells this way), an Excel serial day number (cells
// that hold a date but aren't formatted as one), or a plain text date string.
export const parseExcelCellDate = (value) => {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + value * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    // A cell formatted as "mmm-yy" (e.g. "Sep-26" for an expiry sheet) can come
    // back as that literal text after an export/re-import round trip. JS's
    // native Date parser misreads the 2-digit year as a day-of-month in a
    // bogus year ("Sep-26" -> 26 Sep 2001), so handle month+year text
    // explicitly before falling back to the generic parser below.
    const monthYear = text.match(/^([A-Za-z]{3,9})[\s-]+(\d{2,4})$/);
    if (monthYear) {
      const month = MONTH_ABBR[monthYear[1].slice(0, 3).toLowerCase()];
      if (month !== undefined) {
        let year = Number(monthYear[2]);
        if (year < 100) year += year < 80 ? 2000 : 1900;
        return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      }
    }
    const d = new Date(text);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
};
