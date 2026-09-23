// A stalled request (dropped connection, a slow Render cold-start that never
// comes back, anything) has no natural end — fetch() itself has no timeout,
// so without this an action like Punch In can spin on "Punching in…"
// forever with no way for the rep to know something's wrong or retry.
const REQUEST_TIMEOUT_MS = 25000;

async function request(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  // A FormData body (Certifications/Rep Q&A document upload) must NOT get a
  // manual Content-Type — the browser sets its own with the multipart
  // boundary, and overriding it here would break multer's parsing.
  const isFormData = options?.body instanceof FormData;
  try {
    res = await fetch(`/api${path}`, {
      headers: isFormData ? {} : { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Couldn't reach the server — check your connection and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Builds a query string from a params object, dropping undefined/null/empty
// values so callers can pass a sparse object without worrying about it
// (e.g. { client: "", limit: 5 } becomes just "?limit=5").
function qs(params) {
  const clean = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (clean.length === 0) return "";
  return `?${new URLSearchParams(clean).toString()}`;
}

// Certifications/Rep Q&A uploads: fields plus an optional `file` (a File
// object from an <input type="file">) go into one multipart FormData body.
function toFormData(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    fd.append(key, value);
  }
  return fd;
}

export const api = {
  login: (passcode) => request("/login", { method: "POST", body: JSON.stringify({ passcode }) }),
  logout: () => request("/logout", { method: "POST" }),
  getSession: () => request("/session"),
  bootstrap: (opts) => request(opts?.fresh ? "/bootstrap?fresh=true" : "/bootstrap"),
  bootstrapReference: (opts) => request(opts?.fresh ? "/bootstrap/reference?fresh=true" : "/bootstrap/reference"),
  getVisits: (params) => request(`/visits${qs(params)}`),
  getOrders: (params) => request(`/orders${qs(params)}`),
  getSamples: (params) => request(`/samples${qs(params)}`),
  getPunchLog: (params) => request(`/punch-log${qs(params)}`),
  getOutreachLogToday: () => request("/outreach-log/today"),
  getCompetitorSightings: (params) => request(`/competitor-sightings${qs(params)}`),
  getCompetitorProducts: (params) => request(`/competitor-products${qs(params)}`),
  getClientVisitStats: (names) => request("/clients/visit-stats", { method: "POST", body: JSON.stringify({ names }) }),
  getVisitCadence: () => request("/visit-cadence"),
  getDoctorVisitStats: (names) => request("/doctors/visit-stats", { method: "POST", body: JSON.stringify({ names }) }),
  // Doctor-visit redesign: one combined read for a single doctor's Pre-Call
  // brief (lastVisit/memory) + full Timeline. Distinct from the batch
  // getDoctorVisitStats above, which is only for DoctorsView's list rows.
  getDoctorProfile: (name) => request(`/doctors/${encodeURIComponent(name)}/profile`),
  // Pharmacy/supplement-store equivalent (Manager Performance Management
  // redesign) — same shape as getDoctorProfile, used by ClientsView's
  // History-toggle upgrade.
  getClientProfile: (name) => request(`/clients/${encodeURIComponent(name)}/profile`),
  addProduct: (product) => request("/products", { method: "POST", body: JSON.stringify(product) }),
  removeProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  addCatalogProduct: (product) => request("/product-catalog", { method: "POST", body: JSON.stringify(product) }),
  updateCatalogProduct: (id, patch) => request(`/product-catalog/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeCatalogProduct: (id) => request(`/product-catalog/${id}`, { method: "DELETE" }),
  importCatalogProductsBulk: (products) => request("/product-catalog/import-bulk", { method: "POST", body: JSON.stringify({ products }) }),
  importSampleInventory: () => request("/products/import-sample", { method: "POST" }),
  importBulkProducts: (products) => request("/products/import-bulk", { method: "POST", body: JSON.stringify({ products }) }),
  addVisit: (visit) => request("/visits", { method: "POST", body: JSON.stringify(visit) }),
  updateVisit: (id, patch) => request(`/visits/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeVisit: (id) => request(`/visits/${id}`, { method: "DELETE" }),
  punch: (type, coords) => request("/punch", { method: "POST", body: JSON.stringify({ type, coords }) }),
  createOrder: (order) => request("/orders", { method: "POST", body: JSON.stringify(order) }),
  updateOrder: (id, patch) => request(`/orders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteOrder: (id) => request(`/orders/${id}`, { method: "DELETE" }),
  requestDeleteOrder: (id) => request(`/orders/${id}/request-delete`, { method: "POST" }),
  approveDeleteOrder: (id) => request(`/orders/${id}/approve-delete`, { method: "POST" }),
  denyDeleteOrder: (id) => request(`/orders/${id}/deny-delete`, { method: "POST" }),
  markOrderPosEntered: (id) => request(`/orders/${id}/pos-entered`, { method: "PATCH" }),
  addOffer: (offer) => request("/offers", { method: "POST", body: JSON.stringify(offer) }),
  updateOffer: (id, patch) => request(`/offers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeOffer: (id) => request(`/offers/${id}`, { method: "DELETE" }),
  addClient: (client) => request("/clients", { method: "POST", body: JSON.stringify(client) }),
  importClientsBulk: (payload) => request("/clients/import-bulk", { method: "POST", body: JSON.stringify(payload) }),
  removeClient: (id) => request(`/clients/${id}`, { method: "DELETE" }),
  assignClientRep: (id, assignedRep) => request(`/clients/${id}`, { method: "PATCH", body: JSON.stringify({ assignedRep }) }),
  updateClientDiscount: (id, discountRate) => request(`/clients/${id}`, { method: "PATCH", body: JSON.stringify({ discountRate }) }),
  completeClientInfo: (id, patch) => request(`/clients/${id}/complete-info`, { method: "PATCH", body: JSON.stringify(patch) }),
  completeDoctorInfo: (id, patch) => request(`/doctors/${id}/complete-info`, { method: "PATCH", body: JSON.stringify(patch) }),
  addDoctor: (doctor) => request("/doctors", { method: "POST", body: JSON.stringify(doctor) }),
  importDoctorsBulk: (payload) => request("/doctors/import-bulk", { method: "POST", body: JSON.stringify(payload) }),
  removeDoctor: (id) => request(`/doctors/${id}`, { method: "DELETE" }),
  getReps: () => request("/reps"),
  addRep: (rep) => request("/reps", { method: "POST", body: JSON.stringify(rep) }),
  updateRep: (id, patch) => request(`/reps/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeRep: (id) => request(`/reps/${id}`, { method: "DELETE" }),
  createRepExportSheet: (id, email) => request(`/reps/${id}/create-export-sheet`, { method: "POST", body: JSON.stringify({ email }) }),
  getMyExportSheet: () => request("/reps/me/export-sheet"),
  getVapidPublicKey: () => request("/push/vapid-public-key"),
  savePushSubscription: (subscription) => request("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) }),
  logOutreach: (entry) => request("/outreach-log", { method: "POST", body: JSON.stringify(entry) }),
  updateSettings: (patch) => request("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  getTelegramStatus: () => request("/telegram/status"),
  sendTelegramDigestNow: () => request("/telegram/send-digest-now", { method: "POST" }),
  getMyTelegramLinkCode: () => request("/reps/me/telegram-link-code", { method: "POST" }),
  getStockMovementStatus: () => request("/stock-movement/status"),
  importStockMovement: (year, rows) => request("/stock-movement/import", { method: "POST", body: JSON.stringify({ year, rows }) }),
  unlockStockMovementYear: (year) => request("/stock-movement/unlock", { method: "POST", body: JSON.stringify({ year }) }),
  getRepTelegramLinkCode: (id) => request(`/reps/${id}/telegram-link-code`, { method: "POST" }),
  getManagerTelegramLinkCode: () => request("/settings/telegram-link-code", { method: "POST" }),
  scheduleFollowUp: (followUp) => request("/followups", { method: "POST", body: JSON.stringify(followUp) }),
  stopFollowUp: (payload) => request("/followups/stop", { method: "POST", body: JSON.stringify(payload) }),
  addSamples: (payload) => request("/samples", { method: "POST", body: JSON.stringify(payload) }),
  getPharmacySalesStatus: () => request("/pharmacy-sales/status"),
  importPharmacySales: (rows) => request("/pharmacy-sales/import", { method: "POST", body: JSON.stringify({ rows }) }),
  addCompetitor: (competitor) => request("/competitors", { method: "POST", body: JSON.stringify(competitor) }),
  updateCompetitor: (id, patch) => request(`/competitors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeCompetitor: (id) => request(`/competitors/${id}`, { method: "DELETE" }),
  addCompetitorProduct: (product) => request("/competitor-products", { method: "POST", body: JSON.stringify(product) }),
  importCompetitorProductsBulk: (products) => request("/competitor-products/import-bulk", { method: "POST", body: JSON.stringify({ products }) }),
  updateCompetitorProduct: (id, patch) => request(`/competitor-products/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeCompetitorProduct: (id) => request(`/competitor-products/${id}`, { method: "DELETE" }),
  addVisitComment: (visitId, text) => request(`/visits/${visitId}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  getTrainingVideos: () => request("/training-videos"),
  getTrainingVideo: (id) => request(`/training-videos/${id}`),
  addTrainingVideo: (payload) => request("/admin/training-videos", { method: "POST", body: JSON.stringify(payload) }),
  updateTrainingVideo: (id, patch) => request(`/admin/training-videos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeTrainingVideo: (id) => request(`/admin/training-videos/${id}`, { method: "DELETE" }),
  getTrainingPlaybackUrl: (id) => request(`/training-videos/${id}/playback-url`),
  completeTrainingVideo: (id, quizResponses) => request(`/training-videos/${id}/complete`, { method: "POST", body: JSON.stringify({ quizResponses }) }),
  getTrainingProgress: () => request("/training-progress"),
  getTrainingStudies: () => request("/training-studies"),
  addTrainingStudy: (payload) => request("/admin/training-studies", { method: "POST", body: JSON.stringify(payload) }),
  updateTrainingStudy: (id, patch) => request(`/admin/training-studies/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeTrainingStudy: (id) => request(`/admin/training-studies/${id}`, { method: "DELETE" }),
  markTrainingStudyViewed: (id) => request(`/training-studies/${id}/viewed`, { method: "POST" }),
  tagTrainingStudyNutrient: (id, nutrient) => request(`/training-studies/${id}/nutrient`, { method: "PATCH", body: JSON.stringify({ nutrient }) }),
  getRecallCategories: () => request("/recall/categories"),
  getRecallCategory: (id) => request(`/recall/categories/${id}`),
  getRecallAssignments: (repName) => request(`/recall/assignments?repName=${encodeURIComponent(repName)}`),
  saveRecallAssignments: (repName, categoryIds) => request("/recall/assignments", { method: "POST", body: JSON.stringify({ repName, categoryIds }) }),
  getRecallDosageForms: () => request("/recall/dosage-forms"),
  updateRecallCompetitorResearch: (id, patch) => request(`/recall/competitor-research/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  updateRecallOurProduct: (linkId, patch) => request(`/recall/our-products/${linkId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  addRecallRetailerListing: (listing) => request("/recall/retailer-listings", { method: "POST", body: JSON.stringify(listing) }),
  updateRecallRetailerListing: (id, patch) => request(`/recall/retailer-listings/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  resolveRecallFieldConflict: (id, resolution) => request(`/recall/field-conflicts/${id}/resolve`, { method: "PATCH", body: JSON.stringify({ resolution }) }),
  getRecallLinkableProducts: () => request("/recall/linkable-products"),
  getRecallCompetitorRelationships: () => request("/recall/competitor-relationships"),
  addRecallCompetitorRelationship: (payload) => request("/recall/competitor-relationships", { method: "POST", body: JSON.stringify(payload) }),
  removeRecallCompetitorRelationship: (id) => request(`/recall/competitor-relationships/${id}`, { method: "DELETE" }),

  // ---------- Manager Performance Management redesign ----------
  correctInteractionType: (visitId, interactionType, reason) =>
    request(`/visits/${visitId}/interaction-type`, { method: "PATCH", body: JSON.stringify({ interactionType, reason }) }),
  getAuditLog: (params) => request(`/audit-log${qs(params)}`),
  getRepTargets: () => request("/rep-targets"),
  saveRepTarget: (repName, patch) => request(`/rep-targets/${encodeURIComponent(repName)}`, { method: "PUT", body: JSON.stringify(patch) }),
  assignDoctorRep: (id, assignedRep) => request(`/doctors/${id}`, { method: "PATCH", body: JSON.stringify({ assignedRep }) }),
  getFollowUps: (params) => request(`/followups${qs(params)}`),
  updateFollowUp: (id, patch) => request(`/followups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  getManagerNotes: (repName) => request(`/manager-notes${qs({ repName })}`),
  addManagerNote: (note) => request("/manager-notes", { method: "POST", body: JSON.stringify(note) }),

  // ---------- Product Expert: Certifications + Rep Q&A ----------
  getCertifications: () => request("/certifications"),
  addCertification: (fields) => request("/admin/certifications", { method: "POST", body: toFormData(fields) }),
  updateCertification: (id, fields) => request(`/admin/certifications/${id}`, { method: "PATCH", body: toFormData(fields) }),
  removeCertification: (id) => request(`/admin/certifications/${id}`, { method: "DELETE" }),
  getCertificationViewUrl: (id) => request(`/certifications/${id}/view-url`),
  getRepQuestions: () => request("/rep-questions"),
  addRepQuestion: (payload) => request("/rep-questions", { method: "POST", body: JSON.stringify(payload) }),
  answerRepQuestion: (id, fields) => request(`/admin/rep-questions/${id}/answer`, { method: "PATCH", body: toFormData(fields) }),
  getRepQuestionAnswerViewUrl: (id) => request(`/rep-questions/${id}/answer-document/view-url`),
};
