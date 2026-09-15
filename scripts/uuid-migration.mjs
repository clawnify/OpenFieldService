// Build one atomic D1 batch from the current schema and the database's actual columns.
// No user values enter SQL; table/column names are checked against our schema.
export function uuidMigration(schema, existing, triggers = []) {
  const definitions = [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)^\);/gm)]
    .filter(([, name]) => name !== "_meta");
  const tables = definitions.map(([, name]) => name);
  const present = tables.filter((name) => existing[name]?.length);
  if (!present.length || present.every((name) => existing[name].find((c) => c.name === "id")?.type === "TEXT")) return null;
  if (present.some((name) => existing[name].find((c) => c.name === "id")?.type !== "INTEGER")) throw new Error("Mixed ID types: inspect the database before migration.");
  const uuid = schema.match(/DEFAULT \((lower\(hex\(randomblob[^\n]+)\) CHECK/)[1];
  const sql = [
    "PRAGMA defer_foreign_keys = ON;",
    "CREATE TABLE _uuid_check (valid INTEGER CHECK(valid = 1));",
    "INSERT INTO _uuid_check SELECT COUNT(*) = 0 FROM pragma_foreign_key_check;",
    `CREATE TABLE _uuid_ids (entity TEXT, old_id INTEGER, new_id TEXT NOT NULL DEFAULT (${uuid}), PRIMARY KEY(entity, old_id));`,
  ];
  for (const name of present) sql.push(`INSERT INTO _uuid_ids(entity, old_id) SELECT '${name}', id FROM ${name};`);
  // Deleted jobs have no row to join, but their logical references must remain stable.
  if (present.includes("asset_history")) sql.push("INSERT OR IGNORE INTO _uuid_ids(entity, old_id) SELECT 'jobs', job_id FROM asset_history WHERE job_id IS NOT NULL;");
  const rename = (text) => tables.reduce((s, name) => s.replaceAll(new RegExp(`\\b${name}\\b`, "g"), `_uuid_${name}`), text);
  const targets = { customer_id: "customers", technician_id: "technicians", service_type_id: "service_types", job_id: "jobs", asset_id: "assets", site_id: "sites", material_id: "materials", invoice_id: "invoices" };
  for (const [ddl] of definitions) sql.push(rename(ddl));
  for (const [, name, body] of definitions) {
    if (!present.includes(name)) continue;
    const allowed = [...body.matchAll(/^  (\w+) (?:TEXT|INTEGER|REAL)\b/gm)].map((m) => m[1]);
    const columns = existing[name].map((c) => c.name);
    if (columns.some((column) => !allowed.includes(column))) throw new Error(`Custom columns on ${name}: migrate them explicitly before continuing.`);
    const values = columns.map((column) => {
      const target = column === "id" ? name : targets[column];
      return target ? `(SELECT new_id FROM _uuid_ids WHERE entity = '${target}' AND old_id = source.${column})` : `source.${column}`;
    });
    sql.push(`INSERT INTO _uuid_${name} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${name} AS source ORDER BY source.rowid;`);
    sql.push(`INSERT INTO _uuid_check SELECT (SELECT COUNT(*) FROM ${name}) = (SELECT COUNT(*) FROM _uuid_${name});`);
  }
  // Reject constraints before removing any original table. All statements also roll back as one batch.
  sql.push("INSERT INTO _uuid_check SELECT COUNT(*) = 0 FROM pragma_foreign_key_check;");
  for (const trigger of triggers) {
    if (!/^[a-z_]+$/.test(trigger)) throw new Error("Unexpected trigger name");
    if (!schema.includes(`CREATE TRIGGER IF NOT EXISTS ${trigger} `)) throw new Error(`Custom trigger ${trigger}: migrate it explicitly.`);
    sql.push(`DROP TRIGGER ${trigger};`);
  }
  const dropOrder = ["asset_history", "invoice_lines", "invoices", "job_materials", "job_checklist", "job_notes", "jobs", "assets", "sites", "materials", "service_types", "technicians", "customers"];
  for (const name of dropOrder) if (present.includes(name)) sql.push(`DROP TABLE ${name};`);
  for (const name of tables) sql.push(`ALTER TABLE _uuid_${name} RENAME TO ${name};`);
  sql.push(schema, "INSERT INTO _uuid_check SELECT COUNT(*) = 0 FROM pragma_foreign_key_check;", "DROP TABLE _uuid_ids;", "DROP TABLE _uuid_check;");
  return sql.join("\n");
}
