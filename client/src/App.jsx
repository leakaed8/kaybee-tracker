import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
import {
  MapPin, Package, LayoutDashboard, Settings, Plus, Send, Clock, AlertTriangle,
  TrendingDown, Check, X, Loader2, MessageCircle, RotateCcw, Copy, Download, Upload,
  Navigation, Users, Target, Megaphone,
} from "lucide-react";
import { api } from "./api.js";
import {
  daysUntil, fmtDate, turnoverPct, zoneFor, lifecyclePct, TIER_CADENCE, haversineKm, daysSince, parseExcelCellDate,
} from "./helpers.js";

const POLL_INTERVAL_MS = 20000;

// ---------- main app ----------
export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [role, setRole] = useState("manager");
  const [tab, setTab] = useState("expiry");
  const [products, setProducts] = useState([]);
  const [visits, setVisits] = useState([]);
  const [clients, setClients] = useState([]);
  const [outreachLog, setOutreachLog] = useState([]);
  const [settings, setSettings] = useState({
    slowThreshold: 15, repPhone: "", dailyTarget: 3, monthlyVisitTarget: 60, templates: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [loadError, setLoadError] = useState("");

  const settingsDirtyRef = useRef(false);
  const settingsDebounceRef = useRef(null);

  useEffect(() => {
    api.getSession()
      .then((data) => { setRole(data.role); setAuthState("in"); })
      .catch(() => setAuthState("out"));
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* cookie is cleared client-side regardless */ }
    setAuthState("out");
  };

  const refresh = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setProducts(data.products);
      setVisits(data.visits);
      setClients(data.clients);
      setOutreachLog(data.outreachLog);
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
      await fn();
      await refresh();
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus(""), 1200);
    } catch (e) {
      setSyncStatus("error");
      setLoadError(e.message);
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

  const addProduct = (prod) => withSync(() => api.addProduct(prod));
  const removeProduct = (id) => withSync(() => api.removeProduct(id));
  const loadImportedInventory = () => withSync(() => api.importSampleInventory());
  const bulkImportProducts = (products) => withSync(() => api.importBulkProducts(products));
  const addVisit = (visit) => withSync(() => api.addVisit(visit));
  const addClient = (client) => withSync(() => api.addClient(client));
  const removeClient = (id) => withSync(() => api.removeClient(id));
  const logOutreach = (entry) => withSync(() => api.logOutreach(entry));

  const zoned = products.map((p) => ({ ...p, zone: zoneFor(p, role, settings.slowThreshold) }));
  const sorted = [...zoned].sort((a, b) => daysUntil(a.expiry) - daysUntil(b.expiry));

  if (authState === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAF7F2" }}>
        <Loader2 size={22} className="spin" color="#8A8272" />
      </div>
    );
  }

  if (authState === "out") {
    return <LoginView onSuccess={(r) => { setRole(r); setAuthState("in"); }} />;
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
            {role === "manager" ? "Manager" : "Med Rep"}
          </span>
          <button onClick={logout} style={{ fontSize: 12, color: "#8A8272", background: "none", border: "1px solid #E5DFD3", borderRadius: 8, padding: "9px 12px" }}>
            Log out
          </button>
        </div>
      </header>

      <nav style={{ display: "flex", gap: 4, padding: "12px 24px 0", borderBottom: "1px solid #E5DFD3", overflowX: "auto" }}>
        <TabBtn active={tab === "expiry"} onClick={() => setTab("expiry")} icon={<Package size={15} />} label="Expiry Alerts" />
        <TabBtn active={tab === "clients"} onClick={() => setTab("clients")} icon={<Users size={15} />} label="Clients" />
        {role === "rep" && <TabBtn active={tab === "checkin"} onClick={() => setTab("checkin")} icon={<MapPin size={15} />} label="Check-In" />}
        {role === "rep" && <TabBtn active={tab === "route"} onClick={() => setTab("route")} icon={<Navigation size={15} />} label="Route" />}
        {role === "manager" && <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={<LayoutDashboard size={15} />} label="Dashboard" />}
        {role === "manager" && <TabBtn active={tab === "performance"} onClick={() => setTab("performance")} icon={<Target size={15} />} label="Performance" />}
        {role === "manager" && <TabBtn active={tab === "outreach"} onClick={() => setTab("outreach")} icon={<MessageCircle size={15} />} label="Outreach" />}
        {role === "manager" && <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")} icon={<Megaphone size={15} />} label="Broadcast" />}
        <TabBtn active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={15} />} label="Settings" />
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
                showAddProduct={showAddProduct}
                setShowAddProduct={setShowAddProduct}
                onAdd={(prod) => { addProduct(prod); setShowAddProduct(false); }}
                onRemove={removeProduct}
              />
            )}
            {tab === "checkin" && role === "rep" && <CheckInView visits={visits} clients={clients} onAddVisit={addVisit} />}
            {tab === "clients" && <ClientsView clients={clients} visits={visits} onAdd={addClient} onRemove={removeClient} />}
            {tab === "route" && role === "rep" && <RouteView clients={clients} visits={visits} />}
            {tab === "dashboard" && role === "manager" && <DashboardView zoned={zoned} visits={visits} />}
            {tab === "performance" && role === "manager" && (
              <PerformanceView
                visits={visits}
                monthlyVisitTarget={settings.monthlyVisitTarget}
                setMonthlyVisitTarget={(v) => updateSettingsField({ monthlyVisitTarget: v })}
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
            {tab === "settings" && (
              <SettingsView
                slowThreshold={settings.slowThreshold} setSlowThreshold={(v) => updateSettingsField({ slowThreshold: v })}
                repPhone={settings.repPhone} setRepPhone={(v) => updateSettingsField({ repPhone: v })}
                dailyTarget={settings.dailyTarget} setDailyTarget={(v) => updateSettingsField({ dailyTarget: v })}
                templates={settings.templates} setTemplates={(v) => updateSettingsField({ templates: v })}
                loadImportedInventory={loadImportedInventory}
                onBulkImport={bulkImportProducts}
                productCount={products.length}
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
      onSuccess(data.role);
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
function ExpiryView({ role, sorted, slowThreshold, repPhone, showAddProduct, setShowAddProduct, onAdd, onRemove }) {
  const zoneCounts = sorted.reduce((acc, p) => { acc[p.zone.key] = (acc[p.zone.key] || 0) + 1; return acc; }, {});

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
            {role === "rep" ? "What needs clearing this month" : "Shelf-life overview"}
          </h2>
          <p style={{ fontSize: 13, color: "#8A8272", margin: "4px 0 0" }}>
            {role === "rep" ? "Alarm window: 30 days" : "Alarm window: 6–12 months out"} · slow-mover threshold {slowThreshold}% turnover/90d
          </p>
        </div>
        <button onClick={() => setShowAddProduct((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
          background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500,
        }}>
          <Plus size={15} /> Add product
        </button>
      </div>

      {showAddProduct && <AddProductForm onAdd={onAdd} onCancel={() => setShowAddProduct(false)} />}

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {Object.entries(zoneCounts).map(([key, count]) => {
          const sample = sorted.find((p) => p.zone.key === key);
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "6px 12px" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: sample.zone.color, display: "inline-block" }} />
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>{sample.zone.label}</span>
              <span className="kb-font-mono" style={{ fontSize: 12, color: "#8A8272" }}>{count}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.map((p) => (
          <ProductRow key={p.id} product={p} repPhone={repPhone} onRemove={() => onRemove(p.id)} />
        ))}
        {sorted.length === 0 && <EmptyState text="No products yet. Add your first one above." />}
      </div>
    </div>
  );
}

function ProductRow({ product, repPhone, onRemove }) {
  const dLeft = daysUntil(product.expiry);
  const turnover = turnoverPct(product.sold90, product.qty);
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
            {product.category} · {product.qty} units · expires {fmtDate(product.expiry)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, background: `${product.zone.color}1A`, color: product.zone.color }}>
            {product.zone.label}
          </span>
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
          <span><TrendingDown size={11} style={{ verticalAlign: -1 }} /> {turnover}% turnover/90d</span>
        </div>
        {(product.zone.key === "urgent" || product.zone.key === "slow") && waLink && (
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

function AddProductForm({ onAdd, onCancel }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Supplement");
  const [expiry, setExpiry] = useState("");
  const [qty, setQty] = useState("");
  const [sold90, setSold90] = useState("");
  const [description, setDescription] = useState("");

  const canSubmit = name && expiry && qty !== "" && sold90 !== "";

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Product name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vitamin C 1000mg" style={inputStyle} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            {["Supplement", "Vitamin", "Herbal", "Beauty", "OTC"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Expiry date">
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Units in stock">
          <input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" style={inputStyle} />
        </Field>
        <Field label="Units sold, last 90 days">
          <input type="number" min="0" value={sold90} onChange={(e) => setSold90(e.target.value)} placeholder="0" style={inputStyle} />
        </Field>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Field label="Description (optional)">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Key benefits, real product info…" style={{ ...inputStyle, resize: "vertical" }} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={!canSubmit}
          onClick={() => onAdd({ name, category, expiry, qty: Number(qty), sold90: Number(sold90), description: description || undefined })}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: canSubmit ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>
          Add product
        </button>
        <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
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

// ---------- Check-In View (rep) ----------
function CheckInView({ visits, clients, onAddVisit }) {
  const [client, setClient] = useState("");
  const [notes, setNotes] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");

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

  const submit = () => {
    onAddVisit({ client, notes, coords });
    setClient(""); setNotes(""); setCoords(null);
  };

  const todayVisits = visits.filter((v) => new Date(v.time).toDateString() === new Date().toDateString());

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Log a client visit</h2>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <Field label="Client / pharmacy name">
          <input
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="e.g. Pharmacie Al Nour"
            list="checkin-client-options"
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          <datalist id="checkin-client-options">
            {clients.map((c) => <option key={c.id} value={c.name} />)}
          </datalist>
        </Field>
        <Field label="Visit notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed, orders taken, objections…" rows={3} style={{ ...inputStyle, marginBottom: 10, resize: "vertical" }} />
        </Field>

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

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Today's visits ({todayVisits.length})</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {todayVisits.map((v) => (
          <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}</span>
              <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>{new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {v.notes && <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 4 }}>{v.notes}</div>}
            {v.coords && <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 4 }}><MapPin size={11} style={{ verticalAlign: -1 }} /> {v.coords.lat}, {v.coords.lng}</div>}
          </div>
        ))}
        {todayVisits.length === 0 && <EmptyState text="No visits logged yet today." />}
      </div>
    </div>
  );
}

// ---------- Clients View (tiering + follow-up nudges) ----------
function ClientsView({ clients, visits, onAdd, onRemove }) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState("B");
  const [area, setArea] = useState("");

  const lastVisitFor = (clientName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === clientName.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };

  const addClient = () => {
    if (!name) return;
    onAdd({ name, phone, tier, area });
    setName(""); setPhone(""); setArea(""); setTier("B");
    setShowAdd(false);
  };

  const rows = clients.map((c) => {
    const lv = lastVisitFor(c.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[c.tier] || 30;
    const overdue = days === null || days > cadence;
    return { ...c, days, overdue, cadence };
  }).sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));

  const tierColor = { A: "#B33A3A", B: "#D9A441", C: "#6B7280" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Clients & follow-up</h2>
          <p style={{ fontSize: 13, color: "#8A8272", margin: "4px 0 0" }}>
            Tier A: visit every {TIER_CADENCE.A}d · B: {TIER_CADENCE.B}d · C: {TIER_CADENCE.C}d. Overdue clients sort to the top.
          </p>
        </div>
        <button onClick={() => setShowAdd((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
          background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500,
        }}>
          <Plus size={15} /> Add client
        </button>
      </div>

      {showAdd && (
        <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Field label="Client / pharmacy name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pharmacie Al Nour" style={inputStyle} /></Field>
            <Field label="WhatsApp number"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} /></Field>
            <Field label="Tier">
              <select value={tier} onChange={(e) => setTier(e.target.value)} style={inputStyle}>
                <option value="A">A — high value, visit every 14d</option>
                <option value="B">B — standard, visit every 30d</option>
                <option value="C">C — low priority, visit every 60d</option>
              </select>
            </Field>
            <Field label="Area"><input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Jbeil" style={inputStyle} /></Field>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!name} onClick={addClient} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>Add client</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((c) => (
          <div key={c.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${tierColor[c.tier]}1A`, color: tierColor[c.tier] }}>Tier {c.tier}</span>
                </div>
                <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 3 }}>
                  {c.area || "no area set"} {c.phone ? `· ${c.phone}` : ""}
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
        {rows.length === 0 && <EmptyState text="No clients added yet." />}
      </div>
    </div>
  );
}

// ---------- Route View (simple nearest-neighbor route ordering) ----------
function RouteView({ clients, visits }) {
  const [selected, setSelected] = useState([]);
  const [myLoc, setMyLoc] = useState(null);
  const [locating, setLocating] = useState(false);
  const [ordered, setOrdered] = useState(null);

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
    const stops = selected.map((id) => clients.find((c) => c.id === id)).filter(Boolean).map((c) => {
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
        Orders stops by straight-line distance from you, using each client's last captured GPS. Not real driving directions — use judgement for one-way streets or traffic.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={getMyLocation} disabled={locating} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
          border: "1px solid #E5DFD3", background: "#fff", fontSize: 12.5, fontWeight: 500,
        }}>
          {locating ? <Loader2 size={14} className="spin" /> : <MapPin size={14} />} {myLoc ? "Update my location" : "Capture my location"}
        </button>
        {myLoc && <span className="kb-font-mono" style={{ fontSize: 11, color: "#4C7A5E", alignSelf: "center" }}><Check size={12} style={{ verticalAlign: -1 }} /> location set</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
        {clients.map((c) => (
          <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            {c.name} <span style={{ fontSize: 10.5, color: "#8A8272" }}>({c.area || "no area"})</span>
          </label>
        ))}
        {clients.length === 0 && <EmptyState text="Add clients in the Clients tab first." />}
      </div>

      <button onClick={optimize} disabled={selected.length === 0} style={{
        padding: "9px 18px", borderRadius: 8, border: "none",
        background: selected.length ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500, marginBottom: 20,
      }}>
        Optimize order ({selected.length} selected)
      </button>

      {ordered && (
        <div>
          {ordered.note === "no-location" && <p style={{ fontSize: 12, color: "#B33A3A", marginBottom: 10 }}>Capture your location first for a distance-based order — showing selected order as-is.</p>}
          {ordered.note === "partial" && <p style={{ fontSize: 12, color: "#D9A441", marginBottom: 10 }}>Some clients have no saved location yet (never visited) — they're listed last.</p>}
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
  const urgent = zoned.filter((p) => p.zone.key === "urgent");
  const slow = zoned.filter((p) => p.zone.key === "slow");
  const watch = zoned.filter((p) => p.zone.key === "watch" || p.zone.key === "watch2");

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Team overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
        <StatCard label="Urgent expiry" value={urgent.length} color="#B33A3A" icon={<AlertTriangle size={16} />} />
        <StatCard label="Plan-ahead window" value={watch.length} color="#D9A441" icon={<Clock size={16} />} />
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

// ---------- Performance View (MedRep targets) ----------
function PerformanceView({ visits, monthlyVisitTarget, setMonthlyVisitTarget }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const visitsThisMonth = visits.filter((v) => new Date(v.time) >= monthStart).length;
  const pctOfTarget = Math.min(100, Math.round((visitsThisMonth / Math.max(monthlyVisitTarget, 1)) * 100));
  const pctOfMonth = Math.round((dayOfMonth / daysInMonth) * 100);
  const onPace = pctOfTarget >= pctOfMonth;
  const uniqueClients = new Set(visits.filter((v) => new Date(v.time) >= monthStart).map((v) => v.client.toLowerCase().trim())).size;

  const weeks = {};
  visits.filter((v) => new Date(v.time) >= monthStart).forEach((v) => {
    const wk = Math.ceil(new Date(v.time).getDate() / 7);
    weeks[wk] = (weeks[wk] || 0) + 1;
  });

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>MedRep performance</h2>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <Field label="Monthly visit target">
          <input type="number" min="1" value={monthlyVisitTarget} onChange={(e) => setMonthlyVisitTarget(Number(e.target.value) || 1)} style={{ ...inputStyle, maxWidth: 140 }} />
        </Field>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{visitsThisMonth} / {monthlyVisitTarget} visits this month</span>
          <span style={{ fontSize: 12, color: onPace ? "#4C7A5E" : "#B33A3A", fontWeight: 500 }}>{onPace ? "On pace" : "Behind pace"}</span>
        </div>
        <div style={{ height: 8, background: "#F0EBE0", borderRadius: 4, overflow: "hidden", marginBottom: 4 }}>
          <div style={{ height: "100%", width: `${pctOfTarget}%`, background: onPace ? "#4C7A5E" : "#D9A441", transition: "width .3s" }} />
        </div>
        <div className="kb-font-mono" style={{ fontSize: 10.5, color: "#8A8272" }}>Day {dayOfMonth} of {daysInMonth} ({pctOfMonth}% of month elapsed)</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard label="Visits this month" value={visitsThisMonth} color="#4C7A5E" icon={<MapPin size={16} />} />
        <StatCard label="Unique clients seen" value={uniqueClients} color="#C17817" icon={<Users size={16} />} />
        <StatCard label="Avg / week" value={Math.round(visitsThisMonth / Math.max(Math.ceil(dayOfMonth / 7), 1))} color="#6B7280" icon={<Target size={16} />} />
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>By week this month</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {Object.keys(weeks).length === 0 && <EmptyState text="No visits logged yet this month." />}
        {Object.entries(weeks).sort(([a], [b]) => a - b).map(([wk, count]) => (
          <div key={wk} style={{ display: "flex", justifyContent: "space-between", background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
            <span>Week {wk}</span>
            <span className="kb-font-mono" style={{ color: "#8A8272" }}>{count} visits</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Broadcast View (stock reminder to existing clients) ----------
function BroadcastView({ zoned, clients }) {
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [selectedTier, setSelectedTier] = useState("all");
  const [copied, setCopied] = useState(false);

  const healthy = zoned.filter((p) => p.zone.key === "ok").slice(0, 20);
  const toggleProduct = (id) => setSelectedProducts((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const targetClients = clients.filter((c) => selectedTier === "all" || c.tier === selectedTier);

  const message = `Hi! Quick reminder from KayBee Pharma — we currently have good stock of:\n${
    zoned.filter((p) => selectedProducts.includes(p.id)).map((p) => `• ${p.name}`).join("\n") || "(select items below)"
  }\n\nLet us know if you'd like to reorder or need pricing. No pressure, just keeping you posted!`;

  const copyMessage = () => { navigator.clipboard?.writeText(message); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Stock reminder broadcast</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Pulled from your own inventory — pick items you want to remind clients about, then send via your WhatsApp Business broadcast list.
      </p>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Select items to feature (showing healthy-stock items)</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {healthy.map((p) => (
            <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={selectedProducts.includes(p.id)} onChange={() => toggleProduct(p.id)} />
              {p.name}
            </label>
          ))}
          {healthy.length === 0 && <span style={{ fontSize: 12, color: "#8A8272" }}>No healthy-stock items found — import your inventory first.</span>}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Send to</label>
        <select value={selectedTier} onChange={(e) => setSelectedTier(e.target.value)} style={inputStyle}>
          <option value="all">All clients ({clients.length})</option>
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {targetClients.map((c) => (
            c.phone
              ? <a key={c.id} href={`https://wa.me/${c.phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, background: "#4C7A5E1A", color: "#4C7A5E", textDecoration: "none" }}>
                  {c.name}
                </a>
              : <span key={c.id} style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, background: "#F0EBE0", color: "#8A8272" }}>{c.name} (no number)</span>
          ))}
          {targetClients.length === 0 && <EmptyState text="No clients in this tier yet." />}
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
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>New client outreach</h2>
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
  const [mapping, setMapping] = useState({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "" });
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
        setMapping({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "" });
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    setMapping({ name: "", expiry: "", qty: "", sold90: "", category: "", description: "" });
  };

  const parsed = useMemo(() => {
    if (!mapping.name || !mapping.expiry || !mapping.qty) return { valid: [], skipped: 0 };
    const nameIdx = headers.indexOf(mapping.name);
    const expiryIdx = headers.indexOf(mapping.expiry);
    const qtyIdx = headers.indexOf(mapping.qty);
    const sold90Idx = headers.indexOf(mapping.sold90);
    const categoryIdx = headers.indexOf(mapping.category);
    const descIdx = headers.indexOf(mapping.description);

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

// ---------- Settings ----------
function SettingsView({ slowThreshold, setSlowThreshold, repPhone, setRepPhone, dailyTarget, setDailyTarget, templates, setTemplates, loadImportedInventory, onBulkImport, productCount }) {
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [imported, setImported] = useState(false);

  const doImport = () => {
    loadImportedInventory();
    setShowImportConfirm(false);
    setImported(true);
    setTimeout(() => setImported(false), 2500);
  };

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Settings</h2>

      <ExcelImportSection onImport={onBulkImport} productCount={productCount} />

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Sample inventory import</label>
        <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
          Loads 124 batches pulled from <strong>INVENTORY EXPIRY AND MOVEMENT</strong> (STOCK tab) on Jul 26, 2026 — each expiry batch as its own row. 90-day sales are matched where available; items without a match show 0 and are treated as slow-movers until you update them. This replaces the current product list in this app ({productCount} items now).
        </p>
        {!showImportConfirm && !imported && (
          <button onClick={() => setShowImportConfirm(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
            background: "#1F2A24", color: "#FAF7F2", border: "none", fontSize: 13, fontWeight: 500,
          }}>
            <Download size={15} /> Import 124 batches
          </button>
        )}
        {showImportConfirm && (
          <div style={{ padding: 10, background: "#FBF3E8", borderRadius: 8 }}>
            <p style={{ fontSize: 12.5, color: "#7A5B2E", marginBottom: 8 }}>This replaces all {productCount} current products. Continue?</p>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={doImport} style={{ fontSize: 12, background: "#C17817", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px" }}>Yes, import</button>
              <button onClick={() => setShowImportConfirm(false)} style={{ fontSize: 12, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "6px 12px" }}>Cancel</button>
            </div>
          </div>
        )}
        {imported && <div style={{ fontSize: 12.5, color: "#4C7A5E", display: "flex", alignItems: "center", gap: 5 }}><Check size={14} /> Imported 124 batches.</div>}
      </div>
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label={`Slow-mover threshold: flag if turnover falls below ${slowThreshold}% of stock sold per 90 days`}>
          <input type="range" min="5" max="40" value={slowThreshold} onChange={(e) => setSlowThreshold(Number(e.target.value))} style={{ width: "100%" }} />
        </Field>
        <p style={{ fontSize: 11.5, color: "#8A8272", marginTop: 6 }}>
          Formula: (units sold in last 90 days ÷ units in stock) × 100. Below this % is flagged slow-moving, regardless of expiry date.
        </p>
      </div>
      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label="Rep WhatsApp number (for expiry nudges, include country code)">
          <input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="+961 xx xxx xxx" style={inputStyle} />
        </Field>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
        <Field label={`Daily new-client outreach goal: ${dailyTarget} contacts/day`}>
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


