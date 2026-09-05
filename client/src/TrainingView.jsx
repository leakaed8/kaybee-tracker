import React, { useState, useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import { Check, X, Loader2, Play } from "lucide-react";
import { api } from "./api.js";

// Kept local (not imported from App.jsx) to avoid a circular import between
// the two files — same look as the rest of the app either way.
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "30px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}

// Plays a signed, short-expiry Cloudflare Stream URL fetched fresh from our
// own backend for this logged-in employee — never a public/unsigned link,
// and the URL is never persisted anywhere on the client past this session.
// Native download UI, right-click, and Picture-in-Picture are all disabled;
// the name+timestamp watermark is a deterrent/traceability layer on top,
// not real DRM — nothing here claims to make the video uncopiable.
function TrainingVideoPlayer({ videoId, repName, onEnded }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
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
    api.getTrainingPlaybackUrl(videoId)
      .then(({ url }) => {
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        if (Hls.isSupported()) {
          const hls = new Hls();
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari plays HLS natively — no hls.js needed there.
          video.src = url;
        } else {
          setError("This browser can't play the training video format. Try Chrome, Firefox, or Safari.");
        }
        setLoading(false);
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => {
      cancelled = true;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
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
            ref={videoRef}
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

// Admin-only: paste the Cloudflare Stream video id and the quiz JSON
// generated once in NotebookLM. No AI calls happen here — this is a plain
// data-entry form, exactly per the hard constraint that quiz content is
// static and pasted in, never generated live.
function AddTrainingVideoForm({ onAdded }) {
  const [title, setTitle] = useState("");
  const [videoId, setVideoId] = useState("");
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
    if (!title.trim() || !videoId.trim()) { setError("Title and Cloudflare Stream video id are required."); return; }
    setSaving(true);
    try {
      await api.addTrainingVideo({ title: title.trim(), cloudflareStreamVideoId: videoId.trim(), quiz });
      setTitle(""); setVideoId(""); setQuizText("");
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
        Upload the video to Cloudflare Stream first (this app never stores video files). Then paste its video id here, plus the quiz JSON from NotebookLM.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" style={inputStyle} />
        <input value={videoId} onChange={(e) => setVideoId(e.target.value)} placeholder="Cloudflare Stream video id" style={inputStyle} />
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

export function TrainingVideosView({ role, repName, isSupervisor, repNames }) {
  const [videos, setVideos] = useState(null);
  const [progress, setProgress] = useState([]);
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [expandedVideoId, setExpandedVideoId] = useState(null);
  const isManagerView = role === "manager" || isSupervisor;

  const load = useCallback(() => {
    Promise.all([api.getTrainingVideos(), api.getTrainingProgress()])
      .then(([v, p]) => { setVideos(v.videos || []); setProgress(p.progress || []); })
      .catch(() => { setVideos([]); setProgress([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const myCompletion = (videoId) => progress.find((p) => p.employeeId === repName && p.videoId === videoId);
  const completersFor = (videoId) => progress.filter((p) => p.videoId === videoId);

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Training</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Watch each video, then answer the questions that follow.
      </p>

      {isManagerView && <AddTrainingVideoForm onAdded={load} />}

      {videos === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {videos && videos.length === 0 && <EmptyState text="No training videos yet." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {videos && videos.map((v) => {
          const mine = myCompletion(v.id);
          const completers = completersFor(v.id);
          const isActive = activeVideoId === v.id;
          const isExpanded = expandedVideoId === v.id;
          return (
            <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
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

              {isActive && (
                <div style={{ marginTop: 12 }}>
                  <TrainingVideoSession
                    videoId={v.id}
                    repName={repName || "Manager"}
                    onDone={() => { setActiveVideoId(null); load(); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
