import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";
import { computeMetrics, fmtMoney, fmtDays } from "./competitorCalc.js";
import { TrainingStudiesView } from "./TrainingView.jsx";
import { CertificationsView } from "./CertificationsView.jsx";
import { RepQAView } from "./RepQAView.jsx";

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
// Product Expert (renamed from "Recall" — the tab key stays "recall"
// internally, same rename-the-label-only technique already used for
// Check-In -> "Log Contact") groups four sub-tabs: Products is exactly the
// category/ingredient/competitor browser this file always had, unchanged;
// Studies is TrainingStudiesView re-routed here from the old Training tab
// (same component, same data, no rewrite); Certifications and Rep Q&A are
// new features (see CertificationsView.jsx / RepQAView.jsx).
export function RecallView({ role, repName, repNames, products }) {
  const [subTab, setSubTab] = useState("products");
  const pillStyle = (active) => ({
    padding: "6px 14px", borderRadius: 16, fontSize: 12.5, fontWeight: 500,
    border: active ? "1px solid #1F2A24" : "1px solid #E5DFD3",
    background: active ? "#1F2A24" : "#fff", color: active ? "#FAF7F2" : "#5B5445",
  });

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>Product Expert</h2>
      <p style={{ fontSize: 13, color: "#8A8272", margin: "0 0 18px", fontStyle: "italic" }}>
        Know the product. Know the evidence. Know how to answer.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setSubTab("products")} style={pillStyle(subTab === "products")}>Products</button>
        <button onClick={() => setSubTab("studies")} style={pillStyle(subTab === "studies")}>Studies</button>
        <button onClick={() => setSubTab("certifications")} style={pillStyle(subTab === "certifications")}>Certifications</button>
        <button onClick={() => setSubTab("qa")} style={pillStyle(subTab === "qa")}>Rep Q&A</button>
      </div>

      {subTab === "products" && <RecallProductsPanel role={role} repNames={repNames} />}
      {subTab === "studies" && <TrainingStudiesView role={role} products={products} />}
      {subTab === "certifications" && <CertificationsView role={role} products={products} />}
      {subTab === "qa" && <RepQAView role={role} repName={repName} products={products} />}
    </div>
  );
}

// Exactly what RecallView rendered before this reorganization — the
// category list -> category detail -> assignments flow — unchanged, just
// wrapped under the new "Products" pill instead of being the whole tab.
function RecallProductsPanel({ role, repNames }) {
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

// Collapsed by default — a category page stacks a dozen of these, and
// showing every one expanded at once buried the parts a rep actually came
// for. Click the title to expand; nothing inside changed, just whether
// it's shown right away.
function RecallSection({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "#8A8272", letterSpacing: 0.4 }}>{title.toUpperCase()}</span>
        <span style={{ fontSize: 11, color: "#8A8272" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
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

// ---------- Recall: Analysis + Competitors (separate comparison tables) ----------
// Two sibling sections, each with the same table shape (so a rep reads
// them the same way) but scoped to one side of the comparison — "Analysis"
// is just our own products, "Competitors" is just what's linked against
// them. Split out of a single combined table per feedback that the two
// belonged apart, not because the underlying data changed. Editing is
// still available (managers on our products, any employee on competitor
// research) but tucked behind a collapsed "Manage research" panel below
// each table, so it's there when needed without cluttering the comparison.
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
    daysSupply: metrics.daysSupply != null ? fmtDays(metrics.daysSupply) : "",
    servingSize: p.servingSize || "",
    dosageForm: p.form || "",
    pricePerPill: metrics.hasPrice && metrics.hasPackSize ? [{ label: "", value: metrics.costPerDose }] : [],
    countryOfOrigin: "", // not applicable — this is our own manufacturer/distributor relationship, not a sourced competitor product
    pharmacyDiscount: "", // not applicable to our own products
    raw: p,
  };
}

function competitorRow(c) {
  const cp = c.competitorProduct;
  const metrics = computeMetrics(cp);
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
    daysSupply: metrics.daysSupply != null ? fmtDays(metrics.daysSupply) : "",
    servingSize: "", // not tracked on CompetitorProducts — never inferred
    dosageForm: cp.form || "",
    pricePerPill,
    countryOfOrigin: cp.manufacturingCountry || "",
    pharmacyDiscount: cp.discountRate !== "" && cp.discountRate != null ? `${cp.discountRate}%` : "",
    raw: cp,
    rel: c,
  };
}

function ComparisonField({ label, value }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: "#8A8272", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 12.5, marginTop: 2, color: value ? "#1F2A24" : "#B7AF9E" }}>{value || "Not verified"}</div>
    </div>
  );
}

// Shared by both the Analysis and Competitors sections — same fields, same
// card rendering, so the two read as one system even though each only
// shows its own side of the comparison. A stacked card per product instead
// of a wide table — a 10-column table meant endless horizontal swiping on
// a phone; a card's fields just wrap to the next line instead. Editing
// lives directly in the card (an Edit button + an inline expanded panel)
// instead of a separate "Manage research" list below — the same fact was
// otherwise showing up twice.
function ComparisonTable({ rows, expandedKey, onToggleExpanded, renderExpanded }) {
  const hasActions = !!onToggleExpanded;
  return (
    <div style={{ marginBottom: 14 }}>
      {rows.map((r) => {
        const hasOpenConflict = (r.raw.conflicts || []).some((c) => c.status === "CONFLICT");
        const isExpanded = expandedKey === r.key;
        return (
          <div key={r.key} style={{ background: r.isOurs ? "#F4F8F5" : "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
              <div>
                {r.isOurs && <div style={{ fontSize: 9.5, fontWeight: 700, color: "#4C7A5E" }}>OUR PRODUCT</div>}
                <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
                {hasOpenConflict && <div style={{ fontSize: 10, fontWeight: 700, color: "#8A6B1A" }}>⚠ conflict</div>}
              </div>
              {hasActions && (
                <button type="button" onClick={() => onToggleExpanded(r.key)} style={{ ...editButtonStyle, flexShrink: 0 }}>
                  {isExpanded ? "Close" : "Edit"}
                </button>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 10 }}>
              <ComparisonField label="Active ingredient" value={r.activeIngredient} />
              <ComparisonField label="Dose per unit" value={r.dosePerUnit} />
              <ComparisonField label="Pills per box" value={r.pillsPerBox} />
              <ComparisonField label="Days supply" value={r.daysSupply} />
              <ComparisonField label="Serving size" value={r.servingSize} />
              <ComparisonField label="Dosage form" value={r.dosageForm} />
              <ComparisonField label="Price per pill" value={priceRows(r.pricePerPill)} />
              <ComparisonField label="Country of origin" value={r.countryOfOrigin || (r.isOurs ? "—" : "")} />
              <ComparisonField label="Pharmacy discount" value={r.pharmacyDiscount || (r.isOurs ? "—" : "")} />
            </div>
            {isExpanded && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3" }}>
                {renderExpanded(r)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Our own products only — the comparison table plus a positioning
// conclusion built from those same documented facts. Editing (and its
// conflict/missing-info detail) now lives directly in the table's Actions
// column instead of a separate "Manage research" list below — the two used
// to show the exact same product twice.
function RecallAnalysisSection({ products, ingredient, role, onSaved }) {
  const ourRows = (products || []).map(ourProductRow);
  const whatNotToClaimFirstLine = (ingredient?.whatNotToClaim || "").split("\n").filter(Boolean)[0] || "";
  const [expandedKey, setExpandedKey] = useState(null);
  const canEdit = role === "manager";

  return (
    <RecallSection title="Analysis">
      {ourRows.length === 0 ? (
        <EmptyState text="No our-products have been added to this category yet." />
      ) : (
        <>
          <ComparisonTable
            rows={ourRows}
            expandedKey={expandedKey}
            onToggleExpanded={(key) => setExpandedKey((k) => (k === key ? null : key))}
            renderExpanded={(r) => (
              <div>
                <ConflictBanner conflicts={r.raw.conflicts} onSaved={onSaved} canResolve={canEdit} />
                <MissingInfoBadge researchStatus={r.raw.verificationStatus} missingFields={r.raw.missingFields} />
                {canEdit ? (
                  <OurProductEditor product={r.raw} onCancel={() => setExpandedKey(null)} onSaved={() => { onSaved(); setExpandedKey(null); }} />
                ) : (
                  <div style={{ fontSize: 12, color: "#8A8272", fontStyle: "italic" }}>Only a manager can edit our own product research.</div>
                )}
              </div>
            )}
          />

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
        </>
      )}
    </RecallSection>
  );
}

// Competitor products linked to THIS category only (now auto-linked by
// shared ingredient, see ensureCompetitorIngredientAutoLinking server-side
// — "+ Add existing competitor" below still covers the rare case that
// needs a manual link). Editing lives directly in the table, same as
// Analysis above.
function RecallCompetitorsSection({ competitors, products, role, onSaved }) {
  const competitorRows = (competitors || []).map(competitorRow);
  const ourProducts = (products || []).map((p) => ({ id: p.id, name: p.name }));
  const [expandedKey, setExpandedKey] = useState(null);

  return (
    <RecallSection title="Competitors">
      {competitorRows.length === 0 ? (
        <EmptyState text="No competitor research has been linked to this category yet." />
      ) : (
        <ComparisonTable
          rows={competitorRows}
          expandedKey={expandedKey}
          onToggleExpanded={(key) => setExpandedKey((k) => (k === key ? null : key))}
          renderExpanded={(r) => (
            <CompetitorExpandedContent
              rel={r.rel}
              canUnlink={role === "manager"}
              onSaved={onSaved}
              onClose={() => setExpandedKey(null)}
            />
          )}
        />
      )}

      <AddCompetitorToCategory
        ourProducts={ourProducts}
        existingCompetitorIds={new Set(competitorRows.map((r) => r.raw.id))}
        onSaved={onSaved}
      />
    </RecallSection>
  );
}

function CompetitorExpandedContent({ rel: c, canUnlink, onSaved, onClose }) {
  const cp = c.competitorProduct;
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState("");
  const unlink = async () => {
    setUnlinking(true);
    setError("");
    try {
      // Only removes the comparison link (RecallCompetitorRelationships) —
      // the competitor product itself is untouched and still lives under
      // Settings' competitor data list, unlinked from this category.
      await api.removeRecallCompetitorRelationship(c.id);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't remove this comparison.");
      setUnlinking(false);
    }
  };
  return (
    <div>
      {c.retailerListings.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {c.retailerListings.map((l) => (
            <div key={l.id} style={{ fontSize: 11, color: "#8A8272" }}>
              {l.retailer}{" — "}{l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noreferrer">source</a> : "source URL not verified"}
            </div>
          ))}
        </div>
      )}
      <ConflictBanner conflicts={cp.conflicts} onSaved={onSaved} canResolve={true} />
      <MissingInfoBadge researchStatus={cp.researchStatus} missingFields={cp.missingFields} />
      <CompetitorEditor competitorProduct={cp} retailerListings={c.retailerListings} onCancel={onClose} onSaved={() => { onSaved(); onClose(); }} />
      {error && <div style={{ color: "#B33A3A", fontSize: 11, marginTop: 4 }}>{error}</div>}
      {canUnlink && (
        <button type="button" disabled={unlinking} onClick={unlink} style={{ ...cancelButtonStyle, marginTop: 8 }}>
          {unlinking ? "Removing…" : "Remove from comparison"}
        </button>
      )}
    </div>
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
