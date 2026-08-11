// All "today" logic must be anchored to Asia/Beirut, not the server's own
// clock (Render runs in UTC) and not a hardcoded UTC+3 offset, since
// Lebanon's daylight-saving rules can change the offset. We lean on the
// ICU timezone database built into Node via Intl, which stays correct
// across DST transitions automatically.
//
// Once we have a plain "YYYY-MM-DD" calendar date, all further arithmetic
// (add days, weekday-of-date) is done with Date.UTC so it never drifts
// based on the machine's local timezone.

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function todayInTz(timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date()); // "YYYY-MM-DD"
}

function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m, d };
}

function isValidDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const { y, m, d } = parseDateStr(dateStr);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  return (
    asUtc.getUTCFullYear() === y &&
    asUtc.getUTCMonth() === m - 1 &&
    asUtc.getUTCDate() === d
  );
}

function addDays(dateStr, days) {
  const { y, m, d } = parseDateStr(dateStr);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sunday..6=Saturday
}

function compareDateStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function formatHumanDate(dateStr, timezone) {
  const { y, m, d } = parseDateStr(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC avoids any DST edge on the display step
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(dt);
}

// Pulls a trailing date expression off the end of free text, e.g.
//   "Call supplier tomorrow"   -> { title: "Call supplier", dueDate: <tomorrow> }
//   "Call supplier Friday"     -> { title: "Call supplier", dueDate: <next Friday> }
//   "Call supplier 2026-08-15" -> { title: "Call supplier", dueDate: "2026-08-15" }
//   "Call supplier"            -> { title: "Call supplier", dueDate: <today> }
function extractTitleAndDueDate(rawText, timezone) {
  const text = rawText.trim();
  const today = todayInTz(timezone);
  if (!text) return { title: "", dueDate: today };

  const isoMatch = text.match(/^(.*\S)\s+(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch && isValidDateStr(isoMatch[2])) {
    return { title: isoMatch[1].trim(), dueDate: isoMatch[2] };
  }

  const todayMatch = text.match(/^(.*\S)\s+today$/i);
  if (todayMatch) {
    return { title: todayMatch[1].trim(), dueDate: today };
  }

  const tomorrowMatch = text.match(/^(.*\S)\s+tomorrow$/i);
  if (tomorrowMatch) {
    return { title: tomorrowMatch[1].trim(), dueDate: addDays(today, 1) };
  }

  const weekdayMatch = text.match(/^(.*\S)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i);
  if (weekdayMatch) {
    const targetIdx = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase());
    const todayIdx = weekdayOf(today);
    // Next occurrence strictly in the future; "today" said as a weekday name
    // means next week's occurrence, not today, to avoid ambiguity.
    let delta = targetIdx - todayIdx;
    if (delta <= 0) delta += 7;
    return { title: weekdayMatch[1].trim(), dueDate: addDays(today, delta) };
  }

  return { title: text, dueDate: today };
}

module.exports = {
  todayInTz,
  isValidDateStr,
  addDays,
  compareDateStr,
  formatHumanDate,
  extractTitleAndDueDate,
};
