// Pure helpers for the two manager-facing readability columns appended to
// the Visits sheet (see sheetsDb.js's Visits schema comment) — split out,
// same reasoning as medicalPromotion.js, so this specific logic can be
// exercised with a plain Node script against synthetic data instead of
// relying on code review alone. Everything here takes an already-built
// row (or patch) and returns plain text; none of it reads or writes
// anything itself.

// Doctor/nutritionist "quality call" fields have no single notes box of
// their own — labeled and concatenated into one readable column so a
// manager doesn't have to hunt across ~15 separate columns to read what a
// med rep wrote about a call. A pharmacy/supplement-store visit's own
// freeform `notes` always wins outright when present; these only ever
// come from a doctor/nutritionist visit, which never populates `notes` at
// all.
const DOCTOR_NOTE_FIELD_LABELS = [
  ["objective", "Objective"], ["doctorNeeds", "Doctor's Needs"],
  ["reaction", "Reaction"], ["concern", "Concern"],
  ["doctorInsight", "Doctor Insight"], ["commitment", "Commitment"],
  ["patientsToTry", "Patients To Try"], ["callOutcome", "Call Outcome"],
  ["keyLearning", "Key Learning"], ["nextAction", "Next Action"],
  ["treatmentGoal", "Treatment Goal"], ["keyMessage", "Key Message"],
  ["plannedObjectionHandling", "Planned Objection Handling"], ["plannedClose", "Planned Close"],
  ["buyingMotive", "Buying Motive"], ["customerComments", "Customer Comments"],
];
function computeNotesSummary(row) {
  if (row.notes && String(row.notes).trim()) return String(row.notes).trim();
  let doctorNeedsList = [];
  if (row.doctorNeeds) {
    try { doctorNeedsList = JSON.parse(row.doctorNeeds); } catch { doctorNeedsList = []; }
  }
  const lines = [];
  for (const [key, label] of DOCTOR_NOTE_FIELD_LABELS) {
    const value = key === "doctorNeeds" ? (doctorNeedsList.length ? doctorNeedsList.join(", ") : "") : row[key];
    if (value !== undefined && value !== null && String(value).trim()) lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

// Turns itemsMentioned's app-internal JSON into plain text a manager can
// read without decoding it — same "sample given"/"interest flagged"
// phrasing the app's own UI already uses, with the sample qty folded in
// (never shown for a plain "discussed" mention, which never carries one).
function computeItemsSummary(itemsMentionedJson) {
  let items = [];
  if (itemsMentionedJson) {
    try { items = JSON.parse(itemsMentionedJson); } catch { items = []; }
  }
  if (!items.length) return "";
  return items.map((it) => {
    const qty = Number(it.qty) || 1;
    if (it.sampleStatus === "gave") return `${it.name} ×${qty} (sample given)`;
    if (it.sampleStatus === "next_visit") return `${it.name} ×${qty} (interest flagged)`;
    return `${it.name} (discussed)`;
  }).join("; ");
}

// Call on a freshly-built row right before it's written (append path) —
// keeps the two summary columns in sync with whatever's actually on the
// row, computed in exactly one place. PATCH /api/visits/:id recomputes
// these itself directly into its patch instead, since it only ever has a
// partial row (merged with the existing one) to work from.
function attachVisitSummaryColumns(row) {
  row.notesSummary = computeNotesSummary(row);
  row.itemsSummary = computeItemsSummary(row.itemsMentioned);
  return row;
}

module.exports = { computeNotesSummary, computeItemsSummary, attachVisitSummaryColumns, DOCTOR_NOTE_FIELD_LABELS };
