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
  bootstrap: () => request("/bootstrap"),
  addProduct: (product) => request("/products", { method: "POST", body: JSON.stringify(product) }),
  removeProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  importSampleInventory: () => request("/products/import-sample", { method: "POST" }),
  addVisit: (visit) => request("/visits", { method: "POST", body: JSON.stringify(visit) }),
  addClient: (client) => request("/clients", { method: "POST", body: JSON.stringify(client) }),
  removeClient: (id) => request(`/clients/${id}`, { method: "DELETE" }),
  logOutreach: (entry) => request("/outreach-log", { method: "POST", body: JSON.stringify(entry) }),
  updateSettings: (patch) => request("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};
