// Every day/month boundary the business cares about — follow-up due dates,
// monthly reports, "is it the 1st", punch-out cutoffs — is anchored to
// Lebanon time (Asia/Beirut), never the server process's own clock (Render
// runs UTC, no TZ set) and never a viewer's device clock. Lebanon observes
// DST on dates that are NOT stable government policy (it delayed the 2023
// spring change by a month with no notice) — correctness here is fully
// outsourced to Node's bundled ICU/tzdata, which is exactly why every
// Beirut-day calculation in the app funnels through this one small module:
// a future policy surprise is a Node-version bump plus a one-line check
// here, not a codebase-wide hunt.
const TZ = "Asia/Beirut";

// "YYYY-MM-DD" in Beirut, for a given instant (or now).
function beirutDateStr(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: TZ });
}

function beirutWeekday(date) {
  return new Date(date.toLocaleString("en-US", { timeZone: TZ })).getDay(); // 0 = Sunday
}

function beirutHour(date) {
  return Number(date.toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }));
}

function todayBeirutStr() {
  return beirutDateStr(new Date());
}

function beirutDateParts(date) {
  const [y, m, d] = beirutDateStr(date).split("-").map(Number);
  return { year: y, month: m, day: d };
}

// Pure calendar-day diff between a "YYYY-MM-DD" value and today in Beirut —
// anchored at Date.UTC on each side's Y/M/D, so wall-clock hours (and thus
// DST) never enter the arithmetic at all.
function daysUntilFromToday(dateStr) {
  const [y1, m1, d1] = dateStr.split("-").map(Number);
  const { year: y2, month: m2, day: d2 } = beirutDateParts(new Date());
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

// Same UTC round-trip in reverse: today in Beirut, plus N days.
function addDaysToTodayStr(days) {
  const { year, month, day } = beirutDateParts(new Date());
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Buckets a real timestamp (visit.time, Orders.date, ...) into its Beirut
// "YYYY-MM" — for monthly report attribution, never for arithmetic.
function beirutMonthKeyOfInstant(isoString) {
  return beirutDateStr(new Date(isoString)).slice(0, 7);
}

// Converts a Beirut WALL-CLOCK date+time (e.g. a scheduled activity's
// dueDate/dueTime, always Beirut by this app's standing convention — see
// the top-of-file comment) into the real UTC instant it represents, for
// comparing against Date.now() (e.g. "has the 1-hour-before threshold
// passed yet"). Standard "guess as UTC, measure the actual Beirut offset at
// that guess via Intl, correct once" technique — robust across DST since it
// measures the real offset in effect at that moment rather than assuming a
// fixed one.
function beirutWallClockToInstantMs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guessMs = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(guessMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const beirutHourPart = get("hour") === 24 ? 0 : get("hour"); // some ICU builds report midnight as "24"
  const beirutAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), beirutHourPart, get("minute"));
  return guessMs + (guessMs - beirutAsUtcMs);
}

module.exports = {
  TZ,
  beirutDateStr,
  beirutWeekday,
  beirutHour,
  todayBeirutStr,
  beirutDateParts,
  daysUntilFromToday,
  addDaysToTodayStr,
  beirutMonthKeyOfInstant,
  beirutWallClockToInstantMs,
};
