"use strict";
// Run with: node --test server/forecasting.test.js
// (node:test is built into Node 18+, no dependency needed.)
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normsinv, tTwoTailedPValue, buildFullCalendarGrid, computeForecastDemand,
  detectOutliers, computeReorderRecommendation, fifoExpiryRisk, allocateBudget, empiricalExposureDays,
  buildReorderForecastItems,
} = require("./forecasting");

// ---------------------------------------------------------------------
// normsinv / tTwoTailedPValue - cross-checked against scipy.stats
// (norm.ppf / t.sf*2) once; values baked in here so this suite doesn't
// need Python+scipy available to run.
// ---------------------------------------------------------------------

test("normsinv matches scipy.stats.norm.ppf", () => {
  const cases = [
    [0.025, -1.9599639845400545], [0.05, -1.6448536269514729], [0.375, -0.31863936396437514],
    [0.5, 0], [0.95, 1.6448536269514722], [0.975, 1.959963984540054], [0.99, 2.3263478740408408],
  ];
  for (const [p, expected] of cases) {
    assert.ok(Math.abs(normsinv(p) - expected) < 1e-7, `normsinv(${p})`);
  }
});

test("tTwoTailedPValue matches scipy.stats.t.sf(|t|, df)*2", () => {
  const cases = [
    [1.0, 5, 0.3632174676491229], [2.5, 10, 0.03144684423660882],
    [5.0, 2, 0.037749551350623724], [1.96, 30, 0.05934231289605049],
    [7.2, 58, 1.352058021016448e-09],
  ];
  for (const [t, df, expected] of cases) {
    const got = tTwoTailedPValue(t, df);
    assert.ok(Math.abs(got - expected) < 1e-7 || Math.abs(got - expected) / expected < 1e-4,
      `t_p(${t}, df=${df}): got ${got}, expected ${expected}`);
  }
});

// ---------------------------------------------------------------------
// buildFullCalendarGrid
// ---------------------------------------------------------------------

test("calendar grid fills missing months with zero, not absence", () => {
  const grid = buildFullCalendarGrid(
    [{ productName: "A", year: 2026, month: 1, netDemand: 12 }],
    new Date(2026, 2, 15), // March 15 2026 - Jan and Feb fully elapsed
  );
  const rows = grid.get("A");
  assert.equal(rows.length, 2); // Jan, Feb only
  assert.equal(rows.find((r) => r.month === 2).netDemand, 0);
  const mean = rows.reduce((s, r) => s + r.netDemand, 0) / rows.length;
  assert.ok(Math.abs(mean - 6.0) < 1e-9); // 12/2, not 12/1
});

test("calendar grid excludes the partial current month", () => {
  const grid = buildFullCalendarGrid(
    [
      { productName: "A", year: 2026, month: 7, netDemand: 100 },
      { productName: "A", year: 2026, month: 8, netDemand: 15 }, // partial Aug, must be excluded entirely
    ],
    new Date(2026, 7, 11), // Aug 11 2026
  );
  const rows = grid.get("A");
  assert.equal(Math.max(...rows.map((r) => r.month)), 7);
  assert.equal(rows.length, 7); // Jan..Jul
  assert.equal(rows.reduce((s, r) => s + r.netDemand, 0), 100);
});

// ---------------------------------------------------------------------
// computeForecastDemand
// ---------------------------------------------------------------------

function calendarRows(values, startYear = 2024, startMonth = 1) {
  const rows = [];
  let y = startYear, m = startMonth;
  for (const v of values) {
    rows.push({ year: y, month: m, netDemand: v });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

test("insufficient history falls back to the trailing average", () => {
  const rows = calendarRows([10, 20, 30, 40]); // 4 months, mean=25
  const result = computeForecastDemand(rows, 3, 12);
  assert.ok(Math.abs(result.forecastedMonthlyDemand - 25) < 1e-9);
  assert.equal(result.trendPValue, null);
  assert.match(result.forecastMethod, /insufficient history/i);
});

test("detects a significant linear trend and projects it forward", () => {
  // 14 months, y = 10 + 2t exactly (zero noise) -> perfect fit, p=0.
  // exposure_months=1 -> one future month at t=14: forecast = 10+2*14=38.
  const rows = calendarRows(Array.from({ length: 14 }, (_, t) => 10 + 2 * t));
  const result = computeForecastDemand(rows, 1, 12);
  assert.ok(Math.abs(result.trendPValue) < 1e-9);
  assert.ok(Math.abs(result.trendSlope - 2) < 1e-9);
  assert.ok(Math.abs(result.forecastedMonthlyDemand - 38) < 1e-9);
  assert.ok(Math.abs(result.forecastResidualStdDev) < 1e-9);
  assert.match(result.forecastMethod, /trend/i);
  assert.doesNotMatch(result.forecastMethod, /seasonal/i); // only 14 months - no seasonality attempted
});

test("non-significant trend falls back to the flat trailing average", () => {
  // 14 months oscillating 20/30/... - tiny nonzero OLS slope, swamped by noise.
  const rows = calendarRows(Array.from({ length: 14 }, (_, t) => (t % 2 === 0 ? 20 : 30)));
  const result = computeForecastDemand(rows, 1, 12);
  assert.ok(result.trendPValue > 0.05);
  assert.ok(Math.abs(result.trendSlope) < 1e-9);
  assert.ok(Math.abs(result.forecastedMonthlyDemand - 25) < 1e-9);
  assert.match(result.forecastMethod, /not significant/i);
});

test("no demand recorded returns zero", () => {
  const rows = calendarRows([0, 0, 0]);
  const result = computeForecastDemand(rows, 3, 12);
  assert.equal(result.forecastedMonthlyDemand, 0);
  assert.equal(result.forecastMethod, "No demand recorded");
});

test("seasonal pattern biases the forecast toward the season", () => {
  const seasonalValue = (month) => (month === 12 ? 150 : month === 6 ? 50 : 100);
  const yearValues = Array.from({ length: 12 }, (_, i) => seasonalValue(i + 1));
  const threeYears = [...yearValues, ...yearValues, ...yearValues];

  const intoDecember = computeForecastDemand(calendarRows(threeYears.slice(0, 35)), 1, 24);
  const intoJune = computeForecastDemand(calendarRows(threeYears.slice(0, 29)), 1, 24);

  assert.match(intoDecember.forecastMethod, /seasonal/i);
  assert.ok(intoDecember.forecastedMonthlyDemand > intoJune.forecastedMonthlyDemand);
  assert.ok(intoDecember.forecastedMonthlyDemand > 100);
  assert.ok(intoJune.forecastedMonthlyDemand < 100);
});

// ---------------------------------------------------------------------
// detectOutliers - regression for a real production bug: one implausible
// month-level quantity (e.g. a fat-fingered extra digit, or a monetary
// value mistakenly imported into a quantity column) blew up the residual
// stdev by orders of magnitude, producing a suggested reorder qty in the
// hundreds of millions for an otherwise ordinary slow-moving item.
// ---------------------------------------------------------------------

test("detectOutliers caps a single implausible month without disturbing normal months", () => {
  const rows = calendarRows([40, 38, 42, 41, 39, 868222000, 40, 41, 39, 40]);
  const { cleanedRows, outliers } = detectOutliers(rows);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].originalQty, 868222000);
  assert.ok(cleanedRows[5].netDemand < 1000, "the capped value should be back in a sane range");
  assert.equal(cleanedRows[0].netDemand, 40); // untouched
});

test("detectOutliers leaves ordinary variability (even a flat series) alone", () => {
  const rows = calendarRows([40, 38, 42, 41, 39, 45, 40, 41, 39, 40]);
  assert.equal(detectOutliers(rows).outliers.length, 0);
  const flat = calendarRows([40, 40, 40, 40, 40, 40]);
  assert.equal(detectOutliers(flat).outliers.length, 0);
});

test("detectOutliers never flags small quantities, however extreme relatively", () => {
  const rows = calendarRows([1, 1, 1, 1, 1, 50]); // "extreme" by z-score but tiny in absolute terms
  assert.equal(detectOutliers(rows).outliers.length, 0);
});

test("a capped outlier surfaces as a DATA ANOMALY note with its original value", () => {
  const today = new Date(2026, 0, 15);
  const stockMovement = calendarRows([40, 38, 42, 41, 39, 868222000, 40, 41, 39, 40], 2025, 1)
    .map((r) => ({ productName: "Apple Cider Vinegar", year: r.year, month: r.month, qty: r.netDemand }));
  const products = [{ name: "Apple Cider Vinegar", qty: "5945", expiry: "" }];

  const { items } = buildReorderForecastItems(
    { stockMovement, products, purchases: [], destructions: [], productCatalog: [] },
    { leadTimeDays: 5, reviewPeriodDays: 3, minServiceZ: 1.65, totalBudget: null },
    today,
  );
  const item = items.find((it) => it.productKey === "apple cider vinegar");
  assert.ok(item.notes.includes("DATA ANOMALY"));
  assert.ok(item.notes.some((n) => n.includes("868,222,000") && n.includes("6/2025")));
  // And the whole point: the suggested qty no longer explodes.
  assert.ok(item.suggestedReorderQty < 1000, `expected a sane suggested qty, got ${item.suggestedReorderQty}`);
});

// ---------------------------------------------------------------------
// computeReorderRecommendation (periodic review) - same scenario as the
// Python tool's WORKED_EXAMPLE.md section 2, hand-verified there.
// ---------------------------------------------------------------------

test("target stock level and suggested qty match the hand-worked example", () => {
  // avg=25, stdev=11.180339887498949, lead time 75 days, review period 180
  // days, z=1.28, current stock=10.
  // exposure_months = (75+180)/30.44 = 8.377135348226018
  // target = 25*8.377135348226018 + 1.28*11.180339887498949*sqrt(8.377135348226018)
  //        = 209.42838370565045 + 41.420252525988886 = 250.84863623163932
  // suggested = ceil(250.849 - 10) = 241
  const row = computeReorderRecommendation(
    {
      forecastedMonthlyDemand: 25, forecastResidualStdDev: 11.180339887498949,
      currentStock: 10, costPrice: null, salePrice: null, minOrderQty: null,
    },
    { leadTimeDays: 75, reviewPeriodDays: 180, minServiceZ: 1.28 },
  );
  assert.ok(Math.abs(row.targetStockLevel - 250.84863623163932) < 1e-6);
  assert.equal(row.suggestedReorderQty, 241);
  assert.ok(Math.abs(row.daysOfStockRemaining - 12.176) < 1e-2);
});

test("infrequent order cycle requires a higher target than lead time alone", () => {
  // Regression for the exact bug a user caught in the Excel version: 195
  // units in stock at 35/month demand looks fine against a 2-month lead
  // time alone, but the real exposure is 2+6=8 months.
  const row = computeReorderRecommendation(
    {
      forecastedMonthlyDemand: 35, forecastResidualStdDev: 0,
      currentStock: 195, costPrice: null, salePrice: null, minOrderQty: null,
    },
    { leadTimeDays: 60, reviewPeriodDays: 180, minServiceZ: 1.28 },
  );
  assert.ok(Math.abs(row.targetStockLevel - 275.95269382391587) < 1e-6);
  assert.equal(row.suggestedReorderQty, 81);
});

test("min order qty (case pack) rounds the suggested qty up to a whole case", () => {
  const row = computeReorderRecommendation(
    {
      forecastedMonthlyDemand: 20, forecastResidualStdDev: 0,
      currentStock: 0, costPrice: null, salePrice: null, minOrderQty: 50,
    },
    { leadTimeDays: 30, reviewPeriodDays: 0, minServiceZ: 1.0 },
  );
  // raw gap = 20 * (30/30.44) ~= 19.71 -> rounds up to one case of 50, not 20.
  assert.equal(row.suggestedReorderQty, 50);
});

test("critical ratio pushes the service level above the floor but never below it", () => {
  // High margin, cheap waste -> CR-derived Z should beat the floor.
  const highMargin = computeReorderRecommendation(
    {
      forecastedMonthlyDemand: 35.25, forecastResidualStdDev: 17.166464, currentStock: 195,
      costPrice: 2, salePrice: 200, salvageValue: 0, minOrderQty: null,
    },
    { leadTimeDays: 75, reviewPeriodDays: 182, minServiceZ: 1.65 },
  );
  assert.ok(highMargin.serviceLevelZ > 1.65);

  // Modest margin -> CR-derived Z is lower than the floor, floor wins.
  const modestMargin = computeReorderRecommendation(
    {
      forecastedMonthlyDemand: 35.25, forecastResidualStdDev: 17.166464, currentStock: 195,
      costPrice: 10, salePrice: 25, salvageValue: 0, minOrderQty: null,
    },
    { leadTimeDays: 75, reviewPeriodDays: 182, minServiceZ: 1.65 },
  );
  assert.ok(Math.abs(modestMargin.serviceLevelZ - 1.65) < 1e-9);
});

// ---------------------------------------------------------------------
// fifoExpiryRisk - same scenario as the Python tool's WORKED_EXAMPLE.md
// section 3, hand-verified there.
// ---------------------------------------------------------------------

test("FIFO expiry risk matches the hand-worked example", () => {
  const today = new Date(2026, 0, 1);
  const batches = [
    { quantity: 50, expiryDate: new Date(2026, 0, 11) }, // +10 days
    { quantity: 100, expiryDate: new Date(2026, 1, 10) }, // +40 days
  ];
  const { totalAtRisk } = fifoExpiryRisk(batches, 30, today);
  assert.ok(Math.abs(totalAtRisk - 110.57818659658344) < 1e-3);
});

test("FIFO expiry risk is zero when stock sells through before expiry", () => {
  const today = new Date(2026, 0, 1);
  const batches = [{ quantity: 10, expiryDate: new Date(2027, 0, 1) }]; // +365 days
  const { totalAtRisk } = fifoExpiryRisk(batches, 100, today);
  assert.ok(Math.abs(totalAtRisk) < 1e-9);
});

// ---------------------------------------------------------------------
// empiricalExposureDays
// ---------------------------------------------------------------------

test("empirical exposure uses the median gap between real receive dates", () => {
  // Gaps: Jan1->Apr1 (90d), Apr1->Jul1 (91d), Jul1->Dec28 (~180d, one slow
  // shipment) - median (91) should win over the mean (~120), so the one
  // slow shipment doesn't skew the estimate.
  const dates = [new Date(2025, 0, 1), new Date(2025, 3, 1), new Date(2025, 6, 1), new Date(2025, 11, 28)];
  const result = empiricalExposureDays(dates);
  assert.ok(result > 85 && result < 95, `expected ~91, got ${result}`);
});

test("empirical exposure returns null with too little purchase history", () => {
  const dates = [new Date(2025, 0, 1), new Date(2025, 3, 1)]; // only 1 gap
  assert.equal(empiricalExposureDays(dates), null);
});

// ---------------------------------------------------------------------
// allocateBudget - same 3-item scenario as the Python tool's
// WORKED_EXAMPLE.md section 4, independently verified there by actually
// executing the Excel formula chain via LibreOffice.
// ---------------------------------------------------------------------

test("budget allocation funds the highest value-density items first", () => {
  const items = [
    { id: "A", suggestedReorderQty: 119, costPrice: 2, cu: 1, minOrderQty: null }, // density 0.5
    { id: "B", suggestedReorderQty: 416, costPrice: null, cu: null, minOrderQty: null }, // unpriced
    { id: "C", suggestedReorderQty: 366, costPrice: 5, cu: 3, minOrderQty: null }, // density 0.6
  ];
  const result = allocateBudget(items, 50);
  assert.equal(result.get("C"), 10); // highest density, funded first, partial: floor(50/5)=10
  assert.equal(result.get("A"), 0); // budget already consumed by C's FULL suggested cost (366*5=1830... wait C's full cost is computed from ITS OWN suggestedReorderQty
  assert.equal(result.get("B"), 416); // unpriced -> unconstrained, full suggested qty passes through
});

test("budget allocation passes every item through unconstrained when no budget is set", () => {
  const items = [
    { id: "A", suggestedReorderQty: 119, costPrice: 2, cu: 1, minOrderQty: null },
  ];
  const result = allocateBudget(items, null);
  assert.equal(result.get("A"), 119);
});

// ---------------------------------------------------------------------
// buildReorderForecastItems - the full pipeline joining all five sheets.
// This is exactly where a wiring mistake between otherwise-correct pieces
// would hide (see the standalone Excel tool's cli.py bug this same class
// of integration test caught there), so it's tested with realistic
// multi-sheet mock data, not just the pure math functions in isolation.
// ---------------------------------------------------------------------

test("buildReorderForecastItems joins StockMovement/Products/Purchases/Destructions/ProductCatalog correctly", () => {
  const today = new Date(2026, 0, 15); // Jan 15 2026

  // 14 months of StockMovement for "Alflexil 500mg", Nov 2024..Dec 2025,
  // matched case/whitespace-insensitively against the other sheets (" alflexil 500mg " etc).
  const stockMovement = [];
  let y = 2024, m = 11;
  for (let i = 0; i < 14; i++) {
    stockMovement.push({ productName: "Alflexil 500mg", year: y, month: m, qty: 40 });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }

  const products = [
    { name: " alflexil 500mg ", qty: "100", expiry: "2026-06-01" },
    { name: " alflexil 500mg ", qty: "50", expiry: "2026-08-01" },
    { name: "Unrelated Item", qty: "10", expiry: "2026-01-01" },
  ];

  const purchases = [
    { productName: "ALFLEXIL 500MG", receiveDate: "2025-06-01", quantity: 100, landedCost: "3.10" },
    { productName: "ALFLEXIL 500MG", receiveDate: "2025-10-01", quantity: 100, landedCost: "3.40" }, // most recent -> this is the cost used
  ];

  const destructions = [
    { productName: "Alflexil 500mg", quantity: 5, isDefect: "false" },
    { productName: "Alflexil 500mg", quantity: 2, isDefect: "true" },
  ];

  const productCatalog = [
    { name: "Alflexil 500mg", price: "7.20", packSize: "" },
  ];

  const { items } = buildReorderForecastItems(
    { stockMovement, products, purchases, destructions, productCatalog },
    { leadTimeDays: 75, reviewPeriodDays: 182, minServiceZ: 1.65, totalBudget: null },
    today,
  );

  assert.equal(items.length, 2); // Alflexil + Unrelated Item
  const alflexil = items.find((it) => it.productKey === "alflexil 500mg");
  assert.ok(alflexil, "Alflexil should be matched across all sheets despite case/whitespace differences");

  assert.equal(alflexil.productName, "Alflexil 500mg"); // display name from ProductCatalog/Products, not the raw StockMovement casing
  assert.equal(alflexil.currentStock, 150); // 100 + 50 batches summed
  assert.equal(alflexil.batchCount, 2);
  assert.equal(alflexil.costPrice, 3.4); // most recent purchase by receiveDate, not the first
  assert.equal(alflexil.salePrice, 7.2); // from ProductCatalog
  assert.equal(alflexil.historicalExpiryWasteQty, 5);
  assert.equal(alflexil.historicalDefectQty, 2);
  assert.ok(alflexil.forecastedMonthlyDemand > 0);
  assert.ok(alflexil.cu != null && alflexil.co != null); // critical ratio computed since both prices present
  assert.ok(Array.isArray(alflexil.notes));

  const unrelated = items.find((it) => it.productKey === "unrelated item");
  assert.ok(unrelated);
  assert.equal(unrelated.costPrice, null); // no purchase history -> unpriced, not zero
  assert.equal(unrelated.salePrice, null); // no catalog entry either
});

test("buildReorderForecastItems: a budget caps optimizedOrderQty but never suggestedReorderQty", () => {
  const today = new Date(2026, 0, 15);
  const stockMovement = [
    { productName: "A", year: 2025, month: 1, qty: 100 },
    { productName: "B", year: 2025, month: 1, qty: 100 },
  ];
  const products = [
    { name: "A", qty: "0", expiry: "" },
    { name: "B", qty: "0", expiry: "" },
  ];
  const purchases = [
    { productName: "A", receiveDate: "2025-06-01", quantity: 10, landedCost: "1" },
    { productName: "B", receiveDate: "2025-06-01", quantity: 10, landedCost: "10" },
  ];
  const productCatalog = [
    { name: "A", price: "2", packSize: "" }, // Cu=1, density 1/1=1.0
    { name: "B", price: "11", packSize: "" }, // Cu=1, density 1/10=0.1 -> funded second
  ];

  const { items } = buildReorderForecastItems(
    { stockMovement, products, purchases, destructions: [], productCatalog },
    { leadTimeDays: 10, reviewPeriodDays: 0, minServiceZ: 1.0, totalBudget: 5 },
    today,
  );

  const a = items.find((it) => it.productKey === "a");
  const b = items.find((it) => it.productKey === "b");
  assert.ok(a.suggestedReorderQty > 0 && b.suggestedReorderQty > 0);
  assert.equal(a.optimizedOrderQty, Math.floor(5 / 1)); // all $5 budget goes to the denser item A
  assert.equal(b.optimizedOrderQty, 0); // nothing left for B
  assert.ok(a.notes.includes("BUDGET-LIMITED") || a.optimizedOrderQty === a.suggestedReorderQty);
  assert.ok(b.notes.includes("BUDGET-LIMITED"));
});
