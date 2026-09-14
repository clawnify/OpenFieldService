import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/bin/wrangler.js");
const root = fileURLToPath(new URL("../", import.meta.url));
// Local only. Optional persistence directory lets tests isolate their database.
const persist = process.argv[2] ? ["--persist-to", process.argv[2]] : [];
function execute(args) {
  return execFileSync(process.execPath, [wrangler, "d1", "execute", "open-fieldservice-db", "--local", ...persist, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}

// Existing jobs must receive the nullable link before indexes/triggers in the
// declared schema are installed. SQLite permits the referenced table to follow.
const [info] = JSON.parse(execute(["--command", "PRAGMA table_info(jobs)", "--json"]));
if (info.results.length && !info.results.some((column) => column.name === "asset_id")) {
  execute(["--command", "ALTER TABLE jobs ADD COLUMN asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT"]);
}
execute(["--file", "src/server/schema.sql"]);
console.log("Local database schema is ready.");
