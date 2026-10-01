import React, { useState, useEffect, useMemo } from "react";
import { Plus, X, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { api } from "./api.js";
import { SearchableSelect, ChipPicker, StatCard, EmptyState } from "./App.jsx";
import { todayBeirutStr, fmtDate, fmtTime, daysUntil, addDaysToDateStr, weekdayOfDateStr } from "./helpers.js";

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #E5DFD3", fontSize: 13, background: "#FAF7F2" };
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MEETING_PURPOSES = [
  { key: "Product presentation", label: "Product presentation" },
  { key: "Follow-up", label: "Follow-up" },
  { key: "Meeting", label: "Meeting" },
  { key: "Order discussion", label: "Order discussion" },
  { key: "New product introduction", label: "New product introduction" },
  { key: "Other", label: "Other" },
];
const REMINDER_OPTIONS = [
  { key: "1d", label: "1 day before" },
  { key: "2d", label: "2 days before" },
  { key: "1h", label: "1 hour before" },
  { key: "none", label: "No reminder" },
];
const FILTER_OPTIONS = [
  { key: "all", label: "All" },
  { key: "FOLLOW_UP", label: "Follow-ups" },
  { key: "MEETING", label: "Meetings" },
  { key: "overdue", label: "Overdue" },
];

// A row's live status, DERIVED the same way the rest of the app already
// derives "overdue" (daysUntil(dueDate) < 0) — never stored, so it's always
// correct regardless of when it's viewed. "rescheduled" rows are excluded
// entirely upstream (see visibleRows below) — they're history, not an
// active activity.
function statusOf(row) {
  if (row.status === "done") return "COMPLETED";
  if (row.status === "cancelled" || row.status === "stopped") return "CANCELLED";
  if (daysUntil(row.dueDate) < 0) return "OVERDUE";
  return "UPCOMING";
}

function StatusBadge({ status }) {
  if (status === "COMPLETED") return <span style={{ color: "#4C7A5E", fontWeight: 600, fontSize: 12 }}>✓ Completed</span>;
  if (status === "OVERDUE") return <span style={{ color: "#B33A3A", fontWeight: 600, fontSize: 12 }}>⚠ Overdue</span>;
  if (status === "CANCELLED") return <span style={{ color: "#8A8272", fontWeight: 600, fontSize: 12 }}>Cancelled</span>;
  return <span style={{ color: "#8A8272", fontSize: 12 }}>Upcoming</span>;
}

function activityTypeLabel(row) {
  return row.type === "MEETING" ? (row.purpose || "Meeting") : "Follow-up";
}

// "YYYY-MM" -> "October 2026", anchored at UTC noon-of-the-1st so it never
// needs any timezone conversion to read back correctly.
function fmtMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Bottom sheet — same pattern as App.jsx's FieldChecklistModal (fixed
// rgba(31,42,36,0.55) scrim, bottom-anchored rounded sheet, stopPropagation
// on the inner panel) rather than inventing a new overlay component.
function BottomSheet({ onClose, children, maxWidth = 560 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(31,42,36,0.55)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FAF7F2", borderRadius: "16px 16px 0 0", width: "100%", maxWidth, maxHeight: "88vh", overflowY: "auto", padding: 20, boxShadow: "0 -4px 24px rgba(0,0,0,0.2)" }}>
        {children}
      </div>
    </div>
  );
}

// One activity row, expandable in place to show Complete/Reschedule/Cancel
// — avoids stacking a third modal layer on top of the day sheet.
function ActivityRow({ row, expanded, onToggle, onComplete, onReschedule, onCancel, busy, showDate = false }) {
  const status = statusOf(row);
  const resolved = status === "COMPLETED" || status === "CANCELLED";
  const [rescheduling, setRescheduling] = useState(false);
  const [newDate, setNewDate] = useState(row.dueDate);
  const [newTime, setNewTime] = useState(row.dueTime || "");

  return (
    <div style={{ background: "#fff", border: "1px solid #E5DFD3", borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <button onClick={onToggle} style={{ width: "100%", background: "none", border: "none", padding: 0, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: "#8A8272", fontWeight: 500 }}>
            {showDate ? `${fmtDate(row.dueDate)} · ${row.dueTime || "Any time"}` : (row.dueTime || "Any time")}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {row.type === "MEETING" ? "● " : "↻ "}{row.entityName}
          </div>
          <div style={{ fontSize: 12.5, color: "#5B5445", marginTop: 1 }}>{activityTypeLabel(row)}</div>
        </div>
        <StatusBadge status={status} />
      </button>

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5DFD3" }}>
          {row.notes && <div style={{ fontSize: 12.5, color: "#5B5445", marginBottom: 8 }}>{row.notes}</div>}
          {row.rescheduledFromId && <div style={{ fontSize: 11, color: "#8A8272", marginBottom: 8 }}>Rescheduled from an earlier date.</div>}

          {!resolved && !rescheduling && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={busy} onClick={() => onComplete(row)} style={{ padding: "10px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500, minHeight: 44 }}>
                {row.type === "MEETING" ? "Complete Meeting" : "Complete Follow-up"}
              </button>
              <button disabled={busy} onClick={() => setRescheduling(true)} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24", fontSize: 13, fontWeight: 500, minHeight: 44 }}>
                Reschedule
              </button>
              <button disabled={busy} onClick={() => onCancel(row)} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#B33A3A", fontSize: 13, fontWeight: 500, minHeight: 44 }}>
                Cancel
              </button>
            </div>
          )}

          {rescheduling && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={busy} onClick={() => { onReschedule(row, newDate, newTime); setRescheduling(false); }} style={{ padding: "10px 14px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13, fontWeight: 500, minHeight: 44 }}>
                  Confirm new date
                </button>
                <button disabled={busy} onClick={() => setRescheduling(false)} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #E5DFD3", background: "#fff", color: "#1F2A24", fontSize: 13, fontWeight: 500, minHeight: 44 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddMeetingForm({ clients, doctors, onClose, onSaved }) {
  const [contactQuery, setContactQuery] = useState("");
  const [useFreeText, setUseFreeText] = useState(false);
  const [date, setDate] = useState(todayBeirutStr());
  const [time, setTime] = useState("");
  const [purpose, setPurpose] = useState("Meeting");
  const [notes, setNotes] = useState("");
  const [reminderOffset, setReminderOffset] = useState("1d");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const contactOptions = useMemo(() => [...clients, ...doctors], [clients, doctors]);
  const matchedContact = contactOptions.find((c) => c.name.toLowerCase().trim() === contactQuery.toLowerCase().trim());

  const save = async () => {
    setError("");
    if (!contactQuery.trim()) { setError("Pick or enter a contact."); return; }
    if (!date) { setError("Pick a date."); return; }
    if (!time) { setError("Pick a time."); return; }
    setSaving(true);
    try {
      await api.createMeeting({
        entityName: contactQuery.trim(),
        entityType: matchedContact ? (matchedContact.type || (doctors.includes(matchedContact) ? "doctor" : "pharmacy")) : "other",
        date,
        time,
        purpose,
        notes,
        reminderEnabled: reminderOffset !== "none",
        reminderOffset,
      });
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't save the meeting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <h3 className="kb-font-display" style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>Add Meeting</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A8272", padding: 2 }}><X size={20} /></button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Doctor / Pharmacy / Contact</div>
          {!useFreeText ? (
            <>
              <SearchableSelect
                value={contactQuery}
                onChange={setContactQuery}
                options={contactOptions}
                getLabel={(c) => c.name}
                placeholder="Search clients or doctors…"
                style={inputStyle}
              />
              <button type="button" onClick={() => setUseFreeText(true)} style={{ background: "none", border: "none", color: "#8A8272", fontSize: 11.5, padding: "6px 0", textDecoration: "underline" }}>
                Can't find them? Enter a name manually
              </button>
            </>
          ) : (
            <>
              <input value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} placeholder="Contact name" style={inputStyle} />
              <button type="button" onClick={() => { setUseFreeText(false); setContactQuery(""); }} style={{ background: "none", border: "none", color: "#8A8272", fontSize: 11.5, padding: "6px 0", textDecoration: "underline" }}>
                Search existing clients/doctors instead
              </button>
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Date</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Time</div>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Purpose</div>
          <ChipPicker options={MEETING_PURPOSES} value={purpose} onChange={(v) => v && setPurpose(v)} />
        </div>

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Notes (optional)</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Reminder</div>
          <ChipPicker options={REMINDER_OPTIONS} value={reminderOffset} onChange={(v) => v && setReminderOffset(v)} />
        </div>

        {error && <div style={{ fontSize: 12, color: "#B33A3A" }}>{error}</div>}

        <button disabled={saving} onClick={save} style={{ padding: "12px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 14, fontWeight: 500, minHeight: 44 }}>
          {saving ? "Saving…" : "Save Meeting"}
        </button>
      </div>
    </BottomSheet>
  );
}

function DayDetailSheet({ dateStr, rows, onClose, expandedId, onToggleExpand, onComplete, onReschedule, onCancel, busy }) {
  const [dy, dm, dd] = dateStr.split("-").map(Number);
  const label = new Date(Date.UTC(dy, dm - 1, dd)).toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const sorted = [...rows].sort((a, b) => (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"));

  return (
    <BottomSheet onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <h3 className="kb-font-display" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{label}</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A8272", padding: 2 }}><X size={20} /></button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState text="Nothing scheduled this day." />
      ) : (
        sorted.map((row) => (
          <ActivityRow
            key={row.id}
            row={row}
            expanded={expandedId === row.id}
            onToggle={() => onToggleExpand(row.id)}
            onComplete={onComplete}
            onReschedule={onReschedule}
            onCancel={onCancel}
            busy={busy}
          />
        ))
      )}
    </BottomSheet>
  );
}

function MonthCalendar({ monthKey, rowsByDate, onPickDate, todayStr }) {
  const [year, month] = monthKey.split("-").map(Number);
  const firstDay = `${monthKey}-01`;
  const startWeekday = weekdayOfDateStr(firstDay);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(`${monthKey}-${String(day).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 600, color: "#8A8272", padding: "4px 0" }}>{w}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={i} />;
          const dayRows = (rowsByDate.get(dateStr) || []);
          const dayNum = Number(dateStr.slice(-2));
          const isToday = dateStr === todayStr;
          const hasOverdue = dayRows.some((r) => statusOf(r) === "OVERDUE");
          return (
            <button
              key={i}
              onClick={() => onPickDate(dateStr)}
              style={{
                minHeight: 60, padding: "4px 3px", borderRadius: 8, textAlign: "left", cursor: "pointer",
                border: isToday ? "1.5px solid #C17817" : "1px solid #E5DFD3",
                background: hasOverdue ? "#FBEFEF" : "#fff",
                display: "flex", flexDirection: "column", gap: 1, overflow: "hidden",
              }}
            >
              <div style={{ fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? "#C17817" : "#1F2A24" }}>{dayNum}</div>
              {dayRows.slice(0, 2).map((r) => (
                <div key={r.id} style={{ fontSize: 9, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#5B5445" }}>
                  {r.type === "MEETING" ? "●" : "↻"} {r.entityName}
                </div>
              ))}
              {dayRows.length > 2 && <div style={{ fontSize: 9, color: "#8A8272" }}>+{dayRows.length - 2} more</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ScheduleView({ role, repName, isSupervisor, repNames, clients, doctors }) {
  const canSeeTeam = role === "manager" || isSupervisor;
  const [viewingRep, setViewingRep] = useState(canSeeTeam ? "" : repName);
  const [monthKey, setMonthKey] = useState(todayBeirutStr().slice(0, 7));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [subView, setSubView] = useState("today"); // today | calendar
  const [selectedDate, setSelectedDate] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [showAddMeeting, setShowAddMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const todayStr = todayBeirutStr();
  const effectiveRep = canSeeTeam ? viewingRep : repName;

  // Fetches the rep's WHOLE schedule history, not just the viewed month —
  // an overdue item can be from any past month, and the "Overdue" filter
  // must surface it regardless of which month the calendar happens to be
  // showing. Month navigation below is then pure client-side filtering of
  // this one already-loaded list, matching how the rest of the app already
  // treats this table (small enough to fetch in full, e.g. PerformanceView).
  const load = () => {
    if (canSeeTeam && !viewingRep) { setRows([]); return; }
    setLoading(true);
    api.getSchedule({ repName: canSeeTeam ? viewingRep : undefined })
      .then((data) => setRows((data.followups || []).filter((f) => f.status !== "rescheduled")))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [viewingRep, canSeeTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "overdue") return rows.filter((r) => statusOf(r) === "OVERDUE");
    return rows.filter((r) => (r.type || "FOLLOW_UP") === filter);
  }, [rows, filter]);

  const rowsByDate = useMemo(() => {
    const map = new Map();
    visibleRows.forEach((r) => {
      if (!r.dueDate) return;
      if (!map.has(r.dueDate)) map.set(r.dueDate, []);
      map.get(r.dueDate).push(r);
    });
    return map;
  }, [visibleRows]);

  // The "Overdue" filter's whole point is surfacing items regardless of
  // which day they happen to be under — an overdue item is never "today"
  // by definition — so the Today/list sub-view shows every matching
  // overdue row across all dates instead of just today's, while every
  // other filter still means "today's activities."
  const todayRows = filter === "overdue"
    ? [...visibleRows].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"))
    : (rowsByDate.get(todayStr) || []).sort((a, b) => (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"));
  const weekEndStr = addDaysToDateStr(todayStr, 6);
  const thisWeekCount = rows.filter((r) => r.dueDate >= todayStr && r.dueDate <= weekEndStr).length;
  const upcomingFollowUpsCount = rows.filter((r) => (r.type || "FOLLOW_UP") === "FOLLOW_UP" && statusOf(r) === "UPCOMING").length;

  const runAction = async (fn) => {
    setActionError("");
    setBusy(true);
    try {
      await fn();
      load();
      setExpandedId(null);
    } catch (e) {
      setActionError(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  const handleComplete = (row) => runAction(() => api.completeActivity(row.id));
  const handleReschedule = (row, newDate, newTime) => runAction(() => api.rescheduleActivity(row.id, { newDate, newTime }));
  const handleCancel = (row) => runAction(() => api.cancelActivity(row.id));

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 className="kb-font-display" style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>My Schedule</h2>
          <p style={{ fontSize: 12.5, color: "#8A8272", margin: "2px 0 0" }}>Visits, follow-ups & meetings</p>
        </div>
        <button
          onClick={() => setShowAddMeeting(true)}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 8, border: "none", background: "#1F2A24", color: "#FAF7F2", fontSize: 13.5, fontWeight: 500, minHeight: 44 }}
        >
          <Plus size={16} /> Add Meeting
        </button>
      </div>

      {canSeeTeam && (
        <select value={viewingRep} onChange={(e) => setViewingRep(e.target.value)} style={{ ...inputStyle, maxWidth: 260, margin: "12px 0" }}>
          <option value="">Pick a rep…</option>
          {repNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      )}

      {(!canSeeTeam || viewingRep) && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "14px 0" }}>
            <StatCard label="Today" value={`${todayRows.length} ${todayRows.length === 1 ? "activity" : "activities"}`} color="#1F2A24" icon={<Clock size={16} />} />
            <StatCard label="This Week" value={`${thisWeekCount} scheduled`} color="#4C7A5E" icon={<Clock size={16} />} />
            <StatCard label="Follow-ups" value={`${upcomingFollowUpsCount} upcoming`} color="#C17817" icon={<Clock size={16} />} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <ChipPicker options={FILTER_OPTIONS} value={filter} onChange={(v) => v && setFilter(v)} />
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={() => setSubView("today")} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: subView === "today" ? "1.5px solid #1F2A24" : "1px solid #E5DFD3", background: subView === "today" ? "#1F2A24" : "#fff", color: subView === "today" ? "#FAF7F2" : "#1F2A24", fontSize: 13, fontWeight: 500, minHeight: 44 }}>Today</button>
            <button onClick={() => setSubView("calendar")} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: subView === "calendar" ? "1.5px solid #1F2A24" : "1px solid #E5DFD3", background: subView === "calendar" ? "#1F2A24" : "#fff", color: subView === "calendar" ? "#FAF7F2" : "#1F2A24", fontSize: 13, fontWeight: 500, minHeight: 44 }}>Calendar</button>
          </div>

          {loading ? (
            <EmptyState text="Loading…" />
          ) : subView === "today" ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                {filter === "overdue" ? "Overdue activities" : `Today · ${fmtDate(todayStr)}`}
              </div>
              {todayRows.length === 0 ? (
                <EmptyState text={filter === "overdue" ? "Nothing overdue." : "Nothing scheduled today."} />
              ) : (
                todayRows.map((row) => (
                  <ActivityRow
                    key={row.id}
                    row={row}
                    expanded={expandedId === row.id}
                    onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    onComplete={handleComplete}
                    onReschedule={handleReschedule}
                    onCancel={handleCancel}
                    busy={busy}
                    showDate={filter === "overdue"}
                  />
                ))
              )}
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <button onClick={() => setMonthKey(addDaysToDateStr(`${monthKey}-01`, -1).slice(0, 7))} style={{ background: "none", border: "none", padding: 8, minHeight: 44, minWidth: 44 }}><ChevronLeft size={18} /></button>
                <div className="kb-font-display" style={{ fontSize: 15, fontWeight: 600 }}>
                  {fmtMonthLabel(monthKey)}
                </div>
                <button onClick={() => setMonthKey(addDaysToDateStr(`${monthKey}-01`, 32).slice(0, 7))} style={{ background: "none", border: "none", padding: 8, minHeight: 44, minWidth: 44 }}><ChevronRight size={18} /></button>
              </div>
              <MonthCalendar monthKey={monthKey} rowsByDate={rowsByDate} onPickDate={setSelectedDate} todayStr={todayStr} />
            </div>
          )}

          {actionError && <div style={{ fontSize: 12, color: "#B33A3A", marginTop: 10 }}>{actionError}</div>}
        </>
      )}

      {selectedDate && (
        <DayDetailSheet
          dateStr={selectedDate}
          rows={rowsByDate.get(selectedDate) || []}
          onClose={() => { setSelectedDate(null); setExpandedId(null); }}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
          onComplete={handleComplete}
          onReschedule={handleReschedule}
          onCancel={handleCancel}
          busy={busy}
        />
      )}

      {showAddMeeting && (
        <AddMeetingForm
          clients={clients}
          doctors={doctors}
          onClose={() => setShowAddMeeting(false)}
          onSaved={() => { setShowAddMeeting(false); load(); }}
        />
      )}
    </div>
  );
}
