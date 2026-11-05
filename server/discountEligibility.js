// The customer eligibility threshold for Smart Promotional Offer Assistant
// suggestions — a client whose registered discount is above this never
// sees promotional recommendations (client/src/helpers.js mirrors this
// exact constant for the live OrderBuilder check, which is what actually
// enforces it — that popup is advisory client-side UX, never a submission
// gate). Used here only to compute "before/after promotional eligibility"
// for the permanent discount-change audit trail (Part 3 — Permanent
// Customer Discount Management).
//
// Deliberately separate from — and independent of — both
// effectiveDiscount.js's 35% total-effective-discount cap and
// offerEligibility.js's "7+1" offer-generosity ceiling: three different
// axes that each measure something different about an order or a
// customer's commercial terms.
const MAX_PROMOTIONAL_ELIGIBLE_DISCOUNT_PCT = 22.5;

function isPromotionallyEligible(discountRate) {
  return !(Number(discountRate) > MAX_PROMOTIONAL_ELIGIBLE_DISCOUNT_PCT);
}

module.exports = { MAX_PROMOTIONAL_ELIGIBLE_DISCOUNT_PCT, isPromotionallyEligible };
