import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  MapPin, Package, LayoutDashboard, Settings, Plus, Send, Clock, AlertTriangle,
  TrendingDown, Check, X, Loader2, MessageCircle, RotateCcw, Copy, Download, Upload,
  Navigation, Users, Target, Megaphone, ShoppingCart, Stethoscope, Radar, Search,
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
      .then((data) => { setRole(data.role); setRepName(data.repName || ""); setAuthState("in"); })
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
      setDoctors(data.doctors || []);
      setOutreachLog(data.outreachLog);
      setOrders(data.orders || []);
      setRepNames(data.repNames || []);
      setOffers(data.offers || []);
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
      await refresh();
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

  const addProduct = (prod) => withSync(() => api.addProduct(prod));
  const removeProduct = (id) => withSync(() => api.removeProduct(id));
  const loadImportedInventory = () => withSync(() => api.importSampleInventory());
  const bulkImportProducts = (products) => withSync(() => api.importBulkProducts(products));
  const addVisit = (visit) => withSync(() => api.addVisit(visit));
  const removeVisit = (id) => withSync(() => api.removeVisit(id));
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
        <TabBtn active={tab === "clients"} onClick={() => setTab("clients")} icon={<Users size={15} />} label="Clients" />
        <TabBtn active={tab === "doctors"} onClick={() => setTab("doctors")} icon={<Stethoscope size={15} />} label="Doctors" />
        {role === "rep" && <TabBtn active={tab === "checkin"} onClick={() => setTab("checkin")} icon={<MapPin size={15} />} label="Check-In" />}
        {role === "rep" && <TabBtn active={tab === "route"} onClick={() => setTab("route")} icon={<Navigation size={15} />} label="Route" />}
        {role === "manager" && <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={<LayoutDashboard size={15} />} label="Dashboard" />}
        {role === "manager" && <TabBtn active={tab === "performance"} onClick={() => setTab("performance")} icon={<Target size={15} />} label="Performance" />}
        {role === "manager" && <TabBtn active={tab === "outreach"} onClick={() => setTab("outreach")} icon={<MessageCircle size={15} />} label="Outreach" />}
        {role === "manager" && <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")} icon={<Megaphone size={15} />} label="Broadcast" />}
        {role === "manager" && <TabBtn active={tab === "orders"} onClick={() => setTab("orders")} icon={<ShoppingCart size={15} />} label="Orders" />}
        {role === "manager" && <TabBtn active={tab === "locations"} onClick={() => setTab("locations")} icon={<Radar size={15} />} label="Locations" />}
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
                showAddProduct={showAddProduct}
                setShowAddProduct={setShowAddProduct}
                onAdd={(prod) => { addProduct(prod); setShowAddProduct(false); }}
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
                repName={repName}
                onAddVisit={addVisit}
                onRemoveVisit={removeVisit}
                onCreateOrder={createOrder}
                onRequestDeleteOrder={requestDeleteOrder}
              />
            )}
            {tab === "clients" && (
              <ClientsView
                clients={clients}
                visits={visits}
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
                role={role}
                onAdd={addDoctor}
                onRemove={removeDoctor}
                onBulkImport={bulkImportDoctors}
              />
            )}
            {tab === "route" && role === "rep" && <RouteView clients={clients} doctors={doctors} visits={visits} />}
            {tab === "dashboard" && role === "manager" && <DashboardView zoned={zoned} visits={visits} />}
            {tab === "orders" && role === "manager" && (
              <OrdersView orders={orders} onDelete={deleteOrder} onApproveDelete={approveDeleteOrder} onDenyDelete={denyDeleteOrder} />
            )}
            {tab === "locations" && role === "manager" && <LocationsView visits={visits} />}
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
            {tab === "settings" && role === "manager" && (
              <SettingsView
                role={role}
                slowThreshold={settings.slowThreshold} setSlowThreshold={(v) => updateSettingsField({ slowThreshold: v })}
                repPhone={settings.repPhone} setRepPhone={(v) => updateSettingsField({ repPhone: v })}
                dailyTarget={settings.dailyTarget} setDailyTarget={(v) => updateSettingsField({ dailyTarget: v })}
                templates={settings.templates} setTemplates={(v) => updateSettingsField({ templates: v })}
                loadImportedInventory={loadImportedInventory}
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
            {product.category} · {product.qty} units · expires {fmtDate(product.expiry)}{product.price ? ` · price ${product.price.toFixed(2)}` : ""}
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
  const [price, setPrice] = useState("");

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
        <Field label="Price (optional)">
          <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" style={inputStyle} />
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
          onClick={() => onAdd({ name, category, expiry, qty: Number(qty), sold90: Number(sold90), price: Number(price) || 0, description: description || undefined })}
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
function CheckInView({ visits, clients, doctors, products, offers, orders, repName, onAddVisit, onRemoveVisit, onCreateOrder, onRequestDeleteOrder }) {
  const [entityType, setEntityType] = useState("pharmacy"); // pharmacy | doctor
  const [client, setClient] = useState("");
  const [notes, setNotes] = useState("");
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const [lastVisit, setLastVisit] = useState(null);
  const [showOrderPrompt, setShowOrderPrompt] = useState(false);
  const [showOrderBuilder, setShowOrderBuilder] = useState(false);
  const [confirmVisitId, setConfirmVisitId] = useState(null);
  const [exportSheetId, setExportSheetId] = useState("");
  const [mentionedItems, setMentionedItems] = useState([]);
  const [itemQuery, setItemQuery] = useState("");

  useEffect(() => {
    api.getMyExportSheet().then((data) => setExportSheetId(data.exportSheetId || "")).catch(() => {});
  }, []);

  const nameOptions = entityType === "pharmacy" ? clients : doctors;

  const matchedItem = products.find((p) => p.name.toLowerCase().trim() === itemQuery.toLowerCase().trim());
  const addMentionedItem = () => {
    if (!matchedItem || mentionedItems.some((it) => it.productId === matchedItem.id)) return;
    setMentionedItems((prev) => [...prev, { productId: matchedItem.id, name: matchedItem.name }]);
    setItemQuery("");
  };
  const removeMentionedItem = (productId) => setMentionedItems((prev) => prev.filter((it) => it.productId !== productId));

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
    setClient(""); setNotes(""); setCoords(null); setMentionedItems([]); setItemQuery("");
    setShowOrderPrompt(true);
    setShowOrderBuilder(false);
  };

  const todayVisits = visits.filter((v) => new Date(v.time).toDateString() === new Date().toDateString());

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

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => { setEntityType("pharmacy"); setClient(""); }} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: entityType === "pharmacy" ? "#1F2A24" : "#fff", color: entityType === "pharmacy" ? "#FAF7F2" : "#1F2A24",
        }}>
          Pharmacy
        </button>
        <button onClick={() => { setEntityType("doctor"); setClient(""); }} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: entityType === "doctor" ? "#1F2A24" : "#fff", color: entityType === "doctor" ? "#FAF7F2" : "#1F2A24",
        }}>
          Doctor
        </button>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <Field label={entityType === "pharmacy" ? "Client / pharmacy name" : "Doctor name"}>
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
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed, orders taken, objections…" rows={3} style={{ ...inputStyle, marginBottom: 10, resize: "vertical" }} />
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
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {mentionedItems.map((it) => (
                  <span key={it.productId} style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12,
                    background: "#FAF7F2", border: "1px solid #E5DFD3", borderRadius: 20, padding: "4px 6px 4px 10px",
                  }}>
                    {it.name}
                    <button
                      type="button"
                      onClick={() => removeMentionedItem(it.productId)}
                      style={{ border: "none", background: "none", cursor: "pointer", display: "flex", padding: 2, color: "#8A8272" }}
                      aria-label={`Remove ${it.name}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
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
          onCreateOrder={onCreateOrder}
          onDone={() => { setShowOrderBuilder(false); setShowOrderPrompt(false); }}
        />
      )}

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "#8A8272" }}>Today's visits ({todayVisits.length})</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {todayVisits.map((v) => (
          <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272" }}>{new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                {confirmVisitId === v.id ? (
                  <>
                    <button onClick={() => { onRemoveVisit(v.id); setConfirmVisitId(null); }} style={{ fontSize: 11, background: "#B33A3A", color: "#fff", border: "none", borderRadius: 6, padding: "3px 8px" }}>Yes</button>
                    <button onClick={() => setConfirmVisitId(null)} style={{ fontSize: 11, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 6, padding: "3px 8px" }}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmVisitId(v.id)} title="Delete" style={{ background: "none", border: "none", color: "#B7AF9E", padding: 2 }}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            {v.notes && <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 4 }}>{v.notes}</div>}
            {v.mentionedItems && v.mentionedItems.length > 0 && (
              <div style={{ fontSize: 11.5, color: "#4C7A5E", marginTop: 4 }}>
                Mentioned: {v.mentionedItems.map((it) => it.name).join(", ")}
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
    </div>
  );
}

// ---------- Proforma invoice PDF ----------
function downloadOrderPdf(order) {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text("KayBee Pharma — Proforma Invoice", 14, 18);
  doc.setFontSize(10);
  doc.text(`Client: ${order.clientName}`, 14, 28);
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
  doc.save(`order-${order.clientName.replace(/\s+/g, "_")}-${order.date.slice(0, 10)}.pdf`);
}

// ---------- Order Builder (used from Check-In) ----------
function OrderBuilder({ clientName, visitId, products, offers, onCreateOrder, onDone }) {
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
      const payload = {
        clientName,
        visitId,
        items: items.map(({ productId, name, qty, unitPrice, isFree, originalPrice }) => ({
          productId, name, qty, unitPrice, isFree: !!isFree, originalPrice: originalPrice || 0,
        })),
      };
      const created = await onCreateOrder(payload);
      downloadOrderPdf(created || { ...payload, date: new Date().toISOString(), total });
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

// ---------- Locations View (manager, check-in GPS history) ----------
function LocationsView({ visits }) {
  const withLocation = visits.filter((v) => v.coords).sort((a, b) => new Date(b.time) - new Date(a.time));

  return (
    <div>
      <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Check-in locations</h2>
      <p style={{ fontSize: 12.5, color: "#8A8272", margin: "0 0 16px" }}>
        Shows where each visit was captured, based on the GPS a rep recorded at check-in time. This isn't live tracking — a web app can only record location at the moment "Capture GPS location" is tapped.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {withLocation.map((v) => (
          <div key={v.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{v.client}{v.repName ? ` · ${v.repName}` : ""}</div>
              <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 2 }}>
                {new Date(v.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {v.coords.lat}, {v.coords.lng}
              </div>
            </div>
            <a href={`https://maps.google.com/?q=${v.coords.lat},${v.coords.lng}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#4C7A5E", textDecoration: "none", border: "1px solid #4C7A5E33", borderRadius: 6, padding: "6px 10px" }}>
              View on map
            </a>
          </div>
        ))}
        {withLocation.length === 0 && <EmptyState text="No visits with a captured location yet." />}
      </div>
    </div>
  );
}

// ---------- Excel upload for clients, with duplicate review ----------
function ClientExcelImportSection({ existingClients, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", phone: "", area: "" });
  const [skipIds, setSkipIds] = useState(new Set());
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
        setMapping({ name: "", phone: "", area: "" });
        setSkipIds(new Set());
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    setMapping({ name: "", phone: "", area: "" });
    setSkipIds(new Set());
  };

  const { newClients, updates, unchangedCount } = useMemo(() => {
    if (!mapping.name) return { newClients: [], updates: [], unchangedCount: 0 };
    const nameIdx = headers.indexOf(mapping.name);
    const phoneIdx = headers.indexOf(mapping.phone);
    const areaIdx = headers.indexOf(mapping.area);

    const existingByName = new Map(existingClients.map((c) => [c.name.toLowerCase().trim(), c]));

    const fresh = [];
    const dupes = [];
    let unchanged = 0;

    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? "").trim();
      if (!name) return;
      const phone = phoneIdx >= 0 ? String(r[phoneIdx] ?? "").trim() : "";
      const area = areaIdx >= 0 ? String(r[areaIdx] ?? "").trim() : "";
      const existing = existingByName.get(name.toLowerCase().trim());
      if (!existing) {
        fresh.push({ name, phone, area });
      } else if ((existing.phone || "") !== phone || (existing.area || "") !== area) {
        dupes.push({ existing, incoming: { phone, area } });
      } else {
        unchanged++;
      }
    });

    return { newClients: fresh, updates: dupes, unchangedCount: unchanged };
  }, [mapping, rows, headers, existingClients]);

  const toggleSkip = (id) => setSkipIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const doImport = async () => {
    setError("");
    setImporting(true);
    try {
      const toUpdate = updates
        .filter((u) => !skipIds.has(u.existing.id))
        .map((u) => ({ id: u.existing.id, phone: u.incoming.phone, area: u.incoming.area }));
      const data = await onImport({ toAdd: newClients, toUpdate });
      setResult({ added: newClients.length, updated: toUpdate.length });
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
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Import clients from Excel</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload an .xlsx file of pharmacies. New names get added; names that already exist are shown below so you can choose whether to update their info instead of skipping them.
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
          <Check size={14} /> Added {result.added}, updated {result.updated}.
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
            {fieldSelect("area", "Address / area column", false)}
          </div>

          {mapping.name && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#5B5445", marginBottom: 10 }}>
                {newClients.length} new client{newClients.length === 1 ? "" : "s"} will be added
                {updates.length > 0 ? `, ${updates.length} existing client${updates.length === 1 ? "" : "s"} have different info in your file` : ""}
                {unchangedCount > 0 ? `, ${unchangedCount} already match (no changes needed)` : ""}.
              </div>

              {updates.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 6 }}>Review matched clients — uncheck any you don't want updated:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                    {updates.map((u) => (
                      <label key={u.existing.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10, fontSize: 12 }}>
                        <input type="checkbox" checked={!skipIds.has(u.existing.id)} onChange={() => toggleSkip(u.existing.id)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 2 }}>{u.existing.name}</div>
                          <div style={{ color: "#8A8272" }}>
                            phone: {u.existing.phone || "(none)"} → {u.incoming.phone || "(none)"}<br />
                            area: {u.existing.area || "(none)"} → {u.incoming.area || "(none)"}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

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

              <button
                disabled={importing || (newClients.length === 0 && updates.length === 0)}
                onClick={doImport}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: !importing && (newClients.length > 0 || updates.length > 0) ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
              >
                {importing ? "Importing…" : `Import (${newClients.length} new, ${updates.filter((u) => !skipIds.has(u.existing.id)).length} update${updates.filter((u) => !skipIds.has(u.existing.id)).length === 1 ? "" : "s"})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Clients View (tiering + follow-up nudges) ----------
function ClientsView({ clients, visits, role, repNames, onAdd, onRemove, onBulkImport, onAssignRep }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState("B");
  const [area, setArea] = useState("");
  const [assignedRep, setAssignedRep] = useState("");
  const [search, setSearch] = useState("");

  const lastVisitFor = (clientName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === clientName.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };

  const addClient = () => {
    if (!name) return;
    onAdd({ name, phone, tier, area, assignedRep });
    setName(""); setPhone(""); setArea(""); setTier("B"); setAssignedRep("");
    setShowAdd(false);
  };

  const rows = clients.map((c) => {
    const lv = lastVisitFor(c.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[c.tier] || 30;
    const overdue = days === null || days > cadence;
    return { ...c, days, overdue, cadence };
  }).sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));

  const filteredRows = rows.filter((c) => c.name.toLowerCase().includes(search.toLowerCase().trim()));
  const suggestedFollowUps = rows.filter((c) => c.overdue).slice(0, 5);

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
            <Plus size={15} /> Add client
          </button>
        </div>
      </div>

      {role === "manager" && showImport && <ClientExcelImportSection existingClients={clients} onImport={onBulkImport} onDone={() => setShowImport(false)} />}

      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients by name…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

      {suggestedFollowUps.length > 0 && (
        <div style={{ background: "#FBF3E8", border: "1px solid #E9C88A", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: "0 0 10px", color: "#7A5B2E" }}>Suggested follow-ups</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {suggestedFollowUps.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", border: "1px solid #E9C88A", borderRadius: 8, padding: "8px 12px", fontSize: 12.5 }}>
                <span><strong>{c.name}</strong> — {c.days === null ? "never visited" : `${c.days}d since visit`} (cadence {c.cadence}d)</span>
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
            <Field label="Assigned sales rep (optional)">
              <select value={assignedRep} onChange={(e) => setAssignedRep(e.target.value)} style={inputStyle}>
                <option value="">Unassigned</option>
                {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!name} onClick={addClient} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>Add client</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredRows.map((c) => (
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
        {filteredRows.length === 0 && <EmptyState text={search ? "No clients match your search." : "No clients added yet."} />}
      </div>
    </div>
  );
}

// ---------- Excel upload for doctors, with duplicate review (manager only) ----------
function DoctorExcelImportSection({ existingDoctors, onImport, onDone }) {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ name: "", hospital: "", area: "", phone: "", specialty: "" });
  const [skipIds, setSkipIds] = useState(new Set());
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
        setMapping({ name: "", hospital: "", area: "", phone: "", specialty: "" });
        setSkipIds(new Set());
      } catch (err) {
        setError("Couldn't read that file. Make sure it's a valid Excel (.xlsx) file.");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const changeSheet = (name) => {
    setSelectedSheet(name);
    readSheet(workbook, name);
    setMapping({ name: "", hospital: "", area: "", phone: "", specialty: "" });
    setSkipIds(new Set());
  };

  const { newDoctors, updates } = useMemo(() => {
    if (!mapping.name) return { newDoctors: [], updates: [] };
    const nameIdx = headers.indexOf(mapping.name);
    const hospitalIdx = headers.indexOf(mapping.hospital);
    const areaIdx = headers.indexOf(mapping.area);
    const phoneIdx = headers.indexOf(mapping.phone);
    const specialtyIdx = headers.indexOf(mapping.specialty);

    const existingByName = new Map(existingDoctors.map((d) => [d.name.toLowerCase().trim(), d]));

    const fresh = [];
    const dupes = [];

    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? "").trim();
      if (!name) return;
      const hospital = hospitalIdx >= 0 ? String(r[hospitalIdx] ?? "").trim() : "";
      const area = areaIdx >= 0 ? String(r[areaIdx] ?? "").trim() : "";
      const phone = phoneIdx >= 0 ? String(r[phoneIdx] ?? "").trim() : "";
      const specialty = specialtyIdx >= 0 ? String(r[specialtyIdx] ?? "").trim() : "";
      const existing = existingByName.get(name.toLowerCase().trim());
      if (!existing) {
        fresh.push({ name, hospital, area, phone, specialty });
      } else if ((existing.hospital || "") !== hospital || (existing.area || "") !== area || (existing.phone || "") !== phone || (existing.specialty || "") !== specialty) {
        dupes.push({ existing, incoming: { hospital, area, phone, specialty } });
      }
    });

    return { newDoctors: fresh, updates: dupes };
  }, [mapping, rows, headers, existingDoctors]);

  const toggleSkip = (id) => setSkipIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const doImport = async () => {
    setError("");
    setImporting(true);
    try {
      const toUpdate = updates
        .filter((u) => !skipIds.has(u.existing.id))
        .map((u) => ({ id: u.existing.id, ...u.incoming }));
      await onImport({ toAdd: newDoctors, toUpdate });
      setResult({ added: newDoctors.length, updated: toUpdate.length });
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
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Import doctors from Excel</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Upload an .xlsx file of doctors. New names get added; names that already exist are shown below so you can choose whether to update their info.
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
          <Check size={14} /> Added {result.added}, updated {result.updated}.
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
          </div>

          {mapping.name && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#5B5445", marginBottom: 10 }}>
                {newDoctors.length} new doctor{newDoctors.length === 1 ? "" : "s"} will be added
                {updates.length > 0 ? `, ${updates.length} existing doctor${updates.length === 1 ? "" : "s"} have different info in your file` : ""}.
              </div>

              {updates.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11.5, color: "#8A8272", marginBottom: 6 }}>Review matched doctors — uncheck any you don't want updated:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                    {updates.map((u) => (
                      <label key={u.existing.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: 10, fontSize: 12 }}>
                        <input type="checkbox" checked={!skipIds.has(u.existing.id)} onChange={() => toggleSkip(u.existing.id)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 2 }}>{u.existing.name}</div>
                          <div style={{ color: "#8A8272" }}>
                            hospital: {u.existing.hospital || "(none)"} → {u.incoming.hospital || "(none)"}<br />
                            area: {u.existing.area || "(none)"} → {u.incoming.area || "(none)"}<br />
                            phone: {u.existing.phone || "(none)"} → {u.incoming.phone || "(none)"}<br />
                            specialty: {u.existing.specialty || "(none)"} → {u.incoming.specialty || "(none)"}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

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

              <button
                disabled={importing || (newDoctors.length === 0 && updates.length === 0)}
                onClick={doImport}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: !importing && (newDoctors.length > 0 || updates.length > 0) ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
              >
                {importing ? "Importing…" : `Import (${newDoctors.length} new, ${updates.filter((u) => !skipIds.has(u.existing.id)).length} updates)`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Doctors View (tiering + follow-up nudges) ----------
function DoctorsView({ doctors, visits, role, onAdd, onRemove, onBulkImport }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [name, setName] = useState("");
  const [hospital, setHospital] = useState("");
  const [area, setArea] = useState("");
  const [phone, setPhone] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [tier, setTier] = useState("B");
  const [search, setSearch] = useState("");

  const lastVisitFor = (doctorName) => {
    const matches = visits.filter((v) => v.client.toLowerCase().trim() === doctorName.toLowerCase().trim());
    if (matches.length === 0) return null;
    return matches.reduce((latest, v) => (new Date(v.time) > new Date(latest.time) ? v : latest), matches[0]);
  };

  const addDoctor = () => {
    if (!name) return;
    onAdd({ name, hospital, area, phone, specialty, tier });
    setName(""); setHospital(""); setArea(""); setPhone(""); setSpecialty(""); setTier("B");
    setShowAdd(false);
  };

  const rows = doctors.map((d) => {
    const lv = lastVisitFor(d.name);
    const days = lv ? daysSince(lv.time) : null;
    const cadence = TIER_CADENCE[d.tier] || 30;
    const overdue = days === null || days > cadence;
    return { ...d, days, overdue, cadence };
  }).sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));

  const filteredRows = rows.filter((d) => d.name.toLowerCase().includes(search.toLowerCase().trim()));
  const tierColor = { A: "#B33A3A", B: "#D9A441", C: "#6B7280" };

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

      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} style={{ position: "absolute", left: 12, top: 10, color: "#8A8272" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search doctors by name…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

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
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!name} onClick={addDoctor} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}>Add doctor</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredRows.map((d) => (
          <div key={d.id} style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{d.name}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: `${tierColor[d.tier]}1A`, color: tierColor[d.tier] }}>Tier {d.tier}</span>
                </div>
                <div className="kb-font-mono" style={{ fontSize: 11, color: "#8A8272", marginTop: 3 }}>
                  {d.hospital || "no hospital set"} · {d.area || "no area"} {d.phone ? `· ${d.phone}` : ""}
                </div>
                {d.specialty && <div style={{ fontSize: 11.5, color: "#5B5445", marginTop: 3 }}>{d.specialty}</div>}
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
        {filteredRows.length === 0 && <EmptyState text={search ? "No doctors match your search." : "No doctors added yet."} />}
      </div>
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
        Orders stops by straight-line distance from you, using each client's last captured GPS. Not real driving directions — use judgement for one-way streets or traffic.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => changeEntityType("pharmacy")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: entityType === "pharmacy" ? "#1F2A24" : "#fff", color: entityType === "pharmacy" ? "#FAF7F2" : "#1F2A24",
        }}>
          Pharmacies
        </button>
        <button onClick={() => changeEntityType("doctor")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: entityType === "doctor" ? "#1F2A24" : "#fff", color: entityType === "doctor" ? "#FAF7F2" : "#1F2A24",
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

          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {filteredEntities.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #E5DFD3", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                {c.name} <span style={{ fontSize: 10.5, color: "#8A8272" }}>({c.area || "no area"})</span>
              </label>
            ))}
            {filteredEntities.length === 0 && (
              <EmptyState text={entityType === "pharmacy" ? "Add clients in the Clients tab first." : "Add doctors in the Doctors tab first."} />
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
  const [mode, setMode] = useState("healthy"); // healthy | clearance
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [selectedTier, setSelectedTier] = useState("all");
  const [copied, setCopied] = useState(false);

  const pool = mode === "healthy"
    ? zoned.filter((p) => p.zone.key === "ok").slice(0, 20)
    : zoned.filter((p) => ["urgent", "soon", "watch", "watch2", "slow"].includes(p.zone.key)).slice(0, 20);

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
        Pulled from your own inventory — pick items you want to remind clients about, then send via your WhatsApp Business broadcast list.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => changeMode("healthy")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: mode === "healthy" ? "#1F2A24" : "#fff", color: mode === "healthy" ? "#FAF7F2" : "#1F2A24",
        }}>
          Promote healthy stock
        </button>
        <button onClick={() => changeMode("clearance")} style={{
          flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid #E5DFD3", fontSize: 12.5, fontWeight: 500,
          background: mode === "clearance" ? "#1F2A24" : "#fff", color: mode === "clearance" ? "#FAF7F2" : "#1F2A24",
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

  const load = async () => {
    try {
      const data = await api.getReps();
      setReps(data);
    } catch (e) {
      setError(e.message);
      setReps([]);
    }
  };

  useEffect(() => { load(); }, []);

  const addRep = async () => {
    if (!name || !passcode) return;
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

  const createSheetFor = async (rep) => {
    const emailToUse = sheetEmails[rep.id];
    if (!emailToUse) return;
    setCreatingSheetFor(rep.id);
    setError("");
    try {
      await api.createRepExportSheet(rep.id, emailToUse.trim());
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreatingSheetFor(null);
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11.5, color: "#8A8272", marginBottom: 8 }}>Sales reps</label>
      <p style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 10 }}>
        Give each rep their own name and passcode to log in with. Add their Google account email too and they'll get a personal Google Sheet of their own visits, shared automatically. Once added, you can assign pharmacies to them in the Clients tab.
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
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  <input
                    value={sheetEmails[r.id] || ""}
                    onChange={(e) => setSheetEmails((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder="Rep's Google email for their visits sheet"
                    style={{ ...inputStyle, flex: 1, minWidth: 160, fontSize: 11.5, padding: "5px 8px" }}
                  />
                  <button
                    disabled={!sheetEmails[r.id] || creatingSheetFor === r.id}
                    onClick={() => createSheetFor(r)}
                    style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, border: "none", background: sheetEmails[r.id] ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2" }}
                  >
                    {creatingSheetFor === r.id ? "Creating…" : "Create visits sheet"}
                  </button>
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
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Google email (optional)" style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
        <button
          disabled={!name || !passcode || saving}
          onClick={addRep}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: name && passcode && !saving ? "#1F2A24" : "#D8D2C4", color: "#FAF7F2", fontSize: 13, fontWeight: 500 }}
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

// ---------- Settings ----------
function SettingsView({ role, slowThreshold, setSlowThreshold, repPhone, setRepPhone, dailyTarget, setDailyTarget, templates, setTemplates, loadImportedInventory, onBulkImport, productCount, onRepsChanged, offers, onAddOffer, onToggleOfferActive, onRemoveOffer }) {
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

      <PushNotificationSetup />

      {role === "manager" && <RepsManagementSection onRepsChanged={onRepsChanged} />}

      {role === "manager" && (
        <OffersManagementSection offers={offers} onAdd={onAddOffer} onToggleActive={onToggleOfferActive} onRemove={onRemoveOffer} />
      )}

      {role === "manager" && <ExcelImportSection onImport={onBulkImport} productCount={productCount} />}

      {role === "manager" && (
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
      )}
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
