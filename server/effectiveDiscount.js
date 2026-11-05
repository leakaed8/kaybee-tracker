// Total Effective Discount — a MONITORING/VALIDATION layer, deliberately
// kept separate from (and never feeding back into) the existing
// promotional pricing engine. It never recomputes what a customer is
// charged — buildCleanOrderItems/validateOfferGroups/total/netTotal in
// server/index.js remain the one and only source of truth for that. This
// module only MEASURES an already-priced order against full undiscounted
// retail value, for display and for enforcing the 35% promotional cap.
//
// Definitions (matches the spec's own worked example — 6-paid-for-7 under
// a Buy 6 Get 1 Free offer, plus a 22.5% additional invoice discount,
// comes out to 33.57%, verified in effectiveDiscount.test.js):
//   fullRetailValue   - every unit supplied (paid AND free) priced at its
//                        full list price — a free item's list price is its
//                        own `originalPrice`, which the existing offer
//                        engine already preserves on every free line.
//   finalInvoiceAmount - what the customer actually pays. The caller
//                        passes this in directly (it's the order's own
//                        already-computed `netTotal` — never
//                        re-derived here), so this module can never drift
//                        from the real invoice total.
//   effectiveDiscountPct - (fullRetailValue - finalInvoiceAmount) /
//                        fullRetailValue * 100: the customer's real
//                        savings against full retail, NOT the promotional
//                        % and the additional % added together.

function computeFullRetailValue(items) {
  return (items || []).reduce((sum, it) => {
    const qty = Number(it.qty) || 0;
    const listPrice = it.isFree ? (Number(it.originalPrice) || 0) : (Number(it.unitPrice) || 0);
    return sum + qty * listPrice;
  }, 0);
}

// An item carries offerId whenever it was added under a chosen promotion
// instance — true for both its paid lines and its carved-free line(s) — so
// this is true the moment ANY promotional offer is part of the order, not
// just when a free unit has already been carved out.
function hasPromotionalItems(items) {
  return (items || []).some((it) => !!it.offerId);
}

function computeEffectiveDiscountPct(fullRetailValue, finalInvoiceAmount) {
  if (!(fullRetailValue > 0)) return 0;
  return ((fullRetailValue - finalInvoiceAmount) / fullRetailValue) * 100;
}

// The maximum permitted total effective discount on an invoice that
// contains any promotional offer. Does NOT apply to an ordinary invoice
// with no promotional item, however high its registered discount —
// that's a separate, already-existing commercial-terms question, not a
// promotional-math one.
const MAX_PROMOTIONAL_EFFECTIVE_DISCOUNT_PCT = 35;

// Guards the "exactly 35% must be ALLOWED, but 35.00000001% must be
// REJECTED even though it also rounds to 35.00" requirement against
// ordinary floating-point noise (e.g. 34.999999999999993 from a chain of
// divisions that is mathematically exactly 35) without ever widening the
// real boundary enough to let a genuine 35.01% slip through.
const EFFECTIVE_DISCOUNT_EPSILON = 1e-9;

function exceedsPromotionalCap(effectiveDiscountPct) {
  return effectiveDiscountPct > MAX_PROMOTIONAL_EFFECTIVE_DISCOUNT_PCT + EFFECTIVE_DISCOUNT_EPSILON;
}

// One call for route handlers: given the items that are about to be/were
// saved and the order's own already-computed finalInvoiceAmount (its
// netTotal — never recomputed here), reports the full-precision effective
// discount and whether it's over the cap. `exceeded` is only ever true
// when the order actually contains a promotional item — an ordinary
// invoice is never capped by this, regardless of how high its registered
// discount is.
function evaluatePromotionalCap(items, finalInvoiceAmount) {
  const fullRetailValue = computeFullRetailValue(items);
  const effectiveDiscountPct = computeEffectiveDiscountPct(fullRetailValue, finalInvoiceAmount);
  const promotional = hasPromotionalItems(items);
  return {
    fullRetailValue,
    effectiveDiscountPct,
    hasPromotionalItems: promotional,
    exceeded: promotional && exceedsPromotionalCap(effectiveDiscountPct),
  };
}

module.exports = {
  computeFullRetailValue,
  hasPromotionalItems,
  computeEffectiveDiscountPct,
  exceedsPromotionalCap,
  evaluatePromotionalCap,
  MAX_PROMOTIONAL_EFFECTIVE_DISCOUNT_PCT,
};
