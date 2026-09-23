import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";
import { daysUntil } from "./helpers.js";
import { DocumentViewer } from "./DocumentViewer.jsx";

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "24px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}

const CERT_BRANDS = ["Alfa", "Mason"];
const CERT_LEVELS = [
  { key: "brand", label: "Company/Brand Certifications" },
  { key: "product", label: "Product Certifications" },
];
// Standard supplement-industry set (user-confirmed). Plain constants, not
// manager-editable — same pattern as other hardcoded option lists in this
// app (e.g. CALL_OUTCOME_OPTIONS).
const CERT_TYPES_BY_LEVEL = {
  brand: ["GMP", "ISO 22000", "HACCP", "FDA Facility Registration", "Halal", "Kosher", "Organic"],
  product: ["Third-Party Lab Test", "Heavy Metals Test", "Microbiology Test", "Potency/Purity Test", "Allergen-Free", "Non-GMO"],
};

// Computed purely from expiryDate — deliberately independent of the
// Stock/Expiry Alerts zoneFor system (that's about physical inventory
// expiry, this is about a document's validity period). 60 days is a
// reasonable "renew soon" window for a certification, distinct from the
// 6/12-month stock zones.
function certStatus(expiryDate) {
  if (!expiryDate) return { key: "active", label: "ACTIVE", color: "#4C7A5E" };
  const d = daysUntil(expiryDate);
  if (d < 0) return { key: "expired", label: "EXPIRED", color: "#B33A3A" };
  if (d <= 60) return { key: "expiring", label: "EXPIRING SOON", color: "#D9A441" };
  return { key: "active", label: "ACTIVE", color: "#4C7A5E" };
}

const pillStyle = (active) => ({
  padding: "6px 14px", borderRadius: 16, fontSize: 12.5, fontWeight: 500,
  border: active ? "1px solid #1F2A24" : "1px solid #E5DFD3",
  background: active ? "#1F2A24" : "#fff", color: active ? "#FAF7F2" : "#5B5445",
});

export function CertificationsView({ role, products }) {
  const [brand, setBrand] = useState(CERT_BRANDS[0]);
  const [level, setLevel] = useState("brand");
  const [certifications, setCertifications] = useState(null);
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [viewerDoc, setViewerDoc] = useState(null);
  const canEdit = role === "manager";

  const load = useCallback(() => {
    api.getCertifications().then((d) => setCertifications(d.certifications || [])).catch(() => setCertifications([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = search.toLowerCase().trim();
  const filtered = (certifications || []).filter((c) => {
    if (c.brand !== brand || c.level !== level) return false;
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      (c.productName || "").toLowerCase().includes(q) ||
      c.certificationType.toLowerCase().includes(q) ||
      c.brand.toLowerCase().includes(q)
    );
  });

  const doDelete = async (id) => {
    setDeleting(true);
    try {
      await api.removeCertification(id);
      setConfirmDeleteId(null);
      load();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px" }}>Certifications</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 14px" }}>
        Company/brand and product certifications, viewable in-app — reps can view, only a manager can upload or remove.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {CERT_BRANDS.map((b) => (
          <button key={b} onClick={() => setBrand(b)} style={pillStyle(brand === b)}>{b}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {CERT_LEVELS.map((l) => (
          <button key={l.key} onClick={() => setLevel(l.key)} style={pillStyle(level === l.key)}>{l.label}</button>
        ))}
      </div>

      {canEdit && (
        showAddForm ? (
          <AddCertificationForm
            key={`${brand}|${level}`}
            brand={brand}
            level={level}
            products={products}
            onAdded={() => { setShowAddForm(false); load(); }}
            onCancel={() => setShowAddForm(false)}
          />
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            style={{ fontSize: 12.5, color: "#1F2A24", background: "#fff", border: "1px solid #1F2A24", borderRadius: 8, padding: "8px 14px", marginBottom: 14 }}
          >
            + Upload certification
          </button>
        )
      )}

      {certifications && certifications.length > 0 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, product, or type…"
          style={{ ...inputStyle, marginBottom: 14 }}
        />
      )}

      {certifications === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {certifications && filtered.length === 0 && <EmptyState text="No certifications here yet." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((c) => {
          const status = certStatus(c.expiryDate);
          return (
            <div key={c.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</div>
                  <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 2 }}>
                    {c.certificationType}{c.productName ? ` · ${c.productName}` : ""}
                  </div>
                  {c.description && <div style={{ fontSize: 12, color: "#5B5445", marginTop: 4 }}>{c.description}</div>}
                  {(c.issueDate || c.expiryDate) && (
                    <div style={{ fontSize: 10.5, color: "#B7AF9E", marginTop: 6 }}>
                      {c.issueDate && `Issued ${c.issueDate}`}{c.issueDate && c.expiryDate ? " · " : ""}{c.expiryDate && `Expires ${c.expiryDate}`}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, color: status.color, background: `${status.color}18`, border: `1px solid ${status.color}55`, borderRadius: 12, padding: "3px 8px", whiteSpace: "nowrap" }}>
                  {status.label}
                </div>
              </div>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => setViewerDoc(c)} style={{ fontSize: 11.5, color: "#4C7A5E", background: "#fff", border: "1px solid #CFE0D5", borderRadius: 6, padding: "6px 10px" }}>
                  View document
                </button>
                {canEdit && (
                  confirmDeleteId === c.id ? (
                    <>
                      <span style={{ fontSize: 11.5, color: "#B33A3A" }}>Delete this certification?</span>
                      <button onClick={() => doDelete(c.id)} disabled={deleting} style={{ fontSize: 11.5, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>
                        {deleting ? "Deleting…" : "Yes, delete"}
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)} style={{ fontSize: 11.5, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(c.id)} style={{ fontSize: 11.5, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>
                      Delete
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      <DocumentViewer
        open={!!viewerDoc}
        onClose={() => setViewerDoc(null)}
        title={viewerDoc?.title || ""}
        mimeType={viewerDoc?.documentMimeType || ""}
        fetchViewUrl={() => api.getCertificationViewUrl(viewerDoc.id)}
      />
    </div>
  );
}

function AddCertificationForm({ brand, level, products, onAdded, onCancel }) {
  const [certificationType, setCertificationType] = useState(CERT_TYPES_BY_LEVEL[level][0]);
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedProduct = (products || []).find((p) => p.id === productId);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!title.trim()) return setError("Title is required.");
    if (!file) return setError("Please choose a document to upload.");
    if (level === "product" && !selectedProduct) return setError("Please select a product.");
    setSaving(true);
    try {
      await api.addCertification({
        brand, level, certificationType,
        productId: level === "product" ? productId : undefined,
        productName: level === "product" ? selectedProduct.name : undefined,
        title: title.trim(), description: description.trim(),
        issueDate, expiryDate, file,
      });
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, color: "#8A8272" }}>
        Brand: <strong>{brand}</strong> · Level: <strong>{CERT_LEVELS.find((l) => l.key === level).label}</strong>
      </div>
      <select value={certificationType} onChange={(e) => setCertificationType(e.target.value)} style={inputStyle}>
        {CERT_TYPES_BY_LEVEL[level].map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {level === "product" && (
        <select value={productId} onChange={(e) => setProductId(e.target.value)} style={inputStyle}>
          <option value="">Select product…</option>
          {(products || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={inputStyle} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={2} style={inputStyle} />
      <div style={{ display: "flex", gap: 8 }}>
        <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={inputStyle} title="Issue date" />
        <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} style={inputStyle} title="Expiry date" />
      </div>
      <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files[0] || null)} />
      {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving} style={{ fontSize: 12.5, color: "#fff", background: "#1F2A24", border: "none", borderRadius: 8, padding: "8px 14px" }}>
          {saving ? "Uploading…" : "Upload"}
        </button>
        <button type="button" onClick={onCancel} style={{ fontSize: 12.5, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 14px" }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
