import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";
import { computeMetrics, fmtMoney } from "./competitorCalc.js";

// Kept local (not imported from App.jsx) to avoid a circular import between
// the two files — same look as the rest of the app either way.
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "24px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}

// Always shows what's missing rather than hiding it — a product is never
// displayed as "complete" while required fields are still unverified.
function MissingInfoBadge({ researchStatus, missingFields }) {
  if (!researchStatus && (!missingFields || missingFields.length === 0)) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {researchStatus && (
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#8A8272", letterSpacing: 0.3 }}>
          RESEARCH STATUS: {researchStatus.replace(/_/g, " ")}
        </div>
      )}
      {missingFields && missingFields.length > 0 && (
        <div style={{ fontSize: 11, color: "#8A6B3A", marginTop: 2 }}>
          <div style={{ fontWeight: 600 }}>MISSING INFORMATION</div>
          <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
            {missingFields.map((f, idx) => <li key={idx}>{f}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// Structure-only phase: no clinical content ships with this module. Every
// section below reads from tables that are genuinely empty right now, so
// the empty-state text is accurate, not a placeholder pretending to be
// real content — once RecallIngredients/RecallClinicalEvidence/etc. are
// populated (a separate, deliberate step), these same sections start
// showing the real thing with no UI changes needed.
export function RecallView({ role, repName, repNames }) {
  const [categories, setCategories] = useState([]);
  const [myAssignedCategoryIds, setMyAssignedCategoryIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // "home" | "assignments" | a categoryId
  const [view, setView] = useState("home");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api.getRecallCategories()
      .then((data) => {
        setCategories(data.categories || []);
        setMyAssignedCategoryIds(data.myAssignedCategoryIds || []);
      })
      .catch((e) => setError(e.message || "Couldn't load Recall categories."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>Recall</h2>
      <p style={{ fontSize: 13, color: "#8A8272", margin: "0 0 18px", fontStyle: "italic" }}>
        Learn the science before the call.
      </p>

      {loading && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 12 }}>{error}</div>}

      {!loading && !error && view === "home" && (
        <RecallHome
          role={role}
          categories={categories}
          onOpenCategory={(id) => setView(id)}
          onOpenAssignments={() => setView("assignments")}
        />
      )}

      {!loading && !error && view === "assignments" && role === "manager" && (
        <RecallAssignmentsSection
          repNames={repNames}
          categories={categories}
          onBack={() => setView("home")}
        />
      )}

      {!loading && !error && view !== "home" && view !== "assignments" && (
        <RecallCategoryDetail
          categoryId={view}
          categoryName={categories.find((c) => c.id === view)?.name || ""}
          onBack={() => setView("home")}
          role={role}
        />
      )}
    </div>
  );
}

// Simplified — every rep sees the same full category list a manager does,
// no "My Categories" vs "All Categories" split. (The manager's Recall
// Assignments screen still exists for whatever organizational use a
// manager wants it for; it just no longer gates what a rep sees here.)
function RecallHome({ role, categories, onOpenCategory, onOpenAssignments }) {
  const shown = categories;

  return (
    <div>
      {role === "manager" && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
          <button
            onClick={onOpenAssignments}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500, background: "#1F2A24", color: "#FAF7F2", border: "none", borderRadius: 8, padding: "8px 14px" }}
          >
            Recall Assignments
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState text="No categories found." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {shown.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenCategory(c.id)}
              style={{ textAlign: "left", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, cursor: "pointer" }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>{c.name}</div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#8A8272" }}>
                <span>{c.productCount} product{c.productCount === 1 ? "" : "s"}</span>
                <span>{c.knowledgeCount} ingredient{c.knowledgeCount === 1 ? "" : "s"}</span>
                <span>{c.evidenceCount} evidence</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RecallCategoryDetail({ categoryId, categoryName, onBack, role }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    return api.getRecallCategory(categoryId)
      .then(setData)
      .catch((e) => setError(e.message || "Couldn't load this category."))
      .finally(() => setLoading(false));
  }, [categoryId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#5B5445", background: "none", border: "none", padding: "0 0 14px", cursor: "pointer" }}
      >
        ← Back to categories
      </button>

      {loading && !data && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {error && <div style={{ fontSize: 12.5, color: "#B33A3A" }}>{error}</div>}

      {!error && data && (
        <>
          <h3 className="kb-font-display" style={{ fontSize: 18, fontWeight: 600, margin: "0 0 4px" }}>{data.category.name}</h3>
          {data.category.description && <p style={{ fontSize: 13, color: "#8A8272", margin: "0 0 18px" }}>{data.category.description}</p>}

          <RecallSection title="Quick Recall">
            {data.ingredients.filter((i) => i.repQuickTakeaway).length === 0 ? (
              <EmptyState text="No quick recall summary has been added yet." />
            ) : (
              data.ingredients.filter((i) => i.repQuickTakeaway).map((i) => (
                <div key={i.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 4 }}>{i.name}</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {i.repQuickTakeaway.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 4 }}>{line}</li>)}
                  </ul>
                </div>
              ))
            )}
          </RecallSection>

          <RecallSection title="Forms">
            {data.ingredientForms.length === 0 ? (
              <EmptyState text="No chemical forms have been added yet." />
            ) : (
              data.ingredientForms.map((f) => (
                <div key={f.id} style={{ fontSize: 12.5, marginBottom: 8 }}>
                  <div><strong>{f.formName}</strong>{f.chemicalName ? ` (also known as ${f.chemicalName})` : ""}</div>
                  {f.metabolicNotes && <div style={{ color: "#5B5445" }}>{f.metabolicNotes}</div>}
                  {f.evidenceComparison && <div style={{ color: "#8A8272", fontSize: 11.5 }}>{f.evidenceComparison}</div>}
                </div>
              ))
            )}
          </RecallSection>

          <RecallAnalysisSection products={data.products} ingredient={data.ingredients[0]} role={role} onSaved={load} />

          <RecallCompetitorsSection competitors={data.competitors} products={data.products} role={role} onSaved={load} />

          <MarketSnapshotSection products={data.products} competitors={data.competitors} />

          <RecallSection title="Clinical References">
            {(!data.references || data.references.length === 0) ? (
              <EmptyState text="No PubMed/NCBI study citations have been added yet." />
            ) : (
              data.references.map((r) => (
                <div key={r.id} style={{ fontSize: 12, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #F0EBE0" }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{r.title}</div>
                  <div style={{ color: "#8A8272", fontSize: 11 }}>
                    {[r.studyType, r.publicationYear, r.journal || r.sourceName].filter(Boolean).join(" · ")}
                  </div>
                  {r.population && <div style={{ marginTop: 3, fontSize: 11 }}><strong>Population:</strong> {r.population}{r.sampleSize ? ` (N=${r.sampleSize})` : ""}</div>}
                  {r.intervention && <div style={{ fontSize: 11 }}><strong>Intervention:</strong> {r.intervention}</div>}
                  {r.comparator && <div style={{ fontSize: 11 }}><strong>Comparator:</strong> {r.comparator}</div>}
                  {r.keyFinding && <div style={{ marginTop: 4, color: "#5B5445" }}><strong>Key finding:</strong> {r.keyFinding}</div>}
                  {r.limitations && <div style={{ marginTop: 3, fontSize: 11, color: "#8A8272" }}><strong>Limitations:</strong> {r.limitations}</div>}
                  <div style={{ marginTop: 4, fontSize: 11 }}>
                    PMID: {r.pmid}{" — "}
                    <a href={r.url} target="_blank" rel="noreferrer">Read full study →</a>
                  </div>
                </div>
              ))
            )}
          </RecallSection>

          <RecallSection title="Drug Interactions">
            {data.interactions.length === 0 ? (
              <EmptyState text="No interaction information has been added yet." />
            ) : (
              data.interactions.map((i) => (
                <div key={i.id} style={{ fontSize: 12.5, marginBottom: 8 }}>
                  <strong>{i.drugName}</strong>{i.drugClass ? ` (${i.drugClass})` : ""} — {i.clinicalSignificance}
                  {i.pharmacistCheckpoint && <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 2 }}>Checkpoint: {i.pharmacistCheckpoint}</div>}
                </div>
              ))
            )}
          </RecallSection>

          <RecallSection title="Absorption &amp; Timing">
            {data.ingredients.filter((i) => i.absorptionTimingNotes).length === 0 && data.ingredientForms.filter((f) => f.absorptionNotes).length === 0 ? (
              <EmptyState text="No absorption/timing guidance has been added yet." />
            ) : (
              <>
                {data.ingredients.filter((i) => i.absorptionTimingNotes).map((i) => (
                  <ul key={i.id} style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {i.absorptionTimingNotes.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 4 }}>{line}</li>)}
                  </ul>
                ))}
                {data.ingredientForms.filter((f) => f.absorptionNotes).map((f) => (
                  <div key={f.id} style={{ fontSize: 12, marginTop: 8 }}>
                    <strong>{f.formName}:</strong> {f.absorptionNotes}
                  </div>
                ))}
              </>
            )}
          </RecallSection>

          <RecallSection title="Clinical Checkpoints">
            {data.ingredients.filter((i) => i.clinicalCheckpoints).length === 0 ? (
              <EmptyState text="No clinical checkpoints have been added yet." />
            ) : (
              data.ingredients.filter((i) => i.clinicalCheckpoints).map((i) => (
                <ul key={i.id} style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                  {i.clinicalCheckpoints.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 4 }}>{line}</li>)}
                </ul>
              ))
            )}
          </RecallSection>

          <RecallSection title="What Not to Claim">
            {data.ingredients.filter((i) => i.whatNotToClaim).length === 0 ? (
              <EmptyState text="No guidance has been added yet." />
            ) : (
              data.ingredients.filter((i) => i.whatNotToClaim).map((i) => (
                <ul key={i.id} style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#7A3B3B" }}>
                  {i.whatNotToClaim.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 4 }}>{line}</li>)}
                </ul>
              ))
            )}
          </RecallSection>

          <RecallSection title="Rep Takeaway">
            {data.ingredients.filter((i) => i.clinicalCheckpoints || i.repTakeawayQuestions || i.repTakeaway30Second).length === 0 ? (
              <EmptyState text="No rep takeaway has been added yet." />
            ) : (
              data.ingredients.map((i) => (
                (i.clinicalCheckpoints || i.repTakeawayQuestions || i.repTakeaway30Second) && (
                  <div key={i.id} style={{ marginBottom: 12 }}>
                    {i.clinicalCheckpoints && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>Know this before the call</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                          {i.clinicalCheckpoints.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 3 }}>{line}</li>)}
                        </ul>
                      </div>
                    )}
                    {i.repTakeawayQuestions && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>Questions to ask the physician</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                          {i.repTakeawayQuestions.split("\n").filter(Boolean).map((line, idx) => <li key={idx} style={{ marginBottom: 3 }}>{line}</li>)}
                        </ul>
                      </div>
                    )}
                    {i.repTakeaway30Second && (
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>30-second explanation</div>
                        <div style={{ fontSize: 12.5, color: "#5B5445" }}>{i.repTakeaway30Second}</div>
                      </div>
                    )}
                  </div>
                )
              ))
            )}
          </RecallSection>

          <RecallSection title="Quiz Me">
            {data.quizAvailable ? (
              <div style={{ fontSize: 12.5 }}>{data.quizQuestionCount} question{data.quizQuestionCount === 1 ? "" : "s"} available.</div>
            ) : (
              <EmptyState text="No quiz questions have been added yet." />
            )}
          </RecallSection>
        </>
      )}
    </div>
  );
}

function RecallSection({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "#8A8272", letterSpacing: 0.4, marginBottom: 8 }}>{title.toUpperCase()}</div>
      {children}
    </div>
  );
}

const editButtonStyle = { fontSize: 11, color: "#4C7A5E", background: "none", border: "1px solid #CFE0D5", borderRadius: 6, padding: "4px 8px", cursor: "pointer", whiteSpace: "nowrap" };
const saveButtonStyle = { padding: "6px 12px", borderRadius: 7, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12, fontWeight: 500, cursor: "pointer" };
const cancelButtonStyle = { padding: "6px 12px", borderRadius: 7, border: "1px solid #E5DFD3", background: "#fff", color: "#5B5445", fontSize: 12, cursor: "pointer" };
const editorPanelStyle = { marginTop: 10, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 };
const editorTitleStyle = { fontSize: 11, fontWeight: 700, color: "#8A8272", marginBottom: 8, letterSpacing: 0.3 };
const summaryLineStyle = { fontSize: 12, marginBottom: 4 };
const scientificContextStyle = { fontSize: 11, color: "#5B5445", marginTop: 6, fontStyle: "italic" };
const APPROVED_RETAILERS_CLIENT = ["Skin Society", "Mazen Online", "Nicolas Care", "Sohati Care"];

function EditorField({ label, value, onChange, placeholder, textarea }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: "block", fontSize: 11, color: "#8A8272", marginBottom: 2 }}>{label}</label>
      {textarea ? (
        <textarea value={value} onChange={onChange} placeholder={placeholder} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
      ) : (
        <input value={value} onChange={onChange} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

// Manager-only — the parent card only renders this when canEdit is true, so
// a rep never sees an editable field, but the API routes themselves are
// also requireManager-gated as the real enforcement (never trust the UI
// alone for a permission boundary).
function OurProductEditor({ product: p, onCancel, onSaved }) {
  const [form, setForm] = useState({
    name: p.name || "", price: p.price ?? "", packSize: p.packSize ?? "", unitsPerDay: p.unitsPerDay ?? "",
    catalogNotes: p.notes || "", ingredients: p.ingredients || "",
    chemicalForm: p.chemicalForm || "", compoundAmount: p.compoundAmount ?? "", unit: p.unit || "",
    form: p.form || "", servingSize: p.servingSize || "", dailyAmount: p.dailyAmount || "",
    sku: p.sku || "", manufacturer: p.manufacturer || "", sourceLabel: p.sourceLabel || "", sourceUrl: p.sourceUrl || "",
    linkNotes: p.linkNotes || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // Product identity (linkId/productId) never changes here — this
      // edits the existing master product/link, it never creates a new one.
      await api.updateRecallOurProduct(p.linkId, form);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={editorPanelStyle}>
      <div style={editorTitleStyle}>Complete Product Information</div>
      <EditorField label="Product name" value={form.name} onChange={set("name")} />
      <EditorField label="Amount" value={form.compoundAmount} onChange={set("compoundAmount")} />
      <EditorField label="Unit" value={form.unit} onChange={set("unit")} placeholder="mcg" />
      <EditorField label="Chemical form" value={form.chemicalForm} onChange={set("chemicalForm")} />
      <EditorField label="Dosage form" value={form.form} onChange={set("form")} placeholder="e.g. Tablet, Quick-Dissolve" />
      <EditorField label="Pack size" value={form.packSize} onChange={set("packSize")} />
      <EditorField label="Serving size" value={form.servingSize} onChange={set("servingSize")} />
      <EditorField label="Recommended daily use" value={form.dailyAmount} onChange={set("dailyAmount")} />
      <EditorField label="Price" value={form.price} onChange={set("price")} />
      <EditorField label="Complete ingredients" value={form.ingredients} onChange={set("ingredients")} textarea />
      <EditorField label="SKU" value={form.sku} onChange={set("sku")} />
      <EditorField label="Manufacturer" value={form.manufacturer} onChange={set("manufacturer")} />
      <EditorField label="Source (e.g. Manufacturer label)" value={form.sourceLabel} onChange={set("sourceLabel")} />
      <EditorField label="Manufacturer source URL" value={form.sourceUrl} onChange={set("sourceUrl")} />
      <EditorField label="Notes" value={form.linkNotes} onChange={set("linkNotes")} textarea />
      {error && <div style={{ fontSize: 11.5, color: "#B33A3A", marginBottom: 6 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={saving} onClick={save} style={saveButtonStyle}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} style={cancelButtonStyle}>Cancel</button>
      </div>
    </div>
  );
}

function RetailerListingRow({ listing, onSaved }) {
  const [form, setForm] = useState({ retailer: listing.retailer, displayedPrice: listing.displayedPrice ?? "", currency: listing.currency || "", sourceUrl: listing.sourceUrl || "", notes: listing.notes || "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateRecallRetailerListing(listing.id, form);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed #E5DFD3" }}>
      <div style={{ fontWeight: 600, fontSize: 11.5, marginBottom: 4 }}>{form.retailer}</div>
      <EditorField label="Price" value={form.displayedPrice} onChange={set("displayedPrice")} />
      <EditorField label="Currency" value={form.currency} onChange={set("currency")} />
      <EditorField label="Source URL" value={form.sourceUrl} onChange={set("sourceUrl")} />
      <EditorField label="Notes" value={form.notes} onChange={set("notes")} textarea />
      {error && <div style={{ fontSize: 11, color: "#B33A3A", marginBottom: 4 }}>{error}</div>}
      <button type="button" disabled={saving} onClick={save} style={saveButtonStyle}>{saving ? "Saving…" : "Save listing"}</button>
    </div>
  );
}

function AddRetailerListingRow({ competitorProductId, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ retailer: APPROVED_RETAILERS_CLIENT[0], displayedPrice: "", currency: "USD", sourceUrl: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // Always a NEW listing row, keyed to this one competitor product —
      // never a new master product, and duplicate (product, retailer)
      // listings are rejected the same way the seed logic dedupes them.
      await api.addRecallRetailerListing({ competitorProductId, ...form });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't add listing.");
    } finally {
      setSaving(false);
    }
  };
  if (!open) return <button type="button" onClick={() => setOpen(true)} style={editButtonStyle}>+ Add retailer listing</button>;
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ display: "block", fontSize: 11, color: "#8A8272", marginBottom: 2 }}>Retailer</label>
      <select value={form.retailer} onChange={set("retailer")} style={{ ...inputStyle, marginBottom: 8 }}>
        {APPROVED_RETAILERS_CLIENT.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <EditorField label="Price" value={form.displayedPrice} onChange={set("displayedPrice")} />
      <EditorField label="Currency" value={form.currency} onChange={set("currency")} />
      <EditorField label="Source URL" value={form.sourceUrl} onChange={set("sourceUrl")} />
      <EditorField label="Notes" value={form.notes} onChange={set("notes")} textarea />
      {error && <div style={{ fontSize: 11, color: "#B33A3A", marginBottom: 4 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={saving} onClick={save} style={saveButtonStyle}>{saving ? "Adding…" : "Add"}</button>
        <button type="button" onClick={() => setOpen(false)} style={cancelButtonStyle}>Cancel</button>
      </div>
    </div>
  );
}

function CompetitorEditor({ competitorProduct: cp, retailerListings, onCancel, onSaved }) {
  const [form, setForm] = useState({
    genericName: cp.genericName || "", form: cp.form || "", dosage: cp.dosage || "", packSize: cp.packSize ?? "",
    ingredients: cp.ingredients || "", manufacturer: cp.manufacturer || "", sku: cp.sku || "",
    sourceLabel: cp.sourceLabel || "", sourceUrl: cp.sourceUrl || "", notes: cp.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // Edits the existing master competitor product (cp.id) — never
      // creates a duplicate.
      await api.updateRecallCompetitorResearch(cp.id, form);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={editorPanelStyle}>
      <div style={editorTitleStyle}>Complete Product Information</div>
      <EditorField label="Chemical form" value={form.genericName} onChange={set("genericName")} />
      <EditorField label="Dosage form" value={form.form} onChange={set("form")} />
      <EditorField label="Amount (e.g. 1,000 mcg)" value={form.dosage} onChange={set("dosage")} />
      <EditorField label="Pack size" value={form.packSize} onChange={set("packSize")} />
      <EditorField label="Complete ingredients" value={form.ingredients} onChange={set("ingredients")} textarea />
      <EditorField label="Manufacturer" value={form.manufacturer} onChange={set("manufacturer")} />
      <EditorField label="SKU" value={form.sku} onChange={set("sku")} />
      <EditorField label="Source (e.g. Manufacturer label)" value={form.sourceLabel} onChange={set("sourceLabel")} />
      <EditorField label="Manufacturer source URL" value={form.sourceUrl} onChange={set("sourceUrl")} />
      <EditorField label="Notes" value={form.notes} onChange={set("notes")} textarea />
      {error && <div style={{ fontSize: 11.5, color: "#B33A3A", marginBottom: 6 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={saving} onClick={save} style={saveButtonStyle}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} style={cancelButtonStyle}>Cancel</button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid #E5DFD3" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#8A8272", marginBottom: 6 }}>RETAILER LISTINGS</div>
        {retailerListings.map((l) => <RetailerListingRow key={l.id} listing={l} onSaved={onSaved} />)}
        <AddRetailerListingRow competitorProductId={cp.id} onSaved={onSaved} />
      </div>
    </div>
  );
}

function ConflictRow({ conflict, onSaved, canResolve }) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const resolve = async (which) => {
    setResolving(true);
    setError("");
    try {
      // Picks ONE source's value onto the record — explicit, never
      // automatic. The other value is never silently deleted; both stay
      // visible in this same conflict record's history.
      await api.resolveRecallFieldConflict(conflict.id, which);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't resolve.");
    } finally {
      setResolving(false);
    }
  };
  return (
    <div style={{ background: "#FBF1E4", border: "1px solid #E8D5AE", borderRadius: 8, padding: 8, marginBottom: 6, fontSize: 11.5 }}>
      <div style={{ fontWeight: 700, color: "#8A6B1A", marginBottom: 3 }}>⚠️ SOURCE CONFLICT</div>
      <div>Field: {conflict.fieldName}</div>
      <div>{conflict.sourceALabel || "Source A"}: {conflict.sourceAValue}</div>
      <div>{conflict.sourceBLabel || "Source B"}: {conflict.sourceBValue}</div>
      {error && <div style={{ color: "#B33A3A", marginTop: 4 }}>{error}</div>}
      {canResolve && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" disabled={resolving} onClick={() => resolve("A")} style={cancelButtonStyle}>Use {conflict.sourceALabel || "Source A"}</button>
          <button type="button" disabled={resolving} onClick={() => resolve("B")} style={cancelButtonStyle}>Use {conflict.sourceBLabel || "Source B"}</button>
        </div>
      )}
    </div>
  );
}

// Only OPEN (status === "CONFLICT") rows render — a RESOLVED conflict stays
// in the sheet as history but no longer needs a decision. canResolve gates
// only the action buttons, not visibility — a conflict a viewer can't act
// on (e.g. a rep looking at an our-product conflict, which stays
// manager-only server-side) still stays visible, per "never hide a
// conflict," it just shows read-only.
function ConflictBanner({ conflicts, onSaved, canResolve }) {
  const open = (conflicts || []).filter((c) => c.status === "CONFLICT");
  if (open.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {open.map((c) => <ConflictRow key={c.id} conflict={c} onSaved={onSaved} canResolve={canResolve} />)}
    </div>
  );
}

// Deliberately minimal — the comparison table above already shows every
// fact (dose, form, price, ...); repeating them here would be exactly the
// "repetition of information" this section was simplified to avoid. This
// is just an entry point to edit/complete research and see conflicts.
function OurProductCard({ product: p, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ fontSize: 12.5, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #F0EBE0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{p.name}</div>
        {canEdit && (
          <button type="button" onClick={() => setEditing((v) => !v)} style={editButtonStyle}>
            {editing ? "Close" : "Edit / Complete Research"}
          </button>
        )}
      </div>
      <ConflictBanner conflicts={p.conflicts} onSaved={onSaved} canResolve={canEdit} />
      <MissingInfoBadge researchStatus={p.verificationStatus} missingFields={p.missingFields} />
      {editing && <OurProductEditor product={p} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />}
    </div>
  );
}

function CompetitorCard({ rel: c, canEdit, canUnlink, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState("");
  const cp = c.competitorProduct;
  const unlink = async () => {
    setUnlinking(true);
    setError("");
    try {
      // Only removes the comparison link (RecallCompetitorRelationships) —
      // the competitor product itself is untouched and still lives under
      // the Competitors tab, unlinked from any category.
      await api.removeRecallCompetitorRelationship(c.id);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't remove this comparison.");
      setUnlinking(false);
    }
  };
  return (
    <div style={{ fontSize: 12.5, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #F0EBE0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{cp.competitorName} — {cp.productName}</div>
        <div style={{ display: "flex", gap: 6 }}>
          {canEdit && (
            <button type="button" onClick={() => setEditing((v) => !v)} style={editButtonStyle}>
              {editing ? "Close" : "Edit / Complete Research"}
            </button>
          )}
          {canUnlink && (
            <button type="button" disabled={unlinking} onClick={unlink} style={cancelButtonStyle}>
              {unlinking ? "Removing…" : "Remove from comparison"}
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ color: "#B33A3A", fontSize: 11, marginTop: 4 }}>{error}</div>}
      {c.retailerListings.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {c.retailerListings.map((l) => (
            <div key={l.id} style={{ fontSize: 11, color: "#8A8272" }}>
              {l.retailer}{" — "}{l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noreferrer">source</a> : "source URL not verified"}
            </div>
          ))}
        </div>
      )}
      <ConflictBanner conflicts={cp.conflicts} onSaved={onSaved} canResolve={true} />
      <MissingInfoBadge researchStatus={cp.researchStatus} missingFields={cp.missingFields} />
      {editing && (
        <CompetitorEditor competitorProduct={cp} retailerListings={c.retailerListings} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />
      )}
    </div>
  );
}

// Attaches an EXISTING competitor product (already in the Competitors tab)
// to this category, by linking it against one of the category's own
// products. Never creates a competitor product here — search only finds
// ones that already exist; if it doesn't exist yet, it has to be added
// under the Competitors tab first. Open to any employee, matching the
// shared competitor-research editing rule.
function AddCompetitorToCategory({ ourProducts, existingCompetitorIds, onSaved }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [ourProductId, setOurProductId] = useState(ourProducts[0]?.id || "");
  const [error, setError] = useState("");
  const [addingId, setAddingId] = useState("");

  useEffect(() => {
    if (!open) return;
    setSearching(true);
    const t = setTimeout(() => {
      api.getCompetitorProducts({ q: query.trim(), limit: 15 })
        .then((data) => setResults((data.competitorProducts || []).filter((p) => !existingCompetitorIds.has(p.id))))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, open, existingCompetitorIds]);

  if (ourProducts.length === 0) {
    return <div style={{ fontSize: 11.5, color: "#8A8272", fontStyle: "italic" }}>Add at least one of our products to this category before linking competitors.</div>;
  }

  const add = async (competitorProductId) => {
    setAddingId(competitorProductId);
    setError("");
    try {
      await api.addRecallCompetitorRelationship({ competitorProductId, ourProductId });
      setResults((r) => r.filter((p) => p.id !== competitorProductId));
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't link that competitor.");
    } finally {
      setAddingId("");
    }
  };

  return (
    <div style={{ marginTop: 4, marginBottom: 14, paddingTop: 10, borderTop: "1px solid #F0EBE0" }}>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} style={editButtonStyle}>+ Add existing competitor to this comparison</button>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search competitor products by brand or ingredient…"
              style={{ ...inputStyle, flex: 1, minWidth: 180 }}
            />
            {ourProducts.length > 1 && (
              <select value={ourProductId} onChange={(e) => setOurProductId(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
                {ourProducts.map((p) => <option key={p.id} value={p.id}>Compare against: {p.name}</option>)}
              </select>
            )}
            <button type="button" onClick={() => { setOpen(false); setQuery(""); setResults([]); }} style={cancelButtonStyle}>Close</button>
          </div>
          {error && <div style={{ color: "#B33A3A", fontSize: 11.5, marginBottom: 6 }}>{error}</div>}
          {searching && <div style={{ fontSize: 11.5, color: "#8A8272" }}>Searching…</div>}
          {!searching && results.length === 0 && (
            <div style={{ fontSize: 11.5, color: "#8A8272" }}>
              No unlinked competitor products match{query.trim() ? "" : " yet"} — add it under the Competitors tab first if it doesn't exist there.
            </div>
          )}
          {results.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #F0EBE0", fontSize: 12 }}>
              <div>{p.competitorName} — {p.productName}{p.genericName ? ` (${p.genericName})` : ""}</div>
              <button type="button" disabled={addingId === p.id} onClick={() => add(p.id)} style={editButtonStyle}>
                {addingId === p.id ? "Adding…" : "Add"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Collapsed by default — keeps the market-comparison section to its
// conclusions on first look, per feedback that the full field-by-field
// breakdown made Recall feel crowded. Nothing inside is removed, just
// tucked behind a toggle for a rep who wants the underlying detail.
function ExpandableDetails({ label, hideLabel, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#4C7A5E", background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontWeight: 500 }}
      >
        {open ? `▾ ${hideLabel || `Hide ${label}`}` : `▸ ${label}`}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

// ---------- Recall: Analysis + Competitors (separate comparison tables) ----------
// Two sibling sections, each with the same table shape (so a rep reads
// them the same way) but scoped to one side of the comparison — "Analysis"
// is just our own products, "Competitors" is just what's linked against
// them. Split out of a single combined table per feedback that the two
// belonged apart, not because the underlying data changed. Editing is
// still available (managers on our products, any employee on competitor
// research) but tucked behind a collapsed "Manage research" panel below
// each table, so it's there when needed without cluttering the comparison.
const analysisTableCellStyle = { padding: "8px 10px", fontSize: 12, borderBottom: "1px solid #F0EBE0", whiteSpace: "nowrap" };
const analysisTableHeaderStyle = { ...analysisTableCellStyle, fontWeight: 700, color: "#8A8272", fontSize: 10.5, letterSpacing: 0.3, textTransform: "uppercase", borderBottom: "1px solid #E5DFD3" };
// The Product column stays pinned while the rest of the table scrolls
// horizontally on a narrow screen — with 7 columns there's no way to fit
// this without scrolling, but a rep should never lose track of which row
// they're reading.
const analysisStickyColStyle = { position: "sticky", left: 0, zIndex: 1 };

function priceRows(pricePerPill) {
  if (pricePerPill.length === 0) return "Not verified";
  return pricePerPill.map((p, i) => (
    <div key={i}>{p.label ? `${p.label}: ` : ""}{fmtMoney(p.value)}</div>
  ));
}

function ourProductRow(p) {
  const metrics = computeMetrics(p);
  return {
    key: p.id,
    isOurs: true,
    name: p.name,
    activeIngredient: p.chemicalForm || "",
    dosePerUnit: p.compoundAmount ? `${p.compoundAmount}${p.unit ? ` ${p.unit}` : ""}` : "",
    pillsPerBox: p.packSize || "",
    servingSize: p.servingSize || "",
    dosageForm: p.form || "",
    pricePerPill: metrics.hasPrice && metrics.hasPackSize ? [{ label: "", value: metrics.costPerDose }] : [],
    raw: p,
  };
}

function competitorRow(c) {
  const cp = c.competitorProduct;
  const pricePerPill = (c.retailerListings || [])
    .filter((l) => l.displayedPrice !== "" && l.displayedPrice != null && cp.packSize)
    .map((l) => ({ label: l.retailer, value: computeMetrics({ price: l.displayedPrice, packSize: cp.packSize }).costPerDose }));
  return {
    key: c.id,
    isOurs: false,
    name: `${cp.competitorName} — ${cp.productName}`,
    activeIngredient: cp.genericName || "",
    dosePerUnit: cp.dosage || "",
    pillsPerBox: cp.packSize || "",
    servingSize: "", // not tracked on CompetitorProducts — never inferred
    dosageForm: cp.form || "",
    pricePerPill,
    raw: cp,
    rel: c,
  };
}

// Shared by both the Analysis and Competitors tables — same columns, same
// row rendering, so the two sections read as one system even though each
// only shows its own side of the comparison.
function ComparisonTable({ rows }) {
  return (
    <div style={{ overflowX: "auto", marginBottom: 14, border: "1px solid #E5DFD3", borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ ...analysisTableHeaderStyle, ...analysisStickyColStyle, textAlign: "left", background: "#fff" }}>Product</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Active ingredient</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Dose per unit</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Pills per box</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Serving size</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Dosage form</th>
            <th style={{ ...analysisTableHeaderStyle, textAlign: "left" }}>Price per pill</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ background: r.isOurs ? "#F4F8F5" : "#fff" }}>
              <td style={{ ...analysisTableCellStyle, ...analysisStickyColStyle, fontWeight: 600, whiteSpace: "normal", background: r.isOurs ? "#F4F8F5" : "#fff", maxWidth: 150 }}>
                {r.isOurs && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#4C7A5E", display: "block" }}>OUR PRODUCT</span>}
                {r.name}
              </td>
              <td style={analysisTableCellStyle}>{r.activeIngredient || "Not verified"}</td>
              <td style={analysisTableCellStyle}>{r.dosePerUnit || "Not verified"}</td>
              <td style={analysisTableCellStyle}>{r.pillsPerBox || "Not verified"}</td>
              <td style={analysisTableCellStyle}>{r.servingSize || "Not verified"}</td>
              <td style={analysisTableCellStyle}>{r.dosageForm || "Not verified"}</td>
              <td style={analysisTableCellStyle}>{priceRows(r.pricePerPill)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Our own products only — the comparison table plus a positioning
// conclusion built from those same documented facts.
function RecallAnalysisSection({ products, ingredient, role, onSaved }) {
  const ourRows = (products || []).map(ourProductRow);
  const whatNotToClaimFirstLine = (ingredient?.whatNotToClaim || "").split("\n").filter(Boolean)[0] || "";

  return (
    <RecallSection title="Analysis">
      {ourRows.length === 0 ? (
        <EmptyState text="No our-products have been added to this category yet." />
      ) : (
        <>
          <ComparisonTable rows={ourRows} />

          <div style={{ fontSize: 11, fontWeight: 700, color: "#5B5445", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
            How to position our product
          </div>
          {ourRows.map((r, idx) => {
            const facts = [r.dosePerUnit, r.activeIngredient].filter(Boolean).join(" ");
            const formPhrase = r.dosageForm ? ` in a ${r.dosageForm.toLowerCase()} format` : "";
            const whatCanBeSaid = facts ? `"Contains ${facts}${formPhrase}."` : "Not enough verified information to state yet.";
            return (
              <div key={r.key} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: idx < ourRows.length - 1 ? "1px solid #F0EBE0" : "none" }}>
                <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{r.name}</div>
                <div style={{ fontSize: 12, color: "#2F5B41" }}>{whatCanBeSaid}</div>
                {whatNotToClaimFirstLine && (
                  <div style={{ fontSize: 11.5, color: "#7A3B3B", marginTop: 2 }}>
                    <strong>Do not claim:</strong> {whatNotToClaimFirstLine.replace(/^Do not claim /i, "")}
                  </div>
                )}
              </div>
            );
          })}

          <ExpandableDetails label="Manage research" hideLabel="Manage research">
            {ourRows.map((r) => (
              <OurProductCard key={r.key} product={r.raw} canEdit={role === "manager"} onSaved={onSaved} />
            ))}
          </ExpandableDetails>
        </>
      )}
    </RecallSection>
  );
}

// Competitor products linked to THIS category only — the comparison table,
// plus the tools to complete their research, link a new one in, or unlink
// one, all scoped to this category the same way Analysis is scoped to our
// own products.
function RecallCompetitorsSection({ competitors, products, role, onSaved }) {
  const competitorRows = (competitors || []).map(competitorRow);
  const ourProducts = (products || []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <RecallSection title="Competitors">
      {competitorRows.length === 0 ? (
        <EmptyState text="No competitor research has been linked to this category yet." />
      ) : (
        <ComparisonTable rows={competitorRows} />
      )}

      <ExpandableDetails label="Manage research" hideLabel="Manage research">
        {competitorRows.map((r) => (
          <CompetitorCard key={r.key} rel={r.rel} canEdit={true} canUnlink={role === "manager"} onSaved={onSaved} />
        ))}
        <AddCompetitorToCategory
          ourProducts={ourProducts}
          existingCompetitorIds={new Set(competitorRows.map((r) => r.raw.id))}
          onSaved={onSaved}
        />
      </ExpandableDetails>
    </RecallSection>
  );
}

// Simple factual counts, computed from data already loaded for the Analysis
// and Competitors sections above — no ranking, no score, no "winner". Just
// how many of what exists in this category right now.
function statTileStyle() {
  return { background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "10px 12px", minWidth: 100 };
}
function MarketSnapshotSection({ products, competitors }) {
  const ourProducts = products || [];
  const competitorProducts = (competitors || []).map((c) => c.competitorProduct).filter(Boolean);
  const brands = new Set(competitorProducts.map((cp) => cp.competitorName).filter(Boolean));
  const formulations = new Set([
    ...ourProducts.map((p) => p.chemicalForm).filter(Boolean),
    ...competitorProducts.map((cp) => cp.genericName).filter(Boolean),
  ]);
  const dosageForms = new Set([
    ...ourProducts.map((p) => p.form).filter(Boolean),
    ...competitorProducts.map((cp) => cp.form).filter(Boolean),
  ]);
  const verifiedCount =
    ourProducts.filter((p) => p.verificationStatus === "VERIFIED").length +
    competitorProducts.filter((cp) => cp.researchStatus === "VERIFIED").length;
  const totalCount = ourProducts.length + competitorProducts.length;

  const tiles = [
    { label: "Our products", value: ourProducts.length },
    { label: "Competitor products", value: competitorProducts.length },
    { label: "Brands", value: brands.size },
    { label: "Formulations", value: formulations.size },
    { label: "Dosage forms", value: dosageForms.size },
    { label: "Verified research", value: `${verifiedCount}/${totalCount}` },
  ];

  return (
    <RecallSection title="Market Snapshot">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {tiles.map((t) => (
          <div key={t.label} style={statTileStyle()}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{t.value}</div>
            <div style={{ fontSize: 10.5, color: "#8A8272", textTransform: "uppercase", letterSpacing: 0.3 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </RecallSection>
  );
}

function RecallAssignmentsSection({ repNames, categories, onBack }) {
  const [selectedRep, setSelectedRep] = useState("");
  const [checked, setChecked] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const pickRep = (rep) => {
    setSelectedRep(rep);
    setSaved(false);
    setError("");
    if (!rep) { setChecked(new Set()); return; }
    setLoading(true);
    api.getRecallAssignments(rep)
      .then((data) => setChecked(new Set(data.categoryIds || [])))
      .catch((e) => setError(e.message || "Couldn't load current assignments."))
      .finally(() => setLoading(false));
  };

  const toggle = (id) => {
    setSaved(false);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.saveRecallAssignments(selectedRep, [...checked]);
      setSaved(true);
    } catch (e) {
      setError(e.message || "Couldn't save assignments.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#5B5445", background: "none", border: "none", padding: "0 0 14px", cursor: "pointer" }}
      >
        ← Back
      </button>

      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>Recall Assignments</h3>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Medical Representative</label>
        <select value={selectedRep} onChange={(e) => pickRep(e.target.value)} style={{ ...inputStyle, marginBottom: 14 }}>
          <option value="">— select a rep —</option>
          {(repNames || []).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>

        {selectedRep && (
          <>
            {loading ? (
              <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading current assignments…</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <button type="button" onClick={() => setChecked(new Set(categories.map((c) => c.id)))} style={{ fontSize: 11.5, color: "#4C7A5E", background: "none", border: "1px solid #CFE0D5", borderRadius: 6, padding: "5px 10px" }}>
                    Select All
                  </button>
                  <button type="button" onClick={() => setChecked(new Set())} style={{ fontSize: 11.5, color: "#8A8272", background: "none", border: "1px solid #E5DFD3", borderRadius: 6, padding: "5px 10px" }}>
                    Clear All
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14, maxHeight: 420, overflowY: "auto" }}>
                  {categories.map((c) => (
                    <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} />
                      {c.name}
                    </label>
                  ))}
                </div>
                {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
                {saved && <div style={{ fontSize: 12, color: "#4C7A5E", marginBottom: 10 }}>Saved.</div>}
                <button
                  disabled={saving}
                  onClick={save}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving ? "#D8D2C4" : "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
