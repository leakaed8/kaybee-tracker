// Offer-generosity ceiling: an offer more generous than the "7+1"
// equivalent ratio can never be used on an order without the Head of
// Sales's explicit sign-off — for EVERY client, new or established.
// Purchase history isn't an automatic unlock; it's what the approver
// looks at when deciding (see notifyOfferApprovalNeeded, server/index.js).
//
// Deliberately separate from — and independent of — the 35%
// total-effective-discount cap in effectiveDiscount.js: that one measures
// what the CUSTOMER actually ends up paying across the whole invoice;
// this one measures how generous the OFFER ITSELF is, before any
// additional invoice discount is even applied. An order can trip either,
// both, or neither.
//
// The ratio, not the raw buyQty/getQty numbers, is what's compared — a
// "16+2" offer is exactly as generous as "8+1" (2/18 = 1/9), so it's
// judged the same way, never flagged just for being a bigger instance of
// an already-fine ratio.
const MAX_AUTO_APPROVED_FREE_RATIO = 1 / 8; // the "7+1" ceiling: 1 free per 8 total = 12.5%
const RATIO_EPSILON = 1e-9; // guards the exact ceiling itself against float noise

function offerFreeRatio(offer) {
  const buyQty = Number(offer?.buyQty) || 0;
  const getQty = Number(offer?.getQty) || 0;
  const totalQty = buyQty + getQty;
  return totalQty > 0 ? getQty / totalQty : 0;
}

// True only for an offer MORE generous than the ceiling — exactly at the
// ceiling (7+1, or any equivalent ratio like 14+2) is still auto-allowed.
function offerRequiresApproval(offer) {
  return offerFreeRatio(offer) > MAX_AUTO_APPROVED_FREE_RATIO + RATIO_EPSILON;
}

// Given this order's clean items and a Map of offerId -> offer, true if
// ANY item on the order belongs to an offer that requires sign-off.
function orderNeedsOfferApproval(items, offerById) {
  return (items || []).some((it) => {
    if (!it.offerId) return false;
    const offer = offerById.get(it.offerId);
    return offer ? offerRequiresApproval(offer) : false;
  });
}

module.exports = { MAX_AUTO_APPROVED_FREE_RATIO, offerFreeRatio, offerRequiresApproval, orderNeedsOfferApproval };
