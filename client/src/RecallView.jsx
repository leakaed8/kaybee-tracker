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

function RecallCategoryDetail({ categoryId, categoryName, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api.getRecallCategory(categoryId)
      .then(setData)
      .catch((e) => setError(e.message || "Couldn't load this category."))
      .finally(() => setLoading(false));
  }, [categoryId]);

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

          <RecallSection title="Dosage Forms">
            <EmptyState text="No dosage form information has been added yet." />
          </RecallSection>

          <RecallSection title="Your Products">
            {data.products.length === 0 ? (
              <EmptyState text="No products have been linked to this category yet." />
            ) : (
              data.products.map((p) => (
                <div key={p.id} style={{ fontSize: 12.5, marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #F0EBE0" }}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  {(p.compoundAmount || p.chemicalForm) && (
                    <div style={{ color: "#5B5445", marginTop: 2 }}>
                      {p.compoundAmount ? `${p.compoundAmount} ${p.unit || ""}`.trim() : ""}{p.compoundAmount && p.chemicalForm ? " · " : ""}{p.chemicalForm}
                    </div>
                  )}
                  <MissingInfoBadge researchStatus={p.verificationStatus} missingFields={p.missingFields} />
                </div>
              ))
            )}
          </RecallSection>

          <RecallSection title="Competitors">
            {data.competitors.length === 0 ? (
              <EmptyState text="No competitor comparison has been added yet." />
            ) : (
              data.competitors.map((c) => (
                <div key={c.id} style={{ fontSize: 12.5, marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #F0EBE0" }}>
                  <div style={{ fontWeight: 600 }}>
                    {c.competitorProduct.competitorName} — {c.competitorProduct.productName}
                  </div>
                  <div style={{ color: "#5B5445", marginTop: 2 }}>
                    {[c.competitorProduct.dosage, c.competitorProduct.genericName, c.competitorProduct.form, c.competitorProduct.packSize ? `pack of ${c.competitorProduct.packSize}` : ""]
                      .filter(Boolean).join(" · ")}
                  </div>
                  {c.notes && <div style={{ color: "#8A8272", fontSize: 11.5, marginTop: 4 }}>{c.notes}</div>}
                  {c.retailerListings.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {c.retailerListings.map((l, idx) => (
                        <div key={idx} style={{ fontSize: 11.5, color: "#5B5445" }}>
                          {l.retailer}: {l.displayedPrice !== "" && l.displayedPrice != null ? `${l.currency || ""} ${l.displayedPrice}`.trim() : "price not verified"}
                          {" — "}{l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noreferrer">source</a> : "source URL not verified"}
                        </div>
                      ))}
                    </div>
                  )}
                  <MissingInfoBadge researchStatus={c.competitorProduct.researchStatus} missingFields={c.competitorProduct.missingFields} />
                </div>
              ))
            )}
          </RecallSection>

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
