// The customer eligibility threshold for Smart Promotional Offer Assistant
// suggestions — a client whose registered discount is at or above this
// never sees promotional recommendations (client/src/helpers.js mirrors
// this exact constant for the live OrderBuilder check, which is what
// actually enforces it — that popup is advisory client-side UX, never a
// submission gate). Used here only to compute "before/after promotional
// eligibility" for the permanent discount-change audit trail (Part 3 —
// Permanent Customer Discount Management).
//
// The boundary is EXCLUSIVE at this value (30% itself is ineligible,
// 29.99% is still eligible) — unlike a simple "max eligible rate," there's
// no single largest still-eligible number in an open interval, so this is
// named and compared as a floor for ineligibility, not a ceiling for
// eligibility.
//
// Deliberately separate from — and independent of — both
// effectiveDiscount.js's 35% total-effective-discount cap and
// offerEligibility.js's "7+1" offer-generosity ceiling: three different
// axes that each measure something different about an order or a
// customer's commercial terms.
const PROMOTIONAL_INELIGIBLE_DISCOUNT_PCT = 30;

function isPromotionallyEligible(discountRate) {
  return (Number(discountRate) || 0) < PROMOTIONAL_INELIGIBLE_DISCOUNT_PCT;
}

module.exports = { PROMOTIONAL_INELIGIBLE_DISCOUNT_PCT, isPromotionallyEligible };
