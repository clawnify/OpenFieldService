import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidMigration } from "./uuid-migration.mjs";

const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/bin/wrangler.js");
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const migrate = args.includes("--migrate-uuids");
const directory = args.find((arg) => !arg.startsWith("--"));
const persist = directory ? ["--persist-to", directory] : [];
function execute(args) {
  return execFileSync(process.execPath, [wrangler, "d1", "execute", "open-fieldservice-db", "--local", ...persist, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}
const schema = readFileSync(new URL("../src/server/schema.sql", import.meta.url), "utf8");
const tables = [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]).filter((name) => name !== "_meta");
const catalog = JSON.parse(execute(["--command", "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL", "--json"]))[0].results;
const customTables = catalog.filter((entry) => entry.type === "table" && !tables.includes(entry.name) && !["_meta", "d1_migrations"].includes(entry.name) && !/^(sqlite_|_cf_)/.test(entry.name));
if (customTables.length) throw new Error("Custom tables require an explicit migration: " + customTables.map((entry) => entry.name).join(", "));
const customIndexes = catalog.filter((entry) => entry.type === "index" && !schema.includes(`CREATE INDEX IF NOT EXISTS ${entry.name} `) && !/^(sqlite_|_cf_)/.test(entry.name));
if (customIndexes.length) throw new Error("Custom indexes require an explicit migration: " + customIndexes.map((entry) => entry.name).join(", "));
const info = JSON.parse(execute(["--command", tables.map((name) => `PRAGMA table_info(${name});`).join("\n"), "--json"]));
const existing = Object.fromEntries(tables.map((name, i) => [name, info[i].results]));
const triggers = JSON.parse(execute(["--command", "SELECT name FROM sqlite_master WHERE type = 'trigger'", "--json"]))[0].results.map((r) => r.name);
const migration = uuidMigration(schema, existing, triggers);
if (migration) {
  if (!migrate) throw new Error("This database uses integer IDs. Stop the app, back up .wrangler/state, then run pnpm db:migrate-uuids. No data was changed.");
  const scratch = mkdtempSync(join(tmpdir(), "openfieldservice-uuid-"));
  try {
    const file = join(scratch, "migration.sql");
    writeFileSync(file, migration);
    execute(["--file", file]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} else {
  execute(["--file", "src/server/schema.sql"]);
}
console.log("Local database schema is ready (UUID record IDs).");
