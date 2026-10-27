"use strict";
/**
 * Demand forecasting, reorder point calculation, and FIFO expiry-risk
 * waterfall — a JS port of the standalone Python tool's forecast.py/
 * report.py logic (leakaed8/reorder-forecasting-kaybee), adapted to read
 * from this app's own StockMovement/Products/Purchases/Destructions sheets
 * instead of raw Apothecary export files.
 *
 * Pure functions only — no Google Sheets access in this file. The server
 * route handlers fetch the sheet rows and pass plain arrays/numbers in,
 * which is what makes this testable with plain Node (see
 * server/forecasting.test.js) without live credentials.
 */

const DAYS_PER_MONTH = 30.44;

// Minimum months of history before a linear trend is even tested (fewer
// points than this and a "trend" is just noise dressed up as a formula).
const MIN_MONTHS_FOR_TREND = 12;
// Minimum months of history before monthly seasonal indices are estimated
// (need at least ~2 full yearly cycles so every calendar month has more
// than one observation behind its index).
const MIN_MONTHS_FOR_SEASONALITY = 24;
// Two-tailed significance threshold for the trend slope (Ragsdale,
// "Spreadsheet Modeling and Decision Analysis", ch. 11). A trend that isn't
// significant at this level is treated as flat.
const TREND_SIGNIFICANCE_ALPHA = 0.05;

// ---------------------------------------------------------------------
// Statistics primitives (no external dependency - verified against
// scipy.stats in server/forecasting.verify.py, see that file for the
// cross-check method and tolerance).
// ---------------------------------------------------------------------

/** Inverse standard normal CDF (Acklam's rational approximation, ~1.15e-9
 * relative error - plenty for a z-score feeding safety stock). Equivalent
 * to Excel's NORMSINV / NORM.S.INV. Cross-checked against
 * scipy.stats.norm.ppf in server/forecasting.test.js. */
function normsinv(p) {
  if (p <= 0 || p >= 1 || Number.isNaN(p)) {
    throw new RangeError(`normsinv: p must be in (0, 1), got ${p}`);
  }
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;

  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** log(Gamma(x)) via the Lanczos approximation (standard, used by logBeta below). */
function logGamma(x) {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula for x < 0.5
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = coef[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coef[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction expansion for the regularized incomplete beta
 * function (Numerical Recipes, betacf). */
function betaContinuedFraction(x, a, b) {
  const MAXIT = 200, EPS = 3e-16, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(logBt);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Two-tailed p-value for a t-statistic with `df` degrees of freedom
 * (matches scipy.stats.t.sf(abs(t), df) * 2 / Excel's T.DIST.2T).
 * Cross-checked against scipy in server/forecasting.test.js. */
function tTwoTailedPValue(tStat, df) {
  if (df <= 0) return null;
  const x = df / (df + tStat * tStat);
  return regularizedIncompleteBeta(df / 2, 0.5, x);
}

/** Simple linear regression y = intercept + slope*t, by closed-form OLS,
 * with a two-tailed significance test on the slope. Returns
 * {intercept, slope, pValue}; pValue is null when there isn't enough data
 * to test significance (fewer than 3 points, or zero variance in t). */
function olsTrend(t, y) {
  const n = t.length;
  if (n === 0) return { intercept: 0, slope: 0, pValue: null };
  const meanT = t.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  const sxx = t.reduce((s, v) => s + (v - meanT) ** 2, 0);
  if (n < 2 || sxx === 0) return { intercept: meanY, slope: 0, pValue: null };
  const sxy = t.reduce((s, v, i) => s + (v - meanT) * (y[i] - meanY), 0);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanT;
  if (n < 3) return { intercept, slope, pValue: null };

  const residuals = t.map((v, i) => y[i] - (intercept + slope * v));
  const dfResid = n - 2;
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  if (sse === 0) {
    // Every point lies exactly on the fitted line. If the slope is zero
    // too, that line is flat (y is constant) - there's no trend to be
    // "significant", so don't label it as one. If the slope is nonzero,
    // it's a perfect deterministic trend - as significant as it gets.
    return { intercept, slope, pValue: slope === 0 ? 1 : 0 };
  }
  const mse = sse / dfResid;
  const seSlope = Math.sqrt(mse / sxx);
  if (seSlope === 0) return { intercept, slope, pValue: slope === 0 ? 1 : 0 };
  const tStat = slope / seSlope;
  return { intercept, slope, pValue: tTwoTailedPValue(Math.abs(tStat), dfResid) };
}

// ---------------------------------------------------------------------
// Calendar grid
// ---------------------------------------------------------------------

/** All {year, month} pairs that have FULLY elapsed, for the given years.
 * Deliberately excludes the current, still-in-progress month. */
function monthsThatOccurred(years, today) {
  const pairs = [];
  const uniqueYears = [...new Set(years)].sort((a, b) => a - b);
  for (const year of uniqueYears) {
    if (year > today.getFullYear()) continue;
    const maxMonth = year < today.getFullYear() ? 12 : today.getMonth() + 1 - 1; // getMonth() is 0-indexed
    for (let m = 1; m <= maxMonth; m++) pairs.push({ year, month: m });
  }
  return pairs;
}

/** Reindex monthly demand so every item has an entry for every elapsed
 * month, filling months with no recorded movement as 0 (not missing).
 * monthlyDemand: [{ productName, year, month, netDemand }]
 * Returns: Map<productName, Array<{year, month, netDemand}>> sorted chronologically. */
function buildFullCalendarGrid(monthlyDemand, today) {
  const years = monthlyDemand.map((r) => r.year);
  const calendar = monthsThatOccurred(years, today);
  const products = [...new Set(monthlyDemand.map((r) => r.productName))];

  const lookup = new Map();
  for (const r of monthlyDemand) {
    lookup.set(`${r.productName}::${r.year}::${r.month}`, r.netDemand);
  }

  const grid = new Map();
  for (const productName of products) {
    const rows = calendar.map(({ year, month }) => ({
      year, month,
      // Demand can't be negative for forecasting purposes (a net
      // returns-heavy month floors at 0).
      netDemand: Math.max(0, lookup.get(`${productName}::${year}::${month}`) || 0),
    }));
    grid.set(productName, rows);
  }
  return grid;
}

// ---------------------------------------------------------------------
// Demand forecasting (trend + seasonal, gated by significance/history)
// ---------------------------------------------------------------------

function futureYearMonths(lastYear, lastMonth, count) {
  const months = [];
  let y = lastYear, m = lastMonth;
  for (let i = 0; i < count; i++) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    months.push({ year: y, month: m });
  }
  return months;
}

// Any single month's influence on a calendar month's seasonal index is
// bounded to this range. Real seasonality (e.g. a holiday-driven product)
// is nowhere near a 10x swing; a ratio outside this range means the
// preliminary trend line used to compute it was near zero for that point
// (entirely possible with oscillating or intermittent history - a
// declining fit can cross zero), not that the item is genuinely 1000x
// busier that month. Confirmed as a real bug: an opening-stock-style large
// early entry followed by sparse ordinary sales can drive the fit
// negative later in the series, and any nonzero actual value past that
// point divides by a ~1e-6 floor, producing ratios in the tens of
// millions that silently corrupt the index (and, through it, both the
// flat-level forecast and the residual stdev feeding safety stock).
const SEASONAL_RATIO_MIN = 0.1;
const SEASONAL_RATIO_MAX = 10;

function seasonalIndices(t, y, months) {
  const prelim = olsTrend(t, y);
  const trendFit0 = t.map((v) => Math.max(prelim.intercept + prelim.slope * v, 1e-6));
  const ratio = y.map((v, i) => Math.min(SEASONAL_RATIO_MAX, Math.max(SEASONAL_RATIO_MIN, v / trendFit0[i])));
  const index = {};
  for (let m = 1; m <= 12; m++) {
    const vals = ratio.filter((_, i) => months[i] === m);
    index[m] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 1;
  }
  const meanIndex = Object.values(index).reduce((s, v) => s + v, 0) / 12;
  if (meanIndex > 0) for (const m of Object.keys(index)) index[m] /= meanIndex;
  return index;
}

function medianOf(sortedValues) {
  const len = sortedValues.length;
  if (len === 0) return 0;
  const mid = Math.floor(len / 2);
  return len % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

// Modified-Z-score threshold (median/MAD based, Iglewicz & Hoaglin) for
// flagging a month's quantity as a data-entry error rather than real
// demand. Deliberately very conservative (real seasonal spikes are
// nowhere near this) - the point is to catch a fat-fingered extra digit
// or a monetary value accidentally landing in a quantity column, not to
// second-guess genuine demand variability.
const OUTLIER_MODIFIED_Z_THRESHOLD = 12;
// Never flag a value below this no matter the z-score, so a near-constant
// low-volume item (where any wobble looks "extreme" relative to its own
// tiny MAD) can't trigger a false positive.
const OUTLIER_MIN_ABSOLUTE_QTY = 1000;
// Fallback multiple-of-median used only when MAD is 0 (most months tied
// at the same value) - still needed to catch one huge outlier in an
// otherwise flat series.
const OUTLIER_FLAT_SERIES_MULTIPLE = 50;

/**
 * Flags and caps implausible month-level quantities (e.g. a fat-fingered
 * extra digit, or a monetary value accidentally imported into a quantity
 * column) before they reach the trend/residual math, where a single such
 * outlier can inflate the residual standard deviation by orders of
 * magnitude and blow up the resulting safety stock. Uses a median/MAD
 * based modified z-score (robust to the outlier itself, unlike mean/stdev).
 *
 * rows: [{year, month, netDemand}]. Returns { cleanedRows, outliers },
 * where outliers is [{year, month, originalQty}] for anything capped.
 * Needs at least 5 points to judge what "normal" looks like for this item;
 * with fewer, everything passes through unmodified.
 */
function detectOutliers(rows) {
  if (rows.length < 5) return { cleanedRows: rows, outliers: [] };
  const values = rows.map((r) => r.netDemand);
  const sorted = [...values].sort((a, b) => a - b);
  const median = medianOf(sorted);
  const absDevs = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = medianOf(absDevs);
  const cap = mad > 0 ? median + (OUTLIER_MODIFIED_Z_THRESHOLD * mad) / 0.6745 : median * OUTLIER_FLAT_SERIES_MULTIPLE;

  const outliers = [];
  const cleanedRows = rows.map((r) => {
    const isExtreme = mad > 0
      ? (0.6745 * (r.netDemand - median)) / mad > OUTLIER_MODIFIED_Z_THRESHOLD
      : median > 0 && r.netDemand > cap;
    if (isExtreme && r.netDemand > OUTLIER_MIN_ABSOLUTE_QTY) {
      outliers.push({ year: r.year, month: r.month, originalQty: r.netDemand });
      return { ...r, netDemand: cap };
    }
    return r;
  });
  return { cleanedRows, outliers };
}

/**
 * Per-item forecasted average monthly demand over the upcoming exposure
 * window, and the residual stdev feeding safety stock. See
 * reorder-forecasting-kaybee/src/reorder_forecast/forecast.py
 * compute_forecast_demand for the full method writeup - this is a
 * line-for-line port.
 *
 * rows: [{year, month, netDemand}] sorted chronologically, one item's full
 * calendar grid (as produced by buildFullCalendarGrid).
 * Returns {forecastedMonthlyDemand, forecastResidualStdDev, trendSlope,
 * trendPValue, forecastMethod, dataAnomalies}.
 */
function computeForecastDemand(rows, exposureMonths, windowMonths = 12) {
  const { cleanedRows, outliers } = detectOutliers(rows);
  rows = cleanedRows;
  const nFutureMonths = Math.max(1, Math.ceil(exposureMonths));
  const n = rows.length;
  const yAll = rows.map((r) => r.netDemand);
  const tAll = rows.map((_, i) => i);
  const monthsAll = rows.map((r) => r.month);
  const window = rows.slice(Math.max(0, n - windowMonths));
  const windowT = tAll.slice(Math.max(0, n - windowMonths));

  if (n === 0 || !yAll.some((v) => v > 0)) {
    return {
      forecastedMonthlyDemand: 0, forecastResidualStdDev: 0,
      trendSlope: 0, trendPValue: null, forecastMethod: "No demand recorded",
      dataAnomalies: outliers,
    };
  }

  const futureMonths = futureYearMonths(rows[n - 1].year, rows[n - 1].month, nFutureMonths);
  const futureT = Array.from({ length: nFutureMonths }, (_, i) => n + i);

  const useSeasonal = n >= MIN_MONTHS_FOR_SEASONALITY;
  const useTrendTest = n >= MIN_MONTHS_FOR_TREND;
  const seasonalIndex = useSeasonal ? seasonalIndices(tAll, yAll, monthsAll)
    : Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1]));

  let intercept = 0, slope = 0, pValue = null, significant = false;
  if (useTrendTest) {
    const deseasonalized = yAll.map((v, i) => v / seasonalIndex[monthsAll[i]]);
    const fit = olsTrend(tAll, deseasonalized);
    intercept = fit.intercept; slope = fit.slope; pValue = fit.pValue;
    significant = pValue !== null && pValue < TREND_SIGNIFICANCE_ALPHA;
  }

  let levelFn, method;
  if (significant) {
    levelFn = (tIdx) => intercept + slope * tIdx;
    const trendDesc = useSeasonal ? "Trend + seasonal" : "Trend only";
    method = `${trendDesc} (significant, p=${pValue.toFixed(3)})`;
  } else {
    const windowDeseason = window.map((r) => r.netDemand / seasonalIndex[r.month]);
    const flatLevel = windowDeseason.length
      ? windowDeseason.reduce((s, v) => s + v, 0) / windowDeseason.length : 0;
    levelFn = () => flatLevel;
    slope = 0;
    if (useSeasonal) {
      method = pValue !== null
        ? `Seasonal pattern, flat level (trend not significant, p=${pValue.toFixed(3)})`
        : "Seasonal pattern, flat level";
    } else if (useTrendTest) {
      method = `Trailing average (trend not significant, p=${pValue.toFixed(3)})`;
    } else {
      method = "Trailing average (insufficient history for a trend test)";
    }
  }

  const fittedActual = (tIdx, month) => Math.max(0, levelFn(tIdx) * seasonalIndex[month]);

  const windowResiduals = window.map((r, i) => r.netDemand - fittedActual(windowT[i], r.month));
  const residualStd = windowResiduals.length > 1
    ? Math.sqrt(windowResiduals.reduce((s, v) => s + v * v, 0) / windowResiduals.length)
    : 0;

  const futureValues = futureT.map((tIdx, i) => fittedActual(tIdx, futureMonths[i].month));
  const forecastedMonthlyDemand = futureValues.length
    ? futureValues.reduce((s, v) => s + v, 0) / futureValues.length : 0;

  return {
    forecastedMonthlyDemand,
    forecastResidualStdDev: residualStd,
    trendSlope: significant ? slope : 0,
    trendPValue: pValue,
    forecastMethod: method,
    dataAnomalies: outliers,
  };
}

// Minimum number of real receive events before trusting an empirically
// measured exposure window over the manager-set default - 2 gaps (3
// events) is a low bar, but a single gap could just be one unusually fast
// or slow shipment, not a representative cadence.
const MIN_PURCHASE_EVENTS_FOR_EMPIRICAL_EXPOSURE = 3;

/**
 * The real-world exposure window for an item: the gap between consecutive
 * stock arrivals, measured directly from purchase history instead of
 * assumed lead-time + review-period constants. This is arguably MORE
 * accurate than the two-constant model, since it's measuring the actual
 * end-to-end cycle (order -> arrival -> depletion -> next order ->
 * arrival) directly rather than estimating its two components
 * separately - exposureMonths only ever needs their sum anyway.
 * Uses the MEDIAN gap (not mean) so one unusually slow or fast shipment
 * doesn't skew the estimate.
 *
 * receiveDates: Date[], need not be sorted. Returns null (meaning: fall
 * back to the manager-set default) when there isn't enough history yet.
 */
function empiricalExposureDays(receiveDates) {
  if (receiveDates.length < MIN_PURCHASE_EVENTS_FOR_EMPIRICAL_EXPOSURE) return null;
  const sorted = [...receiveDates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i] - sorted[i - 1]) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

// ---------------------------------------------------------------------
// Periodic-review target stock level / suggested reorder qty
// ---------------------------------------------------------------------

/**
 * Periodic-review (order-up-to) model: stock ordered today has to last
 * until BOTH (a) the new stock arrives (leadTimeDays) AND (b) the next
 * time an order can even be placed (reviewPeriodDays).
 *
 * item: { forecastedMonthlyDemand, forecastResidualStdDev, currentStock,
 *         costPrice, salePrice, salvageValue, minOrderQty }
 * options: { leadTimeDays, reviewPeriodDays, minServiceZ, exposureDaysOverride }
 *   exposureDaysOverride, when given, replaces (leadTimeDays+reviewPeriodDays)
 *   entirely - see empiricalExposureDays below for where this comes from.
 * Returns the full computed row (exposureMonths, cu, co, criticalRatio,
 * serviceLevelZ, safetyStock, targetStockLevel, suggestedReorderQty,
 * daysOfStockRemaining).
 */
function computeReorderRecommendation(item, {
  leadTimeDays, reviewPeriodDays, minServiceZ, exposureDaysOverride,
}) {
  const exposureDays = exposureDaysOverride != null ? exposureDaysOverride : (leadTimeDays + reviewPeriodDays);
  const exposureMonths = exposureDays / DAYS_PER_MONTH;

  let cu = null, co = null, criticalRatio = null, serviceLevelZ = minServiceZ;
  const hasPrices = item.costPrice != null && item.costPrice !== "" && item.salePrice != null && item.salePrice !== "";
  if (hasPrices) {
    cu = item.salePrice - item.costPrice;
    const salvage = item.salvageValue != null && item.salvageValue !== "" ? item.salvageValue : 0;
    co = item.costPrice - salvage;
    if (cu + co > 0) {
      criticalRatio = Math.min(Math.max(cu / (cu + co), 0.001), 0.999);
      serviceLevelZ = Math.max(normsinv(criticalRatio), minServiceZ);
    }
  }

  const safetyStock = serviceLevelZ * item.forecastResidualStdDev * Math.sqrt(exposureMonths);
  const targetStockLevel = item.forecastedMonthlyDemand * exposureMonths + safetyStock;
  const rawGap = Math.max(0, targetStockLevel - item.currentStock);
  let suggestedReorderQty;
  if (rawGap <= 0) {
    suggestedReorderQty = 0;
  } else if (item.minOrderQty && item.minOrderQty > 0) {
    suggestedReorderQty = Math.ceil(rawGap / item.minOrderQty) * item.minOrderQty;
  } else {
    suggestedReorderQty = Math.ceil(rawGap);
  }

  const avgDailyDemand = item.forecastedMonthlyDemand / DAYS_PER_MONTH;
  const daysOfStockRemaining = avgDailyDemand > 0 ? item.currentStock / avgDailyDemand : Infinity;

  return {
    exposureMonths, cu, co, criticalRatio, serviceLevelZ,
    safetyStock, targetStockLevel, suggestedReorderQty, daysOfStockRemaining,
  };
}

// ---------------------------------------------------------------------
// FIFO expiry-risk waterfall (informational only - never feeds the
// reorder quantity above)
// ---------------------------------------------------------------------

/**
 * Simulates FIFO consumption against batches (oldest expiry first) at the
 * forecasted demand rate, and flags quantity projected to expire unsold.
 * batches: [{ expiryDate: Date, quantity }], sorted ascending by caller
 * not required (this sorts internally).
 */
function fifoExpiryRisk(batches, forecastedMonthlyDemand, today) {
  const avgDaily = forecastedMonthlyDemand / DAYS_PER_MONTH;
  const sorted = [...batches].sort((a, b) => a.expiryDate - b.expiryDate);

  let cumulativeQty = 0, riskAccounted = 0;
  const results = [];
  for (const batch of sorted) {
    cumulativeQty += batch.quantity;
    const daysUntilExpiry = Math.max(0, Math.round((batch.expiryDate - today) / 86400000));
    const capacityByExpiry = avgDaily * daysUntilExpiry;
    const shortfall = Math.max(0, cumulativeQty - capacityByExpiry);
    const batchAtRisk = Math.min(batch.quantity, Math.max(0, shortfall - riskAccounted));
    riskAccounted += batchAtRisk;
    results.push({ ...batch, qtyAtRiskOfExpiring: batchAtRisk });
  }
  return { batches: results, totalAtRisk: riskAccounted };
}

// ---------------------------------------------------------------------
// Budget allocation (greedy by value density - optimal for a divisible
// resource; see reorder-forecasting-kaybee WORKED_EXAMPLE.md section 4)
// ---------------------------------------------------------------------

/**
 * items: [{ id, suggestedReorderQty, costPrice, cu, minOrderQty }]
 * Returns a Map<id, optimizedOrderQty>. Items with no costPrice (can't be
 * ranked) are left unconstrained (full suggestedReorderQty), never
 * silently zeroed. If budget is null/undefined, every item passes through
 * unconstrained.
 */
function allocateBudget(items, budget) {
  const result = new Map();
  if (budget == null || budget === "") {
    for (const it of items) result.set(it.id, it.suggestedReorderQty);
    return result;
  }

  const rankable = items.filter((it) => it.suggestedReorderQty > 0 && it.costPrice > 0 && it.cu != null);
  const unrankable = items.filter((it) => !(it.suggestedReorderQty > 0 && it.costPrice > 0 && it.cu != null));
  for (const it of unrankable) result.set(it.id, it.suggestedReorderQty);

  const ranked = [...rankable].sort((a, b) => (b.cu / b.costPrice) - (a.cu / a.costPrice));
  let remaining = budget;
  for (const it of ranked) {
    const fullCost = it.suggestedReorderQty * it.costPrice;
    if (remaining <= 0) {
      result.set(it.id, 0);
    } else if (remaining >= fullCost) {
      result.set(it.id, it.suggestedReorderQty);
    } else if (it.minOrderQty && it.minOrderQty > 0) {
      const affordable = Math.floor(remaining / it.costPrice / it.minOrderQty) * it.minOrderQty;
      result.set(it.id, affordable < it.minOrderQty ? 0 : affordable);
    } else {
      result.set(it.id, Math.floor(remaining / it.costPrice));
    }
    remaining -= fullCost;
  }
  return result;
}

// ---------------------------------------------------------------------
// Full orchestration: combines all the above into one item list per
// product, from this app's own sheet rows. Pure function (no Google
// Sheets/Express in here) specifically so the whole pipeline - the place
// five independent data sources get joined together, exactly where a
// wiring mistake would hide - can be exercised directly from
// forecasting.test.js without live credentials. The server route handler
// (GET /api/reorder-forecast) is just: fetch these five tables + settings,
// call this, respond with the result.
// ---------------------------------------------------------------------

/** Products/StockMovement/Purchases/ProductCatalog are four independently
 * maintained sheets - trim+lowercase is the only match key they all share
 * reliably. A product renamed differently across sheets would split into
 * two forecast rows; nothing here can detect that automatically. */
function normalizeProductKey(name) {
  return String(name || "").trim().toLowerCase();
}

function buildReorderNotes(it) {
  const notes = [];
  if (it.suggestedReorderQty > 0) notes.push("REORDER");
  if (Number.isFinite(it.daysOfStockRemaining) && it.daysOfStockRemaining < it.exposureDays) {
    notes.push("STOCKOUT RISK before next order arrives");
  }
  if (it.qtyAtRiskOfExpiring > 0) notes.push("EXPIRY WASTE RISK");
  if (it.forecastedMonthlyDemand === 0 && it.currentStock > 0) notes.push("SLOW MOVER / EXCESS STOCK");
  if (it.historicalDefectQty > 0) notes.push("HISTORY OF SUPPLIER/IMPORT DEFECTS");
  if (it.optimizedOrderQty != null && it.optimizedOrderQty < it.suggestedReorderQty) notes.push("BUDGET-LIMITED");
  if (it.dataAnomalies && it.dataAnomalies.length > 0) {
    notes.push("DATA ANOMALY");
    for (const a of it.dataAnomalies) {
      notes.push(`implausible qty ${a.originalQty.toLocaleString()} in ${a.month}/${a.year} — check Stock Movement`);
    }
  }
  if (it.overOrder && it.overOrder.overOrderRatio != null
    && it.overOrder.overOrderRatio > OVER_ORDER_RATIO_THRESHOLD && it.overOrder.wastedQtyInWindow > 0) {
    notes.push("OVER-ORDERING HISTORY");
    const sentThrough = Math.round(it.overOrder.soldQtyInWindow + it.overOrder.wastedQtyInWindow);
    notes.push(`bought ${Math.round(it.overOrder.purchasedQtyTotal).toLocaleString()} vs ${sentThrough.toLocaleString()} sold+wasted over that period (${it.overOrder.overOrderRatio.toFixed(1)}x)`);
  }
  return notes;
}

// How much more was purchased than left the shelf (sold) or was destroyed
// as expiry waste, over the calendar window purchase history actually
// covers, before calling it a pattern of over-ordering rather than normal
// inventory buildup. Deliberately requires BOTH a wide ratio AND actual
// recorded expiry waste in that same window - buying ahead of demand
// isn't itself a problem unless it's demonstrably turning into waste.
const OVER_ORDER_RATIO_THRESHOLD = 1.5;

/**
 * Checks purchasing history against what actually left the shelf (sales,
 * from Stock Movement) plus what was destroyed as expiry waste, limited to
 * the calendar window the item's purchase records span - so older
 * Stock Movement/Destructions history outside that window (which the
 * purchasing decision couldn't have been informed by anyway) doesn't
 * dilute or skew the comparison.
 *
 * itemPurchases: raw Purchases rows for one product.
 * calendarRows: that product's full {year, month, netDemand} grid.
 * itemDestructions: raw Destructions rows for one product.
 * Returns null when there's no purchase history to compare against.
 */
function computeOverOrderSignal(itemPurchases, calendarRows, itemDestructions) {
  if (!itemPurchases.length) return null;
  const dates = itemPurchases.map((p) => new Date(p.receiveDate)).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return null;

  const purchasedQtyTotal = itemPurchases.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  const yearMonths = dates.map((d) => d.getFullYear() * 12 + d.getMonth());
  const minYM = Math.min(...yearMonths);
  const maxYM = Math.max(...yearMonths);

  const soldQtyInWindow = calendarRows
    .filter((r) => { const ym = r.year * 12 + (r.month - 1); return ym >= minYM && ym <= maxYM; })
    .reduce((s, r) => s + r.netDemand, 0);

  const minYear = Math.floor(minYM / 12);
  const maxYear = Math.floor(maxYM / 12);
  const wastedQtyInWindow = itemDestructions
    .filter((d) => {
      const isDefect = d.isDefect === true || d.isDefect === "true";
      const dy = Number(d.destructionYear);
      return !isDefect && Number.isFinite(dy) && dy >= minYear && dy <= maxYear;
    })
    .reduce((s, d) => s + (Number(d.quantity) || 0), 0);

  const denom = soldQtyInWindow + wastedQtyInWindow;
  return {
    purchasedQtyTotal, soldQtyInWindow, wastedQtyInWindow,
    overOrderRatio: denom > 0 ? purchasedQtyTotal / denom : null,
  };
}

/**
 * Year-by-year average monthly demand and its standard deviation, straight
 * from the RAW (not outlier-capped) Stock Movement history - this is the
 * transparency layer: it shows exactly what each year actually looked
 * like, including any anomaly, so a suspicious forecast can be traced back
 * to the specific year/month driving it instead of trusting the model's
 * single blended number.
 *
 * rows: [{year, month, netDemand}], the item's full calendar grid.
 * Returns [{year, monthsRecorded, avgMonthlyDemand, stdDevMonthlyDemand,
 * maxMonthlyDemand}], one entry per year, oldest first.
 */
function yearlyDemandStats(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r.netDemand);
  }
  return [...byYear.keys()].sort((a, b) => a - b).map((year) => {
    const vals = byYear.get(year);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    return {
      year,
      monthsRecorded: vals.length,
      avgMonthlyDemand: mean,
      stdDevMonthlyDemand: Math.sqrt(variance),
      maxMonthlyDemand: Math.max(...vals),
    };
  });
}

/**
 * The two headline demand averages a manager expects to be able to compare
 * side by side: a "recent" figure (trailing window, raw - not the model's
 * deseasonalized/trend-adjusted projection) and an "all-time" figure
 * (every elapsed month on record), plus the recent window's raw stdev.
 * Deliberately simple/raw, as a transparency cross-check against
 * forecastedMonthlyDemand/forecastResidualStdDev (which can legitimately
 * differ, since those are model outputs, not plain averages).
 */
function demandSummaryStats(rows, windowMonths = 12) {
  const allTimeMonthsCount = rows.length;
  const allTimeAvgMonthlyDemand = allTimeMonthsCount
    ? rows.reduce((s, r) => s + r.netDemand, 0) / allTimeMonthsCount : 0;

  const window = rows.slice(Math.max(0, rows.length - windowMonths));
  const recentMonthsCount = window.length;
  const recentAvgMonthlyDemand = recentMonthsCount
    ? window.reduce((s, r) => s + r.netDemand, 0) / recentMonthsCount : 0;
  const recentVariance = recentMonthsCount
    ? window.reduce((s, r) => s + (r.netDemand - recentAvgMonthlyDemand) ** 2, 0) / recentMonthsCount : 0;

  return {
    recentAvgMonthlyDemand, recentStdDevMonthlyDemand: Math.sqrt(recentVariance), recentMonthsCount,
    allTimeAvgMonthlyDemand, allTimeMonthsCount,
  };
}

/**
 * sheets: { stockMovement, products, purchases, destructions, productCatalog }
 *   - each the raw array of row objects as returned by db.getAllRows,
 *     field names as given in sheetsDb.js's SCHEMAS (productName/name/etc,
 *     all still strings - this function does all the Number()/Date()
 *     coercion).
 * settings: { leadTimeDays, reviewPeriodDays, minServiceZ, totalBudget }
 * today: Date
 * Returns { items: [...] }, one row per distinct product (by
 * normalizeProductKey), sorted by suggested reorder qty descending.
 */
function buildReorderForecastItems(sheets, settings, today) {
  const { stockMovement, products, purchases, destructions, productCatalog } = sheets;
  const { leadTimeDays, reviewPeriodDays, minServiceZ, totalBudget } = settings;

  const monthlyDemand = stockMovement
    .map((r) => ({
      productName: normalizeProductKey(r.productName),
      year: Number(r.year), month: Number(r.month), netDemand: Number(r.qty) || 0,
    }))
    .filter((r) => r.year && r.month);
  const calendarGrid = buildFullCalendarGrid(monthlyDemand, today);

  // Display names: ProductCatalog (manager-curated, so the cleanest
  // source) wins if present, then Products (re-imported wholesale from a
  // raw file each time, so not necessarily manager-cleaned), then
  // whatever StockMovement itself happened to use as a last resort.
  // Always trimmed, regardless of source - Products/StockMovement names
  // come from raw file uploads and aren't guaranteed clean.
  const displayNameByKey = new Map();
  for (const r of stockMovement) {
    const key = normalizeProductKey(r.productName);
    if (!displayNameByKey.has(key)) displayNameByKey.set(key, String(r.productName || "").trim());
  }
  for (const p of products) displayNameByKey.set(normalizeProductKey(p.name), String(p.name || "").trim());
  for (const p of productCatalog) displayNameByKey.set(normalizeProductKey(p.name), String(p.name || "").trim());

  const stockByProduct = new Map();
  for (const p of products) {
    const key = normalizeProductKey(p.name);
    const qty = Number(p.qty) || 0;
    const expiry = p.expiry ? new Date(p.expiry) : null;
    if (!stockByProduct.has(key)) stockByProduct.set(key, { currentStock: 0, batches: [], batchCount: 0 });
    const entry = stockByProduct.get(key);
    // Quantity across batches of the same item (different expiry dates,
    // e.g. separate shipments) is always summed into one stock total -
    // never just the latest batch.
    entry.currentStock += qty;
    if (expiry && !Number.isNaN(expiry.getTime())) {
      entry.batchCount += 1;
      if (qty > 0) entry.batches.push({ expiryDate: expiry, quantity: qty });
    }
  }
  // The "nearest expiry" worth flagging is the closest date among batches
  // that actually carry a meaningful quantity (>30 units) - a handful of
  // units expiring next week isn't the waste risk; a large batch is. Only
  // falls back to the absolute closest date (regardless of quantity, and
  // marked as such) when every batch on hand is small.
  const NEAREST_EXPIRY_MIN_QTY = 30;
  for (const entry of stockByProduct.values()) {
    const meaningful = entry.batches.filter((b) => b.quantity > NEAREST_EXPIRY_MIN_QTY);
    const pool = meaningful.length ? meaningful : entry.batches;
    entry.nearestExpirySource = meaningful.length ? "significant" : (pool.length ? "small-batch-only" : null);
    entry.nearestExpiry = pool.length
      ? pool.reduce((min, b) => (!min || b.expiryDate < min ? b.expiryDate : min), null)
      : null;
  }

  const purchasesByProduct = new Map();
  for (const pu of purchases) {
    const key = normalizeProductKey(pu.productName);
    if (!purchasesByProduct.has(key)) purchasesByProduct.set(key, []);
    purchasesByProduct.get(key).push(pu);
  }

  const catalogByProduct = new Map();
  for (const pc of productCatalog) catalogByProduct.set(normalizeProductKey(pc.name), pc);
  const productsMasterByProduct = new Map();
  for (const p of products) {
    const key = normalizeProductKey(p.name);
    if (!productsMasterByProduct.has(key)) productsMasterByProduct.set(key, p);
  }

  const destructionsByProduct = new Map();
  for (const d of destructions) {
    const key = normalizeProductKey(d.productName);
    if (!destructionsByProduct.has(key)) destructionsByProduct.set(key, []);
    destructionsByProduct.get(key).push(d);
  }

  const allKeys = new Set([...calendarGrid.keys(), ...stockByProduct.keys()]);
  const items = [];

  for (const key of allKeys) {
    const rows = calendarGrid.get(key) || [];
    const stock = stockByProduct.get(key) || { currentStock: 0, batches: [], nearestExpiry: null, nearestExpirySource: null, batchCount: 0 };
    const catalog = catalogByProduct.get(key);
    const productsMaster = productsMasterByProduct.get(key);
    const itemPurchases = purchasesByProduct.get(key) || [];

    const costedPurchases = itemPurchases
      .filter((p) => p.landedCost !== "" && p.landedCost != null && !Number.isNaN(Number(p.landedCost)))
      .sort((a, b) => new Date(a.receiveDate) - new Date(b.receiveDate));
    const costPrice = costedPurchases.length ? Number(costedPurchases[costedPurchases.length - 1].landedCost) : null;

    const receiveDates = itemPurchases.map((p) => new Date(p.receiveDate)).filter((d) => !Number.isNaN(d.getTime()));
    const exposureDaysOverride = empiricalExposureDays(receiveDates);
    const exposureDays = exposureDaysOverride != null ? exposureDaysOverride : (leadTimeDays + reviewPeriodDays);
    const exposureMonths = exposureDays / DAYS_PER_MONTH;

    const salePriceRaw = catalog && catalog.price !== "" ? catalog.price : productsMaster?.price;
    const salePrice = salePriceRaw != null && salePriceRaw !== "" ? Number(salePriceRaw) : null;
    const minOrderQtyRaw = catalog && catalog.packSize !== "" ? catalog.packSize : productsMaster?.packSize;
    const minOrderQty = minOrderQtyRaw != null && minOrderQtyRaw !== "" ? Number(minOrderQtyRaw) : null;
    const salvageValueRaw = catalog && catalog.salvageValue !== "" ? catalog.salvageValue : undefined;
    const salvageValue = salvageValueRaw != null && salvageValueRaw !== "" ? Number(salvageValueRaw) : null;

    const itemCode = (catalog && catalog.sku) || productsMaster?.sku || "";
    const brand = (catalog && catalog.brand) || "";
    const category = productsMaster?.category || "";
    // Most recent purchase's supplier, same "latest wins" convention as
    // costPrice - a supplier switch should surface the new one, not an
    // old one from years back.
    const purchasesByDate = [...itemPurchases].sort((a, b) => new Date(a.receiveDate) - new Date(b.receiveDate));
    const supplier = purchasesByDate.length ? (purchasesByDate[purchasesByDate.length - 1].supplier || "") : "";

    const demandStats = demandSummaryStats(rows, 12);

    const forecast = computeForecastDemand(rows, exposureMonths, 12);
    const reorder = computeReorderRecommendation(
      {
        forecastedMonthlyDemand: forecast.forecastedMonthlyDemand,
        forecastResidualStdDev: forecast.forecastResidualStdDev,
        currentStock: stock.currentStock,
        costPrice, salePrice, salvageValue, minOrderQty,
      },
      { leadTimeDays, reviewPeriodDays, minServiceZ, exposureDaysOverride },
    );
    const expiryRisk = fifoExpiryRisk(stock.batches, forecast.forecastedMonthlyDemand, today);
    // Simple headcount, independent of FIFO/sell-through: how much of what's
    // on hand right now expires before the next order could even arrive.
    // Deliberately a plain filter (not a forecast), so it reads the same
    // regardless of demand assumptions - a second, more conservative cross-
    // check against qtyAtRiskOfExpiring (which nets out projected sales).
    const exposureCutoff = new Date(today.getTime() + exposureDays * 86400000);
    const qtyExpiringWithinExposureWindow = stock.batches
      .filter((b) => b.expiryDate <= exposureCutoff)
      .reduce((s, b) => s + b.quantity, 0);
    const itemDestructions = destructionsByProduct.get(key) || [];
    const historicalExpiryWasteQty = itemDestructions
      .filter((d) => !(d.isDefect === true || d.isDefect === "true"))
      .reduce((s, d) => s + (Number(d.quantity) || 0), 0);
    const historicalDefectQty = itemDestructions
      .filter((d) => d.isDefect === true || d.isDefect === "true")
      .reduce((s, d) => s + (Number(d.quantity) || 0), 0);
    const overOrder = computeOverOrderSignal(itemPurchases, rows, itemDestructions);
    const yearlyStats = yearlyDemandStats(rows);

    items.push({
      productKey: key,
      productName: displayNameByKey.get(key) || key,
      itemCode, brand, category, supplier,
      currentStock: stock.currentStock,
      batchCount: stock.batchCount,
      nearestExpiry: stock.nearestExpiry ? stock.nearestExpiry.toISOString().slice(0, 10) : null,
      nearestExpirySource: stock.nearestExpirySource,
      forecastedMonthlyDemand: forecast.forecastedMonthlyDemand,
      forecastResidualStdDev: forecast.forecastResidualStdDev,
      trendSlope: forecast.trendSlope,
      trendPValue: forecast.trendPValue,
      forecastMethod: forecast.forecastMethod,
      dataAnomalies: forecast.dataAnomalies,
      yearlyStats,
      recentAvgMonthlyDemand: demandStats.recentAvgMonthlyDemand,
      recentStdDevMonthlyDemand: demandStats.recentStdDevMonthlyDemand,
      recentMonthsCount: demandStats.recentMonthsCount,
      allTimeAvgMonthlyDemand: demandStats.allTimeAvgMonthlyDemand,
      allTimeMonthsCount: demandStats.allTimeMonthsCount,
      daysOfStockRemaining: Number.isFinite(reorder.daysOfStockRemaining) ? reorder.daysOfStockRemaining : null,
      exposureDays, exposureMonths,
      exposureSource: exposureDaysOverride != null ? "empirical" : "default",
      costPrice, costSource: costPrice != null ? "purchases" : null,
      salePrice, salvageValue, minOrderQty,
      cu: reorder.cu, co: reorder.co, criticalRatio: reorder.criticalRatio, serviceLevelZ: reorder.serviceLevelZ,
      safetyStock: reorder.safetyStock, targetStockLevel: reorder.targetStockLevel,
      suggestedReorderQty: reorder.suggestedReorderQty,
      qtyExpiringWithinExposureWindow,
      qtyAtRiskOfExpiring: expiryRisk.totalAtRisk,
      historicalExpiryWasteQty,
      historicalDefectQty,
      totalDestroyedQty: historicalExpiryWasteQty + historicalDefectQty,
      overOrder,
    });
  }

  const budgetInputs = items.map((it) => ({
    id: it.productKey, suggestedReorderQty: it.suggestedReorderQty,
    costPrice: it.costPrice, cu: it.cu, minOrderQty: it.minOrderQty,
  }));
  const budgetMap = allocateBudget(budgetInputs, totalBudget);
  for (const it of items) {
    it.optimizedOrderQty = budgetMap.get(it.productKey);
    it.notes = buildReorderNotes(it);
  }

  items.sort((a, b) => b.suggestedReorderQty - a.suggestedReorderQty || b.qtyAtRiskOfExpiring - a.qtyAtRiskOfExpiring);
  return { items };
}

module.exports = {
  DAYS_PER_MONTH,
  MIN_MONTHS_FOR_TREND,
  MIN_MONTHS_FOR_SEASONALITY,
  TREND_SIGNIFICANCE_ALPHA,
  normsinv,
  tTwoTailedPValue,
  olsTrend,
  monthsThatOccurred,
  buildFullCalendarGrid,
  computeForecastDemand,
  detectOutliers,
  OUTLIER_MODIFIED_Z_THRESHOLD,
  OUTLIER_MIN_ABSOLUTE_QTY,
  empiricalExposureDays,
  MIN_PURCHASE_EVENTS_FOR_EMPIRICAL_EXPOSURE,
  computeReorderRecommendation,
  fifoExpiryRisk,
  allocateBudget,
  normalizeProductKey,
  computeOverOrderSignal,
  OVER_ORDER_RATIO_THRESHOLD,
  yearlyDemandStats,
  demandSummaryStats,
  buildReorderForecastItems,
};
