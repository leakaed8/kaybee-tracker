import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";

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
          myAssignedCategoryIds={myAssignedCategoryIds}
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

function RecallHome({ role, categories, myAssignedCategoryIds, onOpenCategory, onOpenAssignments }) {
  // A manager has no personal "assigned categories" concept — they see the
  // full list by default. A rep starts on their own assigned set and can
  // switch to the full list — never the other way around, per "don't force
  // all categories onto the rep's first screen."
  const [scope, setScope] = useState(role === "manager" ? "all" : "mine");
  const assignedSet = new Set(myAssignedCategoryIds);
  const shown = role === "rep" && scope === "mine" ? categories.filter((c) => assignedSet.has(c.id)) : categories;

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

      {role === "rep" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setScope("mine")}
            style={{
              flex: 1, padding: "8px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 500,
              border: scope === "mine" ? "1px solid #4C7A5E" : "1px solid #1F2A24",
              background: scope === "mine" ? "#4C7A5E" : "#fff", color: scope === "mine" ? "#FAF7F2" : "#1F2A24",
            }}
          >
            My Categories
          </button>
          <button
            onClick={() => setScope("all")}
            style={{
              flex: 1, padding: "8px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 500,
              border: scope === "all" ? "1px solid #4C7A5E" : "1px solid #1F2A24",
              background: scope === "all" ? "#4C7A5E" : "#fff", color: scope === "all" ? "#FAF7F2" : "#1F2A24",
            }}
          >
            All Categories
          </button>
        </div>
      )}

      <h3 style={{ fontSize: 13, fontWeight: 700, color: "#8A8272", letterSpacing: 0.4, margin: "0 0 10px" }}>
        {role === "manager" ? "ALL CATEGORIES" : scope === "mine" ? "MY CATEGORIES" : "ALL CATEGORIES"}
      </h3>

      {shown.length === 0 ? (
        <EmptyState text={role === "rep" && scope === "mine" ? "No categories assigned yet — ask your manager, or switch to All Categories." : "No categories found."} />
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

      {loading && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {error && <div style={{ fontSize: 12.5, color: "#B33A3A" }}>{error}</div>}

      {!loading && !error && data && (
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

          <RecallSection title="Our Products">
            {data.products.length === 0 ? (
              <EmptyState text="No products have been linked to this category yet." />
            ) : (
              data.products.map((p) => (
                <OurProductCard key={p.id} product={p} canEdit={role === "manager"} onSaved={load} />
              ))
            )}
          </RecallSection>

          <RecallSection title="Competitors">
            {data.competitors.length === 0 ? (
              <EmptyState text="No competitor comparison has been added yet." />
            ) : (
              // Competitor research is a shared rep+manager task (unlike
              // Our Products/Product Catalog, which stays manager-only) —
              // anyone who can see this page is authenticated, so canEdit
              // is unconditional here.
              data.competitors.map((c) => (
                <CompetitorCard key={c.id} rel={c} canEdit={true} onSaved={load} />
              ))
            )}
          </RecallSection>

          <RecallComparisonSummary products={data.products} competitors={data.competitors} ingredient={data.ingredients[0]} />

          <RecallSection title="Clinical Evidence">
            {data.evidence.length === 0 ? (
              <EmptyState text="Clinical evidence coming soon." />
            ) : (
              data.evidence.map((e) => (
                <div key={e.id} style={{ fontSize: 12.5, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #F0EBE0" }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{e.condition}</div>
                  {e.result ? (
                    <div>{e.result}</div>
                  ) : (
                    <div style={{ color: "#B7AF9E", fontStyle: "italic" }}>Content pending — not yet extracted from the cited source.</div>
                  )}
                  {e.evidenceLevel && e.evidenceLevel !== "NOT_VERIFIED" && (
                    <div style={{ fontSize: 10.5, color: "#8A8272", marginTop: 4 }}>Evidence level: {e.evidenceLevel}</div>
                  )}
                </div>
              ))
            )}
          </RecallSection>

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
                  {r.keyFinding && <div style={{ marginTop: 4, color: "#5B5445" }}>{r.keyFinding}</div>}
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

function OurProductCard({ product: p, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ fontSize: 12.5, marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #F0EBE0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{p.name}</div>
        {canEdit && (
          <button type="button" onClick={() => setEditing((v) => !v)} style={editButtonStyle}>
            {editing ? "Close" : "Edit / Complete Research"}
          </button>
        )}
      </div>
      {(p.compoundAmount || p.chemicalForm || p.form) && (
        <div style={{ color: "#5B5445", marginTop: 2 }}>
          {[p.compoundAmount ? `${p.compoundAmount} ${p.unit || ""}`.trim() : "", p.chemicalForm, p.form, p.packSize ? `pack of ${p.packSize}` : ""].filter(Boolean).join(" · ")}
        </div>
      )}
      {(p.servingSize || p.dailyAmount) && (
        <div style={{ color: "#8A8272", fontSize: 11.5, marginTop: 2 }}>
          {[p.servingSize ? `Serving size: ${p.servingSize}` : "", p.dailyAmount ? `Daily use: ${p.dailyAmount}` : ""].filter(Boolean).join(" · ")}
        </div>
      )}
      {p.price !== "" && p.price != null && <div style={{ color: "#8A8272", fontSize: 11.5, marginTop: 2 }}>Price: {p.price}</div>}
      <ConflictBanner conflicts={p.conflicts} onSaved={onSaved} canResolve={canEdit} />
      <MissingInfoBadge researchStatus={p.verificationStatus} missingFields={p.missingFields} />
      {editing && <OurProductEditor product={p} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />}
    </div>
  );
}

function CompetitorCard({ rel: c, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const cp = c.competitorProduct;
  return (
    <div style={{ fontSize: 12.5, marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #F0EBE0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{cp.competitorName} — {cp.productName}</div>
        {canEdit && (
          <button type="button" onClick={() => setEditing((v) => !v)} style={editButtonStyle}>
            {editing ? "Close" : "Edit / Complete Research"}
          </button>
        )}
      </div>
      <div style={{ color: "#5B5445", marginTop: 2 }}>
        {[cp.dosage, cp.genericName, cp.form, cp.packSize ? `pack of ${cp.packSize}` : ""].filter(Boolean).join(" · ")}
      </div>
      {c.notes && <div style={{ color: "#8A8272", fontSize: 11.5, marginTop: 4 }}>{c.notes}</div>}
      {c.retailerListings.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {c.retailerListings.map((l) => (
            <div key={l.id} style={{ fontSize: 11.5, color: "#5B5445" }}>
              {l.retailer}: {l.displayedPrice !== "" && l.displayedPrice != null ? `${l.currency || ""} ${l.displayedPrice}`.trim() : "price not verified"}
              {" — "}{l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noreferrer">source</a> : "source URL not verified"}
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

function distinctVerified(items, key) {
  const vals = items.map((i) => i[key]).filter((v) => v && String(v).trim());
  return [...new Set(vals)];
}

function SummarySubsection({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#5B5445", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{title}</div>
      {children}
    </div>
  );
}

// Collapsed by default — keeps the market-comparison section to its
// conclusions on first look, per feedback that the full field-by-field
// breakdown made Recall feel crowded. Nothing inside is removed, just
// tucked behind a toggle for a rep who wants the underlying detail.
function ExpandableDetails({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#4C7A5E", background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontWeight: 500 }}
      >
        {open ? "▾ Hide full market comparison details" : `▸ ${label}`}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

function IncompleteNotice({ missing }) {
  return (
    <div style={{ fontSize: 11.5, color: "#8A6B3A" }}>
      ⚠️ Comparison incomplete<br />
      Missing: {missing.join(", ")}
    </div>
  );
}

// Built ENTIRELY from data.products/data.competitors already loaded for
// this category — no separate fetch, no fabricated commentary. Every line
// either states a value pulled straight from a record or explicitly says
// "Not verified" / shows an "incomplete" notice; this is never a ranking
// (see Phase 2D rule 14/Q — no best/winner/superior/strongest anywhere).
function RecallComparisonSummary({ products, competitors, ingredient }) {
  const ourItems = (products || []).map((p) => ({
    label: p.name,
    amount: p.compoundAmount ? `${p.compoundAmount}${p.unit ? ` ${p.unit}` : ""}` : "",
    chemicalForm: p.chemicalForm || "",
    dosageForm: p.form || "",
    packSize: p.packSize || "",
    price: p.price,
    ingredientsText: p.ingredients || "",
    notesText: [p.notes, p.linkNotes].filter(Boolean).join(" "),
    missingFields: p.missingFields || [],
  }));
  const competitorItems = (competitors || []).map((c) => {
    const cp = c.competitorProduct;
    return {
      label: `${cp.competitorName} — ${cp.productName}`,
      amount: cp.dosage || "",
      chemicalForm: cp.genericName || "",
      dosageForm: cp.form || "",
      packSize: cp.packSize || "",
      retailerListings: c.retailerListings || [],
      ingredientsText: cp.ingredients || "",
      notesText: cp.notes || "",
      missingFields: cp.missingFields || [],
    };
  });
  const allItems = [...ourItems, ...competitorItems];
  if (allItems.length === 0) return null;

  const chemicalFormGroups = new Map();
  allItems.forEach((i) => {
    const key = i.chemicalForm || "Not verified";
    chemicalFormGroups.set(key, [...(chemicalFormGroups.get(key) || []), i.label]);
  });
  const dosageFormGroups = new Map();
  allItems.forEach((i) => {
    const key = i.dosageForm || "Not verified";
    dosageFormGroups.set(key, [...(dosageFormGroups.get(key) || []), i.label]);
  });

  const anyChemicalFormVerified = allItems.some((i) => i.chemicalForm);
  const anyDosageFormVerified = allItems.some((i) => i.dosageForm);
  const anyAmountVerified = allItems.some((i) => i.amount);
  const anyPriceVerified = ourItems.some((i) => i.price !== "" && i.price != null) || competitorItems.some((i) => i.retailerListings.some((l) => l.displayedPrice !== "" && l.displayedPrice != null));
  const hasFormulationNote = (i) => i.ingredientsText || /also contains|includes|folic acid|folate|calcium/i.test(i.notesText);
  const anyFormulationNoted = allItems.some(hasFormulationNote);

  const differentiators = [];
  if (distinctVerified(allItems, "amount").length > 1) differentiators.push("Dose");
  if (distinctVerified(allItems, "chemicalForm").length > 1) differentiators.push("Chemical form");
  if (distinctVerified(allItems, "dosageForm").length > 1) differentiators.push("Dosage form");
  if (distinctVerified(allItems, "packSize").length > 1) differentiators.push("Pack size");
  if (anyFormulationNoted) differentiators.push("Additional ingredients / combination formulation");
  if (anyPriceVerified) differentiators.push("Retailer price");

  const ingredientName = ingredient?.name || "This ingredient";
  const quickTakeawayFirstLine = (ingredient?.repQuickTakeaway || "").split("\n").filter(Boolean)[0] || "";
  const whatNotToClaimFirstLine = (ingredient?.whatNotToClaim || "").split("\n").filter(Boolean)[0] || "";

  return (
    <RecallSection title={`${ingredientName} market comparison`}>
      <div style={{ fontSize: 11, color: "#8A8272", fontStyle: "italic", marginBottom: 10 }}>
        This summarizes documented differences only — it does not recommend one product over another.
      </div>

      {/* Conclusions first, always visible — this is what a rep actually
          needs before a call. The full field-by-field breakdown these are
          drawn from is available on demand below, not by default. */}
      <SummarySubsection title="Pre-call — 30 second summary">
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          <li style={{ marginBottom: 4 }}>Forms represented in this market: {distinctVerified(allItems, "chemicalForm").length > 0 ? distinctVerified(allItems, "chemicalForm").join(", ") : "Not verified"}.</li>
          <li style={{ marginBottom: 4 }}>Our products use: {distinctVerified(ourItems, "chemicalForm").length > 0 ? distinctVerified(ourItems, "chemicalForm").join(", ") : "Not verified"}.</li>
          <li style={{ marginBottom: 4 }}>Competitor dosage formats: {distinctVerified(competitorItems, "dosageForm").length > 0 ? distinctVerified(competitorItems, "dosageForm").join(", ") : "Not verified"}.</li>
          <li style={{ marginBottom: 4 }}>Major formulation differences: {anyFormulationNoted ? "some products contain additional ingredients beyond the core content." : "None documented beyond dose/form."}</li>
          <li style={{ marginBottom: 4 }}>Clinical point to remember: {quickTakeawayFirstLine || "See Clinical Evidence above."}</li>
          <li>What NOT to claim: {whatNotToClaimFirstLine || "See What Not to Claim above."}</li>
        </ol>
      </SummarySubsection>

      <SummarySubsection title="How to position our products">
        {ourItems.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "#8A8272", fontStyle: "italic" }}>No our-products on file for this category yet.</div>
        ) : (
          ourItems.map((i, idx) => {
            const amountForm = [i.amount, i.chemicalForm].filter(Boolean).join(" ");
            const dosageFormPhrase = i.dosageForm ? ` in a ${i.dosageForm.toLowerCase()} format` : "";
            const whatCanBeSaid = amountForm ? `"Contains ${amountForm}${dosageFormPhrase}."` : "Not enough verified information to state yet.";
            return (
              <div key={idx} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: idx < ourItems.length - 1 ? "1px solid #F0EBE0" : "none" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>{i.label}</div>
                <div style={{ fontSize: 11.5, color: "#5B5445", marginBottom: 3 }}>
                  <strong>What it contains:</strong> {[i.amount, i.chemicalForm, i.dosageForm].filter(Boolean).join(", ") || "Not enough verified information."}
                </div>
                {(i.ingredientsText || i.notesText) && (
                  <div style={{ fontSize: 11.5, color: "#5B5445", marginBottom: 3 }}>
                    <strong>What makes its formulation distinct:</strong> {i.ingredientsText || i.notesText}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "#2F5B41", marginBottom: 3 }}>
                  <strong>What can be said:</strong> {whatCanBeSaid}
                </div>
                {whatNotToClaimFirstLine && (
                  <div style={{ fontSize: 11.5, color: "#7A3B3B" }}>
                    <strong>Do not claim:</strong> {whatNotToClaimFirstLine.replace(/^Do not claim /i, "")}
                  </div>
                )}
              </div>
            );
          })
        )}
      </SummarySubsection>

      <SummarySubsection title="What actually differentiates the products?">
        {differentiators.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {differentiators.map((d) => <li key={d} style={{ marginBottom: 3 }}>{d}</li>)}
          </ul>
        ) : <div style={{ fontSize: 11.5, color: "#8A8272", fontStyle: "italic" }}>Not enough verified information to compare.</div>}
      </SummarySubsection>

      <ExpandableDetails label="Show full market comparison details">
        <SummarySubsection title="Dose differences">
          {anyAmountVerified
            ? allItems.map((i, idx) => <div key={idx} style={summaryLineStyle}>{i.label}: {i.amount || "Not verified"}</div>)
            : <IncompleteNotice missing={["amount"]} />}
        </SummarySubsection>

        <SummarySubsection title="Chemical form differences">
          {anyChemicalFormVerified ? (
            <>
              {[...chemicalFormGroups.entries()].map(([form, labels]) => (
                <div key={form} style={summaryLineStyle}><strong>{form}:</strong> {labels.join(", ")}</div>
              ))}
              <div style={scientificContextStyle}>
                Methylcobalamin and adenosylcobalamin are metabolically active forms. Cyanocobalamin and hydroxocobalamin are converted by the body into active forms. Current evidence does not establish that methylcobalamin has superior absorption compared with cyanocobalamin.
              </div>
            </>
          ) : <IncompleteNotice missing={["chemical form"]} />}
        </SummarySubsection>

        <SummarySubsection title="Dosage form differences">
          {anyDosageFormVerified ? (
            <>
              {[...dosageFormGroups.entries()].map(([form, labels]) => (
                <div key={form} style={summaryLineStyle}><strong>{form}:</strong> {labels.join(", ")}</div>
              ))}
              <div style={scientificContextStyle}>
                Chemical form (e.g. Cyanocobalamin, Methylcobalamin) is what the active ingredient is; dosage form (e.g. Tablet, Quick-Dissolve, Lozenge) is how the product is taken — the two are independent facts. A "Quick-Dissolve" product is only described as sublingual when a source explicitly documents that it dissolves under the tongue; sublingual administration is never assumed from the format name alone, and no format is described as more effective than another.
              </div>
            </>
          ) : <IncompleteNotice missing={["dosage form"]} />}
        </SummarySubsection>

        <SummarySubsection title="Formulation differences">
          {anyFormulationNoted ? (
            allItems.filter(hasFormulationNote).map((i, idx) => <div key={idx} style={summaryLineStyle}>{i.label}: {i.ingredientsText || i.notesText}</div>)
          ) : (
            <div style={{ fontSize: 11.5, color: "#8A8272" }}>No documented additional ingredients beyond the core content for the products currently on file.</div>
          )}
        </SummarySubsection>

        <SummarySubsection title="Pack size differences">
          {allItems.some((i) => i.packSize)
            ? allItems.map((i, idx) => <div key={idx} style={summaryLineStyle}>{i.label}: {i.packSize || "Not verified"}</div>)
            : <IncompleteNotice missing={["pack size"]} />}
        </SummarySubsection>

        <SummarySubsection title="Price differences">
          {anyPriceVerified ? (
            <>
              {ourItems.filter((i) => i.price !== "" && i.price != null).map((i, idx) => <div key={`o${idx}`} style={summaryLineStyle}>{i.label}: {i.price}</div>)}
              {competitorItems.flatMap((i, idx) =>
                i.retailerListings.filter((l) => l.displayedPrice !== "" && l.displayedPrice != null).map((l, lidx) => (
                  <div key={`${idx}-${lidx}`} style={summaryLineStyle}>{i.label} ({l.retailer}): {l.currency || ""} {l.displayedPrice}</div>
                ))
              )}
            </>
          ) : <IncompleteNotice missing={["retailer/price information"]} />}
        </SummarySubsection>

        <SummarySubsection title="Information gaps">
          {allItems.some((i) => i.missingFields.length > 0) ? (
            allItems.filter((i) => i.missingFields.length > 0).map((i, idx) => (
              <div key={idx} style={{ ...summaryLineStyle, color: "#8A6B3A" }}>⚠️ {i.label} — missing: {i.missingFields.join(", ")}</div>
            ))
          ) : <div style={{ fontSize: 11.5, color: "#8A8272" }}>No documented information gaps for the products currently on file.</div>}
        </SummarySubsection>

        <SummarySubsection title="If the doctor mentions a competitor">
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            Acknowledge the competitor's form factually, then transition back to what's documented about our product — do not attack the competitor or claim superiority.
          </div>
          <div style={scientificContextStyle}>
            "Methylcobalamin is one of the metabolically active forms of B12. Cyanocobalamin is another supplemental form that is converted into active forms by the body. Current evidence has not established superior absorption simply based on these forms."
          </div>
        </SummarySubsection>
      </ExpandableDetails>
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
