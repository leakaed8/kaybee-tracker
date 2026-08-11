const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthorized } = require("../src/auth");

test("owner id matches -> authorized", () => {
  assert.equal(isAuthorized("123456789", 123456789), true);
});

test("different numeric id -> not authorized", () => {
  assert.equal(isAuthorized("123456789", 987654321), false);
});

test("no allowed id configured yet -> nobody is authorized (setup mode)", () => {
  assert.equal(isAuthorized("", 123456789), false);
  assert.equal(isAuthorized(undefined, 123456789), false);
});

test("missing incoming user id -> not authorized", () => {
  assert.equal(isAuthorized("123456789", undefined), false);
  assert.equal(isAuthorized("123456789", null), false);
});

test("string/number type mismatch still compares correctly", () => {
  assert.equal(isAuthorized(123456789, "123456789"), true);
});
