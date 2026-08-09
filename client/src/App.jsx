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
  GraduationCap,
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

// ---------- main app ----------
export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [role, setRole] = useState("manager");
  const [repName, setRepName] = useState("");
  const [tab, setTab] = useState("expiry");
  const [products, setProducts] = useState([]);
  const [visits, setVisits] = useState([]);
  const [clients, setClients] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [outreachLog, setOutreachLog] = useState([]);
  const [orders, setOrders] = useState([]);
  const [repNames, setRepNames] = useState([]);
  const [offers, setOffers] = useState([]);
  const [samples, setSamples] = useState([]);
  const [punchLog, setPunchLog] = useState([]);
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
      .then((data) => { setRole(data.role); setRepName(data.repName || ""); setAuthState("in"); })
      .catch(() => setAuthState("out"));
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* cookie is cleared client-side regardless */ }
    setAuthState("out");
  };

  const refresh = useCallback(async (opts) => {
    try {
      const data = await api.bootstrap(opts);
      setProducts(data.products);
      setVisits(data.visits);
      setClients(data.clients);
      setDoctors(data.doctors || []);
      setOutreachLog(data.outreachLog);
      setOrders(data.orders || []);
      setRepNames(data.repNames || []);
      setOffers(data.offers || []);
      setSamples(data.samples || []);
      setPunchLog(data.punchLog || []);
      if (!settingsDirtyRef.current) setSettings(data.settings);
      setLoadError("");
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (authState !== "in") return;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh, authState]);

  const withSync = useCallback(async (fn) => {
    setSyncStatus("saving");
    try {
      const result = await fn();
      await refresh({ fresh: true }); // skip the cache — the person who just wrote should see it immediately
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus(""), 1200);
      return result;
    } catch (e) {
      setSyncStatus("error");
      setLoadError(e.message);
      return undefined;
    }
  }, [refresh]);

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
  const contactedToday = outreachLog.filter((o) => o.date === todayStr).length;

  const removeProduct = (id) => withSync(() => api.removeProduct(id));
  const bulkImportProducts = (products) => withSync(() => api.importBulkProducts(products));
  const addVisit = (visit) => withSync(() => api.addVisit(visit));
  const removeVisit = (id) => withSync(() => api.removeVisit(id));
  const punch = (type, coords) => withSync(() => api.punch(type, coords));
  const createOrder = (order) => withSync(() => api.createOrder(order));
  const addClient = (client) => withSync(() => api.addClient(client));
  const removeClient = (id) => withSync(() => api.removeClient(id));
  const bulkImportClients = (payload) => withSync(() => api.importClientsBulk(payload));
  const assignClientRep = (id, assignedRep) => withSync(() => api.assignClientRep(id, assignedRep));
  const addDoctor = (doctor) => withSync(() => api.addDoctor(doctor));
  const removeDoctor = (id) => withSync(() => api.removeDoctor(id));
  const bulkImportDoctors = (payload) => withSync(() => api.importDoctorsBulk(payload));
  const logOutreach = (entry) => withSync(() => api.logOutreach(entry));
  const deleteOrder = (id) => withSync(() => api.deleteOrder(id));
  const requestDeleteOrder = (id) => withSync(() => api.requestDeleteOrder(id));
  const approveDeleteOrder = (id) => withSync(() => api.approveDeleteOrder(id));
  const denyDeleteOrder = (id) => withSync(() => api.denyDeleteOrder(id));
  const addOffer = (offer) => withSync(() => api.addOffer(offer));
  const toggleOfferActive = (id, active) => withSync(() => api.updateOffer(id, { active }));
  const removeOffer = (id) => withSync(() => api.removeOffer(id));

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
    return <LoginView onSuccess={(r, rn) => { setRole(r); setRepName(rn || ""); setAuthState("in"); }} />;
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
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#5B5445", background: "#F0EBE0", borderRadius: 8, padding: "9px 16px" }}>
            {role === "manager" ? "Manager" : repName ? `Med Rep · ${repName}` : "Med Rep"}
          </span>
          <button onClick={logout} style={{ fontSize: 12, color: "#8A8272", background: "none", border: "1px solid #E5DFD3", borderRadius: 8, padding: "9px 12px" }}>
            Log out
          </button>
        </div>
      </header>

      <nav style={{ display: "flex", gap: 4, padding: "12px 24px 0", borderBottom: "1px solid #E5DFD3", overflowX: "auto" }}>
        <TabBtn active={tab === "expiry"} onClick={() => setTab("expiry")} icon={<Package size={15} />} label="Expiry Alerts" />
        <TabBtn active={tab === "clients"} onClick={() => setTab("clients")} icon={<Users size={15} />} label="Pharmacies" />
        <TabBtn active={tab === "doctors"} onClick={() => setTab("doctors")} icon={<Stethoscope size={15} />} label="Doctors" />
        <TabBtn active={tab === "knowledge"} onClick={() => setTab("knowledge")} icon={<BookOpen size={15} />} label="Knowledge" />
        <TabBtn active={tab === "training"} onClick={() => setTab("training")} icon={<GraduationCap size={15} />} label="Training" />
        {role === "rep" && <TabBtn active={tab === "checkin"} onClick={() => setTab("checkin")} icon={<MapPin size={15} />} label="Check-In" />}
        {role === "rep" && <TabBtn active={tab === "route"} onClick={() => setTab("route")} icon={<Navigation size={15} />} label="Route" />}
        {role === "manager" && <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={<LayoutDashboard size={15} />} label="Dashboard" />}
        {role === "manager" && <TabBtn active={tab === "performance"} onClick={() => setTab("performance")} icon={<Target size={15} />} label="Performance" />}
        {role === "manager" && <TabBtn active={tab === "outreach"} onClick={() => setTab("outreach")} icon={<MessageCircle size={15} />} label="Outreach" />}
        {role === "manager" && <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")} icon={<Megaphone size={15} />} label="Broadcast" />}
        {role === "manager" && <TabBtn active={tab === "orders"} onClick={() => setTab("orders")} icon={<ShoppingCart size={15} />} label="Orders" />}
        {role === "manager" && <TabBtn active={tab === "locations"} onClick={() => setTab("locations")} icon={<RadarIcon size={15} />} label="Locations" />}
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
                visits={visits}
                clients={clients}
                doctors={doctors}
                products={products}
                offers={offers}
                orders={orders}
                punchLog={punchLog}
                repName={repName}
                onAddVisit={addVisit}
                onCreateOrder={createOrder}
                onRequestDeleteOrder={requestDeleteOrder}
                onPunch={punch}
              />
            )}
            {tab === "clients" && (
              <ClientsView
                clients={clients}
                visits={visits}
                orders={orders}
                role={role}
                repNames={repNames}
                onAdd={addClient}
                onRemove={removeClient}
                onBulkImport={bulkImportClients}
                onAssignRep={assignClientRep}
              />
            )}
            {tab === "doctors" && (
              <DoctorsView
                doctors={doctors}
                visits={visits}
                samples={samples}
                role={role}
                onAdd={addDoctor}
                onRemove={removeDoctor}
                onBulkImport={bulkImportDoctors}
              />
            )}
            {tab === "knowledge" && <KnowledgeView />}
            {tab === "training" && <TrainingView />}
            {tab === "route" && role === "rep" && <RouteView clients={clients} doctors={doctors} visits={visits} />}
            {tab === "dashboard" && role === "manager" && <DashboardView zoned={zoned} visits={visits} />}
            {tab === "orders" && role === "manager" && (
              <OrdersView orders={orders} onDelete={deleteOrder} onApproveDelete={approveDeleteOrder} onDenyDelete={denyDeleteOrder} />
            )}
            {tab === "locations" && role === "manager" && <LocationsView visits={visits} punchLog={punchLog} repNames={repNames} onRemoveVisit={removeVisit} />}
            {tab === "performance" && role === "manager" && (
              <PerformanceView
                visits={visits}
                orders={orders}
                clients={clients}
                doctors={doctors}
                repNames={repNames}
                monthlyVisitTarget={settings.monthlyVisitTarget}
                setMonthlyVisitTarget={(v) => updateSettingsField({ monthlyVisitTarget: v })}
                monthlyRevenueTarget={settings.monthlyRevenueTarget}
                setMonthlyRevenueTarget={(v) => updateSettingsField({ monthlyRevenueTarget: v })}
              />
            )}
            {tab === "outreach" && role === "manager" && (
              <OutreachView
                dailyTarget={settings.dailyTarget}
                contactedToday={contactedToday}
                templates={settings.templates}
                outreachLog={outreachLog}
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
                onRepsChanged={refresh}
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
      onSuccess(data.role, data.repName);
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

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };

// ---------- Check-In View (rep) ----------
function CheckInView({ visits, clients, doctors, products, offers, orders, punchLog, repName, onAddVisit, onCreateOrder, onRequestDeleteOrder, onPunch }) {
  const [punching, setPunching] = useState(false);
  const [punchError, setPunchError] = useState("");
  const [entityType, setEntityType] = useState("pharmacy"); // pharmacy | doctor
  const [client, setClient] = useState("");
  const [notes, setNotes] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const [lastVisit, setLastVisit] = useState(null);
  const [showOrderPrompt, setShowOrderPrompt] = useState(false);
  const [showOrderBuilder, setShowOrderBuilder] = useState(false);
  const [followUpStatus, setFollowUpStatus] = useState(null); // null | "set" | "skipped"
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [followUpError, setFollowUpError] = useState("");
  const [exportSheetId, setExportSheetId] = useState("");
  const [mentionedItems, setMentionedItems] = useState([]);
  const [itemQuery, setItemQuery] = useState("");
  const [sampleMenuFor, setSampleMenuFor] = useState(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

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

  const nameOptionsSource = entityType === "pharmacy" ? clients : doctors;
  const nameOptions = (client.trim()
    ? nameOptionsSource.filter((c) => c.name.toLowerCase().includes(client.toLowerCase().trim()))
    : nameOptionsSource
  ).slice(0, 50);

  const matchedItem = products.find((p) => p.name.toLowerCase().trim() === itemQuery.toLowerCase().trim());
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

  const myPunches = punchLog.filter((p) => p.repName === repName).sort((a, b) => new Date(b.time) - new Date(a.time));
  const lastPunch = myPunches[0] || null;
  const isPunchedIn = lastPunch?.type === "in";

  const doPunch = (type) => {
    setPunching(true);
    setPunchError("");
    const submit = (coords) => {
      onPunch(type, coords)
        .catch((e) => setPunchError(e?.message || "Couldn't record punch."))
        .finally(() => setPunching(false));
    };
    if (!navigator.geolocation) { submit(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => submit({ lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }),
      () => submit(null),
      { timeout: 8000 }
    );
  };

  const getLocation = () => {
    setLocating(true);
    setLocError("");
    if (!navigator.geolocation) {
      setLocError("Location not available on this device/browser.");
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }); setLocating(false); },
      () => { setLocError("Couldn't get location. Check permissions."); setLocating(false); },
      { timeout: 8000 }
    );
  };

  const submit = async () => {
    const visitClient = client;
    const created = await onAddVisit({ client, notes, coords, mentionedItems });
    setLastVisit(created || { client: visitClient });
    setClient(""); setNotes(""); setCoords(null); setMentionedItems([]); setItemQuery(""); setSampleMenuFor(null);
    setShowOrderPrompt(true);
    setShowOrderBuilder(false);
    setFollowUpStatus(null);
    setFollowUpError("");
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
    } catch (e) {
      setFollowUpError(e?.message || "Couldn't schedule follow-up.");
    } finally {
      setFollowUpSaving(false);
    }
  };

  const todayVisits = visits.filter((v) => v.repName === repName && new Date(v.time).toDateString() === new Date().toDateString());

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Log a visit</h2>
        {exportSheetId && (
          <a href={`https://docs.google.com/spreadsheets/d/${exportSheetId}/edit`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#4C7A5E", textDecoration: "none", border: "1px solid #4C7A5E33", borderRadius: 6, padding: "5px 10px" }}>
            View my visits sheet
          </a>
        )}
      </div>

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
          <input
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder={entityType === "pharmacy" ? "e.g. Pharmacie Al Nour" : "e.g. Dr. Nour Khalil"}
            list="checkin-client-options"
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          <datalist id="checkin-client-options">
            {nameOptions.map((c) => <option key={c.id} value={c.name} />)}
          </datalist>
        </Field>
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
                {products.map((p) => <option key={p.id} value={p.name} />)}
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
            {locating ? "Locating…" : coords ? "Update location" : "Capture GPS location"}
          </button>
          {coords && <span className="kb-font-mono" style={{ fontSize: 11.5, color: "#4C7A5E" }}><Check size={12} style={{ verticalAlign: -1 }} /> {coords.lat}, {coords.lng}</span>}
        </div>
        {locError && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 12 }}>{locError}</div>}

        <button disabled={!client} onClick={submit} style={{
          padding: "9px 18px", borderRadius: 8, border: "none",
          background: client ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500,
        }}>
          Save visit
        </button>
      </div>

      {showOrderPrompt && lastVisit && !showOrderBuilder && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <span style={{ fontSize: 13.5 }}>Did <strong>{lastVisit.client}</strong> place an order?</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowOrderBuilder(true)} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
              Yes, add order
            </button>
            <button onClick={() => setShowOrderPrompt(false)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>
              No
            </button>
          </div>
        </div>
      )}

      {showOrderBuilder && lastVisit && (
        <OrderBuilder
          clientName={lastVisit.client}
          visitId={lastVisit.id}
          products={products}
          offers={offers}
          orders={orders}
          onCreateOrder={onCreateOrder}
          onDone={() => { setShowOrderBuilder(false); setShowOrderPrompt(false); }}
        />
      )}

      {lastVisit && followUpStatus === null && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13.5, marginBottom: 10 }}>
            Schedule a follow-up for <strong>{lastVisit.client}</strong>?
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
            <button
              disabled={followUpSaving}
              onClick={() => setFollowUpStatus("skipped")}
              style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}
            >
              No follow-up needed
            </button>
          </div>
          {followUpError && <div style={{ fontSize: 12, color: "#B33A3A", marginTop: 8 }}>{followUpError}</div>}
        </div>
      )}
      {followUpStatus === "set" && lastVisit && (
        <div style={{ fontSize: 12.5, color: "#4C7A5E", marginBottom: 20 }}>
          <Check size={12} style={{ verticalAlign: -1 }} /> Follow-up scheduled for {lastVisit.client} — you'll get a Telegram reminder when it's due.
        </div>
      )}

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Today's visits ({todayVisits.length})</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {todayVisits.map((v) => (
          <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}</span>
              <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>{new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
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
          </div>
        ))}
        {todayVisits.length === 0 && <EmptyState text="No visits logged yet today." />}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "20px 0 10px", color: "#8A8272" }}>Your recent orders</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {orders.filter((o) => o.repName === repName).slice(0, 10).map((o) => (
          <div key={o.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.clientName}</div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · total {o.total.toFixed(2)}
              </div>
            </div>
            {o.status === "deletion_requested" ? (
              <span style={{ fontSize: 11.5, color: "#C17817" }}>Deletion requested — awaiting approval</span>
            ) : (
              <button onClick={() => onRequestDeleteOrder(o.id)} style={{ fontSize: 11.5, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "6px 10px" }}>
                Request deletion
              </button>
            )}
          </div>
        ))}
        {orders.filter((o) => o.repName === repName).length === 0 && <EmptyState text="No orders yet." />}
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
// though the rep saw the on-screen ⚠ and moved on. Each warning also lists
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
    head: [["Item", "Qty", "Unit Price", "Line Total"]],
    body: order.items.map((it) => [
      it.name + (it.isFree ? " (FREE)" : ""),
      String(it.qty),
      it.isFree ? "FREE" : Number(it.unitPrice).toFixed(2),
      it.isFree ? "0.00" : (it.qty * it.unitPrice).toFixed(2),
    ]),
    foot: [["", "", "Total", Number(order.total).toFixed(2)]],
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

// ---------- Order Builder (used from Check-In) ----------
function OrderBuilder({ clientName, visitId, products, offers, orders, onCreateOrder, onDone }) {
  const [productQuery, setProductQuery] = useState("");
  const [qty, setQty] = useState("");
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [appliedOfferIds, setAppliedOfferIds] = useState(new Set());
  const [applyingOfferId, setApplyingOfferId] = useState(null);
  const [freeProductQuery, setFreeProductQuery] = useState("");

  const matchedProduct = products.find((p) => p.name.toLowerCase().trim() === productQuery.toLowerCase().trim());

  const addItem = () => {
    setError("");
    if (!matchedProduct) { setError("Pick a product from the list."); return; }
    const q = Number(qty);
    if (!q || q <= 0) { setError("Enter a quantity greater than 0."); return; }
    setItems((prev) => [...prev, {
      productId: matchedProduct.id,
      name: matchedProduct.name,
      qty: q,
      unitPrice: matchedProduct.price || 0,
      availableQty: matchedProduct.qty,
      isFree: false,
    }]);
    setProductQuery("");
    setQty("");
  };

  const removeItem = (idx) => {
    setItems((prev) => {
      const removed = prev[idx];
      if (removed?.isFree && removed.viaOfferId) {
        setAppliedOfferIds((ids) => { const next = new Set(ids); next.delete(removed.viaOfferId); return next; });
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  const regularItems = items.filter((it) => !it.isFree);
  const regularQty = regularItems.reduce((sum, it) => sum + it.qty, 0);
  const weightedAvgPrice = regularQty > 0 ? regularItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0) / regularQty : 0;
  const total = items.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const eligibleOffers = offers.filter((o) =>
    o.active && (!o.expiresAt || o.expiresAt >= todayStr) && regularQty >= o.buyQty && !appliedOfferIds.has(o.id)
  );
  const eligibleFreeProducts = products.filter((p) => p.qty > 0 && p.price > 0 && p.price <= weightedAvgPrice);
  const matchedFreeProduct = eligibleFreeProducts.find((p) => p.name.toLowerCase().trim() === freeProductQuery.toLowerCase().trim());

  const applyOffer = (offer) => {
    if (!matchedFreeProduct) return;
    setItems((prev) => [...prev, {
      productId: matchedFreeProduct.id,
      name: matchedFreeProduct.name,
      qty: offer.getQty,
      unitPrice: 0,
      originalPrice: matchedFreeProduct.price,
      availableQty: matchedFreeProduct.qty,
      isFree: true,
      viaOfferId: offer.id,
    }]);
    setAppliedOfferIds((prev) => new Set(prev).add(offer.id));
    setApplyingOfferId(null);
    setFreeProductQuery("");
  };

  const doCreateOrder = async () => {
    if (items.length === 0) { setError("Add at least one item first."); return; }
    setError("");
    setSaving(true);
    try {
      // An item ordered above what's in stock gets saved at the max
      // available instead — the on-screen ⚠ already told the rep, this is
      // the point where it actually gets enforced rather than just shown.
      const stockWarnings = [];
      const finalItems = [];
      for (const it of items) {
        if (it.isFree || it.qty <= it.availableQty) {
          finalItems.push(it);
          continue;
        }
        const cappedQty = Math.max(0, it.availableQty);
        const otherOrders = (orders || [])
          .filter((o) => o.clientName !== clientName && (o.items || []).some((oi) => oi.productId === it.productId))
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 5)
          .map((o) => ({
            clientName: o.clientName,
            qty: o.items.find((oi) => oi.productId === it.productId)?.qty || 0,
            date: o.date,
          }));
        stockWarnings.push({ productName: it.name, requestedQty: it.qty, cappedQty, otherOrders });
        if (cappedQty > 0) finalItems.push({ ...it, qty: cappedQty });
      }
      if (finalItems.length === 0) {
        setError("None of the items in this order have stock available.");
        setSaving(false);
        return;
      }
      const finalTotal = finalItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
      const payload = {
        clientName,
        visitId,
        items: finalItems.map(({ productId, name, qty, unitPrice, isFree, originalPrice }) => ({
          productId, name, qty, unitPrice, isFree: !!isFree, originalPrice: originalPrice || 0,
        })),
      };
      const created = await onCreateOrder(payload);
      downloadOrderPdf(created || { ...payload, date: new Date().toISOString(), total: finalTotal }, stockWarnings);
      onDone();
    } catch (e) {
      setError(e.message || "Couldn't save the order.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>Order for {clientName}</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ flex: 2, minWidth: 160 }}>
          <input
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
            placeholder="Search product…"
            list="order-product-options"
            style={inputStyle}
          />
          <datalist id="order-product-options">
            {products.map((p) => <option key={p.id} value={p.name} />)}
          </datalist>
        </div>
        <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" style={{ ...inputStyle, flex: 1, minWidth: 80 }} />
        <button onClick={addItem} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}>
          Add item
        </button>
      </div>

      {matchedProduct && (
        <div style={{ fontSize: 11.5, color: matchedProduct.qty > 0 ? "#4C7A5E" : "#B33A3A", marginBottom: 8 }}>
          {matchedProduct.qty > 0 ? `${matchedProduct.qty} in stock` : "Out of stock"} · price {matchedProduct.price ? matchedProduct.price.toFixed(2) : "not set"}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "#B33A3A", marginBottom: 8 }}>{error}</div>}

      {eligibleOffers.length > 0 && !applyingOfferId && (
        <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          {eligibleOffers.map((o) => (
            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
              <span>🎉 Qualifies for <strong>{o.label}</strong> — {o.getQty} free item{o.getQty === 1 ? "" : "s"}, up to {weightedAvgPrice.toFixed(2)} each</span>
              <button onClick={() => { setApplyingOfferId(o.id); setFreeProductQuery(""); }} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#C17817", color: "#fff", fontSize: 11.5, fontWeight: 500 }}>
                Apply
              </button>
            </div>
          ))}
        </div>
      )}

      {applyingOfferId && (() => {
        const offer = offers.find((o) => o.id === applyingOfferId);
        if (!offer) return null;
        return (
          <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, marginBottom: 6 }}>Pick a free item (up to {weightedAvgPrice.toFixed(2)}) for "{offer.label}":</div>
            <input
              value={freeProductQuery}
              onChange={(e) => setFreeProductQuery(e.target.value)}
              placeholder="Search eligible items…"
              list="free-item-options"
              style={inputStyle}
            />
            <datalist id="free-item-options">
              {eligibleFreeProducts.map((p) => <option key={p.id} value={p.name} />)}
            </datalist>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                disabled={!matchedFreeProduct}
                onClick={() => applyOffer(offer)}
                style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: matchedFreeProduct ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 12.5, fontWeight: 500 }}
              >
                Add {offer.getQty} free
              </button>
              <button onClick={() => setApplyingOfferId(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5 }}>
                Cancel
              </button>
            </div>
            {eligibleFreeProducts.length === 0 && (
              <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 6 }}>No in-stock items priced at or below {weightedAvgPrice.toFixed(2)}.</div>
            )}
          </div>
        );
      })()}

      {items.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#8A8272" }}>
                  <th style={{ padding: "4px 6px" }}>Item</th>
                  <th style={{ padding: "4px 6px" }}>Qty</th>
                  <th style={{ padding: "4px 6px" }}>Stock</th>
                  <th style={{ padding: "4px 6px" }}>Unit price</th>
                  <th style={{ padding: "4px 6px" }}>Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                    <td style={{ padding: "4px 6px" }}>
                      {it.name}{it.isFree && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "#4C7A5E1A", color: "#4C7A5E" }}>FREE</span>}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{it.qty}</td>
                    <td style={{ padding: "4px 6px", color: it.qty > it.availableQty ? "#B33A3A" : "#4C7A5E" }}>
                      {it.availableQty}{it.qty > it.availableQty ? " ⚠" : ""}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{it.isFree ? "FREE" : it.unitPrice.toFixed(2)}</td>
                    <td style={{ padding: "4px 6px" }}>{it.isFree ? "0.00" : (it.qty * it.unitPrice).toFixed(2)}</td>
                    <td style={{ padding: "4px 6px" }}>
                      <button onClick={() => removeItem(i)} style={{ background: "none", border: "none", color: "#B7AF9E" }}><X size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600, marginTop: 6 }}>Total: {total.toFixed(2)}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={saving || items.length === 0}
          onClick={doCreateOrder}
          style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: !saving && items.length > 0 ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Creating…" : "Create order & download PDF"}
        </button>
        <button onClick={onDone} style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- Orders View (manager, order history) ----------
function OrdersView({ orders, onDelete, onApproveDelete, onDenyDelete }) {
  const [confirmIds, setConfirmIds] = useState(new Set());
  const askConfirm = (id) => setConfirmIds((prev) => new Set(prev).add(id));
  const cancelConfirm = (id) => setConfirmIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  const doDelete = (id) => { onDelete(id); cancelConfirm(id); };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Orders</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {orders.map((o) => (
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
                {new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · {o.items.length} item{o.items.length === 1 ? "" : "s"} · total {o.total.toFixed(2)}
              </div>
              {o.status === "deletion_requested" && <div style={{ fontSize: 11.5, color: "#B33A3A", marginTop: 4 }}>Rep requested deletion</div>}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => downloadOrderPdf(o)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 12, fontWeight: 500 }}>
                <Download size={13} /> PDF
              </button>
              {o.status === "deletion_requested" ? (
                <>
                  <button onClick={() => onApproveDelete(o.id)} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px" }}>Approve delete</button>
                  <button onClick={() => onDenyDelete(o.id)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "7px 12px" }}>Deny</button>
                </>
              ) : confirmIds.has(o.id) ? (
                <>
                  <span style={{ fontSize: 11.5, color: "#B33A3A" }}>Delete?</span>
                  <button onClick={() => doDelete(o.id)} style={{ fontSize: 12, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>Yes</button>
                  <button onClick={() => cancelConfirm(o.id)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 10px" }}>Cancel</button>
                </>
              ) : (
                <button onClick={() => askConfirm(o.id)} style={{ fontSize: 12, color: "#B33A3A", background: "none", border: "1px solid #E5B8B0", borderRadius: 6, padding: "7px 12px" }}>Delete</button>
              )}
            </div>
          </div>
        ))}
        {orders.length === 0 && <EmptyState text="No orders logged yet." />}
      </div>
    </div>
  );
}

// ---------- Locations View (manager, check-in GPS history + punch in/out) ----------
function LocationsView({ visits, punchLog, repNames, onRemoveVisit }) {
  const [selectedRep, setSelectedRep] = useState("all");
  const [confirmId, setConfirmId] = useState(null);

  const visitEvents = visits
    .map((v) => ({ kind: "visit", id: v.id, repName: v.repName, time: v.time, coords: v.coords || null, label: v.client }));

  const punchEvents = (punchLog || [])
    .filter((p) => p.coords)
    .map((p) => ({ kind: "punch", id: p.id, repName: p.repName, time: p.time, coords: p.coords, label: p.type === "in" ? "Punched in" : "Punched out", punchType: p.type }));

  const allEvents = [...visitEvents, ...punchEvents]
    .filter((e) => selectedRep === "all" || e.repName === selectedRep)
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  const shownEvents = allEvents.slice(0, LIST_DISPLAY_CAP);

  const doDelete = (id) => { onRemoveVisit(id); setConfirmId(null); };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Check-in locations</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Shows visit check-ins and punch in/out events, most recent first, with the GPS a rep recorded at that moment where available. This isn't live tracking — a web app can only record location at the moment a button is tapped. You can delete a mistaken visit here.
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
            borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {e.label}{e.repName ? ` · ${e.repName}` : ""}
              </div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(e.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                {e.coords ? ` · ${e.coords.lat}, ${e.coords.lng}` : " · no GPS captured"}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {e.coords && (
                <a href={`https://maps.google.com/?q=${e.coords.lat},${e.coords.lng}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#4C7A5E", textDecoration: "none", border: "1px solid #4C7A5E33", borderRadius: 6, padding: "6px 10px" }}>
                  View on map
                </a>
              )}
              {e.kind === "visit" && (
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

function ClientExcelImportSection({ existingClients, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", phone: "", area: "", address: "", registrationNumber: "" });
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

  const resetMapping = () => setMapping({ name: "", phone: "", area: "", address: "", registrationNumber: "" });

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
    const phoneIdx = headers.indexOf(mapping.phone);
    const areaIdx = headers.indexOf(mapping.area);
    const addressIdx = headers.indexOf(mapping.address);
    const regIdx = headers.indexOf(mapping.registrationNumber);

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
      fresh.push({
        name,
        phone: phoneIdx >= 0 ? String(r[phoneIdx] ?? "").trim() : "",
        area: areaIdx >= 0 ? String(r[areaIdx] ?? "").trim() : "",
        address: addressIdx >= 0 ? String(r[addressIdx] ?? "").trim() : "",
        registrationNumber: regIdx >= 0 ? String(r[regIdx] ?? "").trim() : "",
      });
    });

    return { newClients: fresh, skippedCount: skipped };
  }, [mapping, rows, headers, existingClients]);

  const doImport = async () => {
    setError("");
    setImporting(true);
    setProgress({ done: 0, total: newClients.length });
    try {
      let added = 0;
      for (let i = 0; i < newClients.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = newClients.slice(i, i + IMPORT_CHUNK_SIZE);
        const data = await importChunkWithRetry(() => api.importClientsBulk({ toAdd: chunk }));
        added += data?.added ?? chunk.length;
        setProgress({ done: Math.min(i + IMPORT_CHUNK_SIZE, newClients.length), total: newClients.length });
      }
      await onImport({ toAdd: [] }); // one refresh now that every chunk is in, instead of one per chunk
      setResult({ added, skipped: skippedCount });
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
            {fieldSelect("phone", "Phone number column", false)}
            {fieldSelect("area", "Area column", false)}
            {fieldSelect("address", "Address column", false)}
            {fieldSelect("registrationNumber", "Registration number column", false)}
          </div>

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
                        <th style={{ padding: "4px 6px" }}>Phone</th>
                        <th style={{ padding: "4px 6px" }}>Area</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newClients.slice(0, 5).map((c, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #E5DFD3" }}>
                          <td style={{ padding: "4px 6px" }}>{c.name}</td>
                          <td style={{ padding: "4px 6px" }}>{c.phone || "—"}</td>
                          <td style={{ padding: "4px 6px" }}>{c.area || "—"}</td>
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
function ClientsView({ clients, visits, orders, role, repNames, onAdd, onRemove, onBulkImport, onAssignRep }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState("B");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [assignedRep, setAssignedRep] = useState("");
  const [search, setSearch] = useState("");

  const lastVisitFor = (clientName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === clientName.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };

  const addClient = () => {
    if (!name) return;
    onAdd({ name, phone, tier, area, address, registrationNumber, assignedRep });
    setName(""); setPhone(""); setArea(""); setAddress(""); setRegistrationNumber(""); setTier("B"); setAssignedRep("");
    setShowAdd(false);
  };

  const revenueFor = (clientName) => (orders || [])
    .filter((o) => o.clientName.toLowerCase().trim() === clientName.toLowerCase().trim())
    .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

  const rows = clients.map((c) => {
    const lv = lastVisitFor(c.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[c.tier] || 30;
    const overdue = days === null || days > cadence;
    const revenue = revenueFor(c.name);
    const leadScore = computeLeadScore({ tier: c.tier, days, cadence, revenue });
    return { ...c, days, overdue, cadence, revenue, leadScore };
  }).sort((a, b) => b.leadScore - a.leadScore);

  const q = search.toLowerCase().trim();
  const filteredRows = q ? rows.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    (c.area || "").toLowerCase().includes(q) ||
    (c.phone || "").toLowerCase().includes(q) ||
    (c.registrationNumber || "").toLowerCase().includes(q)
  ) : [];
  // Same priority score shown on every card below — highest-priority overdue
  // pharmacies first, not just "whoever happens to have the most raw days
  // since their last visit" (that ignored tier and order history entirely).
  const suggestedFollowUps = rows.filter((c) => c.overdue).slice(0, 5);
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

      {role === "manager" && showImport && <ClientExcelImportSection existingClients={clients} onImport={onBulkImport} onDone={() => setShowImport(false)} />}

      {showAdd && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Field label="Pharmacy name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pharmacie Al Nour" style={inputStyle} /></Field>
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
            <Field label="Assigned sales rep (optional)">
              <select value={assignedRep} onChange={(e) => setAssignedRep(e.target.value)} style={inputStyle}>
                <option value="">Unassigned</option>
                {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </div>
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

      {suggestedFollowUps.length > 0 && (
        <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: "0 0 2px", color: "#7A5B2E" }}>Suggested follow-ups</h3>
          <p style={{ fontSize: 11, color: "#9C8659", margin: "0 0 10px" }}>
            The 5 overdue pharmacies with the highest priority score — same score shown on each card below (tier + overdue-ness + order history).
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {suggestedFollowUps.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", border: "1px solid #E9C88A", borderRadius: 8, padding: "8px 12px", fontSize: 12.5 }}>
                <span><strong>{c.name}</strong> — priority {c.leadScore} · {c.days === null ? "never visited" : `${c.days}d since visit`} (cadence {c.cadence}d)</span>
                {c.phone && (
                  <a href={`https://wa.me/${c.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "#4C7A5E", textDecoration: "none" }}>
                    WhatsApp
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
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
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: c.overdue ? "#B33A3A" : "#4C7A5E" }}>
                  {c.days === null ? "never visited" : `${c.days}d since visit`}
                </div>
                {c.overdue && <div style={{ fontSize: 10.5, color: "#B33A3A" }}>overdue (cadence {c.cadence}d)</div>}
              </div>
            </div>
            <button onClick={() => onRemove(c.id)} style={{ marginTop: 6, background: "none", border: "none", color: "#B7AF9E", fontSize: 11 }}>Remove</button>
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
      for (let i = 0; i < newDoctors.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = newDoctors.slice(i, i + IMPORT_CHUNK_SIZE);
        const data = await importChunkWithRetry(() => api.importDoctorsBulk({ toAdd: chunk }));
        added += data?.added ?? chunk.length;
        setProgress({ done: Math.min(i + IMPORT_CHUNK_SIZE, newDoctors.length), total: newDoctors.length });
      }
      await onImport({ toAdd: [] }); // one refresh now that every chunk is in, instead of one per chunk
      setResult({ added, skipped: skippedCount });
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
function DoctorsView({ doctors, visits, samples, role, onAdd, onRemove, onBulkImport }) {
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

  const lastVisitFor = (doctorName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === doctorName.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };

  const pendingSamplesFor = (doctorName) => {
    const matches = (samples || []).filter((s) => s.doctorName.toLowerCase().trim() === doctorName.toLowerCase().trim());
    const latestByProduct = new Map();
    matches.forEach((s) => {
      const existing = latestByProduct.get(s.productId);
      if (!existing || new Date(s.date) > new Date(existing.date)) latestByProduct.set(s.productId, s);
    });
    return [...latestByProduct.values()].filter((s) => s.status === "next_visit");
  };

  const addDoctor = () => {
    if (!name) return;
    onAdd({ name, hospital, area, phone, specialty, tier, address, registrationNumber });
    setName(""); setHospital(""); setArea(""); setPhone(""); setSpecialty(""); setTier("B"); setAddress(""); setRegistrationNumber("");
    setShowAdd(false);
  };

  const rows = doctors.map((d) => {
    const lv = lastVisitFor(d.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[d.tier] || 30;
    const overdue = days === null || days > cadence;
    const pendingSamples = pendingSamplesFor(d.name);
    const leadScore = computeLeadScore({ tier: d.tier, days, cadence, engagement: pendingSamples.length });
    return { ...d, days, overdue, cadence, pendingSamples, leadScore };
  }).sort((a, b) => b.leadScore - a.leadScore);

  const q = search.toLowerCase().trim();
  const filteredRows = q ? rows.filter((d) =>
    d.name.toLowerCase().includes(q) ||
    (d.specialty || "").toLowerCase().includes(q) ||
    (d.area || "").toLowerCase().includes(q) ||
    (d.hospital || "").toLowerCase().includes(q) ||
    (d.phone || "").toLowerCase().includes(q) ||
    (d.registrationNumber || "").toLowerCase().includes(q)
  ) : [];
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
            <button onClick={() => onRemove(d.id)} style={{ marginTop: 6, background: "none", border: "none", color: "#B7AF9E", fontSize: 11 }}>Remove</button>
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
function RouteView({ clients, doctors, visits }) {
  const [entityType, setEntityType] = useState("pharmacy"); // pharmacy | doctor
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [myLoc, setMyLoc] = useState(null);
  const [locating, setLocating] = useState(false);
  const [ordered, setOrdered] = useState(null);

  const entities = entityType === "pharmacy" ? clients : doctors;
  const filteredEntities = entities.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase().trim()) || (e.area || "").toLowerCase().includes(search.toLowerCase().trim())
  );
  const shownEntities = filteredEntities.slice(0, LIST_DISPLAY_CAP);

  const changeEntityType = (t) => { setEntityType(t); setSelected([]); setOrdered(null); };

  const lastCoordsFor = (clientName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === clientName.toLowerCase().trim() && v.coords);
    if (matches.length === 0) return null;
    const latest = matches.reduce((a, b) => (new Date(b.time) > new Date(a.time) ? b : a), matches[0]);
    return latest.coords;
  };

  const toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const getMyLocation = () => {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => { setMyLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocating(false); },
      () => setLocating(false),
      { timeout: 8000 }
    );
  };

  const optimize = () => {
    const stops = selected.map((id) => entities.find((c) => c.id === id)).filter(Boolean).map((c) => {
      const coords = lastCoordsFor(c.name);
      return { ...c, coords: coords ? { lat: parseFloat(coords.lat), lng: parseFloat(coords.lng) } : null };
    });
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

      <button onClick={optimize} disabled={selected.length === 0} style={{
        padding: "9px 18px", borderRadius: 8, border: "none",
        background: selected.length ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500, marginBottom: 20,
      }}>
        Optimize order ({selected.length} selected)
      </button>

      {ordered && (
        <div>
          {ordered.note === "no-location" && <p style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>Capture your location first for a distance-based order — showing selected order as-is.</p>}
          {ordered.note === "partial" && <p style={{ fontSize: 12, color: "#D9A441", marginBottom: 10 }}>Some stops have no saved location yet (never visited) — they're listed last.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ordered.route.map((c, i) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10 }}>
                <span className="kb-font-mono" style={{ fontSize: 13, fontWeight: 600, color: "#C17817", width: 20 }}>{i + 1}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: "#8A8272" }}>{c.area || "no area"}{!c.coords && " · no saved location"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({ zoned, visits }) {
  const urgent = zoned.filter((p) => p.zone.key === "red");
  const slow = zoned.filter((p) => p.slowMover);
  const watch = zoned.filter((p) => p.zone.key === "yellow");
  const atRisk = zoned.filter((p) => p.atRisk);

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Team overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
        <StatCard label="Urgent expiry" value={urgent.length} color="#B33A3A" icon={<AlertTriangle size={16} />} />
        <StatCard label="Plan-ahead window" value={watch.length} color="#D9A441" icon={<Clock size={16} />} />
        <StatCard label="At risk of not selling through" value={atRisk.length} color="#C17817" icon={<AlertTriangle size={16} />} />
        <StatCard label="Slow movers" value={slow.length} color="#6B7280" icon={<TrendingDown size={16} />} />
        <StatCard label="Visits logged" value={visits.length} color="#4C7A5E" icon={<MapPin size={16} />} />
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Recent rep visits</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visits.slice(0, 8).map((v) => (
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
        {visits.length === 0 && <EmptyState text="No visits logged by reps yet." />}
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

function RepPerformanceCard({ title, visits, monthlyVisitTarget, orders = [], monthlyRevenueTarget = 0, clients = [], repNameFilter = null }) {
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
  const revenueThisMonth = monthOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
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
    </div>
  );
}

function PerformanceView({ visits, orders, clients, doctors, repNames, monthlyVisitTarget, setMonthlyVisitTarget, monthlyRevenueTarget, setMonthlyRevenueTarget }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

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

  const revenueThisMonthTotal = orders.filter((o) => new Date(o.date) >= monthStart).reduce((s, o) => s + (Number(o.total) || 0), 0);
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
        .reduce((s, o) => s + (Number(o.total) || 0), 0);
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
      const repRevenue = repOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
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
function OutreachView({ dailyTarget, contactedToday, templates, outreachLog, todayStr, onLog }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [templateIdx, setTemplateIdx] = useState(0);
  const [copied, setCopied] = useState(false);

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

  const logContact = () => {
    onLog({ name: name || "Unnamed", date: todayStr, templateIndex: templateIdx });
    setName(""); setPhone("");
    nextTemplate();
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
        {outreachLog.filter((o) => o.date === todayStr).map((o) => (
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span><strong>{r.name}</strong> · passcode: {r.passcode}</span>
                <button onClick={() => removeRep(r.id)} style={{ background: "none", border: "none", color: "#B33A3A", fontSize: 11.5 }}>Remove</button>
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
        Upload monthly sales history, one year at a time, to power real slow-mover analysis instead of the current 90-day approximation. Past years lock once imported so they can't be overwritten by accident — {currentYear} stays open since you'll update it as the year goes.
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
                <div style={{ fontSize: 11, color: "#6B7280" }}>🔒 Locked · {count} rows</div>
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
