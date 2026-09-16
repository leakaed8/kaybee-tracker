import React, { useState, useEffect, useRef, useCallback } from "react";
import { Check, X, Loader2, Play, ExternalLink } from "lucide-react";
import { api } from "./api.js";

// Kept local (not imported from App.jsx) to avoid a circular import between
// the two files — same look as the rest of the app either way.
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "30px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}

// Suggestions for the "Vitamin / nutrient" field on a study — not a closed
// list (it's always a free-text input; anyone can type something not
// listed here, e.g. a nutrient whose name doesn't literally appear in any
// product name). Each nutrient's keywords are matched (case-insensitive,
// substring) against real product names to decide whether it's actually
// "in stock" — see detectStockedNutrients — so the suggestion list reflects
// products that actually exist rather than a generic vitamin textbook list.
const NUTRIENT_KEYWORDS = {
  "Vitamin A": ["vitamin a", "vit a", "beta-carotene", "beta carotene", "retinol"],
  "Vitamin B1 (Thiamine)": ["b1", "thiamine", "thiamin"],
  "Vitamin B2 (Riboflavin)": ["b2", "riboflavin"],
  "Vitamin B3 (Niacin)": ["b3", "niacin"],
  "Vitamin B5 (Pantothenic Acid)": ["b5", "pantothenic"],
  "Vitamin B6": ["b6", "pyridoxine"],
  "Vitamin B7 (Biotin)": ["b7", "biotin"],
  "Vitamin B9 (Folate)": ["b9", "folate", "folic acid"],
  "Vitamin B12": ["b12", "cobalamin"],
  "Vitamin C": ["vitamin c", "vit c", "ascorbic"],
  "Vitamin D": ["vitamin d", "vit d", "cholecalciferol"],
  "Vitamin E": ["vitamin e", "vit e", "tocopherol"],
  "Vitamin K": ["vitamin k", "vit k"],
  "Calcium": ["calcium"],
  "Magnesium": ["magnesium"],
  "Zinc": ["zinc"],
  "Iron": ["iron"],
  "Potassium": ["potassium"],
  "CoQ10": ["coq10", "co q10", "coenzyme q10", "ubiquinone"],
  "Omega-3": ["omega", "fish oil", "flaxseed", "cod liver", "salmon oil"],
  "Probiotics": ["probiotic"],
};

// Only returns nutrients with a real matching product — deliberately doesn't
// invent a connection that isn't backed by an actual product name.
function detectStockedNutrients(products) {
  const names = (products || []).map((p) => (p.name || "").toLowerCase());
  if (names.length === 0) return [];
  return Object.keys(NUTRIENT_KEYWORDS).filter((nutrient) =>
    NUTRIENT_KEYWORDS[nutrient].some((kw) => names.some((n) => n.includes(kw)))
  );
}

// Plays a signed, short-expiry R2 URL fetched fresh from our own backend
// for this logged-in employee — never a public/unsigned link, and the URL
// is never persisted anywhere on the client past this session. It's a
// plain MP4 served with normal HTTP range requests (R2 supports these
// natively, so scrubbing/seeking works), not adaptive-bitrate streaming —
// fine for short internal training clips, and means no streaming library
// is needed on the client at all. Native download UI, right-click, and
// Picture-in-Picture are all disabled; the name+timestamp watermark is a
// deterrent/traceability layer on top, not real DRM — nothing here claims
// to make the video uncopiable.
function TrainingVideoPlayer({ videoId, repName, onEnded }) {
  const [videoSrc, setVideoSrc] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [watermarkAt, setWatermarkAt] = useState(() => new Date());

  useEffect(() => {
    const tick = setInterval(() => setWatermarkAt(new Date()), 5000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setVideoSrc("");
    api.getTrainingPlaybackUrl(videoId)
      .then(({ url }) => { if (!cancelled) { setVideoSrc(url); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [videoId]);

  return (
    <div style={{ position: "relative", background: "#000", borderRadius: 10, overflow: "hidden" }}>
      {loading && (
        <div style={{ padding: 40, textAlign: "center", color: "#fff" }}>
          <Loader2 size={20} className="spin" /> Loading video…
        </div>
      )}
      {error && <div style={{ padding: 20, color: "#FBD3CC", fontSize: 13 }}>{error}</div>}
      {!error && (
        <>
          <video
            src={videoSrc}
            controls
            playsInline
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            onContextMenu={(e) => e.preventDefault()}
            onEnded={onEnded}
            style={{ width: "100%", maxHeight: 480, display: loading ? "none" : "block" }}
          />
          {!loading && (
            <div
              style={{
                position: "absolute", top: 10, right: 12, pointerEvents: "none",
                background: "rgba(0,0,0,0.45)", color: "rgba(255,255,255,0.85)",
                fontSize: 11.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6,
                fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 0.2,
              }}
            >
              {repName} · {watermarkAt.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One question at a time. Scenario answers are self-assessed against a
// model answer (never auto-graded); multiple-choice gives immediate
// correct/incorrect feedback. Nothing here calls out to any AI/LLM — the
// quiz content was pasted in once, ahead of time, by an admin.
function TrainingQuiz({ quiz, onSubmit, submitting }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [responses, setResponses] = useState(() => quiz.map((q) => ({
    type: q.type,
    question: q.question,
    ...(q.type === "scenario" ? { answer: "" } : { selectedOption: null }),
  })));
  const [revealedModelAnswer, setRevealedModelAnswer] = useState(false);

  const q = quiz[stepIndex];
  const r = responses[stepIndex];
  const isLast = stepIndex === quiz.length - 1;

  const updateResponse = (patch) => {
    setResponses((prev) => prev.map((row, i) => (i === stepIndex ? { ...row, ...patch } : row)));
  };

  const canAdvance = q.type === "scenario" ? r.answer.trim().length > 0 : r.selectedOption !== null;

  const goNext = () => {
    setRevealedModelAnswer(false);
    if (isLast) onSubmit(responses);
    else setStepIndex((i) => i + 1);
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 20 }}>
      <div style={{ fontSize: 11.5, color: "#8A8272", fontWeight: 600, marginBottom: 10 }}>
        Question {stepIndex + 1} of {quiz.length}
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 14 }}>{q.question}</div>

      {q.type === "scenario" ? (
        <div>
          <textarea
            value={r.answer}
            onChange={(e) => updateResponse({ answer: e.target.value })}
            placeholder="How would you handle this?"
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
          {q.follow_up && r.answer.trim().length > 0 && (
            <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 8, fontStyle: "italic" }}>{q.follow_up}</div>
          )}
          <div style={{ marginTop: 12 }}>
            {!revealedModelAnswer ? (
              <button
                onClick={() => setRevealedModelAnswer(true)}
                style={{ fontSize: 12.5, padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24" }}
              >
                Show model answer
              </button>
            ) : (
              <div style={{ fontSize: 12.5, background: "#F7FBF8", border: "1px solid #C7DFCE", borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 600, color: "#4C7A5E", marginBottom: 4 }}>Model answer</div>
                {q.model_answer}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {q.options.map((opt, i) => {
            const selected = r.selectedOption === i;
            const showFeedback = r.selectedOption !== null;
            const isCorrectOpt = i === q.correct_answer;
            let border = "1px solid #E5DFD3";
            let bg = "#fff";
            if (showFeedback && isCorrectOpt) { border = "1px solid #4C7A5E"; bg = "#F7FBF8"; }
            else if (showFeedback && selected && !isCorrectOpt) { border = "1px solid #B33A3A"; bg = "#FBF3F0"; }
            return (
              <button
                key={i}
                onClick={() => { if (r.selectedOption === null) updateResponse({ selectedOption: i }); }}
                disabled={r.selectedOption !== null}
                style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border, background: bg, fontSize: 13, cursor: r.selectedOption === null ? "pointer" : "default" }}
              >
                {opt}
                {showFeedback && isCorrectOpt && <span style={{ float: "right", color: "#4C7A5E", fontWeight: 600 }}><Check size={14} style={{ verticalAlign: -2 }} /> Correct</span>}
                {showFeedback && selected && !isCorrectOpt && <span style={{ float: "right", color: "#B33A3A", fontWeight: 600 }}><X size={14} style={{ verticalAlign: -2 }} /> Incorrect</span>}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button
          onClick={goNext}
          disabled={!canAdvance || submitting}
          style={{
            padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
            background: canAdvance && !submitting ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2",
          }}
        >
          {submitting ? "Saving…" : isLast ? "Finish" : "Next question"}
        </button>
      </div>
    </div>
  );
}

// A video row's watch/quiz flow, inline where the row was — video plays,
// then (on end) the quiz replaces it, then a completion note replaces that.
function TrainingVideoSession({ videoId, repName, onDone }) {
  const [phase, setPhase] = useState("watching"); // watching | quiz | done
  const [quiz, setQuiz] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const startQuiz = () => {
    api.getTrainingVideo(videoId)
      .then((v) => { setQuiz(v.quiz || []); setPhase("quiz"); })
      .catch((e) => setError(e.message));
  };

  const submitQuiz = async (responses) => {
    setSubmitting(true);
    setError("");
    try {
      await api.completeTrainingVideo(videoId, responses);
      setPhase("done");
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (error) return <div style={{ fontSize: 12.5, color: "#B33A3A" }}>{error}</div>;

  if (phase === "watching") {
    return <TrainingVideoPlayer videoId={videoId} repName={repName} onEnded={startQuiz} />;
  }
  if (phase === "quiz") {
    if (!quiz || quiz.length === 0) {
      return <div style={{ fontSize: 12.5, color: "#8A8272" }}>This video has no quiz attached — nothing more to do. <button onClick={() => onDone()} style={{ marginLeft: 8, fontSize: 12.5, color: "#4C7A5E" }}>Close</button></div>;
    }
    return <TrainingQuiz quiz={quiz} onSubmit={submitQuiz} submitting={submitting} />;
  }
  return (
    <div style={{ textAlign: "center", padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#4C7A5E", marginBottom: 12 }}>
        <Check size={16} style={{ verticalAlign: -2 }} /> Completed
      </div>
      <button onClick={onDone} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Close</button>
    </div>
  );
}

// Admin-only: paste the R2 object key (the file name/path as uploaded to
// the bucket) and the quiz JSON generated once in NotebookLM. No AI calls
// happen here — this is a plain data-entry form, exactly per the hard
// constraint that quiz content is static and pasted in, never generated
// live.
function AddTrainingVideoForm({ onAdded }) {
  const [title, setTitle] = useState("");
  const [objectKey, setObjectKey] = useState("");
  const [quizText, setQuizText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");
    let quiz;
    try {
      const parsed = JSON.parse(quizText);
      quiz = Array.isArray(parsed) ? parsed : parsed.quiz;
      if (!Array.isArray(quiz)) throw new Error("not an array");
    } catch {
      setError("Quiz isn't valid JSON — paste either a JSON array of questions, or the { \"quiz\": [...] } object.");
      return;
    }
    if (!title.trim() || !objectKey.trim()) { setError("Title and the R2 object key are required."); return; }
    setSaving(true);
    try {
      await api.addTrainingVideo({ title: title.trim(), r2ObjectKey: objectKey.trim(), quiz });
      setTitle(""); setObjectKey(""); setQuizText("");
      onAdded();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px" }}>Add a training video</h3>
      <p style={{ fontSize: 12, color: "#8A8272", margin: "0 0 10px" }}>
        Upload the video file to the R2 bucket first, via the Cloudflare dashboard (this app never stores video files itself). Then paste its exact file name below, plus the quiz JSON from NotebookLM.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" style={inputStyle} />
        <input value={objectKey} onChange={(e) => setObjectKey(e.target.value)} placeholder="R2 object key (e.g. handling-price-objections.mp4)" style={inputStyle} />
        <textarea value={quizText} onChange={(e) => setQuizText(e.target.value)} placeholder='Paste quiz JSON, e.g. { "quiz": [ ... ] }' rows={6} style={{ ...inputStyle, resize: "vertical", fontFamily: "'IBM Plex Mono', monospace" }} />
        {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
        <div>
          <button
            onClick={submit}
            disabled={saving}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving ? "#D8D2C4" : "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
          >
            {saving ? "Adding…" : "Add video"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin-only: fix a mistake in an existing video's title, R2 object key, or
// quiz JSON. Fetches the video's own current values first — the list view
// never carries the quiz or object key, only this manager-only detail
// fetch does.
function EditTrainingVideoForm({ video, onSaved, onCancel }) {
  const [title, setTitle] = useState(video.title);
  const [objectKey, setObjectKey] = useState("");
  const [quizText, setQuizText] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getTrainingVideo(video.id)
      .then((v) => {
        setTitle(v.title);
        setObjectKey(v.r2ObjectKey || "");
        setQuizText(JSON.stringify(v.quiz || [], null, 2));
        setLoadingDetail(false);
      })
      .catch((e) => { setError(e.message); setLoadingDetail(false); });
  }, [video.id]);

  const submit = async () => {
    setError("");
    let quiz;
    try {
      const parsed = JSON.parse(quizText);
      quiz = Array.isArray(parsed) ? parsed : parsed.quiz;
      if (!Array.isArray(quiz)) throw new Error("not an array");
    } catch {
      setError("Quiz isn't valid JSON — paste either a JSON array of questions, or the { \"quiz\": [...] } object.");
      return;
    }
    if (!title.trim() || !objectKey.trim()) { setError("Title and the R2 object key are required."); return; }
    setSaving(true);
    try {
      await api.updateTrainingVideo(video.id, { title: title.trim(), r2ObjectKey: objectKey.trim(), quiz });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loadingDetail) return <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" style={inputStyle} />
      <input value={objectKey} onChange={(e) => setObjectKey(e.target.value)} placeholder="R2 object key" style={inputStyle} />
      <textarea value={quizText} onChange={(e) => setQuizText(e.target.value)} rows={8} style={{ ...inputStyle, resize: "vertical", fontFamily: "'IBM Plex Mono', monospace" }} />
      {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={submit}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving ? "#D8D2C4" : "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

export function TrainingVideosView({ role, repName, isSupervisor, repNames }) {
  const [videos, setVideos] = useState(null);
  const [progress, setProgress] = useState([]);
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [expandedVideoId, setExpandedVideoId] = useState(null);
  const [editingVideoId, setEditingVideoId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const isManagerView = role === "manager" || isSupervisor;
  // Editing/deleting is manager-only (not supervisors) — matches the
  // requireManager gate on the server for these routes.
  const canEditVideos = role === "manager";

  const load = useCallback(() => {
    Promise.all([api.getTrainingVideos(), api.getTrainingProgress()])
      .then(([v, p]) => { setVideos(v.videos || []); setProgress(p.progress || []); })
      .catch(() => { setVideos([]); setProgress([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const myCompletion = (videoId) => progress.find((p) => p.employeeId === repName && p.videoId === videoId);
  const completersFor = (videoId) => progress.filter((p) => p.videoId === videoId);

  const doDelete = async (id) => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.removeTrainingVideo(id);
      setConfirmDeleteId(null);
      load();
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Training</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Watch each video, then answer the questions that follow.
      </p>

      {/* POST /api/admin/training-videos is requireManager-gated server-side
          (a supervisor is a rep account, not a manager) — canEditVideos,
          not isManagerView, so a supervisor never sees a form that would
          403 on submit. */}
      {canEditVideos && <AddTrainingVideoForm onAdded={load} />}

      {videos === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {videos && videos.length === 0 && <EmptyState text="No training videos yet." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {videos && videos.map((v) => {
          const mine = myCompletion(v.id);
          const completers = completersFor(v.id);
          const isActive = activeVideoId === v.id;
          const isExpanded = expandedVideoId === v.id;
          const isEditing = editingVideoId === v.id;
          return (
            <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
              {isEditing ? (
                <EditTrainingVideoForm
                  video={v}
                  onSaved={() => { setEditingVideoId(null); load(); }}
                  onCancel={() => setEditingVideoId(null)}
                />
              ) : (
                <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{v.title}</div>
                  {!isManagerView && (
                    mine ? (
                      <div style={{ fontSize: 11.5, color: "#4C7A5E", marginTop: 3, fontWeight: 600 }}>
                        <Check size={12} style={{ verticalAlign: -1 }} /> Completed {new Date(mine.completedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: "#C17817", marginTop: 3, fontWeight: 600 }}>Not completed</div>
                    )
                  )}
                  {isManagerView && (
                    <button
                      onClick={() => setExpandedVideoId(isExpanded ? null : v.id)}
                      style={{ fontSize: 11.5, color: "#5B5445", background: "none", border: "none", padding: 0, marginTop: 3, textDecoration: "underline", cursor: "pointer" }}
                    >
                      {completers.length} of {repNames.length} employee{repNames.length === 1 ? "" : "s"} completed
                    </button>
                  )}
                </div>
                {!isActive && (
                  <button
                    onClick={() => setActiveVideoId(v.id)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}
                  >
                    <Play size={13} /> {mine ? "Retake" : "Watch"}
                  </button>
                )}
              </div>

              {isManagerView && isExpanded && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
                  {repNames.map((name) => {
                    const rowProgress = completers.find((p) => p.employeeId === name);
                    return (
                      <div key={name} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{name}</span>
                        {rowProgress ? (
                          <span style={{ color: "#4C7A5E" }}>✓ {new Date(rowProgress.completedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
                        ) : (
                          <span style={{ color: "#C17817" }}>Not completed</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {canEditVideos && !isActive && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", alignItems: "center", gap: 8 }}>
                  {confirmDeleteId === v.id ? (
                    <>
                      <span style={{ fontSize: 11.5, color: "#B33A3A" }}>Delete this video? Employee completion history is kept.</span>
                      <button
                        onClick={() => doDelete(v.id)}
                        disabled={deleting}
                        style={{ fontSize: 11.5, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}
                      >
                        {deleting ? "Deleting…" : "Yes, delete"}
                      </button>
                      <button onClick={() => { setConfirmDeleteId(null); setDeleteError(""); }} style={{ fontSize: 11.5, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setEditingVideoId(v.id)} style={{ fontSize: 11.5, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
                        Edit
                      </button>
                      <button onClick={() => setConfirmDeleteId(v.id)} style={{ fontSize: 11.5, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>
                        Delete
                      </button>
                    </>
                  )}
                  {deleteError && confirmDeleteId === v.id && <span style={{ fontSize: 11.5, color: "#B33A3A" }}>{deleteError}</span>}
                </div>
              )}

              {isActive && (
                <div style={{ marginTop: 12 }}>
                  <TrainingVideoSession
                    videoId={v.id}
                    repName={repName || "Manager"}
                    onDone={() => { setActiveVideoId(null); load(); }}
                  />
                </div>
              )}
              </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Admin-only: paste a study's title, URL, and an optional note on why it's
// relevant. No file is hosted here — just a link out.
function AddTrainingStudyForm({ onAdded }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [nutrient, setNutrient] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");
    if (!title.trim() || !url.trim()) { setError("Title and URL are required."); return; }
    if (!nutrient.trim()) { setError("Pick (or type) the vitamin/nutrient this study is about."); return; }
    setSaving(true);
    try {
      await api.addTrainingStudy({ title: title.trim(), url: url.trim(), nutrient: nutrient.trim(), notes: notes.trim() });
      setTitle(""); setUrl(""); setNutrient(""); setNotes("");
      onAdded();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px" }}>Add a study</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Study title" style={inputStyle} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link (e.g. https://pubmed.ncbi.nlm.nih.gov/...)" style={inputStyle} />
        <input value={nutrient} onChange={(e) => setNutrient(e.target.value)} placeholder="Vitamin / nutrient (e.g. Vitamin B12)" list="study-nutrient-options" style={inputStyle} />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why it's relevant (optional)" rows={2} style={{ ...inputStyle, resize: "vertical" }} />
        {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
        <div>
          <button
            onClick={submit}
            disabled={saving}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving ? "#D8D2C4" : "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
          >
            {saving ? "Adding…" : "Add study"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditTrainingStudyForm({ study, onSaved, onCancel }) {
  const [title, setTitle] = useState(study.title);
  const [url, setUrl] = useState(study.url);
  const [nutrient, setNutrient] = useState(study.nutrient || "");
  const [notes, setNotes] = useState(study.notes || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");
    if (!title.trim() || !url.trim()) { setError("Title and URL are required."); return; }
    if (!nutrient.trim()) { setError("Pick (or type) the vitamin/nutrient this study is about."); return; }
    setSaving(true);
    try {
      await api.updateTrainingStudy(study.id, { title: title.trim(), url: url.trim(), nutrient: nutrient.trim(), notes: notes.trim() });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Study title" style={inputStyle} />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link" style={inputStyle} />
      <input value={nutrient} onChange={(e) => setNutrient(e.target.value)} placeholder="Vitamin / nutrient" list="study-nutrient-options" style={inputStyle} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why it's relevant (optional)" rows={2} style={{ ...inputStyle, resize: "vertical" }} />
      {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={submit}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving ? "#D8D2C4" : "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

const ALL_NUTRIENTS_KEY = "__all__";
const UNTAGGED_KEY = "__untagged__";

function studyChipStyle(active) {
  return {
    padding: "6px 12px", borderRadius: 16, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
    border: active ? "1px solid #1F2A24" : "1px solid #E5DFD3",
    background: active ? "#1F2A24" : "#fff", color: active ? "#FAF7F2" : "#5B5445",
  };
}

// A narrow, fast action for any employee (not gated behind manager-only
// Edit) — just enough to clear the "Untagged" backlog without opening a
// full edit form for a study someone else added.
function QuickTagNutrient({ study, nutrientOptions, onTagged }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.tagTrainingStudyNutrient(study.id, value.trim());
      onTagged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="Tag with a vitamin/nutrient…"
        list="study-nutrient-options"
        style={{ ...inputStyle, width: "auto", flex: "1 1 220px", fontSize: 12, padding: "5px 8px" }}
      />
      <button
        onClick={submit}
        disabled={saving || !value.trim()}
        style={{ fontSize: 11.5, fontWeight: 500, color: "#FAF7F2", background: value.trim() ? "#4C7A5E" : "#D8D2C4", border: "none", borderRadius: 6, padding: "6px 10px" }}
      >
        {saving ? "Tagging…" : "Tag"}
      </button>
      {error && <span style={{ fontSize: 11, color: "#B33A3A" }}>{error}</span>}
    </div>
  );
}

export function TrainingStudiesView({ role, products }) {
  const [studies, setStudies] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [selectedNutrient, setSelectedNutrient] = useState(ALL_NUTRIENTS_KEY);
  const [search, setSearch] = useState("");
  const canEdit = role === "manager";

  const load = useCallback(() => {
    api.getTrainingStudies().then((d) => setStudies(d.studies || [])).catch(() => setStudies([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const doDelete = async (id) => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.removeTrainingStudy(id);
      setConfirmDeleteId(null);
      load();
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // "See our vitamins, then the studies under it" — chips built from
  // whatever's actually been used on real studies, each with a live count.
  // A study saved before this field existed (or never tagged) has no
  // nutrient at all — those land under "Untagged" rather than being hidden.
  const usedNutrients = studies ? [...new Set(studies.map((s) => s.nutrient).filter(Boolean))] : [];
  // Suggestions when tagging/adding a study: nutrients already used on some
  // study, plus nutrients actually detected in the real product catalog —
  // never a generic list unconnected to what's really used or sold.
  const nutrientOptions = [...new Set([...usedNutrients, ...detectStockedNutrients(products)])].sort();
  const nutrientCounts = {};
  let untaggedCount = 0;
  (studies || []).forEach((s) => {
    if (s.nutrient) nutrientCounts[s.nutrient] = (nutrientCounts[s.nutrient] || 0) + 1;
    else untaggedCount += 1;
  });
  const chips = [
    { key: ALL_NUTRIENTS_KEY, label: "All", count: studies?.length || 0 },
    ...usedNutrients.sort().map((n) => ({ key: n, label: n, count: nutrientCounts[n] })),
    ...(untaggedCount > 0 ? [{ key: UNTAGGED_KEY, label: "Untagged", count: untaggedCount }] : []),
  ];

  const q = search.toLowerCase().trim();
  const filteredStudies = (studies || []).filter((s) => {
    if (selectedNutrient === ALL_NUTRIENTS_KEY) { /* no nutrient filter */ }
    else if (selectedNutrient === UNTAGGED_KEY && s.nutrient) return false;
    else if (selectedNutrient !== UNTAGGED_KEY && s.nutrient !== selectedNutrient) return false;
    if (!q) return true;
    return s.title.toLowerCase().includes(q) || (s.notes || "").toLowerCase().includes(q) || (s.nutrient || "").toLowerCase().includes(q);
  });

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Studies</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Reference studies to cite with doctors and pharmacists, organized by vitamin/nutrient — tap through to read the source.
      </p>

      <AddTrainingStudyForm onAdded={load} />

      {studies === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {studies && studies.length === 0 && <EmptyState text="No studies added yet." />}

      {studies && studies.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {chips.map((c) => (
              <button key={c.key} onClick={() => setSelectedNutrient(c.key)} style={studyChipStyle(selectedNutrient === c.key)}>
                {c.label} ({c.count})
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search studies…"
            style={{ ...inputStyle, marginBottom: 14 }}
          />
        </>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {studies && filteredStudies.map((s) => (
          <div key={s.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
            {editingId === s.id ? (
              <EditTrainingStudyForm study={s} onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)} />
            ) : (
              <>
                {s.nutrient ? (
                  <div style={{ display: "inline-block", fontSize: 10.5, fontWeight: 600, color: "#4C7A5E", background: "#F3F7F4", border: "1px solid #CFE0D5", borderRadius: 12, padding: "2px 8px", marginBottom: 6 }}>
                    {s.nutrient}
                  </div>
                ) : (
                  <QuickTagNutrient study={s} nutrientOptions={nutrientOptions} onTagged={load} />
                )}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => { api.markTrainingStudyViewed(s.id).catch(() => {}); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600, color: "#4C7A5E", textDecoration: "none" }}
                >
                  {s.title} <ExternalLink size={13} />
                </a>
                {s.notes && <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 4 }}>{s.notes}</div>}
                {s.createdBy && <div style={{ fontSize: 10.5, color: "#B7AF9E", marginTop: 6 }}>Added by {s.createdBy}</div>}
                {canEdit && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", alignItems: "center", gap: 8 }}>
                    {confirmDeleteId === s.id ? (
                      <>
                        <span style={{ fontSize: 11.5, color: "#B33A3A" }}>Delete this study?</span>
                        <button
                          onClick={() => doDelete(s.id)}
                          disabled={deleting}
                          style={{ fontSize: 11.5, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}
                        >
                          {deleting ? "Deleting…" : "Yes, delete"}
                        </button>
                        <button onClick={() => { setConfirmDeleteId(null); setDeleteError(""); }} style={{ fontSize: 11.5, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setEditingId(s.id)} style={{ fontSize: 11.5, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>
                          Edit
                        </button>
                        <button onClick={() => setConfirmDeleteId(s.id)} style={{ fontSize: 11.5, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>
                          Delete
                        </button>
                      </>
                    )}
                    {deleteError && confirmDeleteId === s.id && <span style={{ fontSize: 11.5, color: "#B33A3A" }}>{deleteError}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {studies && studies.length > 0 && filteredStudies.length === 0 && <EmptyState text="No studies match this filter." />}
      </div>

      <datalist id="study-nutrient-options">
        {nutrientOptions.map((n) => <option key={n} value={n} />)}
      </datalist>
    </div>
  );
}
