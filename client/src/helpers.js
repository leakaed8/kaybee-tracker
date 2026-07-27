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
