const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

// Creates a libSQL client and applies the schema. Used both for the real
// Turso-backed production database and for local/in-memory test databases
// (pass { url: "file::memory:" } with no authToken).
async function createDb({ url, authToken }) {
  const client = createClient({ url, authToken: authToken || undefined });
  for (const statement of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
  return client;
}

module.exports = { createDb };
