const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addDays,
  isValidDateStr,
  extractTitleAndDueDate,
} = require("../src/dateUtils");

test("addDays crosses month/year boundaries correctly", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("isValidDateStr rejects malformed and impossible dates", () => {
  assert.equal(isValidDateStr("2026-08-15"), true);
  assert.equal(isValidDateStr("2026-02-30"), false);
  assert.equal(isValidDateStr("not-a-date"), false);
  assert.equal(isValidDateStr("2026-8-15"), false);
});

test("extractTitleAndDueDate: plain text defaults to today", () => {
  const { title, dueDate } = extractTitleAndDueDate("Call supplier", "Asia/Beirut");
  assert.equal(title, "Call supplier");
  assert.match(dueDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("extractTitleAndDueDate: 'tomorrow' suffix", () => {
  const { title, dueDate } = extractTitleAndDueDate("Call supplier tomorrow", "Asia/Beirut");
  assert.equal(title, "Call supplier");
  const expected = addDays(extractTitleAndDueDate("x", "Asia/Beirut").dueDate, 1);
  assert.equal(dueDate, expected);
});

test("extractTitleAndDueDate: explicit ISO date", () => {
  const { title, dueDate } = extractTitleAndDueDate("Call supplier 2026-08-15", "Asia/Beirut");
  assert.equal(title, "Call supplier");
  assert.equal(dueDate, "2026-08-15");
});

test("extractTitleAndDueDate: weekday name resolves to a future date", () => {
  const today = extractTitleAndDueDate("x", "Asia/Beirut").dueDate;
  const { title, dueDate } = extractTitleAndDueDate("Call supplier friday", "Asia/Beirut");
  assert.equal(title, "Call supplier");
  assert.ok(dueDate > today || dueDate === today, "resolved date should not be in the past");
  // Never today unless "friday" literally means today; same-weekday case rolls to next week.
});

test("extractTitleAndDueDate: title with no trailing date word keeps full text", () => {
  const { title, dueDate } = extractTitleAndDueDate("Review sales reps", "Asia/Beirut");
  assert.equal(title, "Review sales reps");
  assert.equal(dueDate, extractTitleAndDueDate("x", "Asia/Beirut").dueDate);
});
