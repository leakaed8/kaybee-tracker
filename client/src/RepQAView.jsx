import React, { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";
import { DocumentViewer } from "./DocumentViewer.jsx";

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "24px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}

// Same two brands as Certifications, kept as a small local constant rather
// than a shared import — it's two string literals, not worth a shared
// module for.
const QA_BRANDS = ["Alfa", "Mason"];

export function RepQAView({ role, repName, products }) {
  const [questions, setQuestions] = useState(null);
  const [search, setSearch] = useState("");
  const [showAskForm, setShowAskForm] = useState(false);
  const [viewerDoc, setViewerDoc] = useState(null);
  const isManager = role === "manager";

  const load = useCallback(() => {
    api.getRepQuestions().then((d) => setQuestions(d.questions || [])).catch(() => setQuestions([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const pending = (questions || []).filter((q) => q.status === "pending");
  const published = (questions || []).filter((q) => q.status === "published");
  const q = search.toLowerCase().trim();
  const filteredPublished = published.filter((item) => {
    if (!q) return true;
    return [item.question, item.productName, item.brand, item.category, item.answer]
      .some((f) => (f || "").toLowerCase().includes(q));
  });

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px" }}>Rep Q&A</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 14px" }}>
        Ask a product or evidence question — search Answered Questions first to avoid asking something already covered.
      </p>

      {!isManager && (
        showAskForm ? (
          <AskQuestionForm products={products} onAsked={() => { setShowAskForm(false); load(); }} onCancel={() => setShowAskForm(false)} />
        ) : (
          <button
            onClick={() => setShowAskForm(true)}
            style={{ fontSize: 12.5, color: "#1F2A24", background: "#fff", border: "1px solid #1F2A24", borderRadius: 8, padding: "8px 14px", marginBottom: 16 }}
          >
            + Ask a question
          </button>
        )
      )}

      {isManager && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Pending Questions ({pending.length})</div>
          {pending.length === 0 && <EmptyState text="No pending questions." />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map((item) => (
              <PendingQuestionRow key={item.id} item={item} onAnswered={load} />
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Answered Questions</div>
      {published.length > 0 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search answered questions…"
          style={{ ...inputStyle, marginBottom: 12 }}
        />
      )}
      {questions === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {questions && published.length === 0 && <EmptyState text="No answered questions yet." />}
      {questions && published.length > 0 && filteredPublished.length === 0 && <EmptyState text="No answered questions match this search." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredPublished.map((item) => (
          <div key={item.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: "#8A8272", marginBottom: 4 }}>
              {[item.brand, item.productName, item.category].filter(Boolean).join(" · ")}
            </div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{item.question}</div>
            <div style={{ fontSize: 13, color: "#333B36", marginTop: 6 }}>{item.answer}</div>
            <div style={{ fontSize: 10.5, color: "#B7AF9E", marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>Asked by {item.askedBy} · Answered by {item.answeredBy}</span>
              {item.answerDocumentName && (
                <button
                  onClick={() => setViewerDoc(item)}
                  style={{ fontSize: 11, color: "#4C7A5E", background: "#fff", border: "1px solid #CFE0D5", borderRadius: 6, padding: "3px 8px" }}
                >
                  View attached document
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <DocumentViewer
        open={!!viewerDoc}
        onClose={() => setViewerDoc(null)}
        title={viewerDoc?.answerDocumentName || ""}
        mimeType={viewerDoc?.answerDocumentMimeType || ""}
        fetchViewUrl={() => api.getRepQuestionAnswerViewUrl(viewerDoc.id)}
      />
    </div>
  );
}

function AskQuestionForm({ products, onAsked, onCancel }) {
  const [question, setQuestion] = useState("");
  const [productId, setProductId] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!question.trim()) return setError("Question is required.");
    setSaving(true);
    try {
      const product = (products || []).find((p) => p.id === productId);
      await api.addRepQuestion({
        question: question.trim(),
        productName: product ? product.name : "",
        brand,
        category: category.trim(),
      });
      onAsked();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Your question" rows={3} style={inputStyle} />
      <select value={productId} onChange={(e) => setProductId(e.target.value)} style={inputStyle}>
        <option value="">Product (optional)</option>
        {(products || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={brand} onChange={(e) => setBrand(e.target.value)} style={inputStyle}>
        <option value="">Brand (optional)</option>
        {QA_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category (optional, e.g. Dosage, Safety)" style={inputStyle} />
      {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving} style={{ fontSize: 12.5, color: "#fff", background: "#1F2A24", border: "none", borderRadius: 8, padding: "8px 14px" }}>
          {saving ? "Submitting…" : "Submit question"}
        </button>
        <button type="button" onClick={onCancel} style={{ fontSize: 12.5, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 14px" }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PendingQuestionRow({ item, onAnswered }) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!answer.trim()) return setError("Answer is required.");
    setSaving(true);
    try {
      await api.answerRepQuestion(item.id, { answer: answer.trim(), file: file || undefined });
      onAnswered();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: "#8A8272", marginBottom: 4 }}>
        {[item.brand, item.productName, item.category].filter(Boolean).join(" · ")}
      </div>
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{item.question}</div>
      <div style={{ fontSize: 10.5, color: "#B7AF9E", marginTop: 6 }}>Asked by {item.askedBy}</div>

      {answering ? (
        <form onSubmit={submit} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" rows={3} style={inputStyle} />
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files[0] || null)} />
          {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving} style={{ fontSize: 11.5, color: "#fff", background: "#4C7A5E", border: "none", borderRadius: 6, padding: "6px 10px" }}>
              {saving ? "Publishing…" : "Publish answer"}
            </button>
            <button type="button" onClick={() => setAnswering(false)} style={{ fontSize: 11.5, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3" }}>
          <button onClick={() => setAnswering(true)} style={{ fontSize: 11.5, color: "#4C7A5E", background: "#fff", border: "1px solid #CFE0D5", borderRadius: 6, padding: "6px 10px" }}>
            Publish Answer
          </button>
        </div>
      )}
    </div>
  );
}
