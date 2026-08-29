import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  LineChart, Line, BarChart, Bar, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend,
} from "recharts";
import {
  MapPin, Package, LayoutDashboard, Settings, Plus, Send, Clock, AlertTriangle,
  TrendingDown, TrendingUp, Check, X, Loader2, MessageCircle, RotateCcw, Copy, Download, Upload,
  Navigation, Users, Target, Megaphone, ShoppingCart, Stethoscope, Radar as RadarIcon, Search, BookOpen,
  GraduationCap, Boxes, Swords, History,
} from "lucide-react";
import { api } from "./api.js";
import {
  daysUntil, fmtDate, turnoverPct, zoneFor, isSlowMover, isAtRisk, effectiveSold90, lifecyclePct, TIER_CADENCE, haversineKm, daysSince, parseExcelCellDate,
  computeLeadScore,
} from "./helpers.js";
import {
  DRUG_NUTRIENT_DATA, CONDITION_TALKING_POINTS, SPECIALTY_TALKING_POINTS,
  BCOMPLEX_INFO, DIABETES_SUPPLEMENT_INTERACTIONS, TALKING_POINTS_NOTES,
} from "./repKnowledge.js";
import {
  TRAINING_INTRO, DIABETES_LANDSCAPE, MODULE1_MINDSET, COLOR_ENERGIES, PHYSICIAN_TYPES,
  ADOPTION_STYLES, CALL_FRAMEWORK, MOM_STRATEGY, APACT_EXAMPLES, VALUE_PROPOSITION,
  POST_CALL_ANALYSIS, LEAG_PHILOSOPHY,
} from "./repTraining.js";

const POLL_INTERVAL_MS = 30000; // Sheets API's per-user read quota is fixed and shared across every session — keep this conservative
const LIST_DISPLAY_CAP = 200; // cap rendered rows so huge imported lists (30k+) don't freeze the browser — use search to narrow

// Visits saved when GPS capture fails (indoors, no signal, permission
// denied) — queued here instead of lost, then flushed automatically once a
// GPS fix becomes available. Lives in localStorage rather than React state
// so it survives a refresh/app close while still unsynced.
const PENDING_VISITS_KEY = "kb_pending_visits";
const loadPendingVisits = () => {
  try { return JSON.parse(localStorage.getItem(PENDING_VISITS_KEY) || "[]"); } catch { return []; }
};
const savePendingVisits = (list) => {
  try { localStorage.setItem(PENDING_VISITS_KEY, JSON.stringify(list)); } catch { /* storage unavailable — nothing more we can do */ }
};

// How far a check-in's GPS can be from a pharmacy/doctor's own saved
// location (geocoded address or a GPS fix captured when it was added)
// before it's flagged as a possible mismatch. Generous on purpose — a
// geocoded address is only approximate, and phone GPS itself drifts, so
// this is meant to catch "visited the wrong place entirely" cases, not
// nitpick normal imprecision.
const LOCATION_MISMATCH_KM = 1;

// The Geolocation API's own `timeout` option only starts counting once a
// permission decision has been made — if a browser/webview leaves the
// permission prompt hanging (seen in some embedded contexts, and is exactly
// what happened when a manager got stuck on "Punching in…" forever testing
// this), neither the success nor the error callback ever fires and the
// caller hangs indefinitely. This adds an unconditional fallback on top so
// every caller gets an answer — real coords or null — within timeoutMs.
function getCurrentPositionSafe(onResult, timeoutMs = 8000) {
  if (!navigator.geolocation) { onResult(null); return; }
  let done = false;
  const finish = (coords) => {
    if (done) return;
    done = true;
    onResult(coords);
  };
  const fallback = setTimeout(() => finish(null), timeoutMs + 2000);
  navigator.geolocation.getCurrentPosition(
    (pos) => { clearTimeout(fallback); finish({ lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }); },
    () => { clearTimeout(fallback); finish(null); },
    { timeout: timeoutMs }
  );
}

// Where each role should land on login/session-restore, matching the tab
// each one actually opens the app to do first — a manager reviews the
// business, a supervisor checks the team, a rep goes straight to logging
// a visit. Kept in sync with the nav order below (App() render).
function defaultTabFor(role, isSupervisor) {
  if (role === "manager") return "dashboard";
  if (isSupervisor) return "performance";
  return "checkin";
}

// ---------- main app ----------
export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [role, setRole] = useState("manager");
  const [repName, setRepName] = useState("");
  const [isSupervisor, setIsSupervisor] = useState(false);
  const [tab, setTab] = useState("expiry");
  // "Reference" tier — Products/Clients/Doctors — loaded once at login, then
  // refreshed on a slow timer (see REFERENCE_POLL_INTERVAL_MS below), not
  // the fast 30s poll. These are needed broadly for search/autocomplete but
  // tolerate being a few minutes stale.
  const [products, setProducts] = useState([]);
  const [clients, setClients] = useState([]);
  const [doctors, setDoctors] = useState([]);
  // "Live" tier — small, polled every 30s as before.
  const [repNames, setRepNames] = useState([]);
  const [offers, setOffers] = useState([]);
  const [competitors, setCompetitors] = useState([]);
  const [myLastPunch, setMyLastPunch] = useState(null);
  const [todayOutreachCount, setTodayOutreachCount] = useState(0);
  const [settings, setSettings] = useState({
    slowThreshold: 15, repPhone: "", dailyTarget: 3, monthlyVisitTarget: 60, monthlyRevenueTarget: 10000, templates: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [loadError, setLoadError] = useState("");

  const settingsDirtyRef = useRef(false);
  const settingsDebounceRef = useRef(null);

  useEffect(() => {
    api.getSession()
      .then((data) => { setRole(data.role); setRepName(data.repName || ""); setIsSupervisor(!!data.isSupervisor); setTab(defaultTabFor(data.role, !!data.isSupervisor)); setAuthState("in"); })
      .catch(() => setAuthState("out"));
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* cookie is cleared client-side regardless */ }
    setAuthState("out");
  };

  const refreshLive = useCallback(async (opts) => {
    try {
      const data = await api.bootstrap(opts);
      setRepNames(data.repNames || []);
      setOffers(data.offers || []);
      setCompetitors(data.competitors || []);
      setMyLastPunch(data.myLastPunch || null);
      setTodayOutreachCount(data.todayOutreachCount || 0);
      if (!settingsDirtyRef.current) setSettings(data.settings);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Products/Clients/Doctors are needed broadly for search/autocomplete but
  // tolerate being a few minutes stale — fetched once at login, then on this
  // much slower interval instead of the 30s live poll, so an Excel import
  // into any of them doesn't get re-downloaded by every open session every
  // 30 seconds.
  const REFERENCE_POLL_INTERVAL_MS = 5 * 60 * 1000;
  const refreshReference = useCallback(async (opts) => {
    try {
      const data = await api.bootstrapReference(opts);
      setProducts(data.products || []);
      setClients(data.clients || []);
      setDoctors(data.doctors || []);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => {
    if (authState !== "in") return;
    refreshLive();
    const id = setInterval(refreshLive, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshLive, authState]);

  useEffect(() => {
    if (authState !== "in") return;
    refreshReference();
    const id = setInterval(refreshReference, REFERENCE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshReference, authState]);

  const withSync = useCallback(async (fn, { touchesReference = false } = {}) => {
    setSyncStatus("saving");
    try {
      const result = await fn();
      // Skip the cache — the person who just wrote should see it immediately.
      await refreshLive({ fresh: true });
      if (touchesReference) await refreshReference({ fresh: true });
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus(""), 1200);
      return result;
    } catch (e) {
      setSyncStatus("error");
      setLoadError(e.message);
      // A failure here doesn't always mean the write didn't happen — a
      // timed-out or dropped request can still have gone through
      // server-side (Punch In succeeding but the confirmation getting
      // lost is exactly this). Re-syncing even on failure means the app
      // catches up with reality on its own instead of getting stuck
      // showing a stale "not punched in" gate forever.
      refreshLive({ fresh: true }).catch(() => {});
      // Rethrown so the many callers written with their own try/catch or
      // .catch() (Punch In's error message, a form's inline validation
      // error, etc.) actually fire — swallowing it here meant those were
      // silently dead code and a failed action could look like it worked.
      throw e;
    }
  }, [refreshLive, refreshReference]);

  // Retries visits that got queued locally because GPS wasn't available at
  // the time (see PENDING_VISITS_KEY) — tries again on a timer and whenever
  // the browser comes back online. Only runs while this tab is open; it's
  // not a background-sync service worker, so a rep needs to reopen the app
  // at some point after regaining signal for the queue to actually flush.
  const [pendingVisitCount, setPendingVisitCount] = useState(() => loadPendingVisits().length);

  const queueVisitOffline = useCallback((visit) => {
    const pending = loadPendingVisits();
    pending.push(visit);
    savePendingVisits(pending);
    setPendingVisitCount(pending.length);
  }, []);

  useEffect(() => {
    if (authState !== "in" || role !== "rep") return;
    const trySyncPendingVisits = async () => {
      const pending = loadPendingVisits();
      if (pending.length === 0) return;
      const remaining = [];
      for (const v of pending) {
        const coords = await new Promise((resolve) => getCurrentPositionSafe(resolve));
        if (!coords) { remaining.push(v); continue; }
        try {
          await api.addVisit({ ...v, coords });
        } catch (e) {
          remaining.push(v);
        }
      }
      savePendingVisits(remaining);
      setPendingVisitCount(remaining.length);
      if (remaining.length !== pending.length) {
        refreshLive({ fresh: true });
        refreshReference({ fresh: true }); // a synced visit can silently set assignedRep server-side
      }
    };
    trySyncPendingVisits();
    const id = setInterval(trySyncPendingVisits, 30000);
    window.addEventListener("online", trySyncPendingVisits);
    return () => { clearInterval(id); window.removeEventListener("online", trySyncPendingVisits); };
  }, [authState, role, refreshLive, refreshReference]);

  const updateSettingsField = useCallback((patch) => {
    settingsDirtyRef.current = true;
    setSettings((prev) => ({ ...prev, ...patch }));
    clearTimeout(settingsDebounceRef.current);
    settingsDebounceRef.current = setTimeout(async () => {
      setSyncStatus("saving");
      try {
        await api.updateSettings(patch);
        setSyncStatus("saved");
        setTimeout(() => setSyncStatus(""), 1200);
      } catch (e) {
        setSyncStatus("error");
      } finally {
        settingsDirtyRef.current = false;
      }
    }, 700);
  }, []);

  const todayStr = new Date().toISOString().slice(0, 10);
  const removeProduct = (id) => withSync(() => api.removeProduct(id), { touchesReference: true });
  const bulkImportProducts = (products) => withSync(() => api.importBulkProducts(products), { touchesReference: true });
  const addVisit = (visit) => withSync(() => api.addVisit(visit), { touchesReference: true }); // can silently set a client's assignedRep server-side
  const removeVisit = (id) => withSync(() => api.removeVisit(id));
  const punch = (type, coords) => withSync(() => api.punch(type, coords));
  const createOrder = (order) => withSync(() => api.createOrder(order));
  const addClient = (client) => withSync(() => api.addClient(client), { touchesReference: true });
  const removeClient = (id) => withSync(() => api.removeClient(id), { touchesReference: true });
  const bulkImportClients = (payload) => withSync(() => api.importClientsBulk(payload), { touchesReference: true });
  const assignClientRep = (id, assignedRep) => withSync(() => api.assignClientRep(id, assignedRep), { touchesReference: true });
  const updateClientDiscount = (id, discountRate) => withSync(() => api.updateClientDiscount(id, discountRate), { touchesReference: true });
  const completeClientInfo = (id, patch) => withSync(() => api.completeClientInfo(id, patch), { touchesReference: true });
  const completeDoctorInfo = (id, patch) => withSync(() => api.completeDoctorInfo(id, patch), { touchesReference: true });
  const addDoctor = (doctor) => withSync(() => api.addDoctor(doctor), { touchesReference: true });
  const removeDoctor = (id) => withSync(() => api.removeDoctor(id), { touchesReference: true });
  const bulkImportDoctors = (payload) => withSync(() => api.importDoctorsBulk(payload), { touchesReference: true });
  const logOutreach = (entry) => withSync(() => api.logOutreach(entry));
  const deleteOrder = (id) => withSync(() => api.deleteOrder(id));
  const requestDeleteOrder = (id) => withSync(() => api.requestDeleteOrder(id));
  const approveDeleteOrder = (id) => withSync(() => api.approveDeleteOrder(id));
  const denyDeleteOrder = (id) => withSync(() => api.denyDeleteOrder(id));
  const addOffer = (offer) => withSync(() => api.addOffer(offer));
  const toggleOfferActive = (id, active) => withSync(() => api.updateOffer(id, { active }));
  const removeOffer = (id) => withSync(() => api.removeOffer(id));
  const addCompetitor = (competitor) => withSync(() => api.addCompetitor(competitor));
  const updateCompetitor = (id, patch) => withSync(() => api.updateCompetitor(id, patch));
  const removeCompetitor = (id) => withSync(() => api.removeCompetitor(id));
  const addCompetitorProduct = (product) => withSync(() => api.addCompetitorProduct(product));
  const updateCompetitorProduct = (id, patch) => withSync(() => api.updateCompetitorProduct(id, patch));
  const removeCompetitorProduct = (id) => withSync(() => api.removeCompetitorProduct(id));
  const importCompetitorProductsBulk = (products) => withSync(() => api.importCompetitorProductsBulk(products));
  const addVisitComment = (visitId, text) => withSync(() => api.addVisitComment(visitId, text));

  const zoned = products.map((p) => ({ ...p, zone: zoneFor(p), slowMover: isSlowMover(p, settings.slowThreshold), atRisk: isAtRisk(p) }));
  const sorted = [...zoned].sort((a, b) => daysUntil(a.expiry) - daysUntil(b.expiry));

  if (authState === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAF7F2" }}>
        <Loader2 size={22} className="spin" color="#8A8272" />
      </div>
    );
  }

  if (authState === "out") {
    return <LoginView onSuccess={(r, rn, sup) => { setRole(r); setRepName(rn || ""); setIsSupervisor(!!sup); setTab(defaultTabFor(r, !!sup)); setAuthState("in"); }} />;
  }

  // Derived from myLastPunch (the current rep's own last punch row — see
  // buildLiveBootstrapPayload server-side) rather than scanning a full team
  // punch history. A punch-out the system auto-recorded (missed by the
  // rep, or by the scheduled 9pm Beirut auto-close — see
  // checkMissedPunchOuts server-side) is just accepted as-is: there used to
  // be a confirm-or-correct step required before punching in again, but it
  // checked the rep's *entire* punch history server-side while only ever
  // showing a confirm screen for the single latest row client-side — an
  // older unconfirmed entry left some reps permanently stuck with an error
  // the UI had no way to resolve. Removed entirely; punch-in is simply
  // allowed whenever the rep isn't already punched in today.
  const punchedInToday = myLastPunch?.type === "in" && new Date(myLastPunch.time).toDateString() === new Date().toDateString();
  if (loaded && role === "rep" && !punchedInToday) {
    return <PunchInGate repName={repName} onPunch={punch} onLogout={logout} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#FAF7F2", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: "#1F2A24" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        .kb-font-display { font-family: 'Fraunces', serif; }
        .kb-font-mono { font-family: 'IBM Plex Mono', monospace; }
        button { font-family: inherit; cursor: pointer; }
        input, textarea, select { font-family: inherit; }
        ::placeholder { color: #9CA3AF; }
        .spin { animation: kb-spin 1s linear infinite; }
        @keyframes kb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <header style={{ borderBottom: "1px solid #E5DFD3", padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="kb-font-display" style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>KayBee Field Tracker</div>
          <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
            {syncStatus === "saving" ? "syncing…" : syncStatus === "saved" ? "✓ synced" : syncStatus === "error" ? "⚠ sync error, will retry" : "expiry · routes · visits"}
          </div>
          {pendingVisitCount > 0 && (
            <div style={{ fontSize: 11, color: "#C17817", marginTop: 2 }}>
              ⏳ {pendingVisitCount} visit{pendingVisitCount === 1 ? "" : "s"} waiting for GPS/signal to sync
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#5B5445", background: "#F0EBE0", borderRadius: 8, padding: "9px 16px" }}>
            {role === "manager" ? "Manager" : repName ? `Med Rep · ${repName}${isSupervisor ? " (Supervisor)" : ""}` : "Med Rep"}
          </span>
          <button onClick={logout} style={{ fontSize: 12, color: "#8A8272", background: "none", border: "1px solid #E5DFD3", borderRadius: 8, padding: "9px 12px" }}>
            Log out
          </button>
        </div>
      </header>

      {/* Ordered by when it gets used in the workday, not by role — the same
          list serves all three roles at once because each role's own tabs
          just fall out of the existing visibility gates below:
            manager:    Dashboard, Performance, Orders, Locations, Outreach,
                        Broadcast, Stock, Expiry, Pharmacies, Doctors,
                        Competitors, Knowledge, Training, Settings
            supervisor: Performance, Orders, Locations, Check-In, Stock,
                        Expiry, Pharmacies, Competitors, Knowledge
            rep:        Check-In, Route, Stock, Expiry, Pharmacies, Doctors,
                        Competitors, Knowledge, Training
          Keep this comment's per-role lists in sync with defaultTabFor()
          above and with any future visibility-gate change. */}
      <nav style={{ display: "flex", gap: 4, padding: "12px 24px 0", borderBottom: "1px solid #E5DFD3", overflowX: "auto" }}>
        {role === "manager" && <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={<LayoutDashboard size={15} />} label="Dashboard" />}
        {(role === "manager" || isSupervisor) && <TabBtn active={tab === "performance"} onClick={() => setTab("performance")} icon={<Target size={15} />} label="Performance" />}
        {(role === "manager" || isSupervisor) && <TabBtn active={tab === "orders"} onClick={() => setTab("orders")} icon={<ShoppingCart size={15} />} label="Orders" />}
        {(role === "manager" || isSupervisor) && <TabBtn active={tab === "locations"} onClick={() => setTab("locations")} icon={<RadarIcon size={15} />} label="Locations" />}
        {role === "manager" && <TabBtn active={tab === "outreach"} onClick={() => setTab("outreach")} icon={<MessageCircle size={15} />} label="Outreach" />}
        {role === "manager" && <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")} icon={<Megaphone size={15} />} label="Broadcast" />}
        {role === "rep" && <TabBtn active={tab === "checkin"} onClick={() => setTab("checkin")} icon={<MapPin size={15} />} label="Check-In" />}
        {role === "rep" && !isSupervisor && <TabBtn active={tab === "route"} onClick={() => setTab("route")} icon={<Navigation size={15} />} label="Route" />}
        <TabBtn active={tab === "stock"} onClick={() => setTab("stock")} icon={<Boxes size={15} />} label="Stock" />
        <TabBtn active={tab === "expiry"} onClick={() => setTab("expiry")} icon={<Package size={15} />} label="Expiry Alerts" />
        <TabBtn active={tab === "clients"} onClick={() => setTab("clients")} icon={<Users size={15} />} label="Pharmacies" />
        {!isSupervisor && <TabBtn active={tab === "doctors"} onClick={() => setTab("doctors")} icon={<Stethoscope size={15} />} label="Doctors" />}
        {(role === "manager" || role === "rep") && <TabBtn active={tab === "cadence"} onClick={() => setTab("cadence")} icon={<History size={15} />} label="Visit Cadence" />}
        {(role === "manager" || role === "rep") && <TabBtn active={tab === "competitors"} onClick={() => setTab("competitors")} icon={<Swords size={15} />} label="Competitors" />}
        <TabBtn active={tab === "knowledge"} onClick={() => setTab("knowledge")} icon={<BookOpen size={15} />} label="Knowledge" />
        {!isSupervisor && <TabBtn active={tab === "training"} onClick={() => setTab("training")} icon={<GraduationCap size={15} />} label="Training" />}
        {role === "manager" && <TabBtn active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={15} />} label="Settings" />}
      </nav>

      <main style={{ padding: "24px", maxWidth: 900, margin: "0 auto" }}>
        {loadError && (
          <div style={{ background: "#FBF3F0", border: "1px solid #E5B8B0", color: "#7A3B3B", borderRadius: 8, padding: 12, fontSize: 12.5, marginBottom: 16 }}>
            Couldn't reach the server: {loadError}
          </div>
        )}
        {!loaded && !loadError && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#8A8272" }}>
            <Loader2 size={20} className="spin" /> Loading your team's data…
          </div>
        )}
        {loaded && (
          <>
            {tab === "expiry" && (
              <ExpiryView
                role={role}
                sorted={sorted}
                slowThreshold={settings.slowThreshold}
                repPhone={settings.repPhone}
                onRemove={removeProduct}
              />
            )}
            {tab === "checkin" && role === "rep" && (
              <CheckInView
                clients={clients}
                doctors={doctors}
                products={products}
                offers={offers}
                repName={repName}
                isSupervisor={isSupervisor}
                onAddVisit={addVisit}
                onCreateOrder={createOrder}
                onRequestDeleteOrder={requestDeleteOrder}
                onPunch={punch}
                onQueueOffline={queueVisitOffline}
                pendingVisitCount={pendingVisitCount}
                competitors={competitors}
                myLastPunch={myLastPunch}
              />
            )}
            {tab === "stock" && <StockView products={sorted} />}
            {tab === "clients" && (
              <ClientsView
                clients={clients}
                role={role}
                repName={repName}
                repNames={repNames}
                onAdd={addClient}
                onRemove={removeClient}
                onBulkImport={bulkImportClients}
                onAssignRep={assignClientRep}
                onUpdateDiscount={updateClientDiscount}
                onCompleteInfo={completeClientInfo}
              />
            )}
            {tab === "doctors" && !isSupervisor && (
              <DoctorsView
                doctors={doctors}
                role={role}
                onAdd={addDoctor}
                onRemove={removeDoctor}
                onBulkImport={bulkImportDoctors}
                onCompleteInfo={completeDoctorInfo}
              />
            )}
            {tab === "cadence" && (role === "manager" || role === "rep") && (
              <VisitCadenceView role={role} isSupervisor={isSupervisor} repNames={repNames} />
            )}
            {tab === "knowledge" && <KnowledgeView />}
            {tab === "training" && !isSupervisor && <TrainingView />}
            {tab === "route" && role === "rep" && !isSupervisor && <RouteView clients={clients} doctors={doctors} />}
            {tab === "dashboard" && role === "manager" && <DashboardView zoned={zoned} />}
            {tab === "orders" && (role === "manager" || isSupervisor) && (
              <OrdersTabView
                role={role}
                isSupervisor={isSupervisor}
                repNames={repNames}
                onDelete={deleteOrder}
                onApproveDelete={approveDeleteOrder}
                onDenyDelete={denyDeleteOrder}
              />
            )}
            {tab === "competitors" && (role === "manager" || role === "rep") && (
              <CompetitorsView
                canEdit={role === "manager"}
                competitors={competitors}
                onAdd={addCompetitor}
                onUpdate={updateCompetitor}
                onRemove={removeCompetitor}
                onAddProduct={addCompetitorProduct}
                onUpdateProduct={updateCompetitorProduct}
                onRemoveProduct={removeCompetitorProduct}
                onImportProducts={importCompetitorProductsBulk}
              />
            )}
            {tab === "locations" && (role === "manager" || isSupervisor) && (
              <LocationsView
                role={role}
                isSupervisor={isSupervisor}
                clients={clients}
                doctors={doctors}
                repNames={repNames}
                onRemoveVisit={removeVisit}
                onAddComment={addVisitComment}
              />
            )}
            {tab === "performance" && (role === "manager" || isSupervisor) && (
              <PerformanceView
                clients={clients}
                doctors={doctors}
                repNames={repNames}
                monthlyVisitTarget={settings.monthlyVisitTarget}
                setMonthlyVisitTarget={(v) => updateSettingsField({ monthlyVisitTarget: v })}
                monthlyRevenueTarget={settings.monthlyRevenueTarget}
                setMonthlyRevenueTarget={(v) => updateSettingsField({ monthlyRevenueTarget: v })}
                isSupervisor={isSupervisor}
              />
            )}
            {tab === "outreach" && role === "manager" && (
              <OutreachView
                dailyTarget={settings.dailyTarget}
                contactedToday={todayOutreachCount}
                templates={settings.templates}
                todayStr={todayStr}
                onLog={logOutreach}
              />
            )}
            {tab === "broadcast" && role === "manager" && <BroadcastView zoned={zoned} clients={clients} />}
            {tab === "settings" && role === "manager" && (
              <SettingsView
                role={role}
                slowThreshold={settings.slowThreshold} setSlowThreshold={(v) => updateSettingsField({ slowThreshold: v })}
                repPhone={settings.repPhone} setRepPhone={(v) => updateSettingsField({ repPhone: v })}
                dailyTarget={settings.dailyTarget} setDailyTarget={(v) => updateSettingsField({ dailyTarget: v })}
                templates={settings.templates} setTemplates={(v) => updateSettingsField({ templates: v })}
                onBulkImport={bulkImportProducts}
                productCount={products.length}
                onRepsChanged={refreshLive}
                offers={offers}
                onAddOffer={addOffer}
                onToggleOfferActive={toggleOfferActive}
                onRemoveOffer={removeOffer}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function LoginView({ onSuccess }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await api.login(passcode);
      onSuccess(data.role, data.repName, data.isSupervisor);
    } catch (err) {
      setError("Incorrect passcode.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAF7F2", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 16 }}>
      <form onSubmit={submit} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 12, padding: 28, width: "100%", maxWidth: 300 }}>
        <div className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>KayBee Field Tracker</div>
        <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>Enter your passcode to continue.</p>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          autoFocus
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 14, marginBottom: 10, background: "#FAF7F2" }}
        />
        {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
        <button
          type="submit"
          disabled={!passcode || loading}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", background: passcode && !loading ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 14, fontWeight: 500 }}
        >
          {loading ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

// Blocks the entire app behind a full-screen punch-in prompt for a rep who
// hasn't punched in yet today — no header, no nav, nothing else reachable —
// so the first thing that happens every day is a punch-in, not something a
// rep can scroll past or forget.
function PunchInGate({ repName, onPunch, onLogout }) {
  const [punching, setPunching] = useState(false);
  const [error, setError] = useState("");

  const doPunchIn = () => {
    setPunching(true);
    setError("");
    getCurrentPositionSafe((coords) => {
      onPunch("in", coords)
        .catch((e) => setError(e?.message || "Couldn't record punch. Try again."))
        .finally(() => setPunching(false));
    });
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAF7F2", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 16 }}>
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 14, padding: 32, width: "100%", maxWidth: 340, textAlign: "center" }}>
        <div className="kb-font-display" style={{ fontSize: 21, fontWeight: 600, marginBottom: 8 }}>
          Hi {repName || "there"} 👋
        </div>
        <p style={{ fontSize: 13.5, color: "#8A8272", marginBottom: 24 }}>
          Punch in to start your day — this unlocks the rest of the app.
        </p>
        <button
          onClick={doPunchIn}
          disabled={punching}
          style={{ width: "100%", padding: "14px 18px", borderRadius: 10, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 15, fontWeight: 600 }}
        >
          {punching ? "Punching in…" : "Punch in"}
        </button>
        {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginTop: 12 }}>{error}</div>}
        <button onClick={onLogout} style={{ marginTop: 18, fontSize: 11.5, color: "#8A8272", background: "none", border: "none" }}>
          Not you? Log out
        </button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "10px 14px",
      background: "none", border: "none", borderBottom: active ? "2px solid #C17817" : "2px solid transparent",
      color: active ? "#1F2A24" : "#8A8272", fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap",
    }}>
      {icon} {label}
    </button>
  );
}

// ---------- Expiry View ----------
const EXPIRY_ZONES = [
  { key: "red", label: "Red zone", sub: "Expires within 6 months", color: "#B33A3A" },
  { key: "yellow", label: "Yellow zone", sub: "Expires within a year", color: "#D9A441" },
  { key: "green", label: "PUSH SALES", sub: "Slow movers, more than a year out", color: "#4C7A5E" },
];

// The PUSH SALES tab isn't "everything more than a year out" — a healthy,
// fast-moving item that far from expiry doesn't need action. It's
// specifically green-zone items that are also slow-moving or at risk of not
// selling through, since those are the ones worth proactively pushing now,
// before they age into yellow/red.
const isPushSales = (p) => p.zone.key === "green" && (p.slowMover || p.atRisk);

const FOLLOWUP_PRESETS = [
  { key: "2d", label: "In 2 days" },
  { key: "3d", label: "In 3 days" },
  { key: "1w", label: "In 1 week" },
  { key: "2w", label: "In 2 weeks" },
  { key: "1m", label: "In 1 month" },
];

function ExpiryView({ role, sorted, slowThreshold, repPhone, onRemove }) {
  const [activeZone, setActiveZone] = useState("red");

  const visibleFor = (key) => (key === "green" ? sorted.filter(isPushSales) : sorted.filter((p) => p.zone.key === key));
  const counts = { red: visibleFor("red").length, yellow: visibleFor("yellow").length, green: visibleFor("green").length };
  const shown = visibleFor(activeZone);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          {role === "rep" ? "What needs clearing this month" : "Shelf-life overview"}
        </h2>
        <p style={{ fontSize: 13, color: "#8A8272", margin: "4px 0 0" }}>
          Tap a zone to see its items · slow-mover threshold {slowThreshold}% turnover/90d
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        {EXPIRY_ZONES.map((z) => {
          const active = activeZone === z.key;
          return (
            <button key={z.key} onClick={() => setActiveZone(z.key)} style={{
              flex: 1, minWidth: 150, textAlign: "left", padding: "12px 14px", borderRadius: 10,
              border: active ? `1px solid ${z.color}` : "1px solid #1F2A24",
              background: active ? z.color : "#fff", color: active ? "#FAF7F2" : "#1F2A24",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? "#FAF7F2" : z.color, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{z.label}</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{z.sub}</div>
              <div className="kb-font-mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{counts[z.key] || 0}</div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {shown.map((p) => (
          <ProductRow key={p.id} product={p} repPhone={repPhone} onRemove={() => onRemove(p.id)} />
        ))}
        {shown.length === 0 && <EmptyState text="No products in this zone." />}
      </div>
    </div>
  );
}

function ProductRow({ product, repPhone, onRemove }) {
  const dLeft = daysUntil(product.expiry);
  const turnover = turnoverPct(effectiveSold90(product), product.qty);
  const hasRealMovement = product.avgMonthlyMovement != null;
  const pct = lifecyclePct(product);
  const [showConfirm, setShowConfirm] = useState(false);

  const waMessage = encodeURIComponent(
    `Heads up: ${product.name} — ${dLeft} days to expiry (${fmtDate(product.expiry)}), ${product.qty} units in stock. Please prioritize clearing this.`
  );
  const waLink = repPhone ? `https://wa.me/${repPhone.replace(/\D/g, "")}?text=${waMessage}` : null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{product.name}</div>
          <div className="kb-font-mono" style={{ fontSize: 11.5, color: "#8A8272", marginTop: 2 }}>
            {product.category} · {product.qty} units · expires {fmtDate(product.expiry)}{product.price ? ` · price ${product.price.toFixed(2)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {product.atRisk && (
            <span title="Projected to not sell through before it expires, at current velocity" style={{ fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "#C178171A", color: "#C17817" }}>
              ⚠ At risk
            </span>
          )}
          {product.slowMover && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: "#6B72801A", color: "#6B7280" }}>
              Slow mover
            </span>
          )}
          <button onClick={() => setShowConfirm(true)} title="Remove" style={{ background: "none", border: "none", color: "#B7AF9E", padding: 2 }}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div style={{ position: "relative", height: 8, background: "#F0EBE0", borderRadius: 4, marginBottom: 10 }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: product.zone.color, borderRadius: 4, transition: "width .3s" }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="kb-font-mono" style={{ fontSize: 11.5, color: "#8A8272", display: "flex", gap: 14 }}>
          <span><Clock size={11} style={{ verticalAlign: -1 }} /> {dLeft >= 0 ? `${dLeft}d left` : `expired ${Math.abs(dLeft)}d ago`}</span>
          <span title={hasRealMovement ? "Based on uploaded monthly sales history" : "Based on last 90 days only — upload Stock Movement history for a real figure"}>
            <TrendingDown size={11} style={{ verticalAlign: -1 }} /> {turnover}% turnover/90d {hasRealMovement ? "(history)" : "(90d est.)"}
          </span>
        </div>
        {(product.zone.key === "red" || product.slowMover || product.atRisk) && waLink && (
          <a href={waLink} target="_blank" rel="noreferrer" style={{
            display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500,
            color: "#4C7A5E", textDecoration: "none", padding: "5px 10px", border: "1px solid #4C7A5E33", borderRadius: 6,
          }}>
            <Send size={12} /> Notify via WhatsApp
          </a>
        )}
      </div>

      {showConfirm && (
        <div style={{ marginTop: 10, padding: 10, background: "#FBF3F0", borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: "#7A3B3B" }}>Remove this product from the list?</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onRemove} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px" }}>Remove</button>
            <button onClick={() => setShowConfirm(false)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "5px 10px" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Stock View (rep + manager quick availability lookup) ----------
// Same product data as Expiry Alerts, shown as a flat searchable list
// instead of red/yellow/green zones — for "is this even in stock" checks
// that don't need the full expiry-urgency framing, e.g. while on a call
// with a pharmacy and not going through the order flow at all.
function StockView({ products }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  const categories = Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort();

  const q = search.toLowerCase().trim();
  const filtered = products
    .filter((p) => category === "all" || p.category === category)
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = filtered.slice(0, LIST_DISPLAY_CAP);

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Stock</h2>
      <p style={{ fontSize: 13, color: "#8A8272", margin: "0 0 16px" }}>
        Quick lookup of what's in stock right now — handy even when you're not placing an order.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 2, minWidth: 200 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by product name…"
            style={{ ...inputStyle, paddingLeft: 34 }}
          />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 160 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 10 }}>
        {filtered.length} item{filtered.length === 1 ? "" : "s"}{category !== "all" ? ` in ${category}` : ""}{q ? ` matching "${search}"` : ""}
      </div>

      {shown.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#8A8272", fontSize: 11.5 }}>
                <th style={{ padding: "6px 8px" }}>Item</th>
                <th style={{ padding: "6px 8px" }}>Category</th>
                <th style={{ padding: "6px 8px" }}>Qty</th>
                <th style={{ padding: "6px 8px" }}>Price</th>
                <th style={{ padding: "6px 8px" }}>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #E5DFD3" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 500 }}>{p.name}</td>
                  <td style={{ padding: "6px 8px", color: "#8A8272" }}>{p.category || "-"}</td>
                  <td style={{ padding: "6px 8px", fontWeight: 600, color: p.qty > 0 ? "#4C7A5E" : "#B33A3A" }}>
                    {p.qty > 0 ? p.qty : "Out of stock"}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{p.price ? p.price.toFixed(2) : "-"}</td>
                  <td className="kb-font-mono" style={{ padding: "6px 8px", color: p.zone?.color || "#8A8272" }}>{fmtDate(p.expiry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState text="No products match." />
      )}
      {filtered.length > LIST_DISPLAY_CAP && (
        <div style={{ fontSize: 12, color: "#8A8272", marginTop: 10 }}>
          Showing the first {LIST_DISPLAY_CAP} of {filtered.length.toLocaleString()} — narrow your search to see more.
        </div>
      )}
    </div>
  );
}

// Lets a rep fill in gaps on an existing pharmacy/doctor record (phone,
// address, registration number, ...) without being able to touch fields
// that already have a value — that still requires a manager. `fields` is
// [{key, label}] for whichever fields are currently blank on this record.
function CompleteInfoForm({ fields, onSave, onCancel }) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const hasAny = Object.values(values).some((v) => v && v.trim());

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(values);
      onCancel();
    } catch (e) {
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 8, padding: 10, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              value={values[f.key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              style={inputStyle}
            />
          </Field>
        ))}
      </div>
      {error && <div style={{ fontSize: 11.5, color: "#B33A3A", marginBottom: 6 }}>{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button disabled={!hasAny || saving} onClick={save} style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, border: "none", background: hasAny ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontWeight: 500 }}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff" }}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };

// Replaces native <input list="..."><datalist> search boxes, which is what
// was actually making pharmacy/product search feel slow — not the
// filtering itself (a plain JS .filter() over even a few thousand rows
// takes a few milliseconds), but two things a native datalist forces:
// (1) the browser's own suggestion popup, which measurably lags on mobile
// (especially mid-range Android) every time its option list changes, and
// (2) every keystroke immediately updating the parent's state, which for
// a big field like this one (client, matchedClient, otherRepWarning, etc.
// all re-derived) re-runs a lot of otherwise-unrelated work in the parent
// component on every single character typed.
// This fixes both: the dropdown is plain React-rendered DOM (no native
// popup), filtering is memoized and capped, and the parent only gets the
// committed value on an explicit pick or shortly after typing pauses
// (COMMIT_DEBOUNCE_MS) — not on every keystroke — while the input itself
// stays fully local, so typing never waits on the parent's re-render.
const SEARCHABLE_SELECT_MAX_RESULTS = 8;
const SEARCHABLE_SELECT_COMMIT_DEBOUNCE_MS = 150;
function SearchableSelect({ value, onChange, options, getLabel, placeholder, style, onFocus }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const commitTimerRef = useRef(null);

  // Keeps the field in sync when the parent resets it from elsewhere (e.g.
  // switching the Pharmacy/Doctor toggle clears `client`) without fighting
  // the debounce above — only applies when the parent's value actually
  // diverges from what's locally typed.
  useEffect(() => { if (value !== query) setQuery(value || ""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value]);

  const q = query.toLowerCase().trim();
  const matches = useMemo(
    () => (q ? options.filter((o) => getLabel(o).toLowerCase().includes(q)) : options),
    [q, options, getLabel]
  );
  const shown = matches.slice(0, SEARCHABLE_SELECT_MAX_RESULTS);

  useEffect(() => {
    const onOutside = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, []);
  useEffect(() => () => clearTimeout(commitTimerRef.current), []);

  const scheduleCommit = (text) => {
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => onChange(text), SEARCHABLE_SELECT_COMMIT_DEBOUNCE_MS);
  };
  // If a rep types the exact value by hand (skipping the dropdown) and
  // immediately taps another button — "Add item", "Save visit" — that
  // click must never race ahead of the debounced commit above and see a
  // stale (empty) parent value. A button click blurs this input first, so
  // flushing here guarantees the parent is caught up before that button's
  // own handler runs.
  const flushPendingCommit = () => {
    if (!commitTimerRef.current) return;
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    onChange(query);
  };

  const pick = (o) => {
    const label = getLabel(o);
    clearTimeout(commitTimerRef.current);
    setQuery(label);
    onChange(label);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); scheduleCommit(e.target.value); }}
        onFocus={() => { setOpen(true); onFocus?.(); }}
        onBlur={flushPendingCommit}
        placeholder={placeholder}
        style={style}
        autoComplete="off"
      />
      {open && shown.length > 0 && (
        <div style={{
          position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 4,
          background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, maxHeight: 280,
          overflowY: "auto", boxShadow: "0 6px 18px rgba(31,42,36,0.12)",
        }}>
          {shown.map((o, i) => (
            <button
              key={getLabel(o) + i}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "9px 12px",
                background: "none", border: "none", borderBottom: i < shown.length - 1 ? "1px solid #F0EBE0" : "none",
                fontSize: 13, cursor: "pointer", color: "#1F2A24",
              }}
            >
              {getLabel(o)}
            </button>
          ))}
          {matches.length > shown.length && (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "#8A8272" }}>
              +{matches.length - shown.length} more — keep typing to narrow it down
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Every rep's own read-only visit history, reached from Check-In. Replaces
// the old "View my visits sheet" link's role for reps who were never given
// a Google Sheet export (that required a manager to manually create one
// per rep) — this works for everyone immediately, no setup. Self-fetching,
// scoped to the logged-in rep only (never another rep's visits), capped at
// the same 200-row limit GET /api/visits already enforces — no delete/edit
// actions, purely a lookup.
function MyVisitsView({ repName, onClose }) {
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setLoading(true);
    api.getVisits({ repName, limit: 200 })
      .then((data) => setVisits(data.visits || []))
      .catch(() => setVisits([]))
      .finally(() => setLoading(false));
  }, [repName]);

  const filtered = query.trim()
    ? visits.filter((v) => v.client.toLowerCase().includes(query.toLowerCase().trim()))
    : visits;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>My visits</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A8272", cursor: "pointer" }}><X size={16} /></button>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by pharmacy/doctor name…"
        style={{ ...inputStyle, marginBottom: 10 }}
      />
      {loading && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}
      {!loading && filtered.length === 0 && <EmptyState text={query ? "No visits match that search." : "No visits logged yet."} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflowY: "auto" }}>
        {filtered.map((v) => (
          <div key={v.id} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{v.client}</span>
              <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>
                {new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}{" "}
                {new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {v.notes && (
              <div style={{ fontSize: 12, marginTop: 4 }}><strong style={{ color: "#8A8272", fontWeight: 600 }}>Notes: </strong>{v.notes}</div>
            )}
            {v.mentionedItems && v.mentionedItems.length > 0 && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <strong style={{ color: "#8A8272", fontWeight: 600 }}>Items discussed: </strong>
                {v.mentionedItems.map((it) => it.name).join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
      {visits.length >= 200 && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 8 }}>Showing your 200 most recent visits.</div>}
    </div>
  );
}

function BackStepButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#5B5445", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer" }}
    >
      ← Back
    </button>
  );
}

// ---------- Check-In View (rep) ----------
function CheckInView({ clients, doctors, products, offers, repName, isSupervisor, onAddVisit, onCreateOrder, onRequestDeleteOrder, onPunch, onQueueOffline, pendingVisitCount, competitors, myLastPunch }) {
  const [punching, setPunching] = useState(false);
  const [punchError, setPunchError] = useState("");
  const [entityType, setEntityType] = useState("pharmacy"); // pharmacy | doctor
  const [client, setClient] = useState("");
  const [notes, setNotes] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const [lastVisit, setLastVisit] = useState(null);
  // The visit-logging flow is one step at a time instead of one long
  // scrolling page: checkin -> orderPrompt -> order (only if "yes") ->
  // followup -> done. Punch in/out and the reference lists below (today's
  // visits, recent orders) sit outside this flow since they aren't part of
  // logging any one specific visit.
  const [step, setStep] = useState("checkin");
  // Tracks the actual path taken through the wizard (not a fixed step
  // order — "No, no order" skips straight past order/sample, so "back"
  // has to return to wherever this specific visit actually came from, not
  // just "the previous entry in a fixed list"). A ref, not state — it's
  // pure bookkeeping for goBack() and never drives its own render.
  const stepHistoryRef = useRef([]);
  const goToStep = (next) => { stepHistoryRef.current.push(step); setStep(next); };
  // Never steps back onto "checkin" — that form was already submitted
  // (the visit is saved by the time any later step exists), so re-showing
  // it with the same fields still filled in risks creating a second,
  // duplicate visit if "Save visit" gets tapped again. A doctor visit
  // reaches "followup" directly from "checkin" (no order/sample steps in
  // between), so this guard is what makes Back a no-op there specifically,
  // rather than only on the pharmacy path where it's obviously needed.
  const canGoBack = stepHistoryRef.current.length > 0 && stepHistoryRef.current[stepHistoryRef.current.length - 1] !== "checkin";
  const goBack = () => {
    if (!canGoBack) return;
    setStep(stepHistoryRef.current.pop());
  };
  const [followUpStatus, setFollowUpStatus] = useState(null); // null | "set" | "stopped"
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [followUpError, setFollowUpError] = useState("");
  const [customFollowUpDays, setCustomFollowUpDays] = useState("");
  const [showStopFollowUp, setShowStopFollowUp] = useState(false);
  const [stopFollowUpReason, setStopFollowUpReason] = useState("");
  const [exportSheetId, setExportSheetId] = useState("");
  const [showMyVisits, setShowMyVisits] = useState(false);
  const [mentionedItems, setMentionedItems] = useState([]);
  const [itemQuery, setItemQuery] = useState("");
  const [sampleMenuFor, setSampleMenuFor] = useState(null);
  const [sawCompetitor, setSawCompetitor] = useState(false);
  const [competitorName, setCompetitorName] = useState("");
  const [competitorNotes, setCompetitorNotes] = useState("");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  // Own-scoped, on-demand replacements for what used to come out of the
  // global visits/orders bootstrap arrays — fetched here, refetched after
  // whatever action would change them, instead of held in App() state.
  const [todayVisits, setTodayVisits] = useState([]);
  const [recentOrders, setRecentOrders] = useState([]);
  // recentOrders is capped at 10 and isn't date-scoped — fine for the
  // "Your recent orders" reference list below, but wrong for "does this
  // visit already have an order": on any day busier than 10 orders total,
  // an earlier visit's order silently falls outside that window and the
  // Today's Visits panel would wrongly show "+ Add order" for a visit that
  // already has one, risking a duplicate. This is its own fetch, scoped to
  // today specifically with a limit no real day comes close to.
  const [todayOrders, setTodayOrders] = useState([]);
  const loadTodayOrders = useCallback(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    api.getOrders({ repName, from: todayStr, to: todayStr, limit: 100 })
      .then((data) => setTodayOrders(data.orders || []))
      .catch(() => {});
  }, [repName]);
  useEffect(() => { loadTodayOrders(); }, [loadTodayOrders]);
  // A rep who forgot to add an order or a sample mid-visit can go back into
  // any of today's own visits and add it after the fact — reuses the exact
  // same OrderBuilder / PharmacySampleStep already used inline in the
  // wizard above, just launched from here instead. Never lets them touch
  // an order that already exists (that's the separate request-delete flow)
  // — this is purely "add what's missing," nothing else.
  const [expandedTodayVisitId, setExpandedTodayVisitId] = useState(null);
  const [addingOrderForVisitId, setAddingOrderForVisitId] = useState(null);
  const [addingSampleForVisitId, setAddingSampleForVisitId] = useState(null);
  const [samplesByVisitId, setSamplesByVisitId] = useState({});

  const loadSamplesForVisit = (visitId) => {
    api.getSamples({ visitId }).then((data) => {
      setSamplesByVisitId((prev) => ({ ...prev, [visitId]: data.samples || [] }));
    }).catch(() => {});
  };
  const toggleTodayVisit = (v) => {
    const opening = expandedTodayVisitId !== v.id;
    setExpandedTodayVisitId(opening ? v.id : null);
    if (opening && samplesByVisitId[v.id] === undefined) loadSamplesForVisit(v.id);
  };

  const loadTodayVisits = useCallback(() => {
    api.getVisits({ repName, limit: 50 })
      .then((data) => {
        const todayStr = new Date().toDateString();
        setTodayVisits((data.visits || []).filter((v) => new Date(v.time).toDateString() === todayStr));
      })
      .catch(() => {});
  }, [repName]);
  const loadRecentOrders = useCallback(() => {
    api.getOrders({ repName, limit: 10 }).then((data) => setRecentOrders(data.orders || [])).catch(() => {});
  }, [repName]);
  useEffect(() => { loadTodayVisits(); }, [loadTodayVisits]);
  useEffect(() => { loadRecentOrders(); }, [loadRecentOrders]);

  useEffect(() => {
    api.getMyExportSheet().then((data) => setExportSheetId(data.exportSheetId || "")).catch(() => {});
  }, []);

  const SpeechRecognitionClass = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  const toggleDictation = () => {
    if (!SpeechRecognitionClass) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new SpeechRecognitionClass();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(" ");
      setNotes((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const NOTE_TEMPLATES = [
    "No stock issues", "Requested pricing follow-up", "Price objection raised",
    "Competitor product in use", "Out of office, reschedule", "Placed reorder",
  ];
  const appendTemplate = (t) => setNotes((prev) => (prev ? `${prev}. ${t}` : t));

  // Filtering/capping now happens inside SearchableSelect itself (memoized,
  // decoupled from this component's re-renders) — this is just which raw
  // list it searches.
  const nameOptionsSource = entityType === "pharmacy" ? clients : doctors;

  // Pharmacies are auto-assigned to whichever rep logs their first visit.
  // If this one already belongs to someone else, flag it before the rep
  // submits — visiting another rep's pharmacy is sometimes legitimate
  // (covering, shared territory) but should never happen silently.
  const matchedClient = entityType === "pharmacy"
    ? clients.find((c) => c.name.toLowerCase().trim() === client.toLowerCase().trim())
    : null;
  const otherRepWarning = matchedClient && matchedClient.assignedRep && matchedClient.assignedRep !== repName
    ? matchedClient.assignedRep
    : null;

  // A visit must point at a real Pharmacies/Doctors record, not just
  // whatever string got typed — otherwise it logs against a name with no
  // tier, address, or assigned rep behind it. New clients get added
  // properly (with full details) via their own tab, not invented here.
  const matchedEntity = entityType === "pharmacy"
    ? matchedClient
    : doctors.find((d) => d.name.toLowerCase().trim() === client.toLowerCase().trim());
  const unknownEntity = client.trim().length > 0 && !matchedEntity;

  // The last couple of visits to whoever's just been picked — a memory
  // refresher right in the flow so a rep isn't walking in blind on what was
  // discussed or promised last time, without having to leave Check-In first.
  // Fetched on demand per matched entity instead of scanning a full visits
  // history held in state — the server already sorts newest-first.
  const [recentVisitsForEntity, setRecentVisitsForEntity] = useState([]);
  useEffect(() => {
    if (!matchedEntity) { setRecentVisitsForEntity([]); return; }
    api.getVisits({ client: matchedEntity.name, limit: 3 })
      .then((data) => setRecentVisitsForEntity(data.visits || []))
      .catch(() => setRecentVisitsForEntity([]));
  }, [matchedEntity?.name]);

  // Cross-checks the GPS just captured against the pharmacy/doctor's own
  // saved location, if it has one — this is how you'd know a rep's check-in
  // GPS actually matches the place they say they visited, not just that
  // some GPS was captured.
  const locationMismatchKm = coords && matchedEntity?.coordsLat && matchedEntity?.coordsLng
    ? haversineKm(Number(coords.lat), Number(coords.lng), Number(matchedEntity.coordsLat), Number(matchedEntity.coordsLng))
    : null;
  const locationMismatch = locationMismatchKm !== null && locationMismatchKm > LOCATION_MISMATCH_KM;

  const matchedItem = products.find((p) => p.name.toLowerCase().trim() === itemQuery.toLowerCase().trim());
  // Filtered + capped like nameOptions above — with hundreds/thousands of
  // products, dumping every single one into the datalist on every render
  // (previously unfiltered) is what made typing here feel laggy.
  const itemOptions = (itemQuery.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(itemQuery.toLowerCase().trim()))
    : products
  ).slice(0, 50);
  const addMentionedItem = () => {
    if (!matchedItem || mentionedItems.some((it) => it.productId === matchedItem.id)) return;
    setMentionedItems((prev) => [...prev, { productId: matchedItem.id, name: matchedItem.name, sampleStatus: null }]);
    setItemQuery("");
  };
  const removeMentionedItem = (productId) => setMentionedItems((prev) => prev.filter((it) => it.productId !== productId));
  const setSampleStatus = (productId, status) => {
    setMentionedItems((prev) => prev.map((it) => (it.productId === productId ? { ...it, sampleStatus: status } : it)));
    setSampleMenuFor(null);
  };

  const lastPunch = myLastPunch;
  const isPunchedIn = lastPunch?.type === "in";

  const doPunch = (type) => {
    setPunching(true);
    setPunchError("");
    getCurrentPositionSafe((coords) => {
      onPunch(type, coords)
        .catch((e) => setPunchError(e?.message || "Couldn't record punch."))
        .finally(() => setPunching(false));
    });
  };

  const getLocation = () => {
    setLocating(true);
    setLocError("");
    getCurrentPositionSafe((coords) => {
      setLocating(false);
      if (coords) { setCoords(coords); return; }
      setLocError("Couldn't get location. Check permissions.");
    });
  };

  const [visitError, setVisitError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setVisitError("");
    setSaving(true);
    try {
      const visitClient = client;
      const created = await onAddVisit({
        client, notes, coords, mentionedItems,
        competitorName: sawCompetitor ? competitorName : "",
        competitorNotes: sawCompetitor ? competitorNotes : "",
      });
      setLastVisit(created || { client: visitClient });
      setClient(""); setNotes(""); setCoords(null); setMentionedItems([]); setItemQuery(""); setSampleMenuFor(null);
      setSawCompetitor(false); setCompetitorName(""); setCompetitorNotes("");
      setFollowUpStatus(null);
      setFollowUpError("");
      setCustomFollowUpDays("");
      setShowStopFollowUp(false);
      setStopFollowUpReason("");
      loadTodayVisits();
      // Doctors don't buy stock, and sample-giving is already captured
      // per-item above (in "Items mentioned") — so they skip straight to
      // scheduling a follow-up. Pharmacies still go on to the order question
      // first, then their own follow-up step later.
      goToStep(entityType === "pharmacy" ? "orderPrompt" : "followup");
    } catch (e) {
      setVisitError(e?.message || "Couldn't save the visit.");
    } finally {
      setSaving(false);
    }
  };

  // GPS genuinely isn't always available (indoors, dead zones) — rather
  // than leave the rep stuck with no way forward, this queues the visit
  // locally and finishes it later automatically once a fix comes through.
  // Order/sample steps aren't offered for these since there's no real
  // visit id yet to attach them to; the rep can note anything important in
  // the text notes instead, or check in again once it's synced.
  const saveOffline = () => {
    onQueueOffline({
      client, notes, mentionedItems,
      competitorName: sawCompetitor ? competitorName : "",
      competitorNotes: sawCompetitor ? competitorNotes : "",
      queuedAt: new Date().toISOString(),
    });
    setLastVisit({ client, pending: true });
    setClient(""); setNotes(""); setCoords(null); setMentionedItems([]); setItemQuery(""); setSampleMenuFor(null);
    setSawCompetitor(false); setCompetitorName(""); setCompetitorNotes("");
    setVisitError(""); setLocError("");
    setFollowUpStatus(null);
    setStep("done");
  };

  const scheduleFollowUp = async (presetKey) => {
    setFollowUpSaving(true);
    setFollowUpError("");
    try {
      await api.scheduleFollowUp({
        entityName: lastVisit.client,
        entityType,
        presetKey,
        visitId: lastVisit.id,
      });
      setFollowUpStatus("set");
      setStep("done");
    } catch (e) {
      setFollowUpError(e?.message || "Couldn't schedule follow-up.");
    } finally {
      setFollowUpSaving(false);
    }
  };

  const scheduleCustomFollowUp = async () => {
    const days = Number(customFollowUpDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setFollowUpError("Enter a whole number of days, between 1 and 365.");
      return;
    }
    setFollowUpSaving(true);
    setFollowUpError("");
    try {
      await api.scheduleFollowUp({
        entityName: lastVisit.client,
        entityType,
        days,
        visitId: lastVisit.id,
      });
      setFollowUpStatus("set");
      setStep("done");
    } catch (e) {
      setFollowUpError(e?.message || "Couldn't schedule follow-up.");
    } finally {
      setFollowUpSaving(false);
    }
  };

  // Persisted (unlike the old silent "skip"), with an optional reason, so
  // the manager/rep can later see why a pharmacy or doctor dropped off —
  // and so it counts toward visit-frequency history instead of vanishing.
  const stopFollowUp = async () => {
    setFollowUpSaving(true);
    setFollowUpError("");
    try {
      await api.stopFollowUp({
        entityName: lastVisit.client,
        entityType,
        reason: stopFollowUpReason.trim(),
        visitId: lastVisit.id,
      });
      setFollowUpStatus("stopped");
      setStep("done");
    } catch (e) {
      setFollowUpError(e?.message || "Couldn't save that.");
    } finally {
      setFollowUpSaving(false);
    }
  };

  const startNewVisit = () => {
    setLastVisit(null);
    setFollowUpStatus(null);
    setFollowUpError("");
    setVisitError("");
    setCustomFollowUpDays("");
    setShowStopFollowUp(false);
    setStopFollowUpReason("");
    stepHistoryRef.current = [];
    setStep("checkin");
  };

  // Pharmacies place orders, so they get order -> sample -> follow-up.
  // Doctors don't buy stock, and sample-giving is captured per-item right
  // in step 1, so they go straight from logging the visit to follow-up.
  const STEP_KEYS = entityType === "pharmacy"
    ? ["checkin", "orderPrompt", "order", "sample", "followup"]
    : ["checkin", "followup"];
  const STEP_INFO = entityType === "pharmacy" ? {
    checkin: { n: 1, title: "Log the visit" },
    orderPrompt: { n: 2, title: "Did they place an order?" },
    order: { n: 3, title: "Order details" },
    sample: { n: 4, title: "Did you give a sample?" },
    followup: { n: 5, title: "Schedule a follow-up" },
  } : {
    checkin: { n: 1, title: "Log the visit" },
    followup: { n: 2, title: "Schedule a follow-up" },
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Log a visit</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => setShowMyVisits((v) => !v)}
            style={{ fontSize: 12, color: "#5B5445", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}
          >
            {showMyVisits ? "Hide my visits" : "My Visits"}
          </button>
          {exportSheetId && (
            <a href={`https://docs.google.com/spreadsheets/d/${exportSheetId}/edit`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#4C7A5E", textDecoration: "none", border: "1px solid #4C7A5E33", borderRadius: 6, padding: "5px 10px" }}>
            View my visits sheet
          </a>
          )}
        </div>
      </div>

      {showMyVisits && <MyVisitsView repName={repName} onClose={() => setShowMyVisits(false)} />}

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10,
        background: isPunchedIn ? "#EFF6F1" : "#fff", border: `1px solid ${isPunchedIn ? "#4C7A5E55" : "#E5DFD3"}`, borderRadius: 10, padding: 14, marginBottom: 16,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {isPunchedIn ? "Punched in" : "Not punched in"}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 2 }}>
            {lastPunch
              ? `${isPunchedIn ? "Since" : "Last punched out at"} ${new Date(lastPunch.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
              : "Punch in when you start your day"}
          </div>
          {punchError && <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 4 }}>{punchError}</div>}
        </div>
        <button
          onClick={() => doPunch(isPunchedIn ? "out" : "in")}
          disabled={punching}
          style={{
            padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
            background: isPunchedIn ? "#B33A3A" : "#1F2A24", color: "#FAF7F2",
          }}
        >
          {punching ? "…" : isPunchedIn ? "Punch out" : "Punch in"}
        </button>
      </div>

      {step !== "done" && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#8A8272" }}>Step {STEP_INFO[step].n} of {STEP_KEYS.length}</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{STEP_INFO[step].title}</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
            {STEP_KEYS.map((s) => (
              <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: STEP_INFO[s].n <= STEP_INFO[step].n ? "#4C7A5E" : "#E5DFD3" }} />
            ))}
          </div>
        </>
      )}

      {step === "checkin" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button onClick={() => { setEntityType("pharmacy"); setClient(""); }} style={{
              flex: 1, padding: "8px 14px", borderRadius: 8, border: entityType === "pharmacy" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
              background: entityType === "pharmacy" ? "#4C7A5E" : "#fff", color: entityType === "pharmacy" ? "#FAF7F2" : "#1F2A24",
            }}>
              Pharmacy
            </button>
            <button onClick={() => { setEntityType("doctor"); setClient(""); }} style={{
              flex: 1, padding: "8px 14px", borderRadius: 8, border: entityType === "doctor" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
              background: entityType === "doctor" ? "#4C7A5E" : "#fff", color: entityType === "doctor" ? "#FAF7F2" : "#1F2A24",
            }}>
              Doctor
            </button>
          </div>

          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
            <Field label={entityType === "pharmacy" ? "Pharmacy name" : "Doctor name"}>
              <SearchableSelect
                value={client}
                onChange={setClient}
                options={nameOptionsSource}
                getLabel={(c) => c.name}
                placeholder={entityType === "pharmacy" ? "e.g. Pharmacie Al Nour" : "e.g. Dr. Nour Khalil"}
                style={{ ...inputStyle, marginBottom: 10 }}
              />
            </Field>
            {otherRepWarning && (
              <div style={{ background: "#FBF0F0", border: "1px solid #E5B8B0", color: "#7A3B3B", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 10, fontWeight: 500 }}>
                ⚠ {client} is assigned to <strong>{otherRepWarning}</strong> — you're about to visit another rep's pharmacy.
              </div>
            )}
            {unknownEntity && (
              <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", color: "#7A5B2E", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 10, fontWeight: 500 }}>
                ⚠ "{client}" isn't in the system yet. Go to the {entityType === "pharmacy" ? "Pharmacies" : "Doctors"} tab and add it there first (with full details{entityType === "pharmacy" ? ", including registration number" : ""}), then come back to check in.
              </div>
            )}
            {recentVisitsForEntity.length > 0 && (
              <div style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "#8A8272", marginBottom: 6 }}>Last time — a quick refresher</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {recentVisitsForEntity.map((v) => (
                    <div key={v.id} style={{ fontSize: 12 }}>
                      <span className="kb-font-mono" style={{ color: "#8A8272" }}>
                        {new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}{v.repName && v.repName !== repName ? ` · ${v.repName}` : ""}
                      </span>
                      {v.notes && <div>{v.notes}</div>}
                      {v.mentionedItems && v.mentionedItems.length > 0 && (
                        <div style={{ color: "#5B5445" }}><strong style={{ fontWeight: 600 }}>Discussed: </strong>{v.mentionedItems.map((it) => it.name).join(", ")}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Field label="Visit notes">
              <div style={{ position: "relative" }}>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was discussed, orders taken, objections…"
                  rows={3}
                  style={{ ...inputStyle, marginBottom: 8, resize: "vertical", paddingRight: 40 }}
                />
                {SpeechRecognitionClass && (
                  <button
                    type="button"
                    onClick={toggleDictation}
                    title={listening ? "Stop dictation" : "Dictate notes"}
                    style={{
                      position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: 6,
                      border: "1px solid #E5DFD3", background: listening ? "#B33A3A" : "#fff",
                      color: listening ? "#FAF7F2" : "#5B5445", fontSize: 13, lineHeight: 1,
                    }}
                  >
                    🎙
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {NOTE_TEMPLATES.map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => appendTemplate(t)}
                    style={{ fontSize: 11, padding: "4px 9px", borderRadius: 12, border: "1px solid #E5DFD3", background: "#FAF7F2", color: "#5B5445" }}
                  >
                    + {t}
                  </button>
                ))}
              </div>
            </Field>

            {entityType === "pharmacy" && (
              <Field label="Competitors">
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#5B5445", marginBottom: sawCompetitor ? 8 : 0 }}>
                  <input type="checkbox" checked={sawCompetitor} onChange={(e) => setSawCompetitor(e.target.checked)} />
                  Any competitor brands on the shelf here?
                </label>
                {sawCompetitor && (
                  <>
                    <input
                      value={competitorName}
                      onChange={(e) => setCompetitorName(e.target.value)}
                      placeholder="Who's the competitor? e.g. another vitamin brand"
                      list="checkin-competitor-options"
                      style={{ ...inputStyle, marginBottom: 8 }}
                    />
                    <datalist id="checkin-competitor-options">
                      {(competitors || []).map((c) => <option key={c.id} value={c.name} />)}
                    </datalist>
                    <input
                      value={competitorNotes}
                      onChange={(e) => setCompetitorNotes(e.target.value)}
                      placeholder="What are they offering? (price, terms, promo…)"
                      style={inputStyle}
                    />
                  </>
                )}
              </Field>
            )}

            {entityType === "doctor" && (
              <Field label="Items mentioned during visit">
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    value={itemQuery}
                    onChange={(e) => setItemQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMentionedItem(); } }}
                    placeholder="Search product…"
                    list="checkin-item-options"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <datalist id="checkin-item-options">
                    {itemOptions.map((p) => <option key={p.id} value={p.name} />)}
                  </datalist>
                  <button
                    type="button"
                    onClick={addMentionedItem}
                    disabled={!matchedItem}
                    style={{
                      padding: "8px 14px", borderRadius: 8, border: "none", whiteSpace: "nowrap",
                      background: matchedItem ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500,
                    }}
                  >
                    Add item
                  </button>
                </div>
                {mentionedItems.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                    {mentionedItems.map((it) => (
                      <div key={it.productId} style={{
                        display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, fontSize: 12,
                        background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 10, padding: "6px 8px 6px 10px",
                      }}>
                        <span style={{ fontWeight: 500 }}>{it.name}</span>

                        {it.sampleStatus === "gave" && (
                          <span style={{ fontSize: 10.5, color: "#4C7A5E", fontWeight: 600 }}>✓ Sample given</span>
                        )}
                        {it.sampleStatus === "next_visit" && (
                          <span style={{ fontSize: 10.5, color: "#C17817", fontWeight: 600 }}>→ Give next visit</span>
                        )}

                        {sampleMenuFor === it.productId ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button type="button" onClick={() => setSampleStatus(it.productId, "gave")} style={{ fontSize: 10.5, border: "none", background: "#4C7A5E", color: "#fff", borderRadius: 5, padding: "3px 8px", fontWeight: 500 }}>
                              Gave
                            </button>
                            <button type="button" onClick={() => setSampleStatus(it.productId, "next_visit")} style={{ fontSize: 10.5, border: "none", background: "#C17817", color: "#fff", borderRadius: 5, padding: "3px 8px", fontWeight: 500 }}>
                              Give next visit
                            </button>
                            <button type="button" onClick={() => setSampleMenuFor(null)} style={{ fontSize: 10.5, border: "1px solid #E5DFD3", background: "#fff", borderRadius: 5, padding: "3px 8px" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => setSampleMenuFor(it.productId)} style={{ fontSize: 10.5, border: "1px solid #D8D2C4", background: "#fff", borderRadius: 5, padding: "3px 8px", fontWeight: 500 }}>
                            {it.sampleStatus ? "Change" : "Sample"}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => removeMentionedItem(it.productId)}
                          style={{ border: "none", background: "none", cursor: "pointer", display: "flex", padding: 2, marginLeft: "auto", color: "#8A8272" }}
                          aria-label={`Remove ${it.name}`}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <button onClick={getLocation} disabled={locating} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
                border: "1px solid #E5DFD3", background: "#FAF7F2", fontSize: 12.5, fontWeight: 500,
              }}>
                {locating ? <Loader2 size={14} className="spin" /> : <MapPin size={14} />}
                {locating ? "Locating…" : coords ? "Update location" : isSupervisor ? "Capture GPS location (optional)" : "Capture GPS location (required)"}
              </button>
              {coords && <span className="kb-font-mono" style={{ fontSize: 11.5, color: "#4C7A5E" }}><Check size={12} style={{ verticalAlign: -1 }} /> {coords.lat}, {coords.lng}</span>}
            </div>
            {locationMismatch && (
              <div style={{ background: "#FBF0F0", border: "1px solid #E5B8B0", color: "#7A3B3B", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 12, fontWeight: 500 }}>
                ⚠ You're {locationMismatchKm.toFixed(1)}km from {client}'s known location. Double-check you're at the right place before saving.
              </div>
            )}
            {locError && (
              <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 8, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 6 }}>{locError}</div>
                <div style={{ fontSize: 12, color: "#7A5B2E", marginBottom: 8 }}>
                  No GPS available right now (indoors, dead zone)? You can save this offline — it'll sync automatically once you have a signal.
                </div>
                <button
                  type="button"
                  disabled={!client || !matchedEntity}
                  onClick={saveOffline}
                  style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: client && matchedEntity ? "#C17817" : "#D8D2C4", color: "#fff", fontSize: 12.5, fontWeight: 500 }}
                >
                  Save offline, sync later
                </button>
              </div>
            )}
            {visitError && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 12 }}>{visitError}</div>}
            {/* GPS is required for everyone except the Head of Sales (isSupervisor)
                — a temporary exception while Rabih's phone location permissions
                get sorted out. Remove the isSupervisor carve-out below (both here
                and server-side in POST /api/visits) once that's fixed. */}
            {!coords && !isSupervisor && <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 12 }}>Capture your GPS location before saving — this is how a visit gets confirmed as real.</div>}
            {!coords && isSupervisor && <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 12 }}>Location isn't required for your account right now — you can save without it.</div>}

            <button disabled={!client || (!coords && !isSupervisor) || !matchedEntity || saving} onClick={submit} style={{
              padding: "9px 18px", borderRadius: 8, border: "none",
              background: client && (coords || isSupervisor) && matchedEntity && !saving ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500,
            }}>
              {saving ? "Saving…" : "Save visit & continue"}
            </button>
          </div>
        </>
      )}

      {step === "orderPrompt" && lastVisit && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <span style={{ fontSize: 13.5 }}>Did <strong>{lastVisit.client}</strong> place an order?</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => goToStep("order")} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
              Yes, add order
            </button>
            <button onClick={() => goToStep(entityType === "pharmacy" ? "sample" : "followup")} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>
              No
            </button>
          </div>
        </div>
      )}

      {step === "order" && lastVisit && (
        <>
          {canGoBack && <BackStepButton onClick={goBack} />}
          <OrderBuilder
            clientName={lastVisit.client}
            visitId={lastVisit.id}
            products={products}
            offers={offers}
            clients={clients}
            onCreateOrder={onCreateOrder}
            onDone={() => { loadRecentOrders(); loadTodayOrders(); goToStep("sample"); }}
          />
        </>
      )}

      {step === "sample" && lastVisit && (
        <>
          {canGoBack && <BackStepButton onClick={goBack} />}
          <PharmacySampleStep
            clientName={lastVisit.client}
            visitId={lastVisit.id}
            products={products}
            onDone={() => goToStep("followup")}
          />
        </>
      )}

      {step === "followup" && lastVisit && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          {canGoBack && <BackStepButton onClick={goBack} />}
          <div style={{ fontSize: 13.5, marginBottom: 10 }}>
            Schedule a follow-up for <strong>{lastVisit.client}</strong>?
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {FOLLOWUP_PRESETS.map((p) => (
              <button
                key={p.key}
                disabled={followUpSaving}
                onClick={() => scheduleFollowUp(p.key)}
                style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, color: "#5B5445" }}>Or in</span>
            <input
              type="number"
              min="1"
              max="365"
              value={customFollowUpDays}
              onChange={(e) => setCustomFollowUpDays(e.target.value)}
              placeholder="e.g. 10"
              style={{ ...inputStyle, width: 80, padding: "6px 8px", fontSize: 12.5 }}
            />
            <span style={{ fontSize: 12.5, color: "#5B5445" }}>days</span>
            <button
              disabled={followUpSaving || !customFollowUpDays}
              onClick={scheduleCustomFollowUp}
              style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #1F2A24", background: "#fff", color: "#1F2A24", fontSize: 12.5, fontWeight: 500 }}
            >
              Schedule
            </button>
          </div>

          {!showStopFollowUp ? (
            <button
              disabled={followUpSaving}
              onClick={() => setShowStopFollowUp(true)}
              style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#B33A3A", fontSize: 12.5 }}
            >
              🚫 Stop visiting this {entityType === "doctor" ? "doctor" : "pharmacy"}
            </button>
          ) : (
            <div style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 6 }}>
                Why are you stopping? (optional, but helps later — e.g. "no budget", "switched supplier", "closed down")
              </div>
              <textarea
                value={stopFollowUpReason}
                onChange={(e) => setStopFollowUpReason(e.target.value)}
                rows={2}
                style={{ ...inputStyle, width: "100%", resize: "vertical", marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={followUpSaving}
                  onClick={stopFollowUp}
                  style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#B33A3A", color: "#fff", fontSize: 12.5, fontWeight: 500 }}
                >
                  Confirm — stop visiting
                </button>
                <button
                  disabled={followUpSaving}
                  onClick={() => { setShowStopFollowUp(false); setStopFollowUpReason(""); }}
                  style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {followUpError && <div style={{ fontSize: 12, color: "#B33A3A", marginTop: 8 }}>{followUpError}</div>}
        </div>
      )}

      {step === "done" && lastVisit && lastVisit.pending && (
        <div style={{ background: "#fff", border: "1px solid #E9C88A", borderRadius: 10, padding: 20, marginBottom: 20, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#C17817" }}>
            ⏳ Saved offline for {lastVisit.client}
          </div>
          <div style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 16 }}>
            It'll sync automatically once you have a GPS signal or connection — no need to redo anything. Keep the app open occasionally so it can try. You'll see it appear in Today's visits once synced.
          </div>
          <button onClick={startNewVisit} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>
            Log another visit
          </button>
        </div>
      )}
      {step === "done" && lastVisit && !lastVisit.pending && (
        <div style={{ background: "#fff", border: "1px solid #4C7A5E55", borderRadius: 10, padding: 20, marginBottom: 20, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#4C7A5E" }}>
            <Check size={16} style={{ verticalAlign: -2 }} /> Visit logged for {lastVisit.client}
          </div>
          <div style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 16 }}>
            {followUpStatus === "set"
              ? "Follow-up scheduled — you'll get a Telegram reminder when it's due."
              : followUpStatus === "stopped"
              ? "Marked as stopped — no more reminders for this one."
              : "No follow-up scheduled for this visit."}
          </div>
          <button onClick={startNewVisit} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>
            Log another visit
          </button>
        </div>
      )}

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#8A8272" }}>Today's visits ({todayVisits.length})</h3>
      <p style={{ fontSize: 11.5, color: "#8A8272", margin: "0 0 10px" }}>Tap a visit to add an order or sample you forgot at the time.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {todayVisits.map((v) => {
          const isExpanded = expandedTodayVisitId === v.id;
          const isPharmacyVisit = clients.some((c) => c.name.toLowerCase().trim() === v.client.toLowerCase().trim());
          const existingOrder = todayOrders.find((o) => o.visitId === v.id);
          const samples = samplesByVisitId[v.id];
          return (
            <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
              <button
                type="button"
                onClick={() => toggleTodayVisit(v)}
                style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "flex-start", gap: 8, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}
              >
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{isExpanded ? "▾" : "▸"} {v.client}</span>
                <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>{new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
              </button>
              {v.notes && <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 4 }}>{v.notes}</div>}
              {v.mentionedItems && v.mentionedItems.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#4C7A5E", marginTop: 4 }}>
                  Mentioned: {v.mentionedItems.map((it) => (
                    it.sampleStatus === "gave" ? `${it.name} (sample given)`
                    : it.sampleStatus === "next_visit" ? `${it.name} (sample next visit)`
                    : it.name
                  )).join(", ")}
                </div>
              )}
              {v.coords && <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 4 }}><MapPin size={11} style={{ verticalAlign: -1 }} /> {v.coords.lat}, {v.coords.lng}</div>}
              {(v.comments || []).map((c) => (
                <div key={c.id} style={{ fontSize: 12, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "6px 10px", marginTop: 6 }}>
                  <strong>{c.authorName}</strong>: {c.text}
                </div>
              ))}

              {isExpanded && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#8A8272", marginBottom: 4 }}>ORDER</div>
                    {existingOrder ? (
                      <div style={{ fontSize: 12.5 }}>
                        {existingOrder.items.map((it) => `${it.name} ×${it.qty}${it.isFree ? " (free)" : ""}`).join(", ")}
                        {" — "}{Number(existingOrder.netTotal ?? existingOrder.total).toFixed(2)} collected
                      </div>
                    ) : addingOrderForVisitId === v.id ? (
                      <OrderBuilder
                        clientName={v.client}
                        visitId={v.id}
                        products={products}
                        offers={offers}
                        clients={clients}
                        onCreateOrder={onCreateOrder}
                        onDone={() => { loadRecentOrders(); loadTodayOrders(); setAddingOrderForVisitId(null); }}
                      />
                    ) : (
                      <button
                        onClick={() => setAddingOrderForVisitId(v.id)}
                        style={{ fontSize: 12, fontWeight: 500, color: "#C17817", background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
                      >
                        + Add order
                      </button>
                    )}
                  </div>

                  {isPharmacyVisit && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#8A8272", marginBottom: 4 }}>SAMPLE</div>
                      {samples === undefined ? (
                        <div style={{ fontSize: 12, color: "#8A8272" }}>Loading…</div>
                      ) : samples.length > 0 ? (
                        <div style={{ fontSize: 12.5 }}>{samples.map((s) => `${s.productName}${s.qty ? ` ×${s.qty}` : ""}`).join(", ")}</div>
                      ) : addingSampleForVisitId === v.id ? (
                        <PharmacySampleStep
                          clientName={v.client}
                          visitId={v.id}
                          products={products}
                          onDone={() => { loadSamplesForVisit(v.id); setAddingSampleForVisitId(null); }}
                        />
                      ) : (
                        <button
                          onClick={() => setAddingSampleForVisitId(v.id)}
                          style={{ fontSize: 12, fontWeight: 500, color: "#C17817", background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
                        >
                          + Add sample
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {todayVisits.length === 0 && <EmptyState text="No visits logged yet today." />}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "20px 0 10px", color: "#8A8272" }}>Your recent orders</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {recentOrders.map((o) => (
          <div key={o.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.clientName}</div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · collected {Number(o.netTotal ?? o.total).toFixed(2)}
                {o.discountRate > 0 ? ` (list ${o.total.toFixed(2)}, ${o.discountRate}% off)` : ""}
              </div>
            </div>
            {o.status === "deletion_requested" ? (
              <span style={{ fontSize: 11.5, color: "#C17817" }}>Deletion requested — awaiting approval</span>
            ) : (
              <button onClick={() => onRequestDeleteOrder(o.id).then(loadRecentOrders)} style={{ fontSize: 11.5, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>
                Request deletion
              </button>
            )}
          </div>
        ))}
        {recentOrders.length === 0 && <EmptyState text="No orders yet." />}
      </div>

      <div style={{ marginTop: 20 }}>
        <PushNotificationSetup />
      </div>
      <div style={{ marginTop: 12 }}>
        <RepTelegramLinkSection />
      </div>
    </div>
  );
}

function RepTelegramLinkSection() {
  const [status, setStatus] = useState(null);
  const [linking, setLinking] = useState(false);
  const [linkInfo, setLinkInfo] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { api.getTelegramStatus().then(setStatus).catch(() => setStatus({ configured: false })); }, []);

  const generateLink = async () => {
    setLinking(true);
    setError("");
    try {
      const { code, botUsername } = await api.getMyTelegramLinkCode();
      setLinkInfo({ code, botUsername });
    } catch (e) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  };

  if (!status?.configured) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Telegram alerts</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Link your Telegram to get the monthly focus list — what to pick up from pharmacies and what to push sales on — once your manager approves it.
      </p>
      {status.repLinked ? (
        <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 5, background: "#4C7A5E1A", color: "#4C7A5E" }}>
          ✓ Linked
        </span>
      ) : linkInfo ? (
        <div style={{ fontSize: 12, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
          Tap to open Telegram and hit Start:
          <div style={{ marginTop: 4 }}>
            <a className="kb-font-mono" href={`https://t.me/${linkInfo.botUsername}?start=${linkInfo.code}`} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all", color: "#4C7A5E" }}>
              https://t.me/{linkInfo.botUsername}?start={linkInfo.code}
            </a>
          </div>
        </div>
      ) : (
        <button onClick={generateLink} disabled={linking} style={{ fontSize: 12.5, padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24" }}>
          {linking ? "Generating…" : "Link my Telegram"}
        </button>
      )}
      {error && <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ---------- Proforma invoice PDF ----------
// stockWarnings: items whose requested qty exceeded stock and got capped at
// save time — printed as a flagged section so the manager sees it even
// though the rep saw the on-screen ⚠ and moved on. Each warning lists two
// separate things reps otherwise had no way to find out mid-order: any
// OTHER BATCH of the exact same product (a different expiry, its own row
// in the Products sheet) that still has stock — so a low count on the one
// batch picked doesn't read as "this product is out" when it isn't — and
// any other pharmacies with recent orders for the same product, since
// Products.qty isn't live-decremented per order — two reps could both see
// "40 in stock" and both order against it, and this is how that surfaces.
function downloadOrderPdf(order, stockWarnings = []) {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text("KayBee Pharma — Proforma Invoice", 14, 18);
  doc.setFontSize(10);
  doc.text(`Pharmacy: ${order.clientName}`, 14, 28);
  doc.text(`Date: ${new Date(order.date).toLocaleDateString("en-GB")}`, 14, 34);
  autoTable(doc, {
    startY: 42,
    head: [["Item", "Qty", "Expiry", "Unit Price", "Line Total"]],
    body: order.items.map((it) => [
      it.name + (it.isFree ? " (FREE)" : ""),
      String(it.qty),
      it.expiry ? fmtDate(it.expiry) : "-",
      it.isFree ? "FREE" : Number(it.unitPrice).toFixed(2),
      it.isFree ? "0.00" : (it.qty * it.unitPrice).toFixed(2),
    ]),
    foot: order.discountRate
      ? [
          ["", "", "", "List total", Number(order.total).toFixed(2)],
          ["", "", "", `Discount (${order.discountRate}%)`, `-${(Number(order.total) - Number(order.netTotal ?? order.total)).toFixed(2)}`],
          ["", "", "", "Net total", Number(order.netTotal ?? order.total).toFixed(2)],
        ]
      : [["", "", "", "Total", Number(order.total).toFixed(2)]],
  });

  if (stockWarnings.length > 0) {
    let y = (doc.lastAutoTable?.finalY || 60) + 12;
    doc.setTextColor(179, 58, 58);
    doc.setFontSize(12);
    doc.text("Stock warning — for Head of Med Reps", 14, y);
    y += 7;
    doc.setFontSize(9.5);
    doc.setTextColor(90, 40, 40);
    stockWarnings.forEach((w) => {
      const lines = [
        `${w.productName}: pharmacy ordered ${w.requestedQty}, only ${w.cappedQty} in stock — order saved at ${w.cappedQty} (max available).`,
        w.cappedQty > 0
          ? `All remaining stock of this item has been allocated to ${order.clientName}.`
          : `No stock was available — this item was removed from the order entirely.`,
        `OTHER BATCHES of this same product (different expiry) with stock:`,
        ...((w.otherBatches || []).length > 0
          ? w.otherBatches.map((b) => `  - ${b.qty} in stock, exp ${fmtDate(b.expiry)}`)
          : [`  - None — this was the only batch of this product with any stock.`]),
        `DOUBLE CHECK if any other pharmacies have also ordered this item:`,
        ...(w.otherOrders.length > 0
          ? w.otherOrders.map((o) => `  - ${o.clientName} — ${o.qty} units on ${new Date(o.date).toLocaleDateString("en-GB")}`)
          : [`  - No other recent orders of this item found in the app — confirm manually since stock may already be committed elsewhere.`]),
      ];
      const wrapped = doc.splitTextToSize(lines.join("\n"), 180);
      doc.text(wrapped, 14, y);
      y += wrapped.length * 5 + 6;
    });
    doc.setTextColor(0, 0, 0);
  }

  doc.save(`order-${order.clientName.replace(/\s+/g, "_")}-${order.date.slice(0, 10)}.pdf`);
}

// ---------- Sample step (used from Check-In for both pharmacies and doctors) ----
// The primary "did they place an order" replacement for doctors — they
// don't buy stock, they get samples — and also available to pharmacies as
// an extra add-on after their order. onDone is called with whatever items
// were actually given (possibly empty), so the caller can suggest the same
// items when asking about the next visit's sample need.
function PharmacySampleStep({ clientName, visitId, products, onDone }) {
  const [asked, setAsked] = useState(null); // null | "yes" | "no"
  const [itemQuery, setItemQuery] = useState("");
  const [qty, setQty] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const itemOptions = (itemQuery.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(itemQuery.toLowerCase().trim()))
    : products
  ).slice(0, 50);
  const matchedItem = products.find((p) => p.name.toLowerCase().trim() === itemQuery.toLowerCase().trim());

  const addItem = () => {
    setError("");
    if (!matchedItem) { setError("Pick an item from the list."); return; }
    const q = Number(qty);
    if (!q || q <= 0) { setError("Enter a quantity greater than 0."); return; }
    setItems((prev) => [...prev, { productId: matchedItem.id, name: matchedItem.name, qty: q }]);
    setItemQuery(""); setQty("");
  };
  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const finish = async () => {
    if (items.length === 0) { onDone([]); return; }
    setSaving(true);
    setError("");
    try {
      await api.addSamples({ entityName: clientName, visitId, items });
      onDone(items);
    } catch (e) {
      setError(e?.message || "Couldn't save the samples.");
    } finally {
      setSaving(false);
    }
  };

  if (asked === null) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <span style={{ fontSize: 13.5 }}>Did you give <strong>{clientName}</strong> a sample?</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setAsked("yes")} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
            Yes
          </button>
          <button onClick={() => onDone([])} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>
            No
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>Samples given to {clientName}</h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 2, minWidth: 160 }}>
          <input
            value={itemQuery}
            onChange={(e) => setItemQuery(e.target.value)}
            placeholder="Search item…"
            list="sample-item-options"
            style={inputStyle}
          />
          <datalist id="sample-item-options">
            {itemOptions.map((p) => <option key={p.id} value={p.name} />)}
          </datalist>
        </div>
        <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" style={{ ...inputStyle, flex: 1, minWidth: 80 }} />
        <button onClick={addItem} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
          Add
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 8 }}>{error}</div>}

      {items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "6px 10px", fontSize: 12.5 }}>
              <span>{it.name} × {it.qty}</span>
              <button onClick={() => removeItem(i)} style={{ background: "none", border: "none", color: "#B7AF9E" }}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={saving} onClick={finish} style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>
          {saving ? "Saving…" : items.length > 0 ? "Save samples & continue" : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ---------- Order Builder (used from Check-In) ----------
// Each Products row is its own batch — the same item name can appear more
// than once with a different expiry/qty. Including both in the searchable
// label is what lets a rep pick the specific batch to sell from (rather
// than silently getting whichever row happens to be first), so the oldest
// stock actually gets offered to pharmacies first.
const batchLabel = (p) => `${p.name} — exp ${fmtDate(p.expiry)} (${p.qty} in stock)`;

// Given exactly what the rep entered (never mutated for offers), works out
// which single offer — if any — the order qualifies for, and automatically
// carves its free unit(s) out of whichever already-ordered line is closest
// to the rounded-down average price. Pure/derived, so it's always correct
// no matter what gets added or removed afterward — nothing to keep in sync.
function applyOfferToItems(rawItems, offers) {
  const totalQty = rawItems.reduce((sum, it) => sum + it.qty, 0);
  if (totalQty === 0) return { displayItems: rawItems, appliedOffer: null, avg: 0, roundedAvg: 0 };

  const todayStr = new Date().toISOString().slice(0, 10);
  const activeOffers = offers.filter((o) => o.active && (!o.expiresAt || o.expiresAt >= todayStr));
  // The rep enters every physical unit (buyQty + getQty, e.g. all 8 for a
  // 7+1 deal) — the free unit comes out of that set, never tacked on extra.
  // If more than one offer's threshold is met at once, the biggest wins.
  const qualifying = activeOffers
    .filter((o) => totalQty >= o.buyQty + o.getQty)
    .sort((a, b) => (b.buyQty + b.getQty) - (a.buyQty + a.getQty));
  const offer = qualifying[0];
  if (!offer) return { displayItems: rawItems, appliedOffer: null, avg: 0, roundedAvg: 0 };

  const totalValue = rawItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
  const avg = totalValue / totalQty;
  const roundedAvg = Math.floor(avg);

  const priced = rawItems.filter((it) => it.unitPrice > 0);
  if (priced.length === 0) return { displayItems: rawItems, appliedOffer: null, avg, roundedAvg };

  // Closest to the rounded-down average by plain distance — not restricted
  // to prices at or below it. A tie breaks toward the lower price, the more
  // conservative choice.
  const chosen = priced.reduce((best, it) => {
    const d = Math.abs(it.unitPrice - roundedAvg);
    const bd = Math.abs(best.unitPrice - roundedAvg);
    if (d < bd) return it;
    if (d === bd && it.unitPrice < best.unitPrice) return it;
    return best;
  }, priced[0]);

  const freeQty = Math.min(offer.getQty, chosen.qty);
  const remainingQty = chosen.qty - freeQty;
  const displayItems = rawItems
    .map((it) => (it === chosen ? { ...it, qty: remainingQty } : it))
    .filter((it) => it.qty > 0);
  displayItems.push({
    ...chosen,
    qty: freeQty,
    unitPrice: 0,
    originalPrice: chosen.unitPrice,
    isFree: true,
    viaOfferId: offer.id,
  });

  return { displayItems, appliedOffer: offer, avg, roundedAvg, freeItem: chosen, freeQty };
}

function OrderBuilder({ clientName, visitId, products, offers, clients, onCreateOrder, onDone }) {
  const [productQuery, setProductQuery] = useState("");
  const [qty, setQty] = useState("");
  const [items, setItems] = useState([]);
  // Which offer group the NEXT added item joins — "" means regular/no-offer.
  // This is the one place a rep assigns a product to an offer; correcting a
  // mistake is remove-and-re-add, matching how every other item edit in
  // this form already works (there's no in-place qty edit either).
  const [pendingOfferId, setPendingOfferId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const nextKeyRef = useRef(0);

  // Pre-filled from the pharmacy's own negotiated rate, but editable per
  // order — discounts aren't uniform across pharmacies, and even a given
  // pharmacy's standard rate sometimes has a one-off exception.
  const matchedClient = (clients || []).find((c) => c.name.toLowerCase().trim() === clientName.toLowerCase().trim());
  const [discountRate, setDiscountRate] = useState(matchedClient?.discountRate || "");

  const matchedProduct = products.find((p) => batchLabel(p) === productQuery.trim());

  const todayStr = new Date().toISOString().slice(0, 10);
  const activeOffers = offers.filter((o) => o.active && (!o.expiresAt || o.expiresAt >= todayStr));
  const activeOfferIds = new Set(activeOffers.map((o) => o.id));

  const addItem = () => {
    setError("");
    if (!matchedProduct) { setError("Pick a product batch from the list."); return; }
    const q = Number(qty);
    if (!q || q <= 0) { setError("Enter a quantity greater than 0."); return; }
    const offerId = pendingOfferId && activeOfferIds.has(pendingOfferId) ? pendingOfferId : "";

    setItems((prev) => {
      // Merge into an existing line for the same batch *within the same
      // offer group* instead of adding a duplicate row — otherwise 2 units
      // entered as two separate clicks would sit in two lines of qty 1
      // each, and the free-item engine could only carve a free unit out of
      // one line at a time. A product added to two different offer groups
      // (or one offer group and also regular) deliberately stays separate.
      const existingIdx = prev.findIndex((it) => it.productId === matchedProduct.id && it.offerId === offerId);
      if (existingIdx >= 0) {
        return prev.map((it, i) => (i === existingIdx ? { ...it, qty: it.qty + q } : it));
      }
      return [...prev, {
        key: nextKeyRef.current++,
        productId: matchedProduct.id,
        name: matchedProduct.name,
        qty: q,
        unitPrice: matchedProduct.price || 0,
        availableQty: matchedProduct.qty,
        expiry: matchedProduct.expiry,
        isFree: false,
        offerId,
      }];
    });
    setProductQuery("");
    setQty("");
  };

  const removeItem = (key) => setItems((prev) => prev.filter((it) => it.key !== key));

  // Reassigns every raw item currently in `fromOfferId` to `toOfferId` —
  // used by the "Switch to next offer" suggestion below. Never touches
  // qty/price/product, only which group a line belongs to.
  const switchGroupOffer = (fromOfferId, toOfferId) => {
    setItems((prev) => prev.map((it) => (it.offerId === fromOfferId ? { ...it, offerId: toOfferId } : it)));
  };

  // Items whose offerId doesn't resolve to a currently-active offer (never
  // assigned, or the offer was deactivated after assignment) fall back to
  // "regular" rather than forming a dead, unvalidatable group.
  const regularItems = items.filter((it) => !it.offerId || !activeOfferIds.has(it.offerId));
  const groupIds = [];
  items.forEach((it) => {
    if (it.offerId && activeOfferIds.has(it.offerId) && !groupIds.includes(it.offerId)) groupIds.push(it.offerId);
  });

  // Each offer group is computed in total isolation — its own call to the
  // existing, unmodified applyOfferToItems() with only its own items and
  // its own single offer, so one group's average price / free-item pick
  // can never see or affect another group's. A regular order (no offer
  // groups at all) is just an empty array here, unchanged from before.
  const offerGroups = groupIds.map((offerId) => {
    const offer = activeOffers.find((o) => o.id === offerId);
    const rawItems = items.filter((it) => it.offerId === offerId);
    const totalQty = rawItems.reduce((sum, it) => sum + it.qty, 0);
    const required = offer.buyQty + offer.getQty;
    const { displayItems, appliedOffer, avg, roundedAvg, freeItem, freeQty } = applyOfferToItems(rawItems, [offer]);
    return {
      offerId,
      offer,
      rawItems,
      totalQty,
      required,
      valid: totalQty === required,
      taggedDisplayItems: displayItems.map((it) => ({ ...it, offerId })),
      appliedOffer, avg, roundedAvg, freeItem, freeQty,
    };
  });

  const regularTagged = regularItems.map((it) => ({ ...it, offerId: "" }));
  const allDisplayItems = [...offerGroups.flatMap((g) => g.taggedDisplayItems), ...regularTagged];
  const total = allDisplayItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
  const netTotal = total * (1 - (Number(discountRate) || 0) / 100);

  // Same product, a different batch (different expiry, its own row in the
  // Products sheet) with stock left — surfaced whenever a line runs short,
  // so a rep isn't only told "1 left" for the batch they happened to pick
  // without ever finding out a later-expiring batch of the same item has
  // plenty. Never auto-switches or auto-splits a line across batches —
  // that's the rep's call, same as the "switch offer" suggestion above.
  const siblingBatchesFor = (productName, excludeProductId) =>
    products
      .filter((p) => p.name === productName && p.id !== excludeProductId && p.qty > 0)
      .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

  const invalidGroups = offerGroups.filter((g) => !g.valid);
  const allGroupsValid = invalidGroups.length === 0;
  const regularUnitTotal = regularItems.reduce((sum, it) => sum + it.qty, 0);
  const totalUnits = allDisplayItems.reduce((sum, it) => sum + it.qty, 0);
  const totalFreeUnits = offerGroups.reduce((sum, g) => sum + (g.valid ? g.freeQty : 0), 0);

  // "If you have 13 and 7+1 requires 8, the next offer that fits 13 is
  // 12+2 (needs 14)" — the smallest-threshold active offer, other than the
  // one already assigned, whose requirement is still >= what's been added.
  // Only offered when the group is OVER its requirement; being under just
  // needs more units added, not a different offer.
  const nextOfferSuggestion = (group) => {
    if (group.totalQty <= group.required) return null;
    return activeOffers
      .filter((o) => o.id !== group.offerId && o.buyQty + o.getQty >= group.totalQty)
      .sort((a, b) => (a.buyQty + a.getQty) - (b.buyQty + b.getQty))[0] || null;
  };

  const doCreateOrder = async () => {
    if (allDisplayItems.length === 0) { setError("Add at least one item first."); return; }
    if (!allGroupsValid) {
      const names = invalidGroups.map((g) => g.offer.label).join(", ");
      setError(`Fix the quantity for: ${names}. Every offer group must total exactly its required units before this order can be placed.`);
      return;
    }
    setError("");
    setSaving(true);
    try {
      // An item ordered above what's in stock gets saved at the max
      // available instead — the on-screen ⚠ already told the rep, this is
      // the point where it actually gets enforced rather than just shown.
      const stockWarnings = [];
      const finalItems = [];
      for (const it of allDisplayItems) {
        if (it.isFree || it.qty <= it.availableQty) {
          finalItems.push(it);
          continue;
        }
        const cappedQty = Math.max(0, it.availableQty);
        // Fetched on demand instead of scanning a full orders history held
        // in state — only needed the moment a stock cap actually triggers.
        const otherOrdersData = await api.getOrders({ product: it.name, limit: 6 }).catch(() => ({ orders: [] }));
        const otherOrders = (otherOrdersData.orders || [])
          .filter((o) => o.clientName !== clientName && (o.items || []).some((oi) => oi.productId === it.productId))
          .slice(0, 5)
          .map((o) => ({
            clientName: o.clientName,
            qty: o.items.find((oi) => oi.productId === it.productId)?.qty || 0,
            date: o.date,
          }));
        const otherBatches = siblingBatchesFor(it.name, it.productId).map((s) => ({ qty: s.qty, expiry: s.expiry }));
        stockWarnings.push({ productName: it.name, requestedQty: it.qty, cappedQty, otherOrders, otherBatches });
        if (cappedQty > 0) finalItems.push({ ...it, qty: cappedQty });
      }
      if (finalItems.length === 0) {
        setError("None of the items in this order have stock available.");
        setSaving(false);
        return;
      }
      const finalTotal = finalItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
      const finalDiscountRate = Number(discountRate) || 0;
      const payload = {
        clientName,
        visitId,
        items: finalItems.map(({ productId, name, qty, unitPrice, isFree, originalPrice, expiry, offerId }) => ({
          productId, name, qty, unitPrice, isFree: !!isFree, originalPrice: originalPrice || 0, expiry: expiry || "", offerId: offerId || "",
        })),
        discountRate: finalDiscountRate,
      };
      const created = await onCreateOrder(payload);
      downloadOrderPdf(created || { ...payload, date: new Date().toISOString(), total: finalTotal, netTotal: finalTotal * (1 - finalDiscountRate / 100) }, stockWarnings);
      onDone();
    } catch (e) {
      setError(e.message || "Couldn't save the order.");
    } finally {
      setSaving(false);
    }
  };

  const groupCardStyle = { border: "1px solid #E5DFD3", borderRadius: 8, padding: 10, marginBottom: 8 };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>Order for {clientName}</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ flex: 2, minWidth: 160 }}>
          <SearchableSelect
            value={productQuery}
            onChange={setProductQuery}
            options={products}
            getLabel={batchLabel}
            placeholder="Search product — pick the batch by expiry…"
            style={inputStyle}
          />
        </div>
        <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" style={{ ...inputStyle, flex: 1, minWidth: 80 }} />
        {activeOffers.length > 0 && (
          <select aria-label="Assign to offer" value={pendingOfferId} onChange={(e) => setPendingOfferId(e.target.value)} style={{ ...inputStyle, flex: 1.4, minWidth: 150 }}>
            <option value="">No offer (regular)</option>
            {activeOffers.map((o) => <option key={o.id} value={o.id}>{o.label} (buy {o.buyQty}, get {o.getQty})</option>)}
          </select>
        )}
        <button onClick={addItem} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
          Add item
        </button>
      </div>

      {matchedProduct && (
        <div style={{ fontSize: 11.5, color: matchedProduct.qty > 0 ? "#4C7A5E" : "#B33A3A", marginBottom: 8 }}>
          {matchedProduct.qty > 0 ? `${matchedProduct.qty} in stock` : "Out of stock"} · expires {fmtDate(matchedProduct.expiry)} · price {matchedProduct.price ? matchedProduct.price.toFixed(2) : "not set"}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 8 }}>{error}</div>}

      {offerGroups.map((g) => {
        const suggestion = nextOfferSuggestion(g);
        const statusColor = g.valid ? "#4C7A5E" : "#B33A3A";
        return (
          <div key={g.offerId} style={{ ...groupCardStyle, background: g.valid ? "#F7FBF8" : "#FBF3F0", borderColor: g.valid ? "#C7DFCE" : "#E5B8B0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{g.offer.label}</span>
              <span className="kb-font-mono" style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>
                {g.totalQty} / {g.required} units {g.valid ? "✓" : "⚠"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {g.rawItems.map((it) => (
                <div key={it.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span>{it.name} × {it.qty}</span>
                  <button onClick={() => removeItem(it.key)} style={{ background: "none", border: "none", color: "#B7AF9E" }}><X size={12} /></button>
                </div>
              ))}
            </div>
            {g.valid && g.freeItem && (
              <div style={{ fontSize: 11.5, color: "#4C7A5E", marginTop: 6 }}>
                Free: {g.freeItem.name} × {g.freeQty} (auto-selected)
              </div>
            )}
            {!g.valid && g.totalQty < g.required && (
              <div style={{ fontSize: 12, color: "#B33A3A", marginTop: 6 }}>⚠ Add {g.required - g.totalQty} more unit{g.required - g.totalQty === 1 ? "" : "s"} to reach {g.required}.</div>
            )}
            {!g.valid && g.totalQty > g.required && (
              <div style={{ fontSize: 12, color: "#B33A3A", marginTop: 6 }}>
                ⚠ {g.offer.label} requires exactly {g.required} units. You have {g.totalQty - g.required} unit{g.totalQty - g.required === 1 ? "" : "s"} above this offer.
                {suggestion && (
                  <div style={{ marginTop: 4 }}>
                    If you want to order {g.totalQty} units, the next available offer is <strong>{suggestion.label}</strong>, which requires {suggestion.buyQty + suggestion.getQty} units.
                    <div style={{ marginTop: 4 }}>
                      <button
                        onClick={() => switchGroupOffer(g.offerId, suggestion.id)}
                        style={{ fontSize: 11.5, fontWeight: 600, color: "#C17817", background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
                      >
                        Switch to {suggestion.label}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {regularItems.length > 0 && (
        <div style={groupCardStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#8A8272", marginBottom: 6 }}>Regular items (no offer)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {regularItems.map((it) => (
              <div key={it.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                <span>{it.name} × {it.qty}</span>
                <button onClick={() => removeItem(it.key)} style={{ background: "none", border: "none", color: "#B7AF9E" }}><X size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {allDisplayItems.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#8A8272" }}>
                  <th style={{ padding: "4px 6px" }}>Item</th>
                  <th style={{ padding: "4px 6px" }}>Qty</th>
                  <th style={{ padding: "4px 6px" }}>Stock</th>
                  <th style={{ padding: "4px 6px" }}>Expiry</th>
                  <th style={{ padding: "4px 6px" }}>Unit price</th>
                  <th style={{ padding: "4px 6px" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {allDisplayItems.map((it) => {
                  const short = !it.isFree && it.qty > it.availableQty;
                  const siblings = short ? siblingBatchesFor(it.name, it.productId) : [];
                  return (
                    <React.Fragment key={`${it.offerId || "reg"}-${it.key}-${it.isFree ? "free" : "paid"}`}>
                      <tr style={{ borderTop: "1px solid #E5DFD3" }}>
                        <td style={{ padding: "4px 6px" }}>
                          {it.name}{it.isFree && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "#4C7A5E1A", color: "#4C7A5E" }}>FREE</span>}
                        </td>
                        <td style={{ padding: "4px 6px" }}>{it.qty}</td>
                        <td style={{ padding: "4px 6px", color: it.qty > it.availableQty ? "#B33A3A" : "#4C7A5E" }}>
                          {it.availableQty}{it.qty > it.availableQty ? " ⚠" : ""}
                        </td>
                        <td className="kb-font-mono" style={{ padding: "4px 6px" }}>{it.expiry ? fmtDate(it.expiry) : "-"}</td>
                        <td style={{ padding: "4px 6px" }}>{it.isFree ? "FREE" : it.unitPrice.toFixed(2)}</td>
                        <td style={{ padding: "4px 6px" }}>{it.isFree ? "0.00" : (it.qty * it.unitPrice).toFixed(2)}</td>
                      </tr>
                      {short && (
                        <tr>
                          <td colSpan={6} style={{ padding: "2px 6px 8px", fontSize: 11, color: "#B33A3A" }}>
                            Only {it.availableQty} of this exact batch (exp {it.expiry ? fmtDate(it.expiry) : "unknown"}) — the order will be capped here unless you adjust it.
                            {siblings.length > 0 ? (
                              <> Other batches of <strong>{it.name}</strong> with stock: {siblings.map((s) => `${s.qty} in stock (exp ${fmtDate(s.expiry)})`).join(", ")}. Remove this line and re-add from one of those instead if you need more.</>
                            ) : (
                              <> No other batch of <strong>{it.name}</strong> currently has stock.</>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ textAlign: "right", fontSize: 13, marginTop: 6 }}>List total: {total.toFixed(2)}</div>

          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 8 }}>
            <label style={{ fontSize: 12, color: "#8A8272" }}>
              Discount %{matchedClient?.discountRate ? " (pharmacy's standard rate — override for an exception)" : ""}
            </label>
            <input
              type="number" min="0" max="100" step="0.5"
              value={discountRate}
              onChange={(e) => setDiscountRate(e.target.value)}
              placeholder="0"
              style={{ ...inputStyle, width: 80, padding: "6px 8px" }}
            />
          </div>
          <div style={{ textAlign: "right", fontSize: 15, fontWeight: 600, marginTop: 6 }}>
            Net total (collected): {netTotal.toFixed(2)}
          </div>
        </div>
      )}

      {(offerGroups.length > 0 || regularItems.length > 0) && (
        <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 10 }}>
          {offerGroups.length} offer group{offerGroups.length === 1 ? "" : "s"} · {totalFreeUnits} free unit{totalFreeUnits === 1 ? "" : "s"} · {regularUnitTotal} regular unit{regularUnitTotal === 1 ? "" : "s"} · {totalUnits} total units
          {offerGroups.length > 0 && (
            <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {offerGroups.map((g) => (
                <span key={g.offerId} style={{ color: g.valid ? "#4C7A5E" : "#B33A3A", fontWeight: 500 }}>
                  {g.valid ? "✓" : "⚠"} {g.offer.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={saving || allDisplayItems.length === 0 || !allGroupsValid}
          onClick={doCreateOrder}
          style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: !saving && allDisplayItems.length > 0 && allGroupsValid ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Creating…" : "Create order & download PDF"}
        </button>
        <button onClick={onDone} style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- Orders tab (manager + Head of Sales) ----------
// Order History and Pending POS are two views over the same paginated
// endpoint, kept as separate compact screens rather than one giant table
// with everything in it — a pill toggle switches between them, both live
// under the same "Orders" nav slot.
function OrdersTabView({ role, isSupervisor, repNames, onDelete, onApproveDelete, onDenyDelete }) {
  const [subTab, setSubTab] = useState("history"); // history | pending

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button
          onClick={() => setSubTab("history")}
          style={{
            padding: "6px 14px", borderRadius: 16, fontSize: 12.5, fontWeight: 500,
            border: subTab === "history" ? "1px solid #1F2A24" : "1px solid #E5DFD3",
            background: subTab === "history" ? "#1F2A24" : "#fff", color: subTab === "history" ? "#FAF7F2" : "#5B5445",
          }}
        >
          Order History
        </button>
        <button
          onClick={() => setSubTab("pending")}
          style={{
            padding: "6px 14px", borderRadius: 16, fontSize: 12.5, fontWeight: 500,
            border: subTab === "pending" ? "1px solid #C17817" : "1px solid #E5DFD3",
            background: subTab === "pending" ? "#C17817" : "#fff", color: subTab === "pending" ? "#fff" : "#5B5445",
          }}
        >
          Pending POS
        </button>
      </div>
      {subTab === "history" ? (
        <OrderHistoryView role={role} repNames={repNames} onDelete={onDelete} onApproveDelete={onApproveDelete} onDenyDelete={onDenyDelete} />
      ) : (
        <PendingPOSView isSupervisor={isSupervisor} />
      )}
    </div>
  );
}

// ---------- Order History View (manager + Head of Sales, read-only for the latter) ----------
// Built on the paginated GET /api/orders endpoint instead of a full-array
// bootstrap dump — Orders only ever grows, so shipping the whole table to
// every open session on a timer was exactly the pattern that made Excel
// imports (and, over time, this table itself) slow the whole app down.
const ORDER_HISTORY_PAGE_SIZE = 25;
function OrderHistoryView({ role, repNames, onDelete, onApproveDelete, onDenyDelete }) {
  const [confirmIds, setConfirmIds] = useState(new Set());
  const [repFilter, setRepFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [posFilter, setPosFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ orders: [], total: 0 });
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getOrders({
      repName: repFilter, client: clientFilter, product: productFilter, posStatus: posFilter,
      from: fromDate, to: toDate, page, limit: ORDER_HISTORY_PAGE_SIZE,
    })
      .then((data) => setResult(data))
      .catch(() => setResult({ orders: [], total: 0 }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [repFilter, clientFilter, productFilter, posFilter, fromDate, toDate, page]);
  // Any filter change should jump back to page 1 — staying on page 4 of a
  // now-much-smaller filtered result would just show an empty page.
  useEffect(() => { setPage(1); }, [repFilter, clientFilter, productFilter, posFilter, fromDate, toDate]);

  const askConfirm = (id) => setConfirmIds((prev) => new Set(prev).add(id));
  const cancelConfirm = (id) => setConfirmIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  const doDelete = (id) => { onDelete(id).then(load); cancelConfirm(id); };
  const doApprove = (id) => onApproveDelete(id).then(load);
  const doDeny = (id) => onDenyDelete(id).then(load);

  const totalPages = Math.max(1, Math.ceil(result.total / ORDER_HISTORY_PAGE_SIZE));
  // Delete/approve/deny hit requireManager-gated routes server-side — hide
  // them here too for a Head of Sales session so there's no dead button.
  const canManage = role === "manager";

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Order History</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 16 }}>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} style={inputStyle}>
          <option value="">All reps</option>
          {repNames.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} placeholder="Pharmacy name…" style={inputStyle} />
        <input value={productFilter} onChange={(e) => setProductFilter(e.target.value)} placeholder="Product name…" style={inputStyle} />
        <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)} style={inputStyle}>
          <option value="">Any POS status</option>
          <option value="pending">Pending POS</option>
          <option value="entered">POS entered</option>
        </select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={inputStyle} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={inputStyle} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {result.orders.map((o) => (
          <div
            key={o.id}
            style={{
              background: o.status === "deletion_requested" ? "#FBF3F0" : "#fff",
              border: o.status === "deletion_requested" ? "1px solid #E5B8B0" : "1px solid #E5DFD3",
              borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.clientName}{o.repName ? ` · ${o.repName}` : ""}</div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · {o.items.length} item{o.items.length === 1 ? "" : "s"} · collected {Number(o.netTotal ?? o.total).toFixed(2)}
                {o.discountRate > 0 ? ` (list ${o.total.toFixed(2)}, ${o.discountRate}% off)` : ""}
              </div>
              {o.status === "deletion_requested" && <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 4 }}>Rep requested deletion</div>}
              <div style={{ fontSize: 11, marginTop: 4 }}>
                {o.posEntered ? (
                  <span style={{ color: "#4C7A5E", fontWeight: 600 }}>
                    ✓ POS Entered{o.posEnteredBy ? ` — ${o.posEnteredBy}` : ""}{o.posEnteredAt ? `, ${new Date(o.posEnteredAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}` : ""}
                  </span>
                ) : (
                  <span style={{ color: "#C17817", fontWeight: 600 }}>Pending POS</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => downloadOrderPdf(o)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12, fontWeight: 500 }}>
                <Download size={13} /> PDF
              </button>
              {canManage && (o.status === "deletion_requested" ? (
                <>
                  <button onClick={() => doApprove(o.id)} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px" }}>Approve delete</button>
                  <button onClick={() => doDeny(o.id)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "7px 12px" }}>Deny</button>
                </>
              ) : confirmIds.has(o.id) ? (
                <>
                  <span style={{ fontSize: 11.5, color: "#B33A3A" }}>Delete?</span>
                  <button onClick={() => doDelete(o.id)} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>Yes</button>
                  <button onClick={() => cancelConfirm(o.id)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Cancel</button>
                </>
              ) : (
                <button onClick={() => askConfirm(o.id)} style={{ fontSize: 12, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "7px 12px" }}>Delete</button>
              ))}
            </div>
          </div>
        ))}
        {!loading && result.orders.length === 0 && <EmptyState text="No orders found." />}
      </div>

      {result.total > ORDER_HISTORY_PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 12.5 }}>
          <span style={{ color: "#8A8272" }}>
            Showing {(page - 1) * ORDER_HISTORY_PAGE_SIZE + 1}–{Math.min(page * ORDER_HISTORY_PAGE_SIZE, result.total)} of {result.total.toLocaleString()}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, opacity: page <= 1 ? 0.5 : 1 }}>Prev</button>
            <span style={{ color: "#8A8272" }}>Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Pending POS View (compact; the Head of Sales' own worklist) ----------
// Never resets on a schedule — an order sits here until explicitly marked,
// no matter how many weeks pass. Uses the same paginated GET /api/orders
// endpoint as Order History, just filtered to posStatus=pending, so this
// never loads the full Orders table either.
const PENDING_POS_PAGE_SIZE = 20;
function PendingPOSView({ isSupervisor }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ orders: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState(null);

  const load = () => {
    setLoading(true);
    api.getOrders({ posStatus: "pending", page, limit: PENDING_POS_PAGE_SIZE })
      .then((data) => setResult(data))
      .catch(() => setResult({ orders: [], total: 0 }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [page]);

  const markEntered = async (id) => {
    setMarkingId(id);
    try {
      await api.markOrderPosEntered(id);
      load();
    } catch (e) {
      // Left in the list so the rep sees it didn't go through; error is
      // rare here since the button is already hidden for non-supervisors.
    } finally {
      setMarkingId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(result.total / PENDING_POS_PAGE_SIZE));

  return (
    <div>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 14px" }}>
        Orders placed but not yet re-entered into the physical POS. Nothing here expires or resets — it stays until marked.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {result.orders.map((o) => (
          <div key={o.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.clientName}{o.repName ? ` · ${o.repName}` : ""}</div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · {o.items.length} item{o.items.length === 1 ? "" : "s"} · collected {Number(o.netTotal ?? o.total).toFixed(2)}
              </div>
            </div>
            {isSupervisor && (
              <button
                disabled={markingId === o.id}
                onClick={() => markEntered(o.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "none", background: "#4C7A5E", color: "#fff", fontSize: 12.5, fontWeight: 500 }}
              >
                <Check size={13} /> {markingId === o.id ? "Saving…" : "POS Entered"}
              </button>
            )}
          </div>
        ))}
        {!loading && result.orders.length === 0 && <EmptyState text="Nothing pending — every order has been entered into the POS." />}
      </div>

      {result.total > PENDING_POS_PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 12.5 }}>
          <span style={{ color: "#8A8272" }}>
            Showing {(page - 1) * PENDING_POS_PAGE_SIZE + 1}–{Math.min(page * PENDING_POS_PAGE_SIZE, result.total)} of {result.total.toLocaleString()}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, opacity: page <= 1 ? 0.5 : 1 }}>Prev</button>
            <span style={{ color: "#8A8272" }}>Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Competitors View (manager) ----------
// Two halves: the master list itself (name + supplier + offer details, kept
// clean by only managers editing it — reps just pick from it), and a feed of
// what reps actually saw in the field, logged from Check-In. Neither table
// changes the other; this is where a manager reads what's been collected.
function CompetitorsView({ canEdit, competitors, onAdd, onUpdate, onRemove, onAddProduct, onUpdateProduct, onRemoveProduct, onImportProducts }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", supplierName: "", supplierContact: "", offerDetails: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [confirmId, setConfirmId] = useState(null);

  const emptyProductForm = { competitorName: "", productName: "", genericName: "", form: "", dosage: "", packSize: "", price: "", discountRate: "", notes: "" };
  const [productSearch, setProductSearch] = useState("");
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showImportProducts, setShowImportProducts] = useState(false);
  const [productForm, setProductForm] = useState(emptyProductForm);
  const [productSaving, setProductSaving] = useState(false);
  const [productError, setProductError] = useState("");
  const [editingProductId, setEditingProductId] = useState(null);
  const [editProductForm, setEditProductForm] = useState({});
  const [confirmProductId, setConfirmProductId] = useState(null);
  // Both self-fetched now instead of being shipped in full on every 30s
  // bootstrap poll — products via server-side search (this is the tab that
  // grows via Excel import), sightings as a small capped recent feed.
  const [products, setProducts] = useState([]);
  const [productsTotal, setProductsTotal] = useState(0);
  const [sightings, setSightings] = useState([]);

  const loadProducts = useCallback(() => {
    api.getCompetitorProducts({ q: productSearch }).then((data) => {
      setProducts(data.competitorProducts || []);
      setProductsTotal(data.total || 0);
    }).catch(() => { setProducts([]); setProductsTotal(0); });
  }, [productSearch]);
  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => {
    api.getCompetitorSightings({}).then((data) => setSightings(data.sightings || [])).catch(() => setSightings([]));
  }, []);

  const submitAdd = async () => {
    if (!form.name.trim()) { setError("Competitor name is required."); return; }
    setSaving(true);
    setError("");
    try {
      await onAdd(form);
      setForm({ name: "", supplierName: "", supplierContact: "", offerDetails: "", notes: "" });
      setShowAdd(false);
    } catch (e) {
      setError(e?.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm({ name: c.name, supplierName: c.supplierName, supplierContact: c.supplierContact, offerDetails: c.offerDetails, notes: c.notes });
  };
  const saveEdit = async (id) => {
    await onUpdate(id, editForm);
    setEditingId(null);
  };

  // Search now happens server-side (see loadProducts above) — products is
  // already exactly what matches productSearch.
  const filteredProducts = products;

  const submitAddProduct = async () => {
    if (!productForm.competitorName.trim() || !productForm.productName.trim()) {
      setProductError("Competitor and product name are required.");
      return;
    }
    setProductSaving(true);
    setProductError("");
    try {
      await onAddProduct(productForm);
      setProductForm(emptyProductForm);
      setShowAddProduct(false);
      loadProducts();
    } catch (e) {
      setProductError(e?.message || "Couldn't save.");
    } finally {
      setProductSaving(false);
    }
  };

  const startEditProduct = (p) => {
    setEditingProductId(p.id);
    setEditProductForm({ competitorName: p.competitorName, productName: p.productName, genericName: p.genericName, form: p.form, dosage: p.dosage, packSize: p.packSize, price: p.price, discountRate: p.discountRate, notes: p.notes });
  };
  const saveEditProduct = async (id) => {
    await onUpdateProduct(id, editProductForm);
    setEditingProductId(null);
    loadProducts();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Competitors</h2>
        {canEdit && (
          <button
            onClick={() => setShowAdd((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}
          >
            <Plus size={14} /> Add competitor
          </button>
        )}
      </div>
      {!canEdit && (
        <p style={{ fontSize: 12.5, color: "#8A8272", marginTop: -8, marginBottom: 16 }}>
          Shared by your manager — use this to see what other reps are running into and negotiate accordingly.
        </p>
      )}

      {canEdit && showAdd && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Competitor name" style={inputStyle} />
            <input value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} placeholder="Supplier name" style={inputStyle} />
            <input value={form.supplierContact} onChange={(e) => setForm({ ...form, supplierContact: e.target.value })} placeholder="Supplier contact (phone/email)" style={inputStyle} />
            <input value={form.offerDetails} onChange={(e) => setForm({ ...form, offerDetails: e.target.value })} placeholder="Offer details (pricing, terms, promos)" style={inputStyle} />
          </div>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Other notes" rows={2} style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }} />
          {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 8 }}>{error}</div>}
          <button disabled={saving} onClick={submitAdd} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
            {saving ? "Saving…" : "Save competitor"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
        {competitors.map((c) => (
          <div key={c.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            {canEdit && editingId === c.id ? (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="Competitor name" style={inputStyle} />
                  <input value={editForm.supplierName} onChange={(e) => setEditForm({ ...editForm, supplierName: e.target.value })} placeholder="Supplier name" style={inputStyle} />
                  <input value={editForm.supplierContact} onChange={(e) => setEditForm({ ...editForm, supplierContact: e.target.value })} placeholder="Supplier contact" style={inputStyle} />
                  <input value={editForm.offerDetails} onChange={(e) => setEditForm({ ...editForm, offerDetails: e.target.value })} placeholder="Offer details" style={inputStyle} />
                </div>
                <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(c.id)} style={{ fontSize: 12, background: "#1F2A24", color: "#FAF7F2", border: "none", borderRadius: 6, padding: "7px 12px" }}>Save</button>
                  <button onClick={() => setEditingId(null)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "7px 12px" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
                  {c.supplierName && (
                    <div style={{ fontSize: 12, color: "#8A8272", marginTop: 2 }}>
                      Supplier: {c.supplierName}{c.supplierContact ? ` · ${c.supplierContact}` : ""}
                    </div>
                  )}
                  {c.offerDetails && <div style={{ fontSize: 12.5, marginTop: 4 }}>{c.offerDetails}</div>}
                  {c.notes && <div style={{ fontSize: 12, color: "#8A8272", marginTop: 4 }}>{c.notes}</div>}
                </div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => startEdit(c)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Edit</button>
                    {confirmId === c.id ? (
                      <>
                        <button onClick={() => { onRemove(c.id); setConfirmId(null); }} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>Yes</button>
                        <button onClick={() => setConfirmId(null)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmId(c.id)} style={{ fontSize: 12, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>Delete</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {competitors.length === 0 && <EmptyState text="No competitors added yet." />}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Recent sightings from the field ({sightings.length})</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sightings.slice(0, LIST_DISPLAY_CAP).map((s) => (
          <div key={s.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "10px 12px", fontSize: 12.5 }}>
            <strong>{s.competitorName}</strong> at {s.client} — logged by {s.repName || "unknown"} on {new Date(s.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            {s.notes && <div style={{ color: "#8A8272", marginTop: 2 }}>{s.notes}</div>}
          </div>
        ))}
        {sightings.length === 0 && <EmptyState text="No competitor sightings logged yet." />}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "28px 0 10px", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: "#8A8272" }}>Competitor price list</h3>
        {canEdit && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { setShowImportProducts((v) => !v); setShowAddProduct(false); }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24", fontSize: 12.5, fontWeight: 500 }}
            >
              <Upload size={14} /> Import Excel
            </button>
            <button
              onClick={() => { setShowAddProduct((v) => !v); setShowImportProducts(false); }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}
            >
              <Plus size={14} /> Add product
            </button>
          </div>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: "#8A8272", marginTop: -4, marginBottom: 12 }}>
        Search by generic name (e.g. "magnesium") to see every competitor brand that carries it, with pricing.
      </p>
      <input
        value={productSearch}
        onChange={(e) => setProductSearch(e.target.value)}
        placeholder="Search by generic or brand name…"
        style={{ ...inputStyle, marginBottom: 14 }}
      />

      {canEdit && showImportProducts && (
        <CompetitorProductExcelImportSection
          competitors={competitors}
          onImport={(products) => onImportProducts(products).then((r) => { loadProducts(); return r; })}
          onDone={() => setShowImportProducts(false)}
        />
      )}

      {canEdit && showAddProduct && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <input value={productForm.competitorName} onChange={(e) => setProductForm({ ...productForm, competitorName: e.target.value })} placeholder="Competitor name" style={inputStyle} list="competitor-name-options" />
            <input value={productForm.productName} onChange={(e) => setProductForm({ ...productForm, productName: e.target.value })} placeholder="Brand / product name" style={inputStyle} />
            <input value={productForm.genericName} onChange={(e) => setProductForm({ ...productForm, genericName: e.target.value })} placeholder="Generic name (e.g. Magnesium)" style={inputStyle} />
            <input value={productForm.form} onChange={(e) => setProductForm({ ...productForm, form: e.target.value })} placeholder="Type (tablet, capsule, syrup…)" style={inputStyle} list="pill-form-options" />
            <input value={productForm.dosage} onChange={(e) => setProductForm({ ...productForm, dosage: e.target.value })} placeholder="Dose per pill (e.g. 500mg)" style={inputStyle} />
            <input value={productForm.packSize} onChange={(e) => setProductForm({ ...productForm, packSize: e.target.value })} placeholder="Number of pills (e.g. 20)" style={inputStyle} />
            <input value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} placeholder="Public price" style={inputStyle} />
            <input value={productForm.discountRate} onChange={(e) => setProductForm({ ...productForm, discountRate: e.target.value })} placeholder="Supplier offer to pharmacies (%)" style={inputStyle} />
          </div>
          <textarea value={productForm.notes} onChange={(e) => setProductForm({ ...productForm, notes: e.target.value })} placeholder="Other notes" rows={2} style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }} />
          {productError && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 8 }}>{productError}</div>}
          <button disabled={productSaving} onClick={submitAddProduct} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
            {productSaving ? "Saving…" : "Save product"}
          </button>
        </div>
      )}

      <datalist id="competitor-name-options">
        {competitors.map((c) => <option key={c.id} value={c.name} />)}
      </datalist>
      <datalist id="pill-form-options">
        {["Tablet", "Capsule", "Syrup", "Injection", "Cream / Ointment", "Drops", "Sachet"].map((f) => <option key={f} value={f} />)}
      </datalist>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredProducts.slice(0, LIST_DISPLAY_CAP).map((p) => (
          <div key={p.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            {canEdit && editingProductId === p.id ? (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <input value={editProductForm.competitorName} onChange={(e) => setEditProductForm({ ...editProductForm, competitorName: e.target.value })} placeholder="Competitor name" style={inputStyle} />
                  <input value={editProductForm.productName} onChange={(e) => setEditProductForm({ ...editProductForm, productName: e.target.value })} placeholder="Brand / product name" style={inputStyle} />
                  <input value={editProductForm.genericName} onChange={(e) => setEditProductForm({ ...editProductForm, genericName: e.target.value })} placeholder="Generic name" style={inputStyle} />
                  <input value={editProductForm.form} onChange={(e) => setEditProductForm({ ...editProductForm, form: e.target.value })} placeholder="Type (tablet, capsule, syrup…)" style={inputStyle} list="pill-form-options" />
                  <input value={editProductForm.dosage} onChange={(e) => setEditProductForm({ ...editProductForm, dosage: e.target.value })} placeholder="Dose per pill" style={inputStyle} />
                  <input value={editProductForm.packSize} onChange={(e) => setEditProductForm({ ...editProductForm, packSize: e.target.value })} placeholder="Number of pills" style={inputStyle} />
                  <input value={editProductForm.price} onChange={(e) => setEditProductForm({ ...editProductForm, price: e.target.value })} placeholder="Public price" style={inputStyle} />
                  <input value={editProductForm.discountRate} onChange={(e) => setEditProductForm({ ...editProductForm, discountRate: e.target.value })} placeholder="Supplier offer (%)" style={inputStyle} />
                </div>
                <textarea value={editProductForm.notes} onChange={(e) => setEditProductForm({ ...editProductForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEditProduct(p.id)} style={{ fontSize: 12, background: "#1F2A24", color: "#FAF7F2", border: "none", borderRadius: 6, padding: "7px 12px" }}>Save</button>
                  <button onClick={() => setEditingProductId(null)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "7px 12px" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {p.productName} <span style={{ fontWeight: 400, color: "#8A8272" }}>— {p.competitorName}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#8A8272", marginTop: 2 }}>
                    {p.genericName && <span>{p.genericName}</span>}
                    {p.form && <span> · {p.form}</span>}
                    {p.dosage && <span> · {p.dosage}</span>}
                    {p.packSize && <span> · {p.packSize} pills</span>}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    {p.price && <span style={{ fontWeight: 600 }}>Public price: {p.price}</span>}
                    {p.discountRate && <span style={{ color: "#8A8272" }}> · {p.discountRate}% supplier offer</span>}
                  </div>
                  {p.notes && <div style={{ fontSize: 12, color: "#8A8272", marginTop: 4 }}>{p.notes}</div>}
                </div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => startEditProduct(p)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Edit</button>
                    {confirmProductId === p.id ? (
                      <>
                        <button onClick={() => { onRemoveProduct(p.id).then(loadProducts); setConfirmProductId(null); }} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>Yes</button>
                        <button onClick={() => setConfirmProductId(null)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmProductId(p.id)} style={{ fontSize: 12, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>Delete</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {filteredProducts.length === 0 && <EmptyState text={productSearch.trim() ? "No matching products found." : "No competitor products added yet."} />}
        {productsTotal > filteredProducts.length && (
          <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 4 }}>
            Showing {filteredProducts.length} of {productsTotal.toLocaleString()} — use search to narrow the list.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Competitor product Excel import (manager) ----------
// Same shape as the Pharmacies/Doctors Excel importers: map your sheet's
// columns to what the app needs, preview, confirm. If the whole sheet is one
// competitor's price list, "Assign all to a competitor" saves mapping a
// column at all; if it's a mixed sheet, map a Competitor column per row instead.
function CompetitorProductExcelImportSection({ competitors, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const emptyMapping = { competitorName: "", productName: "", genericName: "", form: "", dosage: "", packSize: "", price: "", discountRate: "", notes: "" };
  const [mapping, setMapping] = useState(emptyMapping);
  const [assignAllTo, setAssignAllTo] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const readSheet = (wb, sheetName) => {
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
    const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
    setHeaders(headerRow);
    setRows(dataRows);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        setSelectedSheet(wb.SheetNames[0]);
        readSheet(wb, wb.SheetNames[0]);
        setMapping(emptyMapping);
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    setMapping(emptyMapping);
  };

  const parsed = useMemo(() => {
    if (!mapping.productName || (!mapping.competitorName && !assignAllTo)) return { valid: [], skipped: 0 };
    const idx = (field) => headers.indexOf(mapping[field]);
    const competitorIdx = idx("competitorName");
    const productIdx = idx("productName");
    const genericIdx = idx("genericName");
    const formIdx = idx("form");
    const dosageIdx = idx("dosage");
    const packSizeIdx = idx("packSize");
    const priceIdx = idx("price");
    const discountIdx = idx("discountRate");
    const notesIdx = idx("notes");

    let skipped = 0;
    const valid = [];
    rows.forEach((r) => {
      const productName = String(r[productIdx] ?? "").trim();
      const rowCompetitor = competitorIdx >= 0 ? String(r[competitorIdx] ?? "").trim() : "";
      const competitorName = rowCompetitor || assignAllTo;
      if (!productName || !competitorName) { skipped++; return; }
      valid.push({
        competitorName,
        productName,
        genericName: genericIdx >= 0 ? String(r[genericIdx] ?? "").trim() : "",
        form: formIdx >= 0 ? String(r[formIdx] ?? "").trim() : "",
        dosage: dosageIdx >= 0 ? String(r[dosageIdx] ?? "").trim() : "",
        packSize: packSizeIdx >= 0 ? String(r[packSizeIdx] ?? "").trim() : "",
        price: priceIdx >= 0 ? String(r[priceIdx] ?? "").trim() : "",
        discountRate: discountIdx >= 0 ? String(r[discountIdx] ?? "").trim() : "",
        notes: notesIdx >= 0 ? String(r[notesIdx] ?? "").trim() : "",
      });
    });
    return { valid, skipped };
  }, [mapping, rows, headers, assignAllTo]);

  const canImport = mapping.productName && (mapping.competitorName || assignAllTo) && parsed.valid.length > 0;

  const doImport = async () => {
    setError("");
    setImporting(true);
    try {
      await onImport(parsed.valid);
      setResult({ count: parsed.valid.length });
      setWorkbook(null);
      setHeaders([]);
      setRows([]);
      setSheetNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const fieldSelect = (field, label, required) => (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>
        {label}{required ? " *" : " (optional)"}
      </label>
      <select value={mapping[field]} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))} style={inputStyle}>
        <option value="">{required ? "— select a column —" : "— none —"}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Upload a competitor price list (Excel file)</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Item name, number of pills, type of pills, dose per pill, public price, supplier offer — match your sheet's columns below, preview the result, then confirm.
      </p>

      <button
        onClick={() => fileInputRef.current?.click()}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500, marginBottom: 10 }}
      >
        <Upload size={15} /> Choose Excel file
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />

      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}><Check size={14} /> Imported {result.count} products.</div>}

      {headers.length > 0 && (
        <div style={{ padding: 12, background: "#FAF7F2", borderRadius: 8 }}>
          {sheetNames.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Sheet</label>
              <select value={selectedSheet} onChange={(e) => changeSheet(e.target.value)} style={inputStyle}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Assign all rows to a competitor (optional)</label>
            <input
              value={assignAllTo}
              onChange={(e) => setAssignAllTo(e.target.value)}
              placeholder="Use this if the whole sheet is one competitor's list"
              style={inputStyle}
              list="competitor-name-options"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            {fieldSelect("competitorName", "Competitor column (per-row, overrides above)", false)}
            {fieldSelect("productName", "Item name", true)}
            {fieldSelect("genericName", "Generic name", false)}
            {fieldSelect("form", "Type of pills (tablet, capsule…)", false)}
            {fieldSelect("dosage", "Dose per pill", false)}
            {fieldSelect("packSize", "Number of pills", false)}
            {fieldSelect("price", "Public price", false)}
            {fieldSelect("discountRate", "Supplier offer (%)", false)}
            {fieldSelect("notes", "Notes", false)}
          </div>

          <div style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 12 }}>
            {parsed.valid.length} of {rows.length} rows ready to import{parsed.skipped > 0 ? ` (${parsed.skipped} skipped — missing item name or competitor)` : ""}.
          </div>

          {parsed.valid.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #E5DFD3", borderRadius: 8, marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#F0EAE0" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Competitor</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Item</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Generic</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.valid.slice(0, 200).map((p, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                      <td style={{ padding: "6px 8px" }}>{p.competitorName}</td>
                      <td style={{ padding: "6px 8px" }}>{p.productName}</td>
                      <td style={{ padding: "6px 8px" }}>{p.genericName}</td>
                      <td style={{ padding: "6px 8px" }}>{p.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.valid.length > 200 && (
                <div style={{ padding: "6px 8px", fontSize: 11.5, color: "#8A8272" }}>…and {parsed.valid.length - 200} more.</div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!canImport || importing} onClick={doImport} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: canImport ? "#1F2A24" : "#B8B2A3", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
              {importing ? "Importing…" : `Import ${parsed.valid.length} products`}
            </button>
            <button onClick={onDone} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Visit Cadence View ----------
// Answers "should I be visiting this pharmacy/doctor more or less often" —
// total visits, days since the last one, and the average gap between
// visits, against the same Tier A/B/C cadence already shown on Pharmacies/
// Doctors. Manager/supervisor gets the whole team; a plain rep gets only
// their own scope (the server already filters this — see GET
// /api/visit-cadence), matching "each rep sees their own visits."
function VisitCadenceView({ role, isSupervisor, repNames }) {
  const isTeamWide = role === "manager" || isSupervisor;
  const [cadence, setCadence] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [repFilter, setRepFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all"); // all | pharmacy | doctor
  const [sortBy, setSortBy] = useState("overdue"); // overdue | totalVisits | avgGap | name

  useEffect(() => {
    api.getVisitCadence()
      .then((data) => setCadence(data.cadence || []))
      .catch((e) => setError(e.message || "Couldn't load visit cadence."));
  }, []);

  const rows = (cadence || []).map((c) => {
    const days = c.lastVisit ? daysSince(c.lastVisit) : null;
    const cadenceDays = TIER_CADENCE[c.tier] || 30;
    const overdue = !c.stopped && (days === null || days > cadenceDays);
    return { ...c, days, cadenceDays, overdue };
  });

  const filtered = rows
    .filter((r) => (typeFilter === "all" ? true : r.entityType === typeFilter))
    .filter((r) => (isTeamWide && repFilter !== "all" ? r.assignedRep === repFilter : true))
    .filter((r) => r.entityName.toLowerCase().includes(search.toLowerCase().trim()));

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") return a.entityName.localeCompare(b.entityName);
    if (sortBy === "totalVisits") return b.totalVisits - a.totalVisits;
    if (sortBy === "avgGap") return (b.avgDaysBetweenVisits ?? -1) - (a.avgDaysBetweenVisits ?? -1);
    // Most overdue (or never-visited) first, stopped entities pushed to the bottom.
    if (a.stopped !== b.stopped) return a.stopped ? 1 : -1;
    return (b.days ?? 99999) - (a.days ?? 99999);
  });

  const shown = sorted.slice(0, LIST_DISPLAY_CAP);

  if (error) return <div style={{ fontSize: 12.5, color: "#B33A3A" }}>{error}</div>;
  if (cadence === null) return <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>;

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Visit cadence</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        {isTeamWide
          ? `How often each pharmacy and doctor is actually being visited, across the whole team. Same Tier A/B/C cadence as Pharmacies/Doctors (A: ${TIER_CADENCE.A}d · B: ${TIER_CADENCE.B}d · C: ${TIER_CADENCE.C}d) — use it to spot who's overdue, who's stopped, and where visit frequency should go up or down.`
          : `How often you're actually visiting your own pharmacies and doctors, based on your logged visits. Same cadence targets as Pharmacies/Doctors (A: ${TIER_CADENCE.A}d · B: ${TIER_CADENCE.B}d · C: ${TIER_CADENCE.C}d).`}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name…" style={{ ...inputStyle, maxWidth: 220 }} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }}>
          <option value="all">All types</option>
          <option value="pharmacy">Pharmacies</option>
          <option value="doctor">Doctors</option>
        </select>
        {isTeamWide && (
          <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
            <option value="all">All reps</option>
            {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
          <option value="overdue">Sort: Most overdue first</option>
          <option value="totalVisits">Sort: Most visits first</option>
          <option value="avgGap">Sort: Widest gap first</option>
          <option value="name">Sort: Name</option>
        </select>
      </div>

      {sorted.length > LIST_DISPLAY_CAP && (
        <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 10 }}>
          Showing {LIST_DISPLAY_CAP} of {sorted.length.toLocaleString()} — narrow with search or filters.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((r) => (
          <div
            key={`${r.entityType}-${r.entityName}`}
            style={{
              background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "10px 12px", fontSize: 12.5,
              borderLeft: `3px solid ${r.stopped ? "#B33A3A" : r.overdue ? "#C17817" : "#4C7A5E"}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
              <div>
                <strong>{r.entityName}</strong>{" "}
                <span style={{ color: "#8A8272" }}>
                  · {r.entityType === "doctor" ? "Doctor" : "Pharmacy"}{r.tier ? ` · Tier ${r.tier}` : ""}
                  {isTeamWide && r.assignedRep ? ` · ${r.assignedRep}` : ""}
                </span>
              </div>
              <div>
                {r.stopped ? (
                  <span style={{ color: "#B33A3A", fontWeight: 600 }}>🚫 Stopped</span>
                ) : r.overdue ? (
                  <span style={{ color: "#C17817", fontWeight: 600 }}>⚠ Overdue</span>
                ) : (
                  <span style={{ color: "#4C7A5E", fontWeight: 600 }}>On track</span>
                )}
              </div>
            </div>
            <div style={{ color: "#5B5445", marginTop: 4 }}>
              {r.totalVisits === 0
                ? "Never visited"
                : `${r.totalVisits} visit${r.totalVisits === 1 ? "" : "s"} · last ${r.days}d ago${r.avgDaysBetweenVisits !== null ? ` · avg every ${r.avgDaysBetweenVisits}d` : ""} · target every ${r.cadenceDays}d`}
            </div>
            {r.stopped && (
              <div style={{ color: "#B33A3A", marginTop: 4 }}>
                Stopped {new Date(r.stopDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                {r.stopReason ? ` — "${r.stopReason}"` : ""}
              </div>
            )}
          </div>
        ))}
        {shown.length === 0 && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Nothing to show.</div>}
      </div>
    </div>
  );
}

// ---------- Locations View (manager, check-in GPS history + punch in/out) ----------
function LocationsView({ role, isSupervisor, clients, doctors, repNames, onRemoveVisit, onAddComment }) {
  const [selectedRep, setSelectedRep] = useState("all");
  const [confirmId, setConfirmId] = useState(null);
  const [commentingId, setCommentingId] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [commentSaving, setCommentSaving] = useState(false);
  const canComment = role === "manager" || isSupervisor;

  // Both self-fetched here, scoped to the selected rep, instead of riding
  // along in every 30s bootstrap poll for every open session — this view is
  // manager/supervisor-only and opened rarely relative to how often a rep
  // in the field polls. visits already carries embedded comments (see
  // GET /api/visits), so no separate visitComments fetch is needed.
  const [visits, setVisits] = useState([]);
  const [punchLog, setPunchLog] = useState([]);
  const loadEvents = useCallback(() => {
    const repParam = selectedRep === "all" ? undefined : selectedRep;
    api.getVisits({ repName: repParam, all: true }).then((data) => setVisits(data.visits || [])).catch(() => setVisits([]));
    api.getPunchLog({ repName: selectedRep, limit: 500 }).then((data) => setPunchLog(data.punchLog || [])).catch(() => setPunchLog([]));
  }, [selectedRep]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const submitComment = async (visitId) => {
    if (!commentText.trim()) return;
    setCommentSaving(true);
    try {
      await onAddComment(visitId, commentText.trim());
      setCommentText("");
      setCommentingId(null);
      loadEvents();
    } finally {
      setCommentSaving(false);
    }
  };

  // For each visit, cross-checks the GPS captured against the matching
  // pharmacy/doctor's own saved location (if it has one) — this is the
  // answer to "how do I know they were actually there," not just that some
  // GPS exists on the visit.
  const knownCoordsFor = (name) => {
    const key = name.toLowerCase().trim();
    const entity = clients.find((c) => c.name.toLowerCase().trim() === key) || doctors.find((d) => d.name.toLowerCase().trim() === key);
    return entity?.coordsLat && entity?.coordsLng ? { lat: Number(entity.coordsLat), lng: Number(entity.coordsLng) } : null;
  };

  const visitEvents = visits.map((v) => {
    const known = v.coords ? knownCoordsFor(v.client) : null;
    const mismatchKm = known ? haversineKm(Number(v.coords.lat), Number(v.coords.lng), known.lat, known.lng) : null;
    return {
      kind: "visit", id: v.id, repName: v.repName, time: v.time, coords: v.coords || null, label: v.client,
      mismatchKm: mismatchKm !== null && mismatchKm > LOCATION_MISMATCH_KM ? mismatchKm : null,
      comments: v.comments || [],
    };
  });

  const punchEvents = (punchLog || [])
    .filter((p) => p.coords)
    .map((p) => ({ kind: "punch", id: p.id, repName: p.repName, time: p.time, coords: p.coords, label: p.type === "in" ? "Punched in" : "Punched out", punchType: p.type }));

  const allEvents = [...visitEvents, ...punchEvents]
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  const shownEvents = allEvents.slice(0, LIST_DISPLAY_CAP);

  const doDelete = (id) => { onRemoveVisit(id).then(loadEvents); setConfirmId(null); };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Check-in locations</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Shows visit check-ins and punch in/out events, most recent first, with the GPS a rep recorded at that moment where available — this is what tells you whether they were actually at a pharmacy or doctor, not just that they logged something. This isn't live tracking — a web app can only record location at the moment a button is tapped.
        {role === "manager" && " You can delete a mistaken visit here."}
      </p>

      <div style={{ marginBottom: 14 }}>
        <select value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)} style={{ ...inputStyle, maxWidth: 240 }}>
          <option value="all">All reps</option>
          {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {allEvents.length > LIST_DISPLAY_CAP && (
        <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 10 }}>
          Showing the most recent {LIST_DISPLAY_CAP} of {allEvents.length.toLocaleString()} — pick a rep to narrow the list.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shownEvents.map((e) => (
          <div key={`${e.kind}-${e.id}`} style={{
            background: e.kind === "punch" ? (e.punchType === "in" ? "#EFF6F1" : "#FBF1EF") : "#fff",
            border: `1px solid ${e.kind === "punch" ? (e.punchType === "in" ? "#4C7A5E55" : "#B33A3A55") : "#E5DFD3"}`,
            borderRadius: 10, padding: 12,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {e.label}{e.repName ? ` · ${e.repName}` : ""}
                </div>
                <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                  {new Date(e.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {e.coords ? ` · ${e.coords.lat}, ${e.coords.lng}` : " · no GPS captured"}
                </div>
                {e.mismatchKm != null && (
                  <div style={{ fontSize: 11, color: "#B33A3A", fontWeight: 600, marginTop: 3 }}>
                    ⚠ {e.mismatchKm.toFixed(1)}km from {e.label}'s known location
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {e.coords && (
                  <a href={`https://maps.google.com/?q=${e.coords.lat},${e.coords.lng}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#4C7A5E", textDecoration: "none", border: "1px solid #4C7A5E33", borderRadius: 6, padding: "6px 10px" }}>
                    View on map
                  </a>
                )}
                {e.kind === "visit" && canComment && (
                  <button onClick={() => setCommentingId(commentingId === e.id ? null : e.id)} title="Comment on this visit" style={{ background: "none", border: "1px solid #E5DFD3", borderRadius: 6, padding: "5px 9px", color: "#5B5445" }}>
                    <MessageCircle size={13} />
                  </button>
                )}
                {e.kind === "visit" && role === "manager" && (
                  confirmId === e.id ? (
                    <>
                      <button onClick={() => doDelete(e.id)} style={{ fontSize: 11.5, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>Yes</button>
                      <button onClick={() => setConfirmId(null)} style={{ fontSize: 11.5, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmId(e.id)} title="Delete visit" style={{ background: "none", border: "none", color: "#B7AF9E", padding: 4 }}>
                      <X size={14} />
                    </button>
                  )
                )}
              </div>
            </div>

            {e.kind === "visit" && e.comments.length > 0 && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", flexDirection: "column", gap: 6 }}>
                {e.comments.map((c) => (
                  <div key={c.id} style={{ fontSize: 12, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "6px 10px" }}>
                    <strong>{c.authorName}</strong>: {c.text}
                  </div>
                ))}
              </div>
            )}

            {e.kind === "visit" && commentingId === e.id && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3", display: "flex", gap: 8 }}>
                <input
                  value={commentText}
                  onChange={(ev) => setCommentText(ev.target.value)}
                  placeholder="Leave a note for this rep…"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button disabled={commentSaving} onClick={() => submitComment(e.id)} style={{ fontSize: 12, padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontWeight: 500 }}>
                  {commentSaving ? "Saving…" : "Send"}
                </button>
              </div>
            )}
          </div>
        ))}
        {allEvents.length === 0 && <EmptyState text="No check-ins or punches yet." />}
      </div>
    </div>
  );
}

// ---------- Excel upload for pharmacies (add-only, built for very large files) ----------
const IMPORT_CHUNK_SIZE = 2000;

// Retries a single chunk write on transient failures (network blips, a
// momentary Sheets API rate-limit) instead of letting one hiccup abort the
// whole multi-thousand-row import.
async function importChunkWithRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return importChunkWithRetry(fn, attempt + 1);
  }
}

function ClientExcelImportSection({ existingClients, repNames, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", nameAr: "", phone: "", area: "", address: "", registrationNumber: "", assignedRep: "" });
  const [assignAllTo, setAssignAllTo] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const fileInputRef = useRef(null);

  const readSheet = (wb, sheetName) => {
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
    const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
    setHeaders(headerRow);
    setRows(dataRows);
  };

  const resetMapping = () => { setMapping({ name: "", nameAr: "", phone: "", area: "", address: "", registrationNumber: "", assignedRep: "" }); setAssignAllTo(""); };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        setSelectedSheet(wb.SheetNames[0]);
        readSheet(wb, wb.SheetNames[0]);
        resetMapping();
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    resetMapping();
  };

  const { newClients, skippedCount } = useMemo(() => {
    if (!mapping.name) return { newClients: [], skippedCount: 0 };
    const nameIdx = headers.indexOf(mapping.name);
    const nameArIdx = headers.indexOf(mapping.nameAr);
    const phoneIdx = headers.indexOf(mapping.phone);
    const areaIdx = headers.indexOf(mapping.area);
    const addressIdx = headers.indexOf(mapping.address);
    const regIdx = headers.indexOf(mapping.registrationNumber);
    const repIdx = headers.indexOf(mapping.assignedRep);

    const existingNames = new Set(existingClients.map((c) => c.name.toLowerCase().trim()));
    const seenInFile = new Set();
    const fresh = [];
    let skipped = 0;

    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase().trim();
      if (existingNames.has(key) || seenInFile.has(key)) { skipped++; return; }
      seenInFile.add(key);
      // A rep named per-row in the file (e.g. only some pharmacies already
      // belong to someone) wins over the blanket "assign all to" choice —
      // that dropdown is just the fallback for whatever's left blank.
      const rowRep = repIdx >= 0 ? String(r[repIdx] ?? "").trim() : "";
      fresh.push({
        name,
        nameAr: nameArIdx >= 0 ? String(r[nameArIdx] ?? "").trim() : "",
        phone: phoneIdx >= 0 ? String(r[phoneIdx] ?? "").trim() : "",
        area: areaIdx >= 0 ? String(r[areaIdx] ?? "").trim() : "",
        address: addressIdx >= 0 ? String(r[addressIdx] ?? "").trim() : "",
        registrationNumber: regIdx >= 0 ? String(r[regIdx] ?? "").trim() : "",
        assignedRep: rowRep || assignAllTo || "",
      });
    });

    return { newClients: fresh, skippedCount: skipped };
  }, [mapping, rows, headers, existingClients, assignAllTo]);

  const doImport = async () => {
    setError("");
    setImporting(true);
    setProgress({ done: 0, total: newClients.length });
    try {
      let added = 0;
      let serverSkipped = 0;
      for (let i = 0; i < newClients.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = newClients.slice(i, i + IMPORT_CHUNK_SIZE);
        const data = await importChunkWithRetry(() => api.importClientsBulk({ toAdd: chunk }));
        added += data?.added ?? chunk.length;
        serverSkipped += data?.skipped ?? 0;
        setProgress({ done: Math.min(i + IMPORT_CHUNK_SIZE, newClients.length), total: newClients.length });
      }
      await onImport({ toAdd: [] }); // one refresh now that every chunk is in, instead of one per chunk
      // The server's dedup is authoritative (it checks against the live
      // sheet, not this browser's possibly-stale snapshot) — report what it
      // actually skipped, added to what this preview already knew to skip
      // (duplicates within the file itself, which the server also skips but
      // can't distinguish from "already in the sheet" in its own count).
      setResult({ added, skipped: skippedCount + serverSkipped });
      setWorkbook(null);
      setHeaders([]);
      setRows([]);
      setSheetNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e.message || "Import failed. Whatever made it in before this error is already saved — reopen the file and re-import to pick up where it left off (already-added names get skipped automatically).");
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const fieldSelect = (field, label, required) => (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>
        {label}{required ? " *" : " (optional)"}
      </label>
      <select value={mapping[field]} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))} style={inputStyle}>
        <option value="">{required ? "— select a column —" : "— none —"}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Import pharmacies from Excel</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload an .xlsx file of pharmacies — handles files with tens of thousands of rows. Names that already exist in the system are skipped automatically; only new names get added.
      </p>

      <button
        onClick={() => fileInputRef.current?.click()}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500, marginBottom: 10 }}
      >
        <Upload size={15} /> Choose Excel file
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />

      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
          <Check size={14} /> Added {result.added} new pharmac{result.added === 1 ? "y" : "ies"}{result.skipped > 0 ? `, skipped ${result.skipped} already in the system` : ""}.
        </div>
      )}

      {headers.length > 0 && (
        <div style={{ padding: 12, background: "#FAF7F2", borderRadius: 8 }}>
          {sheetNames.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Sheet / tab</label>
              <select value={selectedSheet} onChange={(e) => changeSheet(e.target.value)} style={inputStyle}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {fieldSelect("name", "Name column", true)}
            {fieldSelect("nameAr", "Name in Arabic column", false)}
            {fieldSelect("phone", "Phone number column", false)}
            {fieldSelect("area", "Area column", false)}
            {fieldSelect("address", "Address column", false)}
            {fieldSelect("registrationNumber", "Registration number column", false)}
            {fieldSelect("assignedRep", "Assigned rep column (if the file already has one)", false)}
            <div>
              <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>
                Assign the rest to a rep (optional)
              </label>
              <select value={assignAllTo} onChange={(e) => setAssignAllTo(e.target.value)} style={inputStyle}>
                <option value="">— leave unassigned —</option>
                {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          {mapping.assignedRep && (
            <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 6 }}>
              Rows with a rep named in that column use it; everything else falls back to your "assign the rest" choice above.
            </div>
          )}

          {mapping.name && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#5B5445", marginBottom: 10 }}>
                {newClients.length} new pharmac{newClients.length === 1 ? "y" : "ies"} will be added
                {skippedCount > 0 ? `, ${skippedCount} already exist and will be skipped` : ""}.
              </div>

              {newClients.length > 0 && (
                <div style={{ overflowX: "auto", marginBottom: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#8A8272" }}>
                        <th style={{ padding: "4px 6px" }}>Name</th>
                        <th style={{ padding: "4px 6px" }}>Name (Arabic)</th>
                        <th style={{ padding: "4px 6px" }}>Phone</th>
                        <th style={{ padding: "4px 6px" }}>Area</th>
                        <th style={{ padding: "4px 6px" }}>Assigned rep</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newClients.slice(0, 5).map((c, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                          <td style={{ padding: "4px 6px" }}>{c.name}</td>
                          <td style={{ padding: "4px 6px" }} dir="rtl">{c.nameAr || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{c.phone || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{c.area || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{c.assignedRep || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {newClients.length > 5 && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 4 }}>...and {newClients.length - 5} more</div>}
                </div>
              )}

              {progress && (
                <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>
                  Importing {progress.done.toLocaleString()} / {progress.total.toLocaleString()}…
                </div>
              )}

              <button
                disabled={importing || newClients.length === 0}
                onClick={doImport}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: !importing && newClients.length > 0 ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
              >
                {importing ? "Importing…" : `Import ${newClients.length} new pharmac${newClients.length === 1 ? "y" : "ies"}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Pharmacies View (tiering + follow-up nudges) ----------
const CLIENT_FILLABLE_FIELDS = [
  { key: "phone", label: "WhatsApp number" },
  { key: "area", label: "Area" },
  { key: "address", label: "Address" },
  { key: "registrationNumber", label: "Registration number" },
  { key: "nameAr", label: "Name in Arabic" },
];

function ClientsView({ clients, role, repName, repNames, onAdd, onRemove, onBulkImport, onAssignRep, onUpdateDiscount, onCompleteInfo }) {
  const [completingId, setCompletingId] = useState(null);
  const [historyId, setHistoryId] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState("B");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [assignedRep, setAssignedRep] = useState("");
  const [discountRate, setDiscountRate] = useState("");
  const [search, setSearch] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const [statsByName, setStatsByName] = useState({});

  // The last few visits to this pharmacy, newest first — fetched only once
  // its history panel is actually expanded, not held for every row.
  useEffect(() => {
    if (!historyId) { setHistoryRows([]); return; }
    const c = clients.find((cl) => cl.id === historyId);
    if (!c) return;
    api.getVisits({ client: c.name, limit: 5 }).then((data) => setHistoryRows(data.visits || [])).catch(() => setHistoryRows([]));
  }, [historyId]);

  // Same navigator.geolocation pattern used for Punch In / Check-In — a GPS
  // fix taken while standing at the pharmacy is more accurate than
  // geocoding whatever gets typed into the address field.
  const getLocation = () => {
    setLocating(true);
    setLocError("");
    getCurrentPositionSafe((coords) => {
      setLocating(false);
      if (coords) { setCoords(coords); return; }
      setLocError("Couldn't get location. Check permissions.");
    });
  };

  const addClient = () => {
    if (!name) return;
    onAdd({ name, nameAr, phone, tier, area, address, registrationNumber, assignedRep, discountRate, coordsLat: coords?.lat || "", coordsLng: coords?.lng || "" });
    setName(""); setNameAr(""); setPhone(""); setArea(""); setAddress(""); setRegistrationNumber(""); setTier("B"); setAssignedRep(""); setDiscountRate(""); setCoords(null); setLocError("");
    setShowAdd(false);
  };

  // Filters raw clients by the search text FIRST, then only fetches the
  // expensive per-row stuff (last visit, revenue) for whatever matched, in
  // one batched request — computing that for every pharmacy on every
  // keystroke against a full in-memory visits/orders history (the old
  // approach) is exactly what made this search feel slow, and holding that
  // full history in the browser at all is exactly what this rework removes.
  const q = search.toLowerCase().trim();
  const nameMatches = q
    ? clients.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.nameAr || "").includes(search.trim()) ||
        (c.area || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q) ||
        (c.registrationNumber || "").toLowerCase().includes(q)
      )
    : [];
  // Bounds the batch stats request even for a broad match (e.g. a whole
  // area) — generous relative to the final render cap since this set gets
  // sorted by leadScore before slicing down to LIST_DISPLAY_CAP.
  const statsTargets = nameMatches.slice(0, LIST_DISPLAY_CAP * 2);
  const statsKey = statsTargets.map((c) => c.name).join("|");

  useEffect(() => {
    if (statsTargets.length === 0) { setStatsByName({}); return; }
    api.getClientVisitStats(statsTargets.map((c) => c.name))
      .then((data) => setStatsByName(data.stats || {}))
      .catch(() => setStatsByName({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey]);

  const filteredRows = statsTargets
    .map((c) => {
      const stat = statsByName[c.name.toLowerCase().trim()] || { lastVisit: null, revenue: 0 };
      const days = stat.lastVisit ? daysSince(stat.lastVisit) : null;
      const cadence = TIER_CADENCE[c.tier] || 30;
      const overdue = days === null || days > cadence;
      const revenue = stat.revenue || 0;
      const leadScore = computeLeadScore({ tier: c.tier, days, cadence, revenue });
      return { ...c, days, overdue, cadence, revenue, leadScore };
    })
    .sort((a, b) => b.leadScore - a.leadScore);
  const shownRows = filteredRows.slice(0, LIST_DISPLAY_CAP);

  const tierColor = { A: "#B33A3A", B: "#D9A441", C: "#6B7280" };
  const scoreColor = (s) => (s >= 65 ? "#B33A3A" : s >= 40 ? "#C17817" : "#6B7280");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Pharmacies & follow-up</h2>
          <p style={{ fontSize: 13, color: "#8A8272", margin: "4px 0 0" }}>
            Tier A: visit every {TIER_CADENCE.A}d · B: {TIER_CADENCE.B}d · C: {TIER_CADENCE.C}d. Overdue pharmacies sort to the top.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {role === "manager" && (
            <button onClick={() => { setShowImport((v) => !v); setShowAdd(false); }} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
              background: "#fff", color: "#1F2A24", border: "1px solid #E5DFD3", fontSize: 13, fontWeight: 500,
            }}>
              <Upload size={15} /> Import from Excel
            </button>
          )}
          <button onClick={() => { setShowAdd((v) => !v); setShowImport(false); }} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
            background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500,
          }}>
            <Plus size={15} /> Add pharmacy
          </button>
        </div>
      </div>

      {role === "manager" && showImport && <ClientExcelImportSection existingClients={clients} repNames={repNames} onImport={onBulkImport} onDone={() => setShowImport(false)} />}

      {showAdd && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Field label="Pharmacy name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pharmacie Al Nour" style={inputStyle} /></Field>
            <Field label="Name in Arabic (optional)"><input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="مثال: صيدلية النور" dir="rtl" style={inputStyle} /></Field>
            <Field label="WhatsApp number"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} /></Field>
            <Field label="Tier">
              <select value={tier} onChange={(e) => setTier(e.target.value)} style={inputStyle}>
                <option value="A">A — high value, visit every 14d</option>
                <option value="B">B — standard, visit every 30d</option>
                <option value="C">C — low priority, visit every 60d</option>
              </select>
            </Field>
            <Field label="Area"><input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Jbeil" style={inputStyle} /></Field>
            <Field label="Address (optional)"><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Full street address" style={inputStyle} /></Field>
            <Field label="Registration number (optional)"><input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} style={inputStyle} /></Field>
            {role === "manager" ? (
              <Field label="Assigned sales rep (optional)">
                <select value={assignedRep} onChange={(e) => setAssignedRep(e.target.value)} style={inputStyle}>
                  <option value="">Unassigned</option>
                  {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Assigned sales rep">
                <div style={{ ...inputStyle, background: "#FAF7F2", color: "#5B5445" }}>{repName} (you)</div>
              </Field>
            )}
            {role === "manager" && (
              <Field label="Standard discount % (optional)">
                <input type="number" min="0" max="100" step="0.5" value={discountRate} onChange={(e) => setDiscountRate(e.target.value)} placeholder="e.g. 22.5" style={inputStyle} />
              </Field>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={getLocation} disabled={locating} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
              border: "1px solid #E5DFD3", background: "#FAF7F2", fontSize: 12.5, fontWeight: 500,
            }}>
              {locating ? <Loader2 size={14} className="spin" /> : <MapPin size={14} />}
              {locating ? "Locating…" : coords ? "Update GPS location" : "Capture GPS location (optional, more accurate than the address above)"}
            </button>
            {coords && <span className="kb-font-mono" style={{ fontSize: 11.5, color: "#4C7A5E" }}><Check size={12} style={{ verticalAlign: -1 }} /> {coords.lat}, {coords.lng}</span>}
          </div>
          {locError && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 12 }}>{locError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!name} onClick={addClient} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>Add pharmacy</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by pharmacy name, area, phone, or registration number…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

      {filteredRows.length > LIST_DISPLAY_CAP && (
        <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 10 }}>
          Showing {LIST_DISPLAY_CAP} of {filteredRows.length.toLocaleString()} — use search to narrow the list.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shownRows.map((c) => (
          <div key={c.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
                  {c.nameAr && <span dir="rtl" style={{ fontSize: 13, color: "#5B5445" }}>{c.nameAr}</span>}
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${tierColor[c.tier]}1A`, color: tierColor[c.tier] }}>Tier {c.tier}</span>
                  <span title="Priority score — tier, overdue-ness, and order history combined" style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${scoreColor(c.leadScore)}1A`, color: scoreColor(c.leadScore) }}>
                    Priority {c.leadScore}
                  </span>
                </div>
                <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 3 }}>
                  {c.area || "no area set"} {c.phone ? `· ${c.phone}` : ""} {c.revenue > 0 ? `· $${c.revenue.toLocaleString()} orders` : ""}
                </div>
                {c.address && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>{c.address}</div>}
                <div style={{ marginTop: 6 }}>
                  {role === "manager" ? (
                    <select
                      value={c.assignedRep || ""}
                      onChange={(e) => onAssignRep(c.id, e.target.value)}
                      style={{ fontSize: 11, padding: "3px 6px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", color: "#5B5445" }}
                    >
                      <option value="">Unassigned</option>
                      {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: "#F0EBE0", color: "#5B5445" }}>
                      {c.assignedRep ? `Rep: ${c.assignedRep}` : "Unassigned"}
                    </span>
                  )}
                  {role === "manager" ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, fontSize: 11, color: "#5B5445" }}>
                      Discount
                      <input
                        type="number" min="0" max="100" step="0.5"
                        defaultValue={c.discountRate || ""}
                        onBlur={(e) => {
                          const v = e.target.value;
                          if (v !== String(c.discountRate || "")) onUpdateDiscount(c.id, v);
                        }}
                        placeholder="0"
                        style={{ width: 50, padding: "2px 4px", fontSize: 11, borderRadius: 5, border: "1px solid #E5DFD3" }}
                      />%
                    </span>
                  ) : c.discountRate ? (
                    <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, marginLeft: 6, background: "#F0EBE0", color: "#5B5445" }}>
                      Discount: {c.discountRate}%
                    </span>
                  ) : null}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: c.overdue ? "#B33A3A" : "#4C7A5E" }}>
                  {c.days === null ? "never visited" : `${c.days}d since visit`}
                </div>
                {c.overdue && <div style={{ fontSize: 10.5, color: "#B33A3A" }}>overdue (cadence {c.cadence}d)</div>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
              <a href={mapsLinkFor(c)} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4C7A5E", textDecoration: "none" }}>
                <MapPin size={11} /> Get directions
              </a>
              <button onClick={() => setHistoryId(historyId === c.id ? null : c.id)} style={{ background: "none", border: "none", color: "#5B5445", fontSize: 11, fontWeight: 500 }}>
                {historyId === c.id ? "Hide history" : "History"}
              </button>
              {role === "rep" && (() => {
                const missing = CLIENT_FILLABLE_FIELDS.filter((f) => !c[f.key]);
                if (missing.length === 0) return null;
                return (
                  <button onClick={() => setCompletingId(completingId === c.id ? null : c.id)} style={{ background: "none", border: "none", color: "#C17817", fontSize: 11, fontWeight: 500 }}>
                    {completingId === c.id ? "Cancel" : "Complete missing info"}
                  </button>
                );
              })()}
              <button onClick={() => onRemove(c.id)} style={{ background: "none", border: "none", color: "#B7AF9E", fontSize: 11 }}>Remove</button>
            </div>
            {historyId === c.id && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {historyRows.map((v) => (
                  <div key={v.id} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#8A8272", fontSize: 11 }}>
                      <span>{v.repName || "unknown rep"}</span>
                      <span className="kb-font-mono">{new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span>
                    </div>
                    {v.notes && <div style={{ marginTop: 3 }}>{v.notes}</div>}
                    {v.mentionedItems && v.mentionedItems.length > 0 && (
                      <div style={{ marginTop: 3, color: "#5B5445" }}>
                        <strong style={{ fontWeight: 600 }}>Discussed: </strong>{v.mentionedItems.map((it) => it.name).join(", ")}
                      </div>
                    )}
                    {v.objectionTag && <div style={{ marginTop: 3, color: "#B33A3A" }}>{v.objectionTag}</div>}
                  </div>
                ))}
                {historyRows.length === 0 && <EmptyState text="No visits logged yet." />}
              </div>
            )}
            {role === "rep" && completingId === c.id && (
              <CompleteInfoForm
                fields={CLIENT_FILLABLE_FIELDS.filter((f) => !c[f.key])}
                onSave={(values) => onCompleteInfo(c.id, values)}
                onCancel={() => setCompletingId(null)}
              />
            )}
          </div>
        ))}
        {!q && clients.length > 0 && (
          <EmptyState text={`Search above to find a pharmacy — ${clients.length.toLocaleString()} in the system.`} />
        )}
        {q && filteredRows.length === 0 && <EmptyState text="No pharmacies match your search." />}
        {!q && clients.length === 0 && <EmptyState text="No pharmacies added yet." />}
      </div>
    </div>
  );
}

// ---------- Excel upload for doctors (add-only, built for very large files) ----------
function DoctorExcelImportSection({ existingDoctors, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", hospital: "", area: "", phone: "", specialty: "", address: "", registrationNumber: "" });
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const fileInputRef = useRef(null);

  const readSheet = (wb, sheetName) => {
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
    const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
    setHeaders(headerRow);
    setRows(dataRows);
  };

  const resetMapping = () => setMapping({ name: "", hospital: "", area: "", phone: "", specialty: "", address: "", registrationNumber: "" });

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        setSelectedSheet(wb.SheetNames[0]);
        readSheet(wb, wb.SheetNames[0]);
        resetMapping();
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    resetMapping();
  };

  const { newDoctors, skippedCount } = useMemo(() => {
    if (!mapping.name) return { newDoctors: [], skippedCount: 0 };
    const nameIdx = headers.indexOf(mapping.name);
    const hospitalIdx = headers.indexOf(mapping.hospital);
    const areaIdx = headers.indexOf(mapping.area);
    const phoneIdx = headers.indexOf(mapping.phone);
    const specialtyIdx = headers.indexOf(mapping.specialty);
    const addressIdx = headers.indexOf(mapping.address);
    const regIdx = headers.indexOf(mapping.registrationNumber);

    const existingNames = new Set(existingDoctors.map((d) => d.name.toLowerCase().trim()));
    const seenInFile = new Set();
    const fresh = [];
    let skipped = 0;

    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase().trim();
      if (existingNames.has(key) || seenInFile.has(key)) { skipped++; return; }
      seenInFile.add(key);
      fresh.push({
        name,
        hospital: hospitalIdx >= 0 ? String(r[hospitalIdx] ?? "").trim() : "",
        area: areaIdx >= 0 ? String(r[areaIdx] ?? "").trim() : "",
        phone: phoneIdx >= 0 ? String(r[phoneIdx] ?? "").trim() : "",
        specialty: specialtyIdx >= 0 ? String(r[specialtyIdx] ?? "").trim() : "",
        address: addressIdx >= 0 ? String(r[addressIdx] ?? "").trim() : "",
        registrationNumber: regIdx >= 0 ? String(r[regIdx] ?? "").trim() : "",
      });
    });

    return { newDoctors: fresh, skippedCount: skipped };
  }, [mapping, rows, headers, existingDoctors]);

  const doImport = async () => {
    setError("");
    setImporting(true);
    setProgress({ done: 0, total: newDoctors.length });
    try {
      let added = 0;
      let serverSkipped = 0;
      for (let i = 0; i < newDoctors.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = newDoctors.slice(i, i + IMPORT_CHUNK_SIZE);
        const data = await importChunkWithRetry(() => api.importDoctorsBulk({ toAdd: chunk }));
        added += data?.added ?? chunk.length;
        serverSkipped += data?.skipped ?? 0;
        setProgress({ done: Math.min(i + IMPORT_CHUNK_SIZE, newDoctors.length), total: newDoctors.length });
      }
      await onImport({ toAdd: [] }); // one refresh now that every chunk is in, instead of one per chunk
      // Server dedup is authoritative (checks the live sheet) — report it
      // alongside what this preview already caught as in-file duplicates.
      setResult({ added, skipped: skippedCount + serverSkipped });
      setWorkbook(null);
      setHeaders([]);
      setRows([]);
      setSheetNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e.message || "Import failed. Whatever made it in before this error is already saved — reopen the file and re-import to pick up where it left off (already-added names get skipped automatically).");
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const fieldSelect = (field, label, required) => (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>
        {label}{required ? " *" : " (optional)"}
      </label>
      <select value={mapping[field]} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))} style={inputStyle}>
        <option value="">{required ? "— select a column —" : "— none —"}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Import doctors from Excel</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload an .xlsx file of doctors — handles files with tens of thousands of rows. Names that already exist in the system are skipped automatically; only new names get added.
      </p>

      <button
        onClick={() => fileInputRef.current?.click()}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500, marginBottom: 10 }}
      >
        <Upload size={15} /> Choose Excel file
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />

      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
          <Check size={14} /> Added {result.added} new doctor{result.added === 1 ? "" : "s"}{result.skipped > 0 ? `, skipped ${result.skipped} already in the system` : ""}.
        </div>
      )}

      {headers.length > 0 && (
        <div style={{ padding: 12, background: "#FAF7F2", borderRadius: 8 }}>
          {sheetNames.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Sheet / tab</label>
              <select value={selectedSheet} onChange={(e) => changeSheet(e.target.value)} style={inputStyle}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {fieldSelect("name", "Name column", true)}
            {fieldSelect("hospital", "Hospital column", false)}
            {fieldSelect("area", "Area column", false)}
            {fieldSelect("phone", "Phone column", false)}
            {fieldSelect("specialty", "Specialty column", false)}
            {fieldSelect("address", "Address column", false)}
            {fieldSelect("registrationNumber", "Registration number column", false)}
          </div>

          {mapping.name && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#5B5445", marginBottom: 10 }}>
                {newDoctors.length} new doctor{newDoctors.length === 1 ? "" : "s"} will be added
                {skippedCount > 0 ? `, ${skippedCount} already exist and will be skipped` : ""}.
              </div>

              {newDoctors.length > 0 && (
                <div style={{ overflowX: "auto", marginBottom: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#8A8272" }}>
                        <th style={{ padding: "4px 6px" }}>Name</th>
                        <th style={{ padding: "4px 6px" }}>Hospital</th>
                        <th style={{ padding: "4px 6px" }}>Area</th>
                        <th style={{ padding: "4px 6px" }}>Specialty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newDoctors.slice(0, 5).map((d, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                          <td style={{ padding: "4px 6px" }}>{d.name}</td>
                          <td style={{ padding: "4px 6px" }}>{d.hospital || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{d.area || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{d.specialty || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {newDoctors.length > 5 && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 4 }}>...and {newDoctors.length - 5} more</div>}
                </div>
              )}

              {progress && (
                <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>
                  Importing {progress.done.toLocaleString()} / {progress.total.toLocaleString()}…
                </div>
              )}

              <button
                disabled={importing || newDoctors.length === 0}
                onClick={doImport}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: !importing && newDoctors.length > 0 ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
              >
                {importing ? "Importing…" : `Import ${newDoctors.length} new doctor${newDoctors.length === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Doctors View (tiering + follow-up nudges) ----------
const DOCTOR_FILLABLE_FIELDS = [
  { key: "phone", label: "Phone" },
  { key: "area", label: "Area" },
  { key: "hospital", label: "Hospital / clinic" },
  { key: "specialty", label: "Specialty" },
  { key: "address", label: "Address" },
  { key: "registrationNumber", label: "Registration number" },
];

function DoctorsView({ doctors, role, onAdd, onRemove, onBulkImport, onCompleteInfo }) {
  const [completingId, setCompletingId] = useState(null);
  const [historyId, setHistoryId] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [name, setName] = useState("");
  const [hospital, setHospital] = useState("");
  const [area, setArea] = useState("");
  const [phone, setPhone] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [tier, setTier] = useState("B");
  const [address, setAddress] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [search, setSearch] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const [statsByName, setStatsByName] = useState({});

  useEffect(() => {
    if (!historyId) { setHistoryRows([]); return; }
    const d = doctors.find((doc) => doc.id === historyId);
    if (!d) return;
    api.getVisits({ client: d.name, limit: 5 }).then((data) => setHistoryRows(data.visits || [])).catch(() => setHistoryRows([]));
  }, [historyId]);

  // Same navigator.geolocation pattern used for Punch In / Check-In / Add
  // Pharmacy — a GPS fix taken on-site beats geocoding a typed address.
  const getLocation = () => {
    setLocating(true);
    setLocError("");
    getCurrentPositionSafe((coords) => {
      setLocating(false);
      if (coords) { setCoords(coords); return; }
      setLocError("Couldn't get location. Check permissions.");
    });
  };

  const addDoctor = () => {
    if (!name) return;
    onAdd({ name, hospital, area, phone, specialty, tier, address, registrationNumber, coordsLat: coords?.lat || "", coordsLng: coords?.lng || "" });
    setName(""); setHospital(""); setArea(""); setPhone(""); setSpecialty(""); setTier("B"); setAddress(""); setRegistrationNumber(""); setCoords(null); setLocError("");
    setShowAdd(false);
  };

  // Same fix as Pharmacies: filter the raw list by the search text first,
  // then fetch the expensive per-doctor stuff (last visit, pending samples,
  // lead score) for whatever matched in one batched request, instead of
  // scanning a full visits/samples history held in the browser.
  const q = search.toLowerCase().trim();
  const nameMatches = q
    ? doctors.filter((d) =>
        d.name.toLowerCase().includes(q) ||
        (d.specialty || "").toLowerCase().includes(q) ||
        (d.area || "").toLowerCase().includes(q) ||
        (d.hospital || "").toLowerCase().includes(q) ||
        (d.phone || "").toLowerCase().includes(q) ||
        (d.registrationNumber || "").toLowerCase().includes(q)
      )
    : [];
  const statsTargets = nameMatches.slice(0, LIST_DISPLAY_CAP * 2);
  const statsKey = statsTargets.map((d) => d.name).join("|");

  useEffect(() => {
    if (statsTargets.length === 0) { setStatsByName({}); return; }
    api.getDoctorVisitStats(statsTargets.map((d) => d.name))
      .then((data) => setStatsByName(data.stats || {}))
      .catch(() => setStatsByName({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey]);

  const filteredRows = statsTargets
    .map((d) => {
      const stat = statsByName[d.name.toLowerCase().trim()] || { lastVisit: null, pendingSamples: [] };
      const days = stat.lastVisit ? daysSince(stat.lastVisit) : null;
      const cadence = TIER_CADENCE[d.tier] || 30;
      const overdue = days === null || days > cadence;
      const pendingSamples = stat.pendingSamples || [];
      const leadScore = computeLeadScore({ tier: d.tier, days, cadence, engagement: pendingSamples.length });
      return { ...d, days, overdue, cadence, pendingSamples, leadScore };
    })
    .sort((a, b) => b.leadScore - a.leadScore);
  const shownRows = filteredRows.slice(0, LIST_DISPLAY_CAP);
  const tierColor = { A: "#B33A3A", B: "#D9A441", C: "#6B7280" };
  const scoreColor = (s) => (s >= 65 ? "#B33A3A" : s >= 40 ? "#C17817" : "#6B7280");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Doctors & follow-up</h2>
          <p style={{ fontSize: 13, color: "#8A8272", margin: "4px 0 0" }}>
            Same cadence system as pharmacies — Tier A: every {TIER_CADENCE.A}d · B: {TIER_CADENCE.B}d · C: {TIER_CADENCE.C}d.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {role === "manager" && (
            <button onClick={() => { setShowImport((v) => !v); setShowAdd(false); }} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
              background: "#fff", color: "#1F2A24", border: "1px solid #E5DFD3", fontSize: 13, fontWeight: 500,
            }}>
              <Upload size={15} /> Import from Excel
            </button>
          )}
          <button onClick={() => { setShowAdd((v) => !v); setShowImport(false); }} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
            background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500,
          }}>
            <Plus size={15} /> Add doctor
          </button>
        </div>
      </div>

      {role === "manager" && showImport && <DoctorExcelImportSection existingDoctors={doctors} onImport={onBulkImport} onDone={() => setShowImport(false)} />}

      {showAdd && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Field label="Doctor name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dr. Nour Khalil" style={inputStyle} /></Field>
            <Field label="Hospital / clinic"><input value={hospital} onChange={(e) => setHospital(e.target.value)} placeholder="e.g. Beirut Hospital" style={inputStyle} /></Field>
            <Field label="Area"><input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Jbeil" style={inputStyle} /></Field>
            <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} /></Field>
            <Field label="Specialty"><input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="e.g. Cardiology" style={inputStyle} /></Field>
            <Field label="Tier">
              <select value={tier} onChange={(e) => setTier(e.target.value)} style={inputStyle}>
                <option value="A">A — high value, visit every 14d</option>
                <option value="B">B — standard, visit every 30d</option>
                <option value="C">C — low priority, visit every 60d</option>
              </select>
            </Field>
            <Field label="Address (optional)"><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Full street address" style={inputStyle} /></Field>
            <Field label="Registration number (optional)"><input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} style={inputStyle} /></Field>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={getLocation} disabled={locating} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
              border: "1px solid #E5DFD3", background: "#FAF7F2", fontSize: 12.5, fontWeight: 500,
            }}>
              {locating ? <Loader2 size={14} className="spin" /> : <MapPin size={14} />}
              {locating ? "Locating…" : coords ? "Update GPS location" : "Capture GPS location (optional, more accurate than the address above)"}
            </button>
            {coords && <span className="kb-font-mono" style={{ fontSize: 11.5, color: "#4C7A5E" }}><Check size={12} style={{ verticalAlign: -1 }} /> {coords.lat}, {coords.lng}</span>}
          </div>
          {locError && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 12 }}>{locError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!name} onClick={addDoctor} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>Add doctor</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by doctor name, specialty, area, hospital, or phone…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

      {filteredRows.length > LIST_DISPLAY_CAP && (
        <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 10 }}>
          Showing {LIST_DISPLAY_CAP} of {filteredRows.length.toLocaleString()} — use search to narrow the list.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shownRows.map((d) => (
          <div key={d.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{d.name}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${tierColor[d.tier]}1A`, color: tierColor[d.tier] }}>Tier {d.tier}</span>
                  <span title="Priority score — tier, overdue-ness, and sample engagement combined" style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${scoreColor(d.leadScore)}1A`, color: scoreColor(d.leadScore) }}>
                    Priority {d.leadScore}
                  </span>
                </div>
                <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 3 }}>
                  {d.hospital || "no hospital set"} · {d.area || "no area"} {d.phone ? `· ${d.phone}` : ""}
                </div>
                {d.address && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>{d.address}</div>}
                {d.specialty && <div style={{ fontSize: 11.5, color: "#5B5445", marginTop: 3 }}>{d.specialty}</div>}
                {d.pendingSamples.length > 0 && (
                  <div style={{ fontSize: 11, color: "#C17817", marginTop: 3, fontWeight: 500 }}>
                    Give next visit: {d.pendingSamples.map((s) => s.productName).join(", ")}
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: d.overdue ? "#B33A3A" : "#4C7A5E" }}>
                  {d.days === null ? "never visited" : `${d.days}d since visit`}
                </div>
                {d.overdue && <div style={{ fontSize: 10.5, color: "#B33A3A" }}>overdue (cadence {d.cadence}d)</div>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
              <a href={mapsLinkFor(d)} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4C7A5E", textDecoration: "none" }}>
                <MapPin size={11} /> Get directions
              </a>
              {role === "rep" && (() => {
                const missing = DOCTOR_FILLABLE_FIELDS.filter((f) => !d[f.key]);
                if (missing.length === 0) return null;
                return (
                  <button onClick={() => setCompletingId(completingId === d.id ? null : d.id)} style={{ background: "none", border: "none", color: "#C17817", fontSize: 11, fontWeight: 500 }}>
                    {completingId === d.id ? "Cancel" : "Complete missing info"}
                  </button>
                );
              })()}
              <button onClick={() => setHistoryId(historyId === d.id ? null : d.id)} style={{ background: "none", border: "none", color: "#5B5445", fontSize: 11, fontWeight: 500 }}>
                {historyId === d.id ? "Hide history" : "History"}
              </button>
              <button onClick={() => onRemove(d.id)} style={{ background: "none", border: "none", color: "#B7AF9E", fontSize: 11 }}>Remove</button>
            </div>
            {historyId === d.id && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {historyRows.map((v) => (
                  <div key={v.id} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#8A8272", fontSize: 11 }}>
                      <span>{v.repName || "unknown rep"}</span>
                      <span className="kb-font-mono">{new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span>
                    </div>
                    {v.notes && <div style={{ marginTop: 3 }}>{v.notes}</div>}
                    {v.mentionedItems && v.mentionedItems.length > 0 && (
                      <div style={{ marginTop: 3, color: "#5B5445" }}>
                        <strong style={{ fontWeight: 600 }}>Discussed: </strong>{v.mentionedItems.map((it) => it.name).join(", ")}
                      </div>
                    )}
                    {v.objectionTag && <div style={{ marginTop: 3, color: "#B33A3A" }}>{v.objectionTag}</div>}
                  </div>
                ))}
                {historyRows.length === 0 && <EmptyState text="No visits logged yet." />}
              </div>
            )}
            {role === "rep" && completingId === d.id && (
              <CompleteInfoForm
                fields={DOCTOR_FILLABLE_FIELDS.filter((f) => !d[f.key])}
                onSave={(values) => onCompleteInfo(d.id, values)}
                onCancel={() => setCompletingId(null)}
              />
            )}
          </div>
        ))}
        {!q && doctors.length > 0 && (
          <EmptyState text={`Search above to find a doctor — ${doctors.length.toLocaleString()} in the system.`} />
        )}
        {q && filteredRows.length === 0 && <EmptyState text="No doctors match your search." />}
        {!q && doctors.length === 0 && <EmptyState text="No doctors added yet." />}
      </div>
    </div>
  );
}

// ---------- Knowledge View (rep reference: talking points + drug/nutrient depletion) ----------
function KnowledgeView() {
  const [section, setSection] = useState("specialty"); // specialty | condition | drugs | reference
  const [search, setSearch] = useState("");
  const q = search.toLowerCase().trim();

  const filteredSpecialty = SPECIALTY_TALKING_POINTS.map((s) => ({
    ...s,
    topics: s.topics.filter((t) =>
      !q || s.specialty.toLowerCase().includes(q) || t.topic.toLowerCase().includes(q) || t.text.toLowerCase().includes(q)
    ),
  })).filter((s) => s.topics.length > 0 || s.specialty.toLowerCase().includes(q));

  const filteredCondition = CONDITION_TALKING_POINTS.filter((c) =>
    !q || c.condition.toLowerCase().includes(q) || c.items.some((i) => i.toLowerCase().includes(q))
  );

  const filteredDrugs = DRUG_NUTRIENT_DATA.filter((d) =>
    !q ||
    d.category.toLowerCase().includes(q) ||
    d.depletions.toLowerCase().includes(q) ||
    d.suggested.toLowerCase().includes(q) ||
    d.interactions.toLowerCase().includes(q)
  );

  const sectionBtn = (key, label) => (
    <button onClick={() => setSection(key)} style={{
      flex: 1, padding: "8px 12px", borderRadius: 8, border: section === key ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12, fontWeight: 500,
      background: section === key ? "#4C7A5E" : "#fff", color: section === key ? "#FAF7F2" : "#1F2A24",
    }}>
      {label}
    </button>
  );

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Rep knowledge base</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Reference material to prep before a visit — what to mention by specialty or condition, and how common medications affect nutrient levels. Not tied to any specific doctor record.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {sectionBtn("specialty", "By Specialty")}
        {sectionBtn("condition", "By Condition")}
        {sectionBtn("drugs", "Drug & Nutrient Depletion")}
        {sectionBtn("reference", "Reference Tables")}
      </div>

      {section !== "reference" && (
        <div style={{ position: "relative", marginBottom: 16 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ ...inputStyle, paddingLeft: 34 }}
          />
        </div>
      )}

      {section === "specialty" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredSpecialty.map((s) => (
            <div key={s.specialty} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{s.specialty}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {s.topics.map((t, i) => (
                  <div key={i} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{t.topic}</div>
                    <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{t.text}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {filteredSpecialty.length === 0 && <EmptyState text="No specialty matches your search." />}
        </div>
      )}

      {section === "condition" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
          {filteredCondition.map((c) => (
            <div key={c.condition} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{c.condition}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#5B5445", lineHeight: 1.6 }}>
                {c.items.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </div>
          ))}
          {filteredCondition.length === 0 && <EmptyState text="No condition matches your search." />}
        </div>
      )}

      {section === "drugs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredDrugs.map((d) => (
            <div key={d.category} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{d.category}</div>
              {d.description && <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 8, lineHeight: 1.5 }}>{d.description}</div>}
              {d.depletions && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#B33A3A" }}>Nutrient depletion</div>
                  <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{d.depletions}</div>
                </div>
              )}
              {d.suggested && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#4C7A5E" }}>Suggested supplementation</div>
                  <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{d.suggested}</div>
                </div>
              )}
              {d.interactions && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#C17817" }}>Potential interactions — use caution</div>
                  <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{d.interactions}</div>
                </div>
              )}
            </div>
          ))}
          {filteredDrugs.length === 0 && <EmptyState text="No drug class matches your search." />}
        </div>
      )}

      {section === "reference" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>B-Complex components</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {BCOMPLEX_INFO.map((b) => (
                <div key={b.vitamin} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  <strong>{b.vitamin}:</strong> <span style={{ color: "#5B5445" }}>{b.note}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Supplement effects on blood glucose (diabetes)</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#8A8272" }}>
                    <th style={{ padding: "4px 8px" }}>Supplement</th>
                    <th style={{ padding: "4px 8px" }}>Effect on blood glucose</th>
                    <th style={{ padding: "4px 8px" }}>Interaction with antidiabetic drugs</th>
                  </tr>
                </thead>
                <tbody>
                  {DIABETES_SUPPLEMENT_INTERACTIONS.map((r) => (
                    <tr key={r.supplement} style={{ borderTop: "1px solid #E5DFD3" }}>
                      <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.supplement}</td>
                      <td style={{ padding: "6px 8px", color: "#5B5445" }}>{r.glucoseEffect}</td>
                      <td style={{ padding: "6px 8px", color: "#5B5445" }}>{r.antidiabeticInteraction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#7A5B2E" }}>Notes</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#7A5B2E", lineHeight: 1.6 }}>
              {TALKING_POINTS_NOTES.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Training View ----------
function TrainingView() {
  const [section, setSection] = useState("overview"); // overview | mindset | profiling | framework | objections | value | growth

  const sectionBtn = (key, label) => (
    <button onClick={() => setSection(key)} style={{
      padding: "8px 12px", borderRadius: 8, border: section === key ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
      background: section === key ? "#4C7A5E" : "#fff", color: section === key ? "#FAF7F2" : "#1F2A24",
    }}>
      {label}
    </button>
  );

  const card = (children, key) => (
    <div key={key} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
      {children}
    </div>
  );

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Rep training course</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Internal Training Manual: Transitioning to Medical Representative for SITAVITAE PLUS.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", overflowX: "auto" }}>
        {sectionBtn("overview", "Overview")}
        {sectionBtn("mindset", "Customer-Centric Mindset")}
        {sectionBtn("profiling", "Behavioral Profiling")}
        {sectionBtn("framework", "6-Step Call Framework")}
        {sectionBtn("objections", "Objection Handling")}
        {sectionBtn("value", "Product Value")}
        {sectionBtn("growth", "Post-Call & Growth")}
      </div>

      {section === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{TRAINING_INTRO.title}</div>
              {TRAINING_INTRO.paragraphs.map((p, i) => (
                <div key={i} style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6, marginBottom: 8 }}>{p}</div>
              ))}
            </>,
            "intro"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{DIABETES_LANDSCAPE.title}</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6, marginBottom: 10 }}>{DIABETES_LANDSCAPE.intro}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {DIABETES_LANDSCAPE.stats.map((s, i) => (
                  <div key={i} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{s.label}</div>
                    <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </>,
            "landscape"
          )}
        </div>
      )}

      {section === "mindset" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{MODULE1_MINDSET.title}</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6 }}>{MODULE1_MINDSET.intro}</div>
            </>,
            "m1-intro"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Needs, Wants, and Demands</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {MODULE1_MINDSET.needsWantsDemands.map((n) => (
                  <div key={n.term} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <strong>{n.term}:</strong> <span style={{ color: "#5B5445" }}>{n.detail}</span>
                  </div>
                ))}
              </div>
            </>,
            "nwd"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Avoiding "Marketing Myopia"</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6 }}>{MODULE1_MINDSET.marketingMyopia}</div>
            </>,
            "myopia"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Physician Needs Analysis</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#8A8272" }}>
                      <th style={{ padding: "4px 8px" }}>Clinical needs (patient-focused)</th>
                      <th style={{ padding: "4px 8px" }}>Personal needs (physician-focused)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MODULE1_MINDSET.physicianNeeds.map((r, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                        <td style={{ padding: "6px 8px", color: "#5B5445" }}>{r.clinical}</td>
                        <td style={{ padding: "6px 8px", color: "#5B5445" }}>{r.personal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>,
            "needs-table"
          )}
        </div>
      )}

      {section === "profiling" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>The Four Color Energies</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {COLOR_ENERGIES.map((c) => (
                  <div key={c.name} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: "#5B5445", lineHeight: 1.5, marginBottom: 2 }}>{c.traits}</div>
                    <div style={{ fontSize: 11.5, color: "#B33A3A", marginBottom: 2 }}>Fear: {c.fear}</div>
                    <div style={{ fontSize: 12, color: "#4C7A5E" }}>Strategy: {c.strategy}</div>
                  </div>
                ))}
              </div>
            </>,
            "colors"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Physician Classifications</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {PHYSICIAN_TYPES.map((p) => (
                  <div key={p.type} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{p.type}</div>
                    <div style={{ fontSize: 12, color: "#8A8272", marginBottom: 4 }}>{p.description}</div>
                    <div style={{ fontSize: 12, color: "#5B5445", lineHeight: 1.5 }}><strong>Strategy:</strong> {p.strategy}</div>
                  </div>
                ))}
              </div>
            </>,
            "types"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Adoption Styles</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6 }}>{ADOPTION_STYLES}</div>
            </>,
            "adoption"
          )}
        </div>
      )}

      {section === "framework" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {CALL_FRAMEWORK.map((f) => (
            <div key={f.step} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14, display: "flex", gap: 12 }}>
              <div style={{
                flexShrink: 0, width: 26, height: 26, borderRadius: "50%", background: "#1F2A24", color: "#FAF7F2",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700,
              }}>
                {f.step}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{f.title}</div>
                <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6 }}>{f.detail}</div>
              </div>
            </div>
          ))}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{MOM_STRATEGY.title}</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6, marginBottom: 10 }}>{MOM_STRATEGY.intro}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {MOM_STRATEGY.steps.map((s, i) => (
                  <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <strong>{s.step}:</strong> <span style={{ color: "#5B5445" }}>{s.detail}</span>
                  </div>
                ))}
              </div>
            </>,
            "mom"
          )}
        </div>
      )}

      {section === "objections" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 4px" }}>
            Use the APACT model: Acknowledge, Probe, Answer, Confirm, Transmit.
          </p>
          {APACT_EXAMPLES.map((ex, i) => (
            <div key={i} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>{ex.concern}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><strong style={{ color: "#4C7A5E" }}>Acknowledge:</strong> <span style={{ color: "#5B5445" }}>{ex.acknowledge}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><strong style={{ color: "#4C7A5E" }}>Probe:</strong> <span style={{ color: "#5B5445" }}>{ex.probe}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><strong style={{ color: "#4C7A5E" }}>Answer:</strong> <span style={{ color: "#5B5445" }}>{ex.answer}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><strong style={{ color: "#4C7A5E" }}>Confirm:</strong> <span style={{ color: "#5B5445" }}>{ex.confirm}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><strong style={{ color: "#4C7A5E" }}>Transmit:</strong> <span style={{ color: "#5B5445" }}>{ex.transmit}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {section === "value" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{VALUE_PROPOSITION.title}</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6, marginBottom: 10 }}>{VALUE_PROPOSITION.clinicalIntro}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {VALUE_PROPOSITION.triggers.map((t) => (
                  <div key={t.name} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>{t.name}</div>
                    <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.5 }}>{t.detail}</div>
                  </div>
                ))}
              </div>
            </>,
            "triggers"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Value Differentiation</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {VALUE_PROPOSITION.differentiation.map((d) => (
                  <div key={d.name} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <strong>{d.name}:</strong> <span style={{ color: "#5B5445" }}>{d.detail}</span>
                  </div>
                ))}
              </div>
            </>,
            "diff"
          )}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Daily Treatment Cost breakdown</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {VALUE_PROPOSITION.priceBreakdown.map((r, i) => (
                  <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ color: "#8A8272" }}>{r.label}</span>
                    <span style={{ color: "#5B5445", fontWeight: 500, textAlign: "right" }}>{r.value}</span>
                  </div>
                ))}
              </div>
            </>,
            "price"
          )}
        </div>
      )}

      {section === "growth" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{POST_CALL_ANALYSIS.title}</div>
              <div style={{ fontSize: 12.5, color: "#5B5445", lineHeight: 1.6, marginBottom: 10 }}>{POST_CALL_ANALYSIS.intro}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {POST_CALL_ANALYSIS.items.map((it) => (
                  <div key={it.label} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <strong>{it.label}:</strong> <span style={{ color: "#5B5445" }}>{it.detail}</span>
                  </div>
                ))}
              </div>
            </>,
            "postcall"
          )}
          <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#7A5B2E" }}>{LEAG_PHILOSOPHY.title}</div>
            <div style={{ fontSize: 12.5, color: "#7A5B2E", lineHeight: 1.6, marginBottom: 10 }}>{LEAG_PHILOSOPHY.intro}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {LEAG_PHILOSOPHY.pillars.map((p) => (
                <div key={p.letter} style={{ fontSize: 12.5, lineHeight: 1.5, color: "#7A5B2E" }}>
                  <strong>{p.letter} — {p.word}:</strong> {p.detail}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Route View (simple nearest-neighbor route ordering) ----------
function RouteView({ clients, doctors }) {
  const [entityType, setEntityType] = useState("pharmacy"); // pharmacy | doctor
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [myLoc, setMyLoc] = useState(null);
  const [locating, setLocating] = useState(false);
  const [ordered, setOrdered] = useState(null);
  const [optimizing, setOptimizing] = useState(false);

  const entities = entityType === "pharmacy" ? clients : doctors;
  const filteredEntities = entities.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase().trim()) || (e.area || "").toLowerCase().includes(search.toLowerCase().trim())
  );
  const shownEntities = filteredEntities.slice(0, LIST_DISPLAY_CAP);

  const changeEntityType = (t) => { setEntityType(t); setSelected([]); setOrdered(null); };

  // Prefers the pharmacy/doctor's own saved location (GPS capture or
  // geocoded address) — falls back to wherever the last visit happened to
  // be logged from, for entries added before that existed. Fetched on
  // demand for just the handful of stops actually picked for today's
  // route, instead of scanning a full visits history held in state.
  const coordsFor = async (entity) => {
    if (entity.coordsLat && entity.coordsLng) return { lat: entity.coordsLat, lng: entity.coordsLng };
    const data = await api.getVisits({ client: entity.name, limit: 5 }).catch(() => ({ visits: [] }));
    const latestWithCoords = (data.visits || []).find((v) => v.coords);
    return latestWithCoords ? latestWithCoords.coords : null;
  };

  const toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const getMyLocation = () => {
    setLocating(true);
    getCurrentPositionSafe((coords) => {
      setLocating(false);
      if (coords) setMyLoc(coords);
    });
  };

  const optimize = async () => {
    setOptimizing(true);
    const selectedEntities = selected.map((id) => entities.find((c) => c.id === id)).filter(Boolean);
    const stops = await Promise.all(selectedEntities.map(async (c) => {
      const coords = await coordsFor(c);
      return { ...c, coords: coords ? { lat: parseFloat(coords.lat), lng: parseFloat(coords.lng) } : null };
    }));
    setOptimizing(false);
    const withCoords = stops.filter((s) => s.coords);
    const withoutCoords = stops.filter((s) => !s.coords);

    if (!myLoc || withCoords.length === 0) { setOrdered({ route: stops, note: "no-location" }); return; }

    let current = myLoc;
    const remaining = [...withCoords];
    const route = [];
    while (remaining.length) {
      remaining.sort((a, b) => haversineKm(current.lat, current.lng, a.coords.lat, a.coords.lng) - haversineKm(current.lat, current.lng, b.coords.lat, b.coords.lng));
      const next = remaining.shift();
      route.push(next);
      current = next.coords;
    }
    setOrdered({ route: [...route, ...withoutCoords], note: withoutCoords.length ? "partial" : "full" });
  };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Today's route</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Orders stops by straight-line distance from you, using each stop's last captured GPS. Not real driving directions — use judgement for one-way streets or traffic.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => changeEntityType("pharmacy")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: entityType === "pharmacy" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
          background: entityType === "pharmacy" ? "#4C7A5E" : "#fff", color: entityType === "pharmacy" ? "#FAF7F2" : "#1F2A24",
        }}>
          Pharmacies
        </button>
        <button onClick={() => changeEntityType("doctor")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: entityType === "doctor" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
          background: entityType === "doctor" ? "#4C7A5E" : "#fff", color: entityType === "doctor" ? "#FAF7F2" : "#1F2A24",
        }}>
          Doctors
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={getMyLocation} disabled={locating} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
          border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, fontWeight: 500,
        }}>
          {locating ? <Loader2 size={14} className="spin" /> : <MapPin size={14} />} {myLoc ? "Update my location" : "Capture my location"}
        </button>
        {myLoc && <span className="kb-font-mono" style={{ fontSize: 11, color: "#4C7A5E", alignSelf: "center" }}><Check size={12} style={{ verticalAlign: -1 }} /> location set</span>}
      </div>

      <button onClick={() => setShowPicker((v) => !v)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
        padding: "10px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff",
        fontSize: 13, fontWeight: 500, marginBottom: 8,
      }}>
        <span>{selected.length > 0 ? `${selected.length} selected` : `Select ${entityType === "pharmacy" ? "pharmacies" : "doctors"}…`}</span>
        <span style={{ color: "#8A8272" }}>{showPicker ? "▲" : "▼"}</span>
      </button>

      {selected.length > 0 && !showPicker && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {selected.map((id) => {
            const e = entities.find((x) => x.id === id);
            if (!e) return null;
            return (
              <span key={id} style={{ fontSize: 11.5, padding: "4px 9px", borderRadius: 6, background: "#F0EBE0", color: "#5B5445" }}>
                {e.name}
              </span>
            );
          })}
        </div>
      )}

      {showPicker && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ position: "relative", marginBottom: 8 }}>
            <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or area…"
              style={{ ...inputStyle, paddingLeft: 34 }}
            />
          </div>

          {filteredEntities.length > LIST_DISPLAY_CAP && (
            <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 6 }}>
              Showing {LIST_DISPLAY_CAP} of {filteredEntities.length.toLocaleString()} — narrow your search to see more.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {shownEntities.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                {c.name} <span style={{ fontSize: 10.5, color: "#8A8272" }}>({c.area || "no area"})</span>
              </label>
            ))}
            {filteredEntities.length === 0 && (
              <EmptyState text={entityType === "pharmacy" ? "Add pharmacies in the Pharmacies tab first." : "Add doctors in the Doctors tab first."} />
            )}
          </div>
        </div>
      )}

      <button onClick={optimize} disabled={selected.length === 0 || optimizing} style={{
        padding: "9px 18px", borderRadius: 8, border: "none",
        background: selected.length ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500, marginBottom: 20,
      }}>
        {optimizing ? "Optimizing…" : `Optimize order (${selected.length} selected)`}
      </button>

      {ordered && (
        <div>
          {ordered.note === "no-location" && <p style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>Capture your location first for a distance-based order — showing selected order as-is.</p>}
          {ordered.note === "partial" && <p style={{ fontSize: 12, color: "#D9A441", marginBottom: 10 }}>Some stops have no saved location yet (never visited, no address, no GPS) — they're listed last.</p>}
          {fullRouteMapsLink(ordered.route, myLoc) && (
            <a
              href={fullRouteMapsLink(ordered.route, myLoc)}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 14, padding: "9px 16px",
                borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500, textDecoration: "none",
              }}
            >
              <MapPin size={14} /> Open full route in Google Maps
            </a>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ordered.route.map((c, i) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                <span className="kb-font-mono" style={{ fontSize: 13, fontWeight: 600, color: "#C17817", width: 20 }}>{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: "#8A8272" }}>{c.area || "no area"}{!c.coords && " · no saved location"}</div>
                </div>
                <a href={mapsLinkFor(c)} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4C7A5E", textDecoration: "none", whiteSpace: "nowrap" }}>
                  <MapPin size={11} /> Directions
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({ zoned }) {
  const urgent = zoned.filter((p) => p.zone.key === "red");
  const slow = zoned.filter((p) => p.slowMover);
  const watch = zoned.filter((p) => p.zone.key === "yellow");
  const atRisk = zoned.filter((p) => p.atRisk);

  // Fetched once when this tab is opened (manager-only, not polled) instead
  // of the whole visits history riding along in every 30s bootstrap poll —
  // the recent-8 list plus a true total count, not the full table.
  const [recentVisits, setRecentVisits] = useState([]);
  const [totalVisits, setTotalVisits] = useState(0);
  useEffect(() => {
    api.getVisits({ limit: 8 }).then((data) => {
      setRecentVisits(data.visits || []);
      setTotalVisits(data.total || 0);
    }).catch(() => {});
  }, []);

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Team overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
        <StatCard label="Urgent expiry" value={urgent.length} color="#B33A3A" icon={<AlertTriangle size={16} />} />
        <StatCard label="Plan-ahead window" value={watch.length} color="#D9A441" icon={<Clock size={16} />} />
        <StatCard label="At risk of not selling through" value={atRisk.length} color="#C17817" icon={<AlertTriangle size={16} />} />
        <StatCard label="Slow movers" value={slow.length} color="#6B7280" icon={<TrendingDown size={16} />} />
        <StatCard label="Visits logged" value={totalVisits} color="#4C7A5E" icon={<MapPin size={16} />} />
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Recent rep visits</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {recentVisits.map((v) => (
          <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}</div>
              {v.notes && <div style={{ fontSize: 12, color: "#8A8272", marginTop: 2 }}>{v.notes}</div>}
            </div>
            <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", whiteSpace: "nowrap" }}>
              {new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
            </span>
          </div>
        ))}
        {recentVisits.length === 0 && <EmptyState text="No visits logged by reps yet." />}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color, marginBottom: 8 }}>{icon}</div>
      <div className="kb-font-display" style={{ fontSize: 24, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "#8A8272", marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ---------- Performance View (MedRep targets + manager charts) ----------
const CHART_COLORS = ["#C17817", "#4C7A5E", "#B33A3A", "#6B7280", "#D9A441", "#8A8272"];

function accountStatusList(clients, doctors, visits) {
  const lastVisitFor = (name) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === name.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };
  return [...clients, ...doctors].map((a) => {
    const lv = lastVisitFor(a.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[a.tier] || 30;
    const overdue = days === null || days > cadence;
    return { ...a, days, overdue, cadence };
  });
}

function RepPerformanceCard({ title, visits, monthlyVisitTarget, orders = [], monthlyRevenueTarget = 0, clients = [], repNameFilter = null, isSupervisor = false, onMarkPosEntered = null }) {
  const [expandedClient, setExpandedClient] = useState(null);
  const [markingId, setMarkingId] = useState(null);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const monthVisits = visits.filter((v) => new Date(v.time) >= monthStart);
  const visitsThisMonth = monthVisits.length;
  const pctOfTarget = Math.min(100, Math.round((visitsThisMonth / Math.max(monthlyVisitTarget, 1)) * 100));
  const pctOfMonth = Math.round((dayOfMonth / daysInMonth) * 100);
  const onPace = pctOfTarget >= pctOfMonth;
  const uniqueClients = new Set(monthVisits.map((v) => v.client.toLowerCase().trim())).size;

  const weeks = {};
  monthVisits.forEach((v) => {
    const wk = Math.ceil(new Date(v.time).getDate() / 7);
    weeks[wk] = (weeks[wk] || 0) + 1;
  });

  const monthOrders = orders.filter((o) => new Date(o.date) >= monthStart);
  const revenueThisMonth = monthOrders.reduce((s, o) => s + Number(o.netTotal ?? o.total ?? 0), 0);
  const revenuePct = Math.min(100, Math.round((revenueThisMonth / Math.max(monthlyRevenueTarget, 1)) * 100));
  const convertedVisits = monthVisits.filter((v) => monthOrders.some((o) => o.visitId === v.id)).length;
  const conversionRate = visitsThisMonth ? Math.round((convertedVisits / visitsThisMonth) * 100) : 0;

  const relevantClients = repNameFilter ? clients.filter((c) => c.assignedRep === repNameFilter) : clients;
  const visitedNames = new Set(monthVisits.map((v) => v.client.toLowerCase().trim()));
  const coveragePct = relevantClients.length
    ? Math.round((relevantClients.filter((c) => visitedNames.has(c.name.toLowerCase().trim())).length / relevantClients.length) * 100)
    : null;

  const lastVisitFor = (name) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === name.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };
  const overdueCount = relevantClients.filter((c) => {
    const lv = lastVisitFor(c.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[c.tier] || 30;
    return days === null || days > cadence;
  }).length;

  // Pharmacies-visited drill-down — per-rep cards only ("All reps combined"
  // has no single rep's route to drill into). Built entirely from the
  // visits/orders already passed into this card (no new fetch): one row
  // per distinct pharmacy visited this month, most-recent visit first.
  const pharmaciesVisited = repNameFilter
    ? (() => {
        const byClient = {};
        monthVisits.forEach((v) => {
          const key = v.client;
          if (!byClient[key] || new Date(v.time) > new Date(byClient[key].time)) byClient[key] = v;
        });
        return Object.values(byClient).sort((a, b) => new Date(b.time) - new Date(a.time));
      })()
    : [];
  const weekDay = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - (weekDay === 0 ? 6 : weekDay - 1));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  const orderThisWeekFor = (clientName) =>
    orders.find((o) => o.clientName === clientName && new Date(o.date) >= weekStart && new Date(o.date) <= weekEnd);

  const handleMarkPosEntered = async (orderId) => {
    if (!onMarkPosEntered) return;
    setMarkingId(orderId);
    try {
      await onMarkPosEntered(orderId);
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <h3 className="kb-font-display" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 12px" }}>{title}</h3>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{visitsThisMonth} / {monthlyVisitTarget} visits this month</span>
        <span style={{ fontSize: 12, color: onPace ? "#4C7A5E" : "#B33A3A", fontWeight: 500 }}>{onPace ? "On pace" : "Behind pace"}</span>
      </div>
      <div style={{ height: 8, background: "#F0EBE0", borderRadius: 4, overflow: "hidden", marginBottom: 4 }}>
        <div style={{ height: "100%", width: `${pctOfTarget}%`, background: onPace ? "#4C7A5E" : "#D9A441", transition: "width .3s" }} />
      </div>
      <div className="kb-font-mono" style={{ fontSize: 10.5, color: "#8A8272", marginBottom: 14 }}>Day {dayOfMonth} of {daysInMonth} ({pctOfMonth}% of month elapsed)</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 14 }}>
        <StatCard label="Visits this month" value={visitsThisMonth} color="#4C7A5E" icon={<MapPin size={16} />} />
        <StatCard label="Unique contacts seen" value={uniqueClients} color="#C17817" icon={<Users size={16} />} />
        <StatCard label="Avg / week" value={Math.round(visitsThisMonth / Math.max(Math.ceil(dayOfMonth / 7), 1))} color="#6B7280" icon={<Target size={16} />} />
        <StatCard label="Revenue this month" value={`$${revenueThisMonth.toLocaleString()}`} color="#4C7A5E" icon={<TrendingUp size={16} />} />
        <StatCard label="Conversion rate" value={`${conversionRate}%`} color="#C17817" icon={<Target size={16} />} />
        {coveragePct !== null && <StatCard label="Territory coverage" value={`${coveragePct}%`} color="#D9A441" icon={<MapPin size={16} />} />}
        <StatCard label="Overdue follow-ups" value={overdueCount} color={overdueCount > 3 ? "#B33A3A" : "#6B7280"} icon={<Clock size={16} />} />
      </div>
      <div className="kb-font-mono" style={{ fontSize: 10.5, color: "#8A8272", marginBottom: 14 }}>
        {revenuePct}% of ${monthlyRevenueTarget.toLocaleString()} revenue target
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, margin: "0 0 8px", color: "#8A8272" }}>By week this month</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {Object.keys(weeks).length === 0 && <EmptyState text="No visits logged yet this month." />}
        {Object.entries(weeks).sort(([a], [b]) => a - b).map(([wk, count]) => (
          <div key={wk} style={{ display: "flex", justifyContent: "space-between", background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "7px 12px", fontSize: 12.5 }}>
            <span>Week {wk}</span>
            <span className="kb-font-mono" style={{ color: "#8A8272" }}>{count} visits</span>
          </div>
        ))}
      </div>

      {repNameFilter && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: "16px 0 8px", color: "#8A8272" }}>Pharmacies visited this month</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pharmaciesVisited.length === 0 && <EmptyState text="No pharmacies visited yet this month." />}
            {pharmaciesVisited.map((v) => {
              const isOpen = expandedClient === v.client;
              const order = orderThisWeekFor(v.client);
              return (
                <div key={v.client} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, overflow: "hidden" }}>
                  <button
                    onClick={() => setExpandedClient(isOpen ? null : v.client)}
                    style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", font: "inherit" }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{isOpen ? "▾" : "▸"} {v.client}</span>
                    <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>
                      {new Date(v.time).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}{" "}
                      {new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 12px 12px", borderTop: "1px solid #E5DFD3" }}>
                      {v.notes && (
                        <div style={{ fontSize: 12.5, marginTop: 8 }}>
                          <strong style={{ color: "#8A8272", fontWeight: 600 }}>Notes: </strong>{v.notes}
                        </div>
                      )}
                      {v.mentionedItems && v.mentionedItems.length > 0 && (
                        <div style={{ fontSize: 12.5, marginTop: 4 }}>
                          <strong style={{ color: "#8A8272", fontWeight: 600 }}>Items discussed: </strong>
                          {v.mentionedItems.map((it) => it.name).join(", ")}
                        </div>
                      )}

                      <div style={{ fontSize: 12, fontWeight: 600, margin: "10px 0 4px", color: "#8A8272" }}>Order this week</div>
                      {!order && <div style={{ fontSize: 12.5, color: "#8A8272" }}>No order placed this week.</div>}
                      {order && (
                        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: 10 }}>
                          <div style={{ fontSize: 12.5 }}>
                            {order.items.map((it) => `${it.name} ×${it.qty}${it.isFree ? " (free — offer)" : ""}`).join(", ")}
                          </div>
                          <div style={{ fontSize: 12.5, marginTop: 4 }}>
                            {Number(order.netTotal ?? order.total).toFixed(2)} collected
                            {order.discountRate > 0 ? ` (list ${Number(order.total).toFixed(2)}, ${order.discountRate}% off)` : ""}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                            <span style={{ fontSize: 11.5, fontWeight: 600, color: order.posEntered ? "#4C7A5E" : "#C17817" }}>
                              {order.posEntered ? `✓ POS Entered — ${order.posEnteredBy}, ${new Date(order.posEnteredAt).toLocaleDateString("en-GB")}` : "Pending POS"}
                            </span>
                            {!order.posEntered && isSupervisor && onMarkPosEntered && (
                              <button
                                onClick={() => handleMarkPosEntered(order.id)}
                                disabled={markingId === order.id}
                                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "#4C7A5E", background: "#EAF3EC", border: "1px solid #C7DFCE", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
                              >
                                <Check size={12} /> {markingId === order.id ? "Saving…" : "POS Entered"}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// One rep's day at a time, on purpose — dumping every rep's every visit into
// one long feed is exactly the "bulk information" this was built to avoid.
// Pick a name, see what they actually did: who they saw, what was
// discussed, what they noted, and what came out of it (order/offers,
// samples, competitor intel) — the things the aggregate stats above don't
// show.
function RepActivityToday({ repNames }) {
  const [selectedRep, setSelectedRep] = useState("");
  // Deliberately its own small, per-rep, per-day fetch rather than piggy-
  // backing on PerformanceView's full-history one — one rep's one day is
  // always small, however big the total visits/orders/samples tables get.
  const [todayVisits, setTodayVisits] = useState([]);
  const [orders, setOrders] = useState([]);
  const [samples, setSamples] = useState([]);
  const [competitorSightings, setCompetitorSightings] = useState([]);

  useEffect(() => {
    if (!selectedRep) { setTodayVisits([]); setOrders([]); setSamples([]); setCompetitorSightings([]); return; }
    api.getVisits({ repName: selectedRep, limit: 50 }).then((data) => {
      const todayStr = new Date().toDateString();
      const today = (data.visits || []).filter((v) => new Date(v.time).toDateString() === todayStr);
      setTodayVisits(today);
      if (today.length === 0) { setOrders([]); setSamples([]); setCompetitorSightings([]); return; }
      api.getOrders({ repName: selectedRep, limit: 100 }).then((d) => setOrders(d.orders || [])).catch(() => setOrders([]));
      Promise.all(today.map((v) => api.getSamples({ visitId: v.id }).catch(() => ({ samples: [] }))))
        .then((results) => setSamples(results.flatMap((r) => r.samples || [])));
      Promise.all(today.map((v) => api.getCompetitorSightings({ visitId: v.id, limit: 5 }).catch(() => ({ sightings: [] }))))
        .then((results) => setCompetitorSightings(results.flatMap((r) => r.sightings || [])));
    }).catch(() => setTodayVisits([]));
  }, [selectedRep]);

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Today's activity</h3>
      <p style={{ fontSize: 12, color: "#8A8272", margin: "0 0 12px" }}>
        Who they visited, what was discussed, and what came of it.
      </p>
      <select value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)} style={{ ...inputStyle, maxWidth: 260, marginBottom: 14 }}>
        <option value="">Select a med rep…</option>
        {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>

      {!selectedRep && <EmptyState text="Pick a rep to see today's visits." />}
      {selectedRep && todayVisits.length === 0 && <EmptyState text={`${selectedRep} hasn't logged a visit yet today.`} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {todayVisits.map((v) => {
          const order = orders.find((o) => o.visitId === v.id);
          const visitSamples = samples.filter((s) => s.visitId === v.id);
          const sighting = competitorSightings.find((cs) => cs.visitId === v.id);
          return (
            <div key={v.id} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}</span>
                <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>
                  {new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              {v.notes && (
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  <strong style={{ color: "#8A8272", fontWeight: 600 }}>Notes: </strong>{v.notes}
                </div>
              )}

              {v.mentionedItems && v.mentionedItems.length > 0 && (
                <div style={{ fontSize: 12.5, marginTop: 4 }}>
                  <strong style={{ color: "#8A8272", fontWeight: 600 }}>Items discussed: </strong>
                  {v.mentionedItems.map((it) => it.name).join(", ")}
                </div>
              )}

              {order && (
                <div style={{ fontSize: 12.5, marginTop: 4 }}>
                  <strong style={{ color: "#8A8272", fontWeight: 600 }}>Order: </strong>
                  {order.items.map((it) => `${it.name} ×${it.qty}${it.isFree ? " (free — offer)" : ""}`).join(", ")}
                  {" — "}{Number(order.netTotal ?? order.total).toFixed(2)} collected
                  {order.discountRate > 0 ? ` (list ${order.total.toFixed(2)}, ${order.discountRate}% off)` : ""}
                </div>
              )}

              {visitSamples.length > 0 && (
                <div style={{ fontSize: 12.5, marginTop: 4 }}>
                  <strong style={{ color: "#8A8272", fontWeight: 600 }}>Samples given: </strong>
                  {visitSamples.map((s) => `${s.productName}${s.qty ? ` ×${s.qty}` : ""}`).join(", ")}
                </div>
              )}

              {sighting && (
                <div style={{ fontSize: 12.5, marginTop: 4, color: "#B33A3A" }}>
                  <strong style={{ fontWeight: 600 }}>Competitor: </strong>
                  {sighting.competitorName}{sighting.notes ? ` — ${sighting.notes}` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PerformanceView({ clients, doctors, repNames, monthlyVisitTarget, setMonthlyVisitTarget, monthlyRevenueTarget, setMonthlyRevenueTarget, isSupervisor }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Fetched once when this tab is opened (manager/supervisor-only, not
  // polled) instead of the whole visits/orders history riding along in
  // every 30s bootstrap poll for every rep in the field.
  const [visits, setVisits] = useState([]);
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api.getVisits({ all: true }).then((data) => setVisits(data.visits || [])).catch(() => {});
    api.getOrders({ all: true }).then((data) => setOrders(data.orders || [])).catch(() => {});
  }, []);

  // Orders are already fully loaded above (all:true, for the existing
  // revenue charts) — the Pharmacy drill-down reuses that in-memory data
  // instead of issuing its own fetch. Marking POS-entered just patches
  // this same state in place so the badge updates immediately.
  const markPosEntered = async (orderId) => {
    const patch = await api.markOrderPosEntered(orderId);
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o)));
  };

  const accountsWithStatus = accountStatusList(clients, doctors, visits);
  const totalOverdue = accountsWithStatus.filter((a) => a.overdue).length;
  const avgCoverage = accountsWithStatus.length
    ? Math.round((accountsWithStatus.filter((a) => !a.overdue).length / accountsWithStatus.length) * 100)
    : 0;

  const tierCompliance = ["A", "B", "C"].map((tier) => {
    const inTier = accountsWithStatus.filter((a) => a.tier === tier);
    const total = Math.max(inTier.length, 1);
    const onTime = inTier.filter((a) => !a.overdue).length;
    return {
      tier: `Tier ${tier} (${TIER_CADENCE[tier]}d)`,
      onTime: Math.round((onTime / total) * 100),
      overdue: Math.round(((inTier.length - onTime) / total) * 100),
    };
  });

  const revenueThisMonthTotal = orders.filter((o) => new Date(o.date) >= monthStart).reduce((s, o) => s + Number(o.netTotal ?? o.total ?? 0), 0);
  const revenueTargetTotal = monthlyRevenueTarget * Math.max(repNames.length, 1);

  const MONTHS_BACK = 6;
  const monthCols = Array.from({ length: MONTHS_BACK }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (MONTHS_BACK - 1 - i), 1);
    return { year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleDateString("en-GB", { month: "short" }) };
  });
  const revenueTrend = monthCols.map(({ year, month, label }) => {
    const row = { month: label };
    repNames.forEach((name) => {
      row[name] = orders
        .filter((o) => o.repName === name && new Date(o.date).getFullYear() === year && new Date(o.date).getMonth() === month)
        .reduce((s, o) => s + Number(o.netTotal ?? o.total ?? 0), 0);
    });
    return row;
  });

  const objectionTally = {};
  visits.forEach((v) => { if (v.objectionTag) objectionTally[v.objectionTag] = (objectionTally[v.objectionTag] || 0) + 1; });
  const objectionData = Object.entries(objectionTally).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);
  const topObjection = objectionData[0];

  const radarMetrics = ["Visits vs target", "Revenue vs target", "Conversion rate", "Coverage", "Follow-up discipline"];
  const radarData = radarMetrics.map((metric) => {
    const row = { metric };
    repNames.forEach((name) => {
      const repVisits = visits.filter((v) => v.repName === name);
      const monthVisits = repVisits.filter((v) => new Date(v.time) >= monthStart);
      const repOrders = orders.filter((o) => o.repName === name && new Date(o.date) >= monthStart);
      const repRevenue = repOrders.reduce((s, o) => s + Number(o.netTotal ?? o.total ?? 0), 0);
      const convertedVisits = monthVisits.filter((v) => repOrders.some((o) => o.visitId === v.id)).length;
      const conversionRate = monthVisits.length ? convertedVisits / monthVisits.length : 0;
      const repClients = clients.filter((c) => c.assignedRep === name);
      const visitedClientNames = new Set(monthVisits.map((v) => v.client.toLowerCase().trim()));
      const coverage = repClients.length
        ? repClients.filter((c) => visitedClientNames.has(c.name.toLowerCase().trim())).length / repClients.length
        : 0;
      const repOverdue = accountsWithStatus.filter((a) => a.assignedRep === name && a.overdue).length;
      let val = 0;
      if (metric === "Visits vs target") val = Math.min(1, monthVisits.length / Math.max(monthlyVisitTarget, 1));
      if (metric === "Revenue vs target") val = Math.min(1, repRevenue / Math.max(monthlyRevenueTarget, 1));
      if (metric === "Conversion rate") val = conversionRate;
      if (metric === "Coverage") val = coverage;
      if (metric === "Follow-up discipline") val = Math.max(0, 1 - repOverdue / 10);
      row[name] = Math.round(val * 100);
    });
    return row;
  });

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>MedRep performance</h2>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
          <Field label="Monthly visit target (per rep)">
            <input type="number" min="1" value={monthlyVisitTarget} onChange={(e) => setMonthlyVisitTarget(Number(e.target.value) || 1)} style={inputStyle} />
          </Field>
          <Field label="Monthly revenue target (per rep, $)">
            <input type="number" min="0" value={monthlyRevenueTarget} onChange={(e) => setMonthlyRevenueTarget(Number(e.target.value) || 0)} style={inputStyle} />
          </Field>
        </div>
      </div>

      {repNames.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
          <StatCard label="Revenue this month" value={`$${revenueThisMonthTotal.toLocaleString()}`}
            color="#4C7A5E" icon={<TrendingUp size={16} />} />
          <StatCard label="Team follow-up compliance" value={`${avgCoverage}%`} color="#D9A441" icon={<MapPin size={16} />} />
          <StatCard label="Overdue follow-ups" value={totalOverdue} color="#B33A3A" icon={<Clock size={16} />} />
          <StatCard label="Top objection" value={topObjection ? topObjection.theme : "None logged"}
            color="#1F2A24" icon={<MessageCircle size={16} />} />
        </div>
      )}

      <RepActivityToday repNames={repNames} />

      <RepPerformanceCard title="All reps combined" visits={visits} monthlyVisitTarget={monthlyVisitTarget}
        orders={orders} monthlyRevenueTarget={revenueTargetTotal} clients={clients} />

      {repNames.map((name) => (
        <RepPerformanceCard
          key={name}
          title={name}
          visits={visits.filter((v) => v.repName === name)}
          monthlyVisitTarget={monthlyVisitTarget}
          orders={orders.filter((o) => o.repName === name)}
          monthlyRevenueTarget={monthlyRevenueTarget}
          clients={clients}
          repNameFilter={name}
          isSupervisor={isSupervisor}
          onMarkPosEntered={markPosEntered}
        />
      ))}

      {repNames.length === 0 && <EmptyState text="Add sales reps in Settings to see per-rep performance." />}

      {repNames.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 16, marginTop: 8 }}>
          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
            <h4 className="kb-font-display" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Revenue trend (6 months)</h4>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={revenueTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5DFD3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {repNames.map((name, i) => (
                  <Line key={name} type="monotone" dataKey={name} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
            <h4 className="kb-font-display" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Follow-up discipline by tier</h4>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tierCompliance} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#E5DFD3" />
                <XAxis type="number" tick={{ fontSize: 11 }} unit="%" />
                <YAxis dataKey="tier" type="category" width={100} tick={{ fontSize: 10.5 }} />
                <Tooltip />
                <Bar dataKey="onTime" stackId="a" fill="#4C7A5E" name="On time %" />
                <Bar dataKey="overdue" stackId="a" fill="#B33A3A" name="Overdue %" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
            <h4 className="kb-font-display" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Rep comparison (normalized)</h4>
            <ResponsiveContainer width="100%" height={240}>
              <RadarChart data={radarData}>
                <PolarGrid stroke="#E5DFD3" />
                <PolarAngleAxis dataKey="metric" tick={{ fontSize: 9.5 }} />
                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 9 }} />
                {repNames.map((name, i) => (
                  <Radar key={name} name={name} dataKey={name} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.25} />
                ))}
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
            <h4 className="kb-font-display" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 6px" }}>Objection themes</h4>
            <div style={{ fontSize: 11, color: "#8A8272", marginBottom: 6 }}>Auto-tagged from visit notes at save time</div>
            {objectionData.length === 0 ? (
              <EmptyState text="No objections tagged yet — they'll appear here as reps log visit notes." />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={objectionData} dataKey="count" nameKey="theme" cx="50%" cy="50%" outerRadius={80} label={{ fontSize: 10.5 }}>
                    {objectionData.map((entry, i) => <Cell key={entry.theme} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Broadcast View (stock reminder to existing pharmacies) ----------
function BroadcastView({ zoned, clients }) {
  const [mode, setMode] = useState("healthy"); // healthy | clearance
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [selectedTier, setSelectedTier] = useState("all");
  const [copied, setCopied] = useState(false);

  const pool = mode === "healthy"
    ? zoned.filter((p) => p.zone.key === "green" && !p.slowMover).slice(0, 20)
    : zoned.filter((p) => p.zone.key !== "green" || p.slowMover).slice(0, 20);

  const changeMode = (m) => { setMode(m); setSelectedProducts([]); };
  const toggleProduct = (id) => setSelectedProducts((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const targetClients = clients.filter((c) => selectedTier === "all" || c.tier === selectedTier);

  const message = mode === "healthy"
    ? `Hi! Quick reminder from KayBee Pharma — we currently have good stock of:\n${
        zoned.filter((p) => selectedProducts.includes(p.id)).map((p) => `• ${p.name}`).join("\n") || "(select items below)"
      }\n\nLet us know if you'd like to reorder or need pricing. No pressure, just keeping you posted!`
    : `Hi! Special pricing from KayBee Pharma while stock lasts:\n${
        zoned.filter((p) => selectedProducts.includes(p.id)).map((p) => `• ${p.name}`).join("\n") || "(select items below)"
      }\n\nGreat opportunity to stock up at a discount — let us know if you'd like to order!`;

  const copyMessage = () => { navigator.clipboard?.writeText(message); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Stock reminder broadcast</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Pulled from your own inventory — pick items you want to remind pharmacies about, then send via your WhatsApp Business broadcast list.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => changeMode("healthy")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: mode === "healthy" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
          background: mode === "healthy" ? "#4C7A5E" : "#fff", color: mode === "healthy" ? "#FAF7F2" : "#1F2A24",
        }}>
          Promote healthy stock
        </button>
        <button onClick={() => changeMode("clearance")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: mode === "clearance" ? "1px solid #4C7A5E" : "1px solid #1F2A24", fontSize: 12.5, fontWeight: 500,
          background: mode === "clearance" ? "#4C7A5E" : "#fff", color: mode === "clearance" ? "#FAF7F2" : "#1F2A24",
        }}>
          Push near-expiry / slow movers
        </button>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>
          Select items to feature ({mode === "healthy" ? "showing healthy-stock items" : "showing near-expiry and slow-moving items"})
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {pool.map((p) => (
            <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={selectedProducts.includes(p.id)} onChange={() => toggleProduct(p.id)} />
              {p.name} <span style={{ fontSize: 10.5, color: "#8A8272" }}>({p.zone.label})</span>
            </label>
          ))}
          {pool.length === 0 && (
            <span style={{ fontSize: 12, color: "#8A8272" }}>
              {mode === "healthy" ? "No healthy-stock items found — import your inventory first." : "No near-expiry or slow-moving items right now."}
            </span>
          )}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Send to</label>
        <select value={selectedTier} onChange={(e) => setSelectedTier(e.target.value)} style={inputStyle}>
          <option value="all">All pharmacies ({clients.length})</option>
          <option value="A">Tier A only ({clients.filter((c) => c.tier === "A").length})</option>
          <option value="B">Tier B only ({clients.filter((c) => c.tier === "B").length})</option>
          <option value="C">Tier C only ({clients.filter((c) => c.tier === "C").length})</option>
        </select>
      </div>

      <div style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.5, marginBottom: 12, whiteSpace: "pre-wrap" }}>
        {message}
      </div>

      <button onClick={copyMessage} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, fontWeight: 500, marginBottom: 16 }}>
        {copied ? <Check size={14} color="#4C7A5E" /> : <Copy size={14} />} {copied ? "Copied" : "Copy message"}
      </button>

      <div>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: "#8A8272" }}>Recipients ({targetClients.length})</h3>
        {targetClients.length > LIST_DISPLAY_CAP && (
          <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 6 }}>Showing first {LIST_DISPLAY_CAP} of {targetClients.length.toLocaleString()}.</div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {targetClients.slice(0, LIST_DISPLAY_CAP).map((c) => (
            c.phone
              ? <a key={c.id} href={`https://wa.me/${c.phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, background: "#4C7A5E1A", color: "#4C7A5E", textDecoration: "none" }}>
                  {c.name}
                </a>
              : <span key={c.id} style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, background: "#F0EBE0", color: "#8A8272" }}>{c.name} (no number)</span>
          ))}
          {targetClients.length === 0 && <EmptyState text="No pharmacies in this tier yet." />}
        </div>
      </div>
    </div>
  );
}

// ---------- Outreach View ----------
function OutreachView({ dailyTarget, contactedToday, templates, todayStr, onLog }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [templateIdx, setTemplateIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  // The full outreach log grows forever and nothing else in the app reads
  // past "today" — so this view owns its own scoped fetch instead of
  // holding the whole history in App() state.
  const [todayEntries, setTodayEntries] = useState([]);

  const loadToday = () => api.getOutreachLogToday().then((data) => setTodayEntries(data.entries || [])).catch(() => {});
  useEffect(() => { loadToday(); }, []);

  const rawTemplate = templates[templateIdx] || templates[0] || "";
  const message = rawTemplate.replace(/\{name\}/g, name || "[pharmacy name]");
  const waLink = phone ? `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}` : null;
  const remaining = Math.max(0, dailyTarget - contactedToday);

  const copyMessage = () => {
    navigator.clipboard?.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const nextTemplate = () => setTemplateIdx((templateIdx + 1) % Math.max(templates.length, 1));

  const logContact = async () => {
    await onLog({ name: name || "Unnamed", date: todayStr, templateIndex: templateIdx });
    setName(""); setPhone("");
    nextTemplate();
    loadToday();
  };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>New pharmacy outreach</h2>
      <p style={{ fontSize: 13, color: "#8A8272", margin: "0 0 18px" }}>
        Today's progress: <strong style={{ color: contactedToday >= dailyTarget ? "#4C7A5E" : "#1F2A24" }}>{contactedToday} / {dailyTarget}</strong>
        {remaining > 0 ? ` — ${remaining} more to hit today's goal` : " — goal reached, nice work"}
      </p>

      <div style={{ height: 6, background: "#F0EBE0", borderRadius: 3, marginBottom: 22, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, (contactedToday / Math.max(dailyTarget, 1)) * 100)}%`, background: "#4C7A5E", transition: "width .3s" }} />
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <Field label="Pharmacy / contact name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pharmacie Al Nour" style={inputStyle} />
          </Field>
          <Field label="WhatsApp number">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 11.5, color: "#8A8272" }}>Message (rotates automatically after each send)</label>
          <button onClick={nextTemplate} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "#C17817", fontSize: 11.5, fontWeight: 500 }}>
            <RotateCcw size={12} /> Try another variation
          </button>
        </div>
        <div style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.5, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {message}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={copyMessage} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, fontWeight: 500 }}>
            {copied ? <Check size={14} color="#4C7A5E" /> : <Copy size={14} />} {copied ? "Copied" : "Copy message"}
          </button>
          {waLink && (
            <a href={waLink} target="_blank" rel="noreferrer" onClick={logContact} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
              background: "#4C7A5E", color: "#fff", fontSize: 12.5, fontWeight: 500, textDecoration: "none",
            }}>
              <Send size={14} /> Open in WhatsApp & log
            </a>
          )}
          {!waLink && name && (
            <button onClick={logContact} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, fontWeight: 500 }}>
              Log as contacted (no number)
            </button>
          )}
        </div>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Contacted today</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {todayEntries.map((o) => (
          <div key={o.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
            {o.name}
          </div>
        ))}
        {contactedToday === 0 && <EmptyState text="Nobody logged yet today." />}
      </div>
    </div>
  );
}

// ---------- Excel upload with column mapping ----------
function ExcelImportSection({ onImport, productCount }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "", price: "" });
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const readSheet = (wb, sheetName) => {
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
    const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
    setHeaders(headerRow);
    setRows(dataRows);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        setSelectedSheet(wb.SheetNames[0]);
        readSheet(wb, wb.SheetNames[0]);
        setMapping({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "", price: "" });
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    setMapping({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "", price: "" });
  };

  const parsed = useMemo(() => {
    if (!mapping.name || !mapping.expiry || !mapping.qty) return { valid: [], skipped: 0 };
    const nameIdx = headers.indexOf(mapping.name);
    const expiryIdx = headers.indexOf(mapping.expiry);
    const qtyIdx = headers.indexOf(mapping.qty);
    const sold90Idx = headers.indexOf(mapping.sold90);
    const categoryIdx = headers.indexOf(mapping.category);
    const descIdx = headers.indexOf(mapping.description);
    const priceIdx = headers.indexOf(mapping.price);

    let skipped = 0;
    const valid = [];
    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? "").trim();
      const expiry = parseExcelCellDate(r[expiryIdx]);
      if (!name || !expiry) { skipped++; return; }
      valid.push({
        name,
        expiry,
        qty: Number(r[qtyIdx]) || 0,
        sold90: sold90Idx >= 0 ? Number(r[sold90Idx]) || 0 : 0,
        category: categoryIdx >= 0 && r[categoryIdx] ? String(r[categoryIdx]).trim() : "Supplement",
        description: descIdx >= 0 ? String(r[descIdx] || "").trim() : "",
        price: priceIdx >= 0 ? Number(r[priceIdx]) || 0 : 0,
      });
    });
    return { valid, skipped };
  }, [mapping, rows, headers]);

  const canImport = mapping.name && mapping.expiry && mapping.qty && parsed.valid.length > 0;

  const doImport = async () => {
    setError("");
    setImporting(true);
    try {
      await onImport(parsed.valid);
      setResult({ count: parsed.valid.length });
      setWorkbook(null);
      setHeaders([]);
      setRows([]);
      setSheetNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const fieldSelect = (field, label, required) => (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>
        {label}{required ? " *" : " (optional)"}
      </label>
      <select value={mapping[field]} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))} style={inputStyle}>
        <option value="">{required ? "— select a column —" : "— none —"}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Upload your own inventory (Excel file)</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload an .xlsx file with your current stock. Match its columns to what the app needs below, preview the result, then confirm — this replaces the current product list ({productCount} items now).
      </p>

      <button
        onClick={() => fileInputRef.current?.click()}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500, marginBottom: 10 }}
      >
        <Upload size={15} /> Choose Excel file
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />

      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}><Check size={14} /> Imported {result.count} products.</div>}

      {headers.length > 0 && (
        <div style={{ padding: 12, background: "#FAF7F2", borderRadius: 8 }}>
          {sheetNames.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>Sheet / tab</label>
              <select value={selectedSheet} onChange={(e) => changeSheet(e.target.value)} style={inputStyle}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {fieldSelect("name", "Product name column", true)}
            {fieldSelect("expiry", "Expiry date column", true)}
            {fieldSelect("qty", "Quantity in stock column", true)}
            {fieldSelect("sold90", "Units sold (last 90 days) column", false)}
            {fieldSelect("category", "Category column", false)}
            {fieldSelect("description", "Description column", false)}
            {fieldSelect("price", "Price column", false)}
          </div>

          {mapping.name && mapping.expiry && mapping.qty && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#5B5445", marginBottom: 6 }}>
                {parsed.valid.length} rows ready to import{parsed.skipped > 0 ? `, ${parsed.skipped} skipped (missing name or unreadable expiry date)` : ""}.
              </div>
              {parsed.valid.length > 0 && (
                <div style={{ overflowX: "auto", marginBottom: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#8A8272" }}>
                        <th style={{ padding: "4px 6px" }}>Name</th>
                        <th style={{ padding: "4px 6px" }}>Category</th>
                        <th style={{ padding: "4px 6px" }}>Expiry</th>
                        <th style={{ padding: "4px 6px" }}>Qty</th>
                        <th style={{ padding: "4px 6px" }}>Sold/90d</th>
                        <th style={{ padding: "4px 6px" }}>Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.valid.slice(0, 5).map((p, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                          <td style={{ padding: "4px 6px" }}>{p.name}</td>
                          <td style={{ padding: "4px 6px" }}>{p.category}</td>
                          <td style={{ padding: "4px 6px" }}>{p.expiry}</td>
                          <td style={{ padding: "4px 6px" }}>{p.qty}</td>
                          <td style={{ padding: "4px 6px" }}>{p.sold90}</td>
                          <td style={{ padding: "4px 6px" }}>{p.price || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.valid.length > 5 && <div style={{ fontSize: 11, color: "#8A8272", marginTop: 4 }}>...and {parsed.valid.length - 5} more</div>}
                </div>
              )}
              <button
                disabled={!canImport || importing}
                onClick={doImport}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: canImport && !importing ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
              >
                {importing ? "Importing…" : `Replace inventory with these ${parsed.valid.length} products`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Sales reps management (manager only) ----------
function RepsManagementSection({ onRepsChanged }) {
  const [reps, setReps] = useState(null); // null = loading
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sheetEmails, setSheetEmails] = useState({}); // per-rep email input for "create visits sheet"
  const [creatingSheetFor, setCreatingSheetFor] = useState(null);
  const [savingEmailFor, setSavingEmailFor] = useState(null);
  const [rowErrors, setRowErrors] = useState({}); // per-rep error messages
  const [rowSaved, setRowSaved] = useState({}); // per-rep "saved" confirmation flash
  const [telegramStatus, setTelegramStatus] = useState(null);
  const [telegramLinkFor, setTelegramLinkFor] = useState({}); // rep id -> { code, botUsername }
  const [telegramLinking, setTelegramLinking] = useState(null);

  useEffect(() => { api.getTelegramStatus().then(setTelegramStatus).catch(() => setTelegramStatus({ configured: false })); }, []);

  const generateTelegramLink = async (rep) => {
    setTelegramLinking(rep.id);
    try {
      const { code, botUsername } = await api.getRepTelegramLinkCode(rep.id);
      setTelegramLinkFor((prev) => ({ ...prev, [rep.id]: { code, botUsername } }));
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [rep.id]: e.message }));
    } finally {
      setTelegramLinking(null);
    }
  };

  const load = async () => {
    try {
      const data = await api.getReps();
      setReps(data);
      // Seed the email inputs from saved data, without clobbering anything the manager is mid-typing.
      setSheetEmails((prev) => {
        const next = { ...prev };
        data.forEach((r) => { if (!(r.id in next)) next[r.id] = r.email || ""; });
        return next;
      });
    } catch (e) {
      setError(e.message);
      setReps([]);
    }
  };

  useEffect(() => { load(); }, []);

  const addRep = async () => {
    if (!name || !passcode || !email) return;
    setSaving(true);
    setError("");
    try {
      await api.addRep({ name: name.trim(), passcode, email: email.trim() });
      setName(""); setPasscode(""); setEmail("");
      await load();
      onRepsChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const removeRep = async (id) => {
    try {
      await api.removeRep(id);
      await load();
      onRepsChanged?.();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleSupervisor = async (rep) => {
    try {
      await api.updateRep(rep.id, { isSupervisor: !rep.isSupervisor });
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [rep.id]: e.message }));
    }
  };

  const saveEmailFor = async (rep) => {
    const emailToUse = (sheetEmails[rep.id] || "").trim();
    if (!emailToUse) return;
    setSavingEmailFor(rep.id);
    setRowErrors((prev) => ({ ...prev, [rep.id]: "" }));
    try {
      await api.updateRep(rep.id, { email: emailToUse });
      setRowSaved((prev) => ({ ...prev, [rep.id]: true }));
      setTimeout(() => setRowSaved((prev) => ({ ...prev, [rep.id]: false })), 1500);
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [rep.id]: e.message }));
    } finally {
      setSavingEmailFor(null);
    }
  };

  const createSheetFor = async (rep) => {
    const emailToUse = (sheetEmails[rep.id] || "").trim();
    if (!emailToUse) return;
    setCreatingSheetFor(rep.id);
    setRowErrors((prev) => ({ ...prev, [rep.id]: "" }));
    try {
      await api.createRepExportSheet(rep.id, emailToUse);
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [rep.id]: e.message }));
      await load(); // the email itself is saved server-side even if sheet creation failed
    } finally {
      setCreatingSheetFor(null);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Sales reps</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Give each rep their own name, passcode, and Google account email. Their own personal Google Sheet of their visits is created and shared with them automatically — no other rep can see it. Once added, you can assign pharmacies to them in the Pharmacies tab.
      </p>

      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {reps === null && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Loading…</div>}

      {reps && reps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {reps.map((r) => (
            <div key={r.id} style={{ background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <span><strong>{r.name}</strong> · passcode: {r.passcode}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "#5B5445" }} title="Sees every rep's Locations + Performance, and can comment on any visit">
                    <input type="checkbox" checked={!!r.isSupervisor} onChange={() => toggleSupervisor(r)} />
                    Supervisor
                  </label>
                  <button onClick={() => removeRep(r.id)} style={{ background: "none", border: "none", color: "#B33A3A", fontSize: 11.5 }}>Remove</button>
                </div>
              </div>
              {r.exportSheetId ? (
                <a href={`https://docs.google.com/spreadsheets/d/${r.exportSheetId}/edit`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "#4C7A5E", display: "inline-block", marginTop: 6 }}>
                  Visits sheet ({r.email}) →
                </a>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <input
                      value={sheetEmails[r.id] || ""}
                      onChange={(e) => setSheetEmails((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder="Rep's Google email for their visits sheet"
                      style={{ ...inputStyle, flex: 1, minWidth: 160, fontSize: 11.5, padding: "5px 8px" }}
                    />
                    <button
                      disabled={!sheetEmails[r.id] || savingEmailFor === r.id}
                      onClick={() => saveEmailFor(r)}
                      style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24" }}
                    >
                      {savingEmailFor === r.id ? "Saving…" : rowSaved[r.id] ? "✓ Saved" : "Save"}
                    </button>
                    <button
                      disabled={!sheetEmails[r.id] || creatingSheetFor === r.id}
                      onClick={() => createSheetFor(r)}
                      style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, border: "none", background: sheetEmails[r.id] ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2" }}
                    >
                      {creatingSheetFor === r.id ? "Creating…" : "Create visits sheet"}
                    </button>
                  </div>
                  {rowErrors[r.id] && <div style={{ fontSize: 11, color: "#B33A3A", marginTop: 4 }}>{rowErrors[r.id]}</div>}
                </div>
              )}

              {telegramStatus?.configured && (
                <div style={{ marginTop: 6 }}>
                  {r.telegramLinked ? (
                    <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: "#4C7A5E1A", color: "#4C7A5E" }}>
                      ✓ Telegram linked
                    </span>
                  ) : telegramLinkFor[r.id] ? (
                    <div style={{ fontSize: 11.5, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 6, padding: 8 }}>
                      Send {r.name} this link — they open it and tap Start in Telegram:
                      <div className="kb-font-mono" style={{ marginTop: 4, wordBreak: "break-all" }}>
                        https://t.me/{telegramLinkFor[r.id].botUsername}?start={telegramLinkFor[r.id].code}
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => generateTelegramLink(r)}
                      disabled={telegramLinking === r.id}
                      style={{ fontSize: 11, padding: "4px 9px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", color: "#5B5445" }}
                    >
                      {telegramLinking === r.id ? "Generating…" : "Link Telegram"}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {reps && reps.length === 0 && <div style={{ fontSize: 12.5, color: "#8A8272", marginBottom: 12 }}>No reps added yet.</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rep name, e.g. Rita" style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
        <input value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Passcode" style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Google email (required for their sheet)" style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
        <button
          disabled={!name || !passcode || !email || saving}
          onClick={addRep}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name && passcode && email && !saving ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Adding…" : "Add rep"}
        </button>
      </div>
    </div>
  );
}

// ---------- Discounts & offers management (manager only) ----------
function OffersManagementSection({ offers, onAdd, onToggleActive, onRemove }) {
  const [label, setLabel] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [getQty, setGetQty] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addOffer = async () => {
    if (!label || !buyQty || !getQty) return;
    setSaving(true);
    setError("");
    try {
      await onAdd({ label, buyQty: Number(buyQty), getQty: Number(getQty), expiresAt });
      setLabel(""); setBuyQty(""); setGetQty("1"); setExpiresAt("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Discounts & offers</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Set up "buy X, get Y free" offers based on total items in an order (any mix of products). Leave the expiry blank for an offer that stays on until you remove or disable it.
      </p>

      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}

      {offers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {offers.map((o) => (
            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 12.5 }}>
              <div>
                <strong>{o.label}</strong> — buy {o.buyQty}, get {o.getQty} free
                {o.expiresAt ? ` · until ${o.expiresAt}` : " · always on"}
                {!o.active && <span style={{ color: "#B33A3A" }}> · disabled</span>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => onToggleActive(o.id, !o.active)} style={{ background: "none", border: "1px solid #E5DFD3", borderRadius: 6, padding: "4px 8px", fontSize: 11.5 }}>
                  {o.active ? "Disable" : "Enable"}
                </button>
                <button onClick={() => onRemove(o.id)} style={{ background: "none", border: "none", color: "#B33A3A", fontSize: 11.5 }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {offers.length === 0 && <div style={{ fontSize: 12.5, color: "#8A8272", marginBottom: 12 }}>No offers set up yet.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Offer name, e.g. Buy 7 Get 1 Free" style={inputStyle} />
        <input type="number" min="1" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} placeholder="Buy qty" style={inputStyle} />
        <input type="number" min="1" value={getQty} onChange={(e) => setGetQty(e.target.value)} placeholder="Get free qty" style={inputStyle} />
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} />
      </div>
      <button
        disabled={!label || !buyQty || !getQty || saving}
        onClick={addOffer}
        style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: label && buyQty && getQty && !saving ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
      >
        {saving ? "Adding…" : "Add offer"}
      </button>
    </div>
  );
}

// ---------- Push notification setup ----------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function ManagerTelegramLinkSection() {
  const [status, setStatus] = useState(null);
  const [linking, setLinking] = useState(false);
  const [linkInfo, setLinkInfo] = useState(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => { api.getTelegramStatus().then(setStatus).catch(() => setStatus({ configured: false })); }, []);

  const generateLink = async () => {
    setLinking(true);
    setError("");
    try {
      const { code, botUsername } = await api.getManagerTelegramLinkCode();
      setLinkInfo({ code, botUsername });
    } catch (e) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  };

  const sendNow = async () => {
    setSending(true);
    setError("");
    setSent(false);
    try {
      await api.sendTelegramDigestNow();
      setSent(true);
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!status?.configured) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Manager Telegram alerts</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        This automatically runs on the 1st of each month, but you can send it now too, e.g. to test the flow. Either way, it arrives here first with Approve / Skip buttons — nothing reaches reps until you approve it.
      </p>
      {status.managerLinked ? (
        <div>
          <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 5, background: "#4C7A5E1A", color: "#4C7A5E" }}>
            ✓ Linked
          </span>
          <div style={{ marginTop: 10 }}>
            <button onClick={sendNow} disabled={sending} style={{ fontSize: 12.5, padding: "7px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2" }}>
              {sending ? "Sending…" : sent ? "✓ Sent to your Telegram" : "Send this month's digest now"}
            </button>
          </div>
        </div>
      ) : linkInfo ? (
        <div style={{ fontSize: 12, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
          Tap to open Telegram and hit Start:
          <div style={{ marginTop: 4 }}>
            <a className="kb-font-mono" href={`https://t.me/${linkInfo.botUsername}?start=${linkInfo.code}`} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all", color: "#4C7A5E" }}>
              https://t.me/{linkInfo.botUsername}?start={linkInfo.code}
            </a>
          </div>
        </div>
      ) : (
        <button onClick={generateLink} disabled={linking} style={{ fontSize: 12.5, padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24" }}>
          {linking ? "Generating…" : "Link my Telegram"}
        </button>
      )}
      {error && <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function PushNotificationSetup() {
  const [status, setStatus] = useState("idle"); // idle | unsupported | subscribing | subscribed | denied | error
  const [error, setError] = useState("");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      reg.pushManager.getSubscription().then((sub) => { if (sub) setStatus("subscribed"); });
    });
  }, []);

  const enable = async () => {
    setStatus("subscribing");
    setError("");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const { publicKey } = await api.getVapidPublicKey();
      if (!publicKey) {
        setError("Push notifications aren't configured on the server yet.");
        setStatus("error");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.savePushSubscription(sub.toJSON());
      setStatus("subscribed");
    } catch (e) {
      setError(e.message || "Couldn't enable notifications.");
      setStatus("error");
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Push notifications</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Get alerted on this device for new orders, deletion requests, expiring stock, and overdue visits. On iPhone: add this app to your Home Screen first (Share → Add to Home Screen), then open it from there before enabling — a regular Safari tab can't receive notifications.
      </p>
      {status === "unsupported" && <div style={{ fontSize: 12.5, color: "#B33A3A" }}>Notifications aren't supported on this browser/device.</div>}
      {status === "subscribed" && <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5 }}><Check size={14} /> Notifications enabled on this device.</div>}
      {status === "denied" && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 8 }}>Notifications were blocked. Enable them in your browser/phone settings, then try again.</div>}
      {error && <div style={{ fontSize: 12.5, color: "#B33A3A", marginBottom: 8 }}>{error}</div>}
      {(status === "idle" || status === "error" || status === "denied") && (
        <button onClick={enable} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>
          Enable notifications on this device
        </button>
      )}
      {status === "subscribing" && <div style={{ fontSize: 12.5, color: "#8A8272" }}>Setting up…</div>}
    </div>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- Stock movement (multi-year monthly sales history for the manager) ----------
function StockMovementImportSection() {
  const [status, setStatus] = useState(null); // { lockedYears, countByYear }
  const [activeYear, setActiveYear] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [nameCol, setNameCol] = useState("");
  const [monthCols, setMonthCols] = useState({}); // { Jan: "header", ... }
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [unlockConfirmYear, setUnlockConfirmYear] = useState(null);
  const [unlocking, setUnlocking] = useState(false);
  const fileInputRef = useRef(null);

  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = 2020; y <= currentYear; y++) years.push(y);

  const load = () => api.getStockMovementStatus().then(setStatus).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const startUpload = (year) => {
    setActiveYear(year);
    setHeaders([]); setRows([]); setNameCol(""); setMonthCols({}); setError(""); setResult(null);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError(""); setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
        const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
        setHeaders(headerRow);
        setRows(dataRows);
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const doUnlock = async (year) => {
    setUnlocking(true);
    setError("");
    try {
      await api.unlockStockMovementYear(year);
      setUnlockConfirmYear(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setUnlocking(false);
    }
  };

  const canImport = nameCol && Object.values(monthCols).some(Boolean) && rows.length > 0;

  const doImport = async () => {
    const nameIdx = headers.indexOf(nameCol);
    const monthIdxs = MONTH_NAMES.map((m, i) => ({ month: i + 1, idx: headers.indexOf(monthCols[m]) })).filter((x) => x.idx >= 0);
    const out = [];
    rows.forEach((r) => {
      const productName = String(r[nameIdx] ?? "").trim();
      if (!productName) return;
      monthIdxs.forEach(({ month, idx }) => {
        const qty = Number(r[idx]);
        if (!isNaN(qty) && r[idx] !== "") out.push({ productName, month, qty });
      });
    });
    setImporting(true); setError("");
    try {
      const res = await api.importStockMovement(activeYear, out);
      setResult({ year: activeYear, count: res.count });
      setActiveYear(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Stock movement</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload monthly sales history, one year at a time, to power real slow-mover analysis instead of the current 90-day approximation. Past years lock once imported so they can't be overwritten by accident — {currentYear} stays open since you'll update it as the year goes. Locked a year by mistake, or need to re-upload a correction? Use "Unlock" on that year's card.
      </p>
      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12.5, color: "#4C7A5E", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
          <Check size={14} /> Imported {result.count} monthly records for {result.year}.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: activeYear ? 14 : 0 }}>
        {years.map((y) => {
          const isCurrent = y === currentYear;
          const isLocked = !isCurrent && status?.lockedYears?.includes(y);
          const count = status?.countByYear?.[y] || 0;
          return (
            <div key={y} style={{ border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", minWidth: 110 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{y}</div>
              {isLocked ? (
                unlockConfirmYear === y ? (
                  <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, color: "#B33A3A" }}>Unlock {y}?</span>
                    <button onClick={() => doUnlock(y)} disabled={unlocking} style={{ fontSize: 10.5, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 5, padding: "3px 7px" }}>
                      {unlocking ? "…" : "Yes"}
                    </button>
                    <button onClick={() => setUnlockConfirmYear(null)} style={{ fontSize: 10.5, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 5, padding: "3px 7px" }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>🔒 Locked · {count} rows</div>
                    <button onClick={() => setUnlockConfirmYear(y)} style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 6, border: "1px solid #E5B8B0", background: "#fff", color: "#B33A3A" }}>
                      Unlock
                    </button>
                  </div>
                )
              ) : (
                <button onClick={() => startUpload(y)} style={{ fontSize: 11.5, padding: "4px 9px", borderRadius: 6, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24" }}>
                  {count > 0 ? `Update (${count} rows)` : "Upload"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {activeYear && (
        <div style={{ marginTop: 14, padding: 12, background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Uploading {activeYear}</div>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ fontSize: 12.5, marginBottom: 10 }} />
          {headers.length > 0 && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <Field label="Product name column">
                  <select value={nameCol} onChange={(e) => setNameCol(e.target.value)} style={inputStyle}>
                    <option value="">Select…</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 6 }}>
                Map each month to a column (leave blank if that month isn't in this file):
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(100px,1fr))", gap: 8, marginBottom: 10 }}>
                {MONTH_NAMES.map((m) => (
                  <Field key={m} label={m}>
                    <select value={monthCols[m] || ""} onChange={(e) => setMonthCols((prev) => ({ ...prev, [m]: e.target.value }))} style={{ ...inputStyle, fontSize: 11.5, padding: "5px 6px" }}>
                      <option value="">—</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 10 }}>{rows.length.toLocaleString()} rows detected in the file.</div>
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!canImport || importing} onClick={doImport} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: canImport ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
              {importing ? "Importing…" : `Import ${activeYear}`}
            </button>
            <button onClick={() => setActiveYear(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Opens Google Maps (app on mobile, web on desktop) instead of an embedded
// custom map — it gets real turn-by-turn navigation and search for free,
// which a from-scratch map view wouldn't do without a lot more work.
// Prefers saved coordinates (GPS capture or geocoded address); falls back
// to a text search on name/area if neither exists yet.
function mapsLinkFor(entity) {
  if (entity.coordsLat && entity.coordsLng) {
    return `https://www.google.com/maps/search/?api=1&query=${entity.coordsLat},${entity.coordsLng}`;
  }
  const query = entity.address || `${entity.name}${entity.area ? `, ${entity.area}` : ""}, Lebanon`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// A single link that opens the whole optimized route as real turn-by-turn
// directions in Google Maps, in order — starting from the rep's captured
// location when available, otherwise from the first stop.
function fullRouteMapsLink(route, myLoc) {
  const points = route.filter((s) => s.coords).map((s) => `${s.coords.lat},${s.coords.lng}`);
  if (points.length === 0) return null;
  const origin = myLoc ? `${myLoc.lat},${myLoc.lng}` : points[0];
  const remaining = myLoc ? points : points.slice(1);
  if (remaining.length === 0) return null;
  const destination = remaining[remaining.length - 1];
  const waypoints = remaining.slice(0, -1);
  const params = new URLSearchParams({ api: "1", origin, destination });
  if (waypoints.length > 0) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

const guessColumn = (headers, candidates) =>
  headers.find((h) => candidates.includes(h.trim().toLowerCase())) || "";

// Powers the Telegram "pick up" list: instead of guessing from KayBee's own
// warehouse stock, this reads an actual sales ledger (product + which
// pharmacy it was sold to + that batch's expiry date) so the message can
// tell a rep exactly which pharmacy to visit. Net units still with each
// pharmacy = sold (Type "IV") minus any returns (Type "CR") — purchases and
// warehouse-only transfers are ignored since they never reached a pharmacy.
function PharmacyPickupImportSection() {
  const [status, setStatus] = useState(null); // { rowCount }
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [typeCol, setTypeCol] = useState("");
  const [nameCol, setNameCol] = useState("");
  const [pharmacyCol, setPharmacyCol] = useState("");
  const [qtyCol, setQtyCol] = useState("");
  const [expiryCol, setExpiryCol] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const load = () => api.getPharmacySalesStatus().then(setStatus).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError(""); setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const headerRow = (json[0] || []).map((h, i) => (h === "" ? `Column ${i + 1}` : String(h)));
        const dataRows = json.slice(1).filter((r) => r.some((cell) => cell !== ""));
        setHeaders(headerRow);
        setRows(dataRows);
        setTypeCol(guessColumn(headerRow, ["type"]));
        setNameCol(guessColumn(headerRow, ["description", "product", "product name", "item"]));
        setPharmacyCol(guessColumn(headerRow, ["third", "pharmacy", "customer", "client"]));
        setQtyCol(guessColumn(headerRow, ["quantity", "qty"]));
        setExpiryCol(guessColumn(headerRow, ["expiry", "expiration", "expiry date"]));
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const canImport = typeCol && nameCol && pharmacyCol && qtyCol && expiryCol && rows.length > 0;

  const doImport = async () => {
    const typeIdx = headers.indexOf(typeCol);
    const nameIdx = headers.indexOf(nameCol);
    const pharmacyIdx = headers.indexOf(pharmacyCol);
    const qtyIdx = headers.indexOf(qtyCol);
    const expiryIdx = headers.indexOf(expiryCol);

    const totals = new Map();
    rows.forEach((r) => {
      const type = String(r[typeIdx] ?? "").trim().toUpperCase();
      if (!["IV", "CR"].includes(type)) return; // skip purchases (PU) and warehouse-only transfers (DE)
      const productName = String(r[nameIdx] ?? "").trim();
      const pharmacyName = String(r[pharmacyIdx] ?? "").trim();
      if (!productName || !pharmacyName) return;
      const expiry = parseExcelCellDate(r[expiryIdx]);
      if (!expiry) return;
      const rawQty = Number(r[qtyIdx]);
      if (isNaN(rawQty)) return;
      // IV rows are already negative (units left the warehouse) so -rawQty
      // adds the sold amount; CR rows are positive (units came back) so
      // -rawQty subtracts the return — same formula covers both.
      const key = `${productName}::${pharmacyName}::${expiry}`;
      const existing = totals.get(key) || { productName, pharmacyName, expiry, qty: 0 };
      existing.qty -= rawQty;
      totals.set(key, existing);
    });

    const out = [];
    totals.forEach(({ productName, pharmacyName, expiry, qty }) => {
      if (qty <= 0) return;
      out.push({ productName, pharmacyName, expiry, qty: Math.round(qty) });
    });

    setImporting(true); setError("");
    try {
      const res = await api.importPharmacySales(out);
      setResult({ count: res.count });
      setHeaders([]); setRows([]);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Pharmacy pick-up list source</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload your sales ledger (product, which pharmacy it was sold to, and that batch's expiry date). The monthly Telegram "pick up" list is built from this — items whose sold batch expires within about 3 months — so each rep is told exactly which of their pharmacies to visit, not just which product is expiring somewhere. Re-uploading replaces the whole list with the new export.
      </p>
      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12.5, color: "#4C7A5E", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
          <Check size={14} /> Imported {result.count} pharmacy/batch records.
        </div>
      )}
      <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 10 }}>
        {status ? `Currently loaded: ${status.rowCount.toLocaleString()} pharmacy/batch records.` : "Loading current status…"}
      </div>

      <input type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ fontSize: 12.5, marginBottom: 10 }} />
      {headers.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 10, marginBottom: 10 }}>
            <Field label="Transaction type column">
              <select value={typeCol} onChange={(e) => setTypeCol(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="Product name column">
              <select value={nameCol} onChange={(e) => setNameCol(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="Pharmacy name column">
              <select value={pharmacyCol} onChange={(e) => setPharmacyCol(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="Quantity column">
              <select value={qtyCol} onChange={(e) => setQtyCol(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="Expiry date column">
              <select value={expiryCol} onChange={(e) => setExpiryCol(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 10 }}>{rows.length.toLocaleString()} rows detected in the file.</div>
        </>
      )}
      <button disabled={!canImport || importing} onClick={doImport} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: canImport ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
        {importing ? "Importing…" : "Import pick-up list"}
      </button>
    </div>
  );
}

// ---------- Settings ----------
function SettingsView({ role, slowThreshold, setSlowThreshold, repPhone, setRepPhone, dailyTarget, setDailyTarget, templates, setTemplates, onBulkImport, productCount, onRepsChanged, offers, onAddOffer, onToggleOfferActive, onRemoveOffer }) {
  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Settings</h2>

      <PushNotificationSetup />

      {role === "manager" && <ManagerTelegramLinkSection />}

      {role === "manager" && <RepsManagementSection onRepsChanged={onRepsChanged} />}

      {role === "manager" && (
        <OffersManagementSection offers={offers} onAdd={onAddOffer} onToggleActive={onToggleOfferActive} onRemove={onRemoveOffer} />
      )}

      {role === "manager" && <ExcelImportSection onImport={onBulkImport} productCount={productCount} />}

      {role === "manager" && <StockMovementImportSection />}

      {role === "manager" && <PharmacyPickupImportSection />}
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label={`Slow-mover threshold: flag if turnover falls below ${slowThreshold}% of stock sold per 90 days`}>
          <input type="range" min="5" max="40" value={slowThreshold} onChange={(e) => setSlowThreshold(Number(e.target.value))} style={{ width: "100%" }} />
        </Field>
        <p style={{ fontSize: 11.5, color: "#8A8272", marginTop: 6 }}>
          Formula: (average monthly movement × 3 ÷ units in stock) × 100. Uses real Stock Movement history where uploaded, otherwise falls back to the last 90 days of sales. Below this % is flagged slow-moving, regardless of expiry date.
        </p>
      </div>
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label="Rep WhatsApp number (for expiry nudges, include country code)">
          <input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} />
        </Field>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label={`Daily new-pharmacy outreach goal: ${dailyTarget} contacts/day`}>
          <input type="range" min="1" max="10" value={dailyTarget} onChange={(e) => setDailyTarget(Number(e.target.value))} style={{ width: "100%" }} />
        </Field>
        <p style={{ fontSize: 11.5, color: "#8A8272", marginTop: 6 }}>
          Keep this modest (2–4/day) — spacing out first-contact messages avoids WhatsApp spam flags.
        </p>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>
          Outreach message variations (use {"{name}"} to insert the contact's name)
        </label>
        {templates.map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <textarea
              value={t}
              onChange={(e) => setTemplates(templates.map((p, idx) => (idx === i ? e.target.value : p)))}
              rows={2}
              style={{ ...inputStyle, resize: "vertical", flex: 1 }}
            />
            <button onClick={() => setTemplates(templates.filter((_, idx) => idx !== i))}
              style={{ background: "none", border: "none", color: "#B7AF9E", padding: "0 4px" }}>
              <X size={16} />
            </button>
          </div>
        ))}
        <button onClick={() => setTemplates([...templates, "Hi {name}, "])}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500, color: "#C17817", background: "none", border: "none", padding: "4px 0" }}>
          <Plus size={14} /> Add variation
        </button>
      </div>
    </div>
  );
}

function EmptyState({ text }) {
  return <div style={{ textAlign: "center", padding: "30px 0", color: "#B7AF9E", fontSize: 13 }}>{text}</div>;
}
