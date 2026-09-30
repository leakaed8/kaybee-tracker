// The whole app operates on Lebanon time (Asia/Beirut) for every viewer,
// regardless of their device's own timezone — see the matching module in
// server/dateUtils.js, which every Beirut-day calculation on the server
// funnels through for the same reason this one does on the client.
//
// Two distinct kinds of date value exist in this app, and they need
// DIFFERENT treatment:
// - A plain "YYYY-MM-DD" string (product.expiry, a follow-up's dueDate) is a
//   calendar day that means the same thing to every viewer everywhere — Oct 7
//   is Oct 7 no matter where you open the app. It must never be reinterpreted
//   through ANY timezone (not the browser's, not even Beirut's) — doing so
//   is exactly what used to make the same stored date shift a day depending
//   on the viewer's device (e.g. "2026-09-01" reading as "31 Aug 2026" for
//   anyone west of UTC, since `new Date("YYYY-MM-DD")` parses as UTC
//   midnight and every local display method then converts to the viewer's
//   own zone).
// - A real timestamp (visit.time, createdAt, a punch time) IS timezone-
//   sensitive — "10:32 AM" means nothing without a zone — and must always
//   display as Beirut wall-clock time, the same for every viewer, never the
//   viewer's own device zone.
const TZ = "Asia/Beirut";

// Today's calendar date in Beirut, as "YYYY-MM-DD" — the anchor every
// date-only calculation below is built from, never the viewer's own device
// "today".
export const todayBeirutStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

// Which Beirut calendar day a real timestamp falls on — for bucketing/
// comparison (e.g. "is this visit on the selected route date"), never for
// arithmetic on its own.
export const beirutDateStrOfInstant = (isoString) => new Date(isoString).toLocaleDateString("sv-SE", { timeZone: TZ });

// Pure calendar-day diff between a date-only string and "today in Beirut" —
// anchored at Date.UTC on each side's Y/M/D, so wall-clock hours (and thus
// DST) never enter the arithmetic at all. Matches server/dateUtils.js's
// daysUntilFromToday exactly.
export const daysUntil = (dateStr) => {
  const [y1, m1, d1] = dateStr.split("-").map(Number);
  const [y2, m2, d2] = todayBeirutStr().split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
};

// Date-only display never needs Beirut at all — it's an opaque calendar
// label, identical for every viewer once it's not reinterpreted through any
// zone. Anchoring at Date.UTC and reading back with timeZone:"UTC" guarantees
// the exact Y/M/D we stored is what renders, regardless of the browser's own
// zone.
export const fmtDate = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};

// For a genuine timestamp (visit.time, createdAt, Orders.date, punch times)
// — every viewer sees the same Beirut wall-clock date/time, not their own
// device's.
export const fmtDateOfInstant = (isoString) => new Date(isoString).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ });
export const fmtTime = (isoString) => new Date(isoString).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", timeZone: TZ });
export const fmtDateTime = (isoString) => new Date(isoString).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });

// Adds N days to any "YYYY-MM-DD" value via the same Date.UTC round-trip as
// daysUntil above — pure calendar-day arithmetic, no timezone involved once
// you already have a Y/M/D triple (a calendar day plus N days means the same
// thing everywhere).
export const addDaysToDateStr = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};

// Day of week (0=Sun..6=Sat) for a "YYYY-MM-DD" value — timezone-independent
// once you have the correct Y/M/D, since a calendar date's weekday never
// changes depending on who's looking at it.
export const weekdayOfDateStr = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
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
// uploaded monthly data — preferring this calendar year's own uploaded
// months over the multi-year average whenever any exist, see
// avgMonthlyMovementFor server-side), it replaces the 90-day-sales proxy
// everywhere movement matters — turnover%, slow-mover, and at-risk all read
// from here.
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
