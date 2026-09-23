import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
// Vite's ?url import gives us a servable path to the worker file rather than
// bundling pdf.js's worker code inline — the standard pattern for pdfjs-dist
// under Vite.
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// Shared in-app viewer for Certifications and Rep Q&A answer attachments.
// Deliberately has NO download/save/print affordance anywhere: a PDF is
// rendered page-by-page onto <canvas> (not an <iframe>, which would surface
// the browser's own PDF viewer chrome — download/print icons included, and
// those can't be reliably suppressed cross-browser) and the presigned URL
// used to fetch it is only ever held in memory for that one fetch, never
// rendered as a clickable link. `fetchViewUrl` is an async () => {url}
// passed in by the caller (a fresh, short-TTL URL minted on every open).
export function DocumentViewer({ open, onClose, title, mimeType, fetchViewUrl }) {
  const [status, setStatus] = useState("loading"); // loading | error | ready
  const [errorMsg, setErrorMsg] = useState("");
  const [scale, setScale] = useState(1);
  const [imageUrl, setImageUrl] = useState("");
  const scrollRef = useRef(null);
  // pdfContainerRef points at a div that ONLY ever holds imperatively
  // appended <canvas> elements — never any JSX children — so React's own
  // reconciliation never tries to diff against nodes it didn't create
  // (mixing appendChild/innerHTML into a React-managed container crashes
  // React's commit phase with a stale-child "removeChild" error).
  const pdfContainerRef = useRef(null);
  const pdfDocRef = useRef(null);
  const isImage = (mimeType || "").startsWith("image/");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setErrorMsg("");
    setScale(1);
    setImageUrl("");
    pdfDocRef.current = null;
    if (pdfContainerRef.current) pdfContainerRef.current.innerHTML = "";
    fetchViewUrl()
      .then(async ({ url }) => {
        if (cancelled) return;
        if (isImage) {
          setImageUrl(url);
          setStatus("ready");
          return;
        }
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(e.message || "Couldn't open this document.");
        setStatus("error");
      });
    return () => { cancelled = true; };
    // fetchViewUrl is expected to be a fresh closure per document (it closes
    // over that document's id) — depending on it re-runs this load whenever
    // the caller points the same open modal at a different document, not
    // only on the initial open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fetchViewUrl]);

  const renderPdfPages = useCallback(async () => {
    const pdf = pdfDocRef.current;
    const container = pdfContainerRef.current;
    if (!pdf || !container) return;
    container.innerHTML = "";
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.display = "block";
      canvas.style.margin = "0 auto 10px";
      canvas.style.boxShadow = "0 1px 4px rgba(0,0,0,0.15)";
      container.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
    }
  }, [scale]);

  useEffect(() => {
    if (status === "ready" && !isImage) renderPdfPages();
  }, [status, scale, isImage, renderPdfPages]);

  const fitToScreen = useCallback(async () => {
    const pdf = pdfDocRef.current;
    const container = scrollRef.current;
    if (!pdf || !container) { setScale(1); return; }
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = container.clientWidth - 24;
    setScale(Math.max(0.25, targetWidth / baseViewport.width));
  }, []);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(23,37,34,0.75)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 12, width: "min(920px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #E5DFD3" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#17251F", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginLeft: 12 }}>
            {!isImage && status === "ready" && (
              <>
                <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} title="Zoom out" style={viewerBtnStyle}><ZoomOut size={15} /></button>
                <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} title="Zoom in" style={viewerBtnStyle}><ZoomIn size={15} /></button>
                <button onClick={fitToScreen} title="Fit to screen" style={viewerBtnStyle}><Maximize2 size={15} /></button>
              </>
            )}
            {isImage && status === "ready" && (
              <>
                <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} title="Zoom out" style={viewerBtnStyle}><ZoomOut size={15} /></button>
                <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} title="Zoom in" style={viewerBtnStyle}><ZoomIn size={15} /></button>
                <button onClick={() => setScale(1)} title="Fit to screen" style={viewerBtnStyle}><Maximize2 size={15} /></button>
              </>
            )}
            <button onClick={onClose} title="Close" style={viewerBtnStyle}><X size={16} /></button>
          </div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 12, background: "#F3F0E8", textAlign: "center" }}>
          {status === "loading" && <div style={{ fontSize: 12.5, color: "#8A8272", padding: 40 }}>Loading document…</div>}
          {status === "error" && <div style={{ fontSize: 12.5, color: "#B33A3A", padding: 40 }}>{errorMsg}</div>}
          {status === "ready" && isImage && (
            <img
              src={imageUrl}
              alt={title}
              style={{ maxWidth: "none", width: `${scale * 100}%`, boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }}
              draggable={false}
            />
          )}
          {/* Rendered PDF pages are appended here as raw <canvas> elements by
              renderPdfPages — this div never has JSX children of its own, so
              React never tries to reconcile against nodes it didn't create. */}
          <div ref={pdfContainerRef} style={{ display: status === "ready" && !isImage ? "block" : "none" }} />
        </div>
      </div>
    </div>
  );
}

const viewerBtnStyle = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, borderRadius: 7, border: "1px solid #E5DFD3", background: "#fff", color: "#5B5445", cursor: "pointer",
};
