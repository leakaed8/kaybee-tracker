// Minimal logger that redacts anything that looks like a secret so tokens
// never end up in Render logs / crash reports.

const SECRET_KEY_PATTERN = /token|secret|auth|password|key/i;

function redact(value) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

function fmt(args) {
  return args.map((a) => (typeof a === "object" ? redact(a) : a));
}

module.exports = {
  info: (...args) => console.log(new Date().toISOString(), "[info]", ...fmt(args)),
  warn: (...args) => console.warn(new Date().toISOString(), "[warn]", ...fmt(args)),
  error: (...args) => console.error(new Date().toISOString(), "[error]", ...fmt(args)),
};
