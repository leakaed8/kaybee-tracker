// ---------- Competitor product calculations ----------
// Pure, dependency-free helpers so a rep never has to do this math by hand.
// Every function tolerates missing/invalid input and returns null (never
// NaN/Infinity) so the UI can show "—" instead of a misleading number.

export const FORM_OPTIONS = [
  "Tablet", "Capsule", "Softgel", "Chewable", "Effervescent",
  "Powder / Sachet", "Syrup", "Drops", "Injection", "Cream / Ointment", "Spray", "Other",
];

export const UNIT_OPTIONS = ["mg", "mcg", "g", "IU", "mL", "%", "Other"];

export function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Best-effort parse of a legacy free-text "dosage" string like "500mg" or
// "5 mg" into {amount, unit} — used only to backfill rows saved before the
// structured `ingredients` field existed.
export function parseLegacyDosage(dosage) {
  if (!dosage) return { amount: null, unit: "" };
  const match = String(dosage).match(/([\d.]+)\s*([a-zA-Z%]*)/);
  if (!match) return { amount: null, unit: "" };
  return { amount: toNum(match[1]), unit: match[2] || "" };
}

// Normalizes to an array of {name, form, amount, unit} whether the product
// uses the new structured `ingredients` field or the old single
// genericName/dosage pair, so every render path can treat all products —
// old and new — the same way.
export function getIngredients(product) {
  if (product.ingredients) {
    try {
      const parsed = typeof product.ingredients === "string" ? JSON.parse(product.ingredients) : product.ingredients;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((i) => ({ name: i.name || "", form: i.form || "", amount: toNum(i.amount), unit: i.unit || "" }));
      }
    } catch {
      // fall through to legacy shape below
    }
  }
  if (product.genericName) {
    const { amount, unit } = parseLegacyDosage(product.dosage);
    return [{ name: product.genericName, form: "", amount, unit }];
  }
  return [];
}

export function formatIngredients(ingredients) {
  if (!ingredients || ingredients.length === 0) return "";
  return ingredients
    .filter((i) => i.name)
    .map((i) => `${i.name}${i.amount != null ? ` ${i.amount}${i.unit || ""}` : ""}`)
    .join(" + ");
}

// The single source of truth for every derived commercial number shown in
// the UI — days supply, cost/day, cost/month, cost/dose, effective price.
// Never divides by zero and never fabricates a number from missing data.
export function computeMetrics(product) {
  const packSize = toNum(product.packSize);
  const price = toNum(product.price);
  const discountRate = toNum(product.discountRate);
  // 1 unit/day is the overwhelmingly common case, and the field defaults to
  // it too — so a product saved without an explicit value still computes.
  const unitsPerDay = toNum(product.unitsPerDay) || 1;

  const hasPrice = price != null && price >= 0;
  const hasPackSize = packSize != null && packSize > 0;
  const hasDiscount = discountRate != null && discountRate > 0;

  const effectivePrice = hasPrice
    ? (hasDiscount ? price * (1 - Math.min(discountRate, 100) / 100) : price)
    : null;

  const daysSupply = hasPackSize && unitsPerDay > 0 ? packSize / unitsPerDay : null;
  const costPerDay = effectivePrice != null && daysSupply ? effectivePrice / daysSupply : null;
  const costPerMonth = costPerDay != null ? costPerDay * 30 : null;
  const costPerDose = effectivePrice != null && hasPackSize ? effectivePrice / packSize : null;

  return {
    packSize, price, discountRate, unitsPerDay,
    hasPrice, hasPackSize, hasDiscount,
    effectivePrice, daysSupply, costPerDay, costPerMonth, costPerDose,
  };
}

export function fmtMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtDays(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Factual, non-medical differences only — no "better"/"more effective"
// language. Anything comparative that needs a value on both sides skips
// silently when either side is missing that value, rather than guessing.
export function buildKeyDifferences(a, b) {
  const ia = getIngredients(a);
  const ib = getIngredients(b);
  const ma = computeMetrics(a);
  const mb = computeMetrics(b);
  const nameA = a.productName || "Product A";
  const nameB = b.productName || "Product B";
  const diffs = [];

  const doseA = ia[0];
  const doseB = ib[0];
  if (doseA?.amount != null && doseB?.amount != null) {
    if (doseA.unit === doseB.unit && doseA.amount !== doseB.amount) {
      diffs.push(`${nameA} provides ${doseA.amount}${doseA.unit || ""}/day vs ${doseB.amount}${doseB.unit || ""}/day for ${nameB}.`);
    } else if (doseA.unit !== doseB.unit) {
      diffs.push(`${nameA} is dosed in ${doseA.unit || "unspecified units"} and ${nameB} in ${doseB.unit || "unspecified units"} — not directly comparable.`);
    }
  }

  if (ma.daysSupply != null && mb.daysSupply != null && Math.round(ma.daysSupply) !== Math.round(mb.daysSupply)) {
    diffs.push(`${nameA} gives ${fmtDays(ma.daysSupply)} days supply vs ${fmtDays(mb.daysSupply)} for ${nameB}.`);
  }

  if (ma.costPerDay != null && mb.costPerDay != null && Math.abs(ma.costPerDay - mb.costPerDay) > 0.005) {
    diffs.push(`${nameA} costs ${fmtMoney(ma.costPerDay)}/day vs ${fmtMoney(mb.costPerDay)}/day for ${nameB}.`);
  }

  if (ia.length !== ib.length && ia.length > 0 && ib.length > 0) {
    const more = ia.length > ib.length ? nameA : nameB;
    diffs.push(`${more} lists an additional active ingredient (${ia.length} vs ${ib.length} total).`);
  } else if (ia.length > 1 && ib.length > 1) {
    const namesA = ia.map((i) => i.name.toLowerCase()).sort().join(",");
    const namesB = ib.map((i) => i.name.toLowerCase()).sort().join(",");
    if (namesA !== namesB) diffs.push(`${nameA} and ${nameB} combine different sets of active ingredients.`);
  }

  if (a.form && b.form && a.form.toLowerCase() !== b.form.toLowerCase()) {
    diffs.push(`${nameA} is a ${a.form.toLowerCase()} while ${nameB} is a ${b.form.toLowerCase()}.`);
  }

  if (!ma.hasPrice || !mb.hasPrice) diffs.push("Price is missing for one product — cost comparisons above may be incomplete.");
  if (!ma.hasPackSize || !mb.hasPackSize) diffs.push("Pack size is missing for one product — days-supply comparisons above may be incomplete.");

  return diffs;
}

export function validateProductForm(form) {
  if (!form.competitorName?.trim()) return "Brand is required.";
  if (!form.productName?.trim()) return "Product name is required.";
  if (form.price !== "" && form.price != null) {
    const price = toNum(form.price);
    if (price === null || price < 0) return "Public price can't be negative.";
  }
  if (form.packSize !== "" && form.packSize != null) {
    const packSize = toNum(form.packSize);
    if (packSize === null || packSize <= 0) return "Pack size must be greater than zero.";
  }
  if (form.discountRate !== "" && form.discountRate != null) {
    const discount = toNum(form.discountRate);
    if (discount === null || discount < 0 || discount > 100) return "Supplier discount must be between 0 and 100.";
  }
  if (form.unitsPerDay !== "" && form.unitsPerDay != null) {
    const upd = toNum(form.unitsPerDay);
    if (upd === null || upd <= 0) return "Units per day must be greater than zero.";
  }
  for (const ing of form.ingredients || []) {
    if (ing.amount !== "" && ing.amount != null && toNum(ing.amount) === null) {
      return `"${ing.name || "Ingredient"}" needs a valid numeric amount.`;
    }
  }
  return null;
}
