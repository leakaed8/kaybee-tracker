async function request(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  login: (passcode) => request("/login", { method: "POST", body: JSON.stringify({ passcode }) }),
  logout: () => request("/logout", { method: "POST" }),
  getSession: () => request("/session"),
  bootstrap: () => request("/bootstrap"),
  addProduct: (product) => request("/products", { method: "POST", body: JSON.stringify(product) }),
  removeProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  importSampleInventory: () => request("/products/import-sample", { method: "POST" }),
  importBulkProducts: (products) => request("/products/import-bulk", { method: "POST", body: JSON.stringify({ products }) }),
  addVisit: (visit) => request("/visits", { method: "POST", body: JSON.stringify(visit) }),
  createOrder: (order) => request("/orders", { method: "POST", body: JSON.stringify(order) }),
  deleteOrder: (id) => request(`/orders/${id}`, { method: "DELETE" }),
  requestDeleteOrder: (id) => request(`/orders/${id}/request-delete`, { method: "POST" }),
  approveDeleteOrder: (id) => request(`/orders/${id}/approve-delete`, { method: "POST" }),
  denyDeleteOrder: (id) => request(`/orders/${id}/deny-delete`, { method: "POST" }),
  addOffer: (offer) => request("/offers", { method: "POST", body: JSON.stringify(offer) }),
  updateOffer: (id, patch) => request(`/offers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeOffer: (id) => request(`/offers/${id}`, { method: "DELETE" }),
  addClient: (client) => request("/clients", { method: "POST", body: JSON.stringify(client) }),
  importClientsBulk: (payload) => request("/clients/import-bulk", { method: "POST", body: JSON.stringify(payload) }),
  removeClient: (id) => request(`/clients/${id}`, { method: "DELETE" }),
  assignClientRep: (id, assignedRep) => request(`/clients/${id}`, { method: "PATCH", body: JSON.stringify({ assignedRep }) }),
  getReps: () => request("/reps"),
  addRep: (rep) => request("/reps", { method: "POST", body: JSON.stringify(rep) }),
  removeRep: (id) => request(`/reps/${id}`, { method: "DELETE" }),
  getVapidPublicKey: () => request("/push/vapid-public-key"),
  savePushSubscription: (subscription) => request("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) }),
  logOutreach: (entry) => request("/outreach-log", { method: "POST", body: JSON.stringify(entry) }),
  updateSettings: (patch) => request("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};
