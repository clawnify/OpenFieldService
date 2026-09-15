import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { uuidMigration } from "../scripts/uuid-migration.mjs";

const schema = readFileSync(new URL("../src/server/schema.sql", import.meta.url), "utf8");
const tables = [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]).filter((t) => t !== "_meta");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function plan(db) {
  return uuidMigration(schema, Object.fromEntries(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all()])), db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name));
}
function legacy() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./fixtures/equipment-integer.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO customers(id,name) VALUES(1,'Existing customer');
    INSERT INTO technicians(id,name) VALUES(1,'Technician');
    INSERT INTO service_types(id,name) VALUES(1,'Inspection');
    INSERT INTO sites(id,customer_id,name) VALUES(1,1,'North');
    INSERT INTO assets(id,customer_id,site_id,name,serial_number) VALUES(1,1,1,'Pump','P-1');
    INSERT INTO jobs(id,identifier,customer_id,technician_id,service_type_id,asset_id) VALUES(1,'JOB-42',1,1,1,1);
    INSERT INTO job_notes(id,job_id,content) VALUES(1,1,'Original repair note');
    INSERT INTO job_checklist(id,job_id,label) VALUES(1,1,'Check pressure');
    INSERT INTO materials(id,name) VALUES(1,'Seal');
    INSERT INTO job_materials(id,job_id,material_id,quantity) VALUES(1,1,1,2);
    INSERT INTO invoices(id,identifier,customer_id,job_id,total) VALUES(1,'INV-8',1,1,100);
    INSERT INTO invoice_lines(id,invoice_id,description,total) VALUES(1,1,'Repair',100);
    INSERT INTO asset_history(asset_id,job_id,summary,details) VALUES(1,99,'JOB-9 deleted','Keep this snapshot'),(1,99,'JOB-9 note','Keep its reference');
    INSERT INTO _meta VALUES('job_counter','42');`);
  return db;
}

test("UUID migration preserves every row, relation, timestamp and retained snapshot; repeat is a no-op", () => {
  const db = legacy();
  try {
    const before = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    db.exec("BEGIN"); db.exec(plan(db)); db.exec("COMMIT");
    const after = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    for (const table of tables) {
      assert.equal(after[table].length, before[table].length, table);
      after[table].forEach((row, i) => {
        for (const [key, value] of Object.entries(row)) {
          if (key === "id" || key.endsWith("_id")) { if (value !== null) assert.match(value, uuid, `${table}.${key}`); }
          else assert.equal(value, before[table][i][key], `${table}.${key}`);
        }
      });
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const job = after.jobs[0];
    assert.equal(job.customer_id, after.customers[0].id);
    assert.equal(job.asset_id, after.assets[0].id);
    assert.equal(after.invoices[0].job_id, job.id);
    assert.equal(after.job_materials[0].material_id, after.materials[0].id);
    assert.equal(after.assets[0].site_id, after.sites[0].id);
    const deleted = after.asset_history.filter((e) => e.summary.startsWith("JOB-9"));
    assert.equal(deleted[0].job_id, deleted[1].job_id);
    assert.notEqual(deleted[0].job_id, job.id);
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key='job_counter'").get().value, "42");
    assert.equal(plan(db), null);
    db.exec("INSERT INTO job_notes(job_id,content) SELECT id,'After migration' FROM jobs");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM asset_history").get().n, after.asset_history.length + 1);
  } finally { db.close(); }
});

test("new databases generate UUIDs including history; malformed IDs fail", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    assert.equal(plan(db), null);
    const customer = db.prepare("INSERT INTO customers(name) VALUES('New') RETURNING id").get();
    assert.match(customer.id, uuid);
    assert.throws(() => db.exec("INSERT INTO customers(id,name) VALUES(1,'Invalid')"));
    assert.throws(() => db.exec("INSERT INTO customers(id,name) VALUES('not-a-uuid-but-exactly-36-characters!!','Invalid')"));
  } finally { db.close(); }
});

test("custom columns are rejected before migration and failed validation rolls back", () => {
  const db = legacy();
  try {
    db.exec("ALTER TABLE customers ADD COLUMN custom_data TEXT");
    assert.throws(() => plan(db), /Custom columns/);
    db.exec("ALTER TABLE customers DROP COLUMN custom_data");
    db.exec("PRAGMA foreign_keys=OFF; UPDATE jobs SET technician_id=999; PRAGMA foreign_keys=ON;");
    const migration = plan(db);
    db.exec("BEGIN");
    assert.throws(() => db.exec(migration), /CHECK constraint/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT id FROM customers").get().id, 1);
    assert.equal(db.prepare("SELECT content FROM job_notes").get().content, "Original repair note");
  } finally { db.close(); }
});
