export const daysUntil = (dateStr) => {
  const d = new Date(dateStr);
  const now = new Date();
  d.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
};

export const fmtDate = (dateStr) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const turnoverPct = (sold90, qty) => {
  if (qty <= 0) return 0;
  return Math.round((sold90 / qty) * 100);
};

export const zoneFor = (product, role, slowThreshold) => {
  const dLeft = daysUntil(product.expiry);
  const turnover = turnoverPct(product.sold90, product.qty);
  const isSlow = turnover < slowThreshold;
  if (role === "rep") {
    if (dLeft <= 30) return { key: "urgent", label: "Urgent — act now", color: "#B33A3A" };
    if (dLeft <= 90) return { key: "soon", label: "Approaching", color: "#D9A441" };
    return isSlow ? { key: "slow", label: "Slow mover", color: "#6B7280" } : { key: "ok", label: "Healthy", color: "#4C7A5E" };
  }
  if (dLeft <= 30) return { key: "urgent", label: "Urgent — act now", color: "#B33A3A" };
  if (dLeft <= 180 && dLeft > 30) return { key: "watch", label: "Plan ahead (6–12mo)", color: "#D9A441" };
  if (dLeft <= 365 && dLeft > 180) return { key: "watch2", label: "On the radar", color: "#C17817" };
  return isSlow ? { key: "slow", label: "Slow mover", color: "#6B7280" } : { key: "ok", label: "Healthy", color: "#4C7A5E" };
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
