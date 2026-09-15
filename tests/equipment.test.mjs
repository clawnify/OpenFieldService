import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/bin/wrangler.js");
const directory = mkdtempSync(join(tmpdir(), "openfieldservice-test-"));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
let server;
let base;
let logs = "";
let legacyId;
const missingId = "00000000-0000-4000-8000-000000000000";
function cli(args) { return execFileSync(process.execPath, [wrangler, ...args], { env, encoding: "utf8" }); }
function sql(command) { return JSON.parse(cli(["d1", "execute", "open-fieldservice-db", "--local", "--persist-to", directory, "--command", command, "--json"]))[0].results; }
async function api(method, path, body, status = 200) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  return JSON.parse(text);
}

before(async () => {
  // Frozen pre-equipment schema ensures the upgrade is exercised with real data.
  cli(["d1", "execute", "open-fieldservice-db", "--local", "--persist-to", directory, "--file", "tests/fixtures/job-centric.sql"]);
  sql("INSERT INTO customers(id,name,address) VALUES (1,'Legacy customer','Original address'); INSERT INTO jobs(id,identifier,customer_id,notes) VALUES (1,'LEGACY-1',1,'Keep this history')");
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, ["scripts/setup-db.mjs", "--migrate-uuids", directory], { env, encoding: "utf8" });
  legacyId = sql("SELECT id FROM jobs WHERE identifier = 'LEGACY-1'")[0].id;
  assert.match(legacyId, /^[0-9a-f-]{36}$/);
  assert.equal(sql("SELECT asset_id FROM jobs WHERE identifier = 'LEGACY-1'")[0].asset_id, null);
  assert.equal(sql("SELECT notes FROM jobs WHERE identifier = 'LEGACY-1'")[0].notes, "Keep this history");
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [wrangler, "dev", "--local", "--port", String(port), "--persist-to", directory, "--inspector-port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (data) => { logs += data; });
  server.stderr.on("data", (data) => { logs += data; });
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(base + "/api/stats")).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local API did not start: " + logs);
});
after(async () => {
  if (server && server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
  rmSync(directory, { recursive: true, force: true });
});

test("equipment lifecycle remains optional and preserves history across moves", async (t) => {
  let customer, other, first, second, foreign, asset, job;
  await t.test("existing and ordinary jobs work without equipment", async () => {
    const { job: legacy } = await api("GET", `/api/jobs/${legacyId}`);
    assert.equal(legacy.asset_id, null);
    assert.equal(legacy.notes, "Keep this history");
    await api("PUT", `/api/jobs/${legacyId}`, { status: "completed" });
    customer = await api("POST", "/api/customers", { name: "Equipment customer", address: "Customer office" }, 201);
    other = await api("POST", "/api/customers", { name: "Another customer" }, 201);
    const ordinary = await api("POST", "/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-15" }, 201);
    assert.equal(ordinary.asset_id, null);
    assert.equal(ordinary.address, "Customer office");
  });
  await t.test("sites have contacts, timezone, access and safety notes", async () => {
    first = await api("POST", `/api/customers/${customer.id}/sites`, { name: "North plant", address: "1 North Road", timezone: "Europe/Amsterdam", contact_name: "Reception", safety_notes: "Isolate supply", access_instructions: "Use gate B" }, 201);
    second = await api("POST", `/api/customers/${customer.id}/sites`, { name: "South plant", address: "2 South Road" }, 201);
    foreign = await api("POST", `/api/customers/${other.id}/sites`, { name: "Other site" }, 201);
    await api("PUT", `/api/sites/${first.id}`, { contact_phone: "555-0100" });
    const { sites } = await api("GET", `/api/customers/${customer.id}/sites`);
    assert.equal(sites.length, 2);
    assert.equal(sites.find((site) => site.id === first.id).safety_notes, "Isolate supply");
    await api("POST", `/api/customers/${customer.id}/sites`, { name: "Bad timezone", timezone: "Moon/Base" }, 400);
    await api("POST", `/api/customers/${customer.id}/sites`, { name: "   " }, 400);
    await api("PUT", `/api/sites/${first.id}`, { customer_id: other.id }, 400);
  });
  await t.test("registration validates serials, dates and customer boundaries", async () => {
    asset = await api("POST", `/api/customers/${customer.id}/assets`, { name: "Air handler", serial_number: " AH-001 ", site_id: first.id, model: "AX-10", manufacturer: "Example", warranty_start: "2026-01-01", warranty_end: "2027-01-01" }, 201);
    assert.equal(asset.serial_number, "AH-001");
    await api("POST", `/api/customers/${customer.id}/assets`, { name: "Duplicate", serial_number: "ah-001", site_id: first.id }, 409);
    await api("POST", `/api/customers/${customer.id}/assets`, { name: "Wrong customer", serial_number: "AH-002", site_id: foreign.id }, 400);
    await api("PUT", `/api/assets/${asset.id}`, { warranty_end: "2025-01-01" }, 400);
    await api("PUT", `/api/assets/${asset.id}`, { installation_date: "2026-02-30" }, 400);
    await api("PUT", `/api/assets/${asset.id}`, { site_id: foreign.id }, 400);
    await api("PUT", `/api/assets/${asset.id}`, { customer_id: other.id }, 400);
    const history = await api("GET", `/api/assets/${asset.id}/history`);
    assert.equal(history.total, 1, "failed mutations must not create history");
    assert.equal((await api("GET", `/api/customers/${customer.id}/assets?search=ah-001`)).total, 1);
    assert.equal((await api("GET", `/api/customers/${other.id}/assets`)).total, 0);
    await api("GET", `/api/customers/${customer.id}/assets?page=0`, undefined, 400);
    await api("GET", `/api/assets/${missingId}`, undefined, 404);
  });
  await t.test("linked jobs snapshot the site address and reject cross-customer links", async () => {
    job = await api("POST", "/api/jobs", { customer_id: customer.id, asset_id: asset.id, scheduled_date: "2026-09-15", notes: "Inspect vibration" }, 201);
    assert.equal(job.asset_id, asset.id);
    assert.equal(job.address, "1 North Road");
    await api("POST", "/api/jobs", { customer_id: other.id, asset_id: asset.id, scheduled_date: "2026-09-15" }, 400);
    await api("PUT", `/api/jobs/${job.id}`, { customer_id: other.id }, 400);
    await api("PUT", `/api/jobs/${legacyId}`, { asset_id: asset.id }, 400);
    const note = await api("POST", `/api/jobs/${job.id}/notes`, { content: "Replaced worn belt" }, 201);
    await api("PUT", `/api/jobs/${job.id}`, { status: "completed", completion_notes: "Vibration resolved" });
    assert.ok(note.id);
  });
  await t.test("same-customer move preserves registration, repair notes and job history", async () => {
    await api("PUT", `/api/assets/${asset.id}`, { site_id: second.id, status: "out_of_service" });
    const detail = await api("GET", `/api/assets/${asset.id}`);
    assert.equal(detail.site.id, second.id);
    assert.equal(detail.asset.model, "AX-10", "partial updates must preserve other fields");
    assert.equal((await api("GET", `/api/jobs/${job.id}`)).job.address, "1 North Road");
    const { history } = await api("GET", `/api/assets/${asset.id}/history`);
    assert.ok(history.some((event) => event.summary === "Site changed" && event.details === "North plant → South plant"));
    assert.ok(history.some((event) => event.details.includes("Replaced worn belt")));
    assert.ok(history.some((event) => event.details.includes("Vibration resolved")));
    assert.ok(history.some((event) => event.available_job_id === job.id));
    await api("DELETE", `/api/customers/${customer.id}`, undefined, 409);
  });
  await t.test("linking existing jobs, unlinking and deletion retain snapshots", async () => {
    await api("PUT", `/api/jobs/${job.id}`, { asset_id: null });
    let history = (await api("GET", `/api/assets/${asset.id}/history`)).history;
    assert.ok(history.some((event) => event.summary.endsWith("unlinked")));
    await api("PUT", `/api/jobs/${job.id}`, { asset_id: asset.id });
    await api("DELETE", `/api/jobs/${job.id}`);
    history = (await api("GET", `/api/assets/${asset.id}/history`)).history;
    assert.ok(history.some((event) => event.summary.endsWith("deleted") && event.details.includes("Vibration resolved")));
    assert.ok(history.filter((event) => event.job_id === job.id).every((event) => event.available_job_id === null));
  });
  await t.test("history pagination is bounded and new routes are discoverable", async () => {
    for (let i = 0; i < 52; i++) await api("PUT", `/api/assets/${asset.id}`, { status: i % 2 ? "in_service" : "out_of_service" });
    const firstPage = await api("GET", `/api/assets/${asset.id}/history`);
    const secondPage = await api("GET", `/api/assets/${asset.id}/history?page=2`);
    assert.equal(firstPage.history.length, 50);
    assert.ok(secondPage.history.length > 0);
    assert.ok(secondPage.history.every((event) => !firstPage.history.some((first) => first.id === event.id)));
    const openapi = await api("GET", "/api/openapi.json");
    assert.ok(openapi.paths["/api/assets/{id}/history"]);
    assert.ok(openapi.paths["/api/customers/{id}/sites"]);
  });
});


test("UUID API contracts cover all record types and concurrent creation", async () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const customers = await Promise.all(Array.from({ length: 8 }, (_, i) => api("POST", "/api/customers", { name: `Concurrent ${i}` }, 201)));
  customers.forEach((customer, i) => { assert.match(customer.id, uuid); assert.equal(customer.name, `Concurrent ${i}`); });
  assert.equal(new Set(customers.map((c) => c.id)).size, 8);
  const customer = customers[0];
  const tech = await api("POST", "/api/technicians", { name: "UUID technician" }, 201);
  const service = await api("POST", "/api/service-types", { name: "UUID inspection", default_price: 125 }, 201);
  assert.match(tech.id, uuid); assert.match(service.id, uuid);
  const jobs = await Promise.all(Array.from({ length: 4 }, () => api("POST", "/api/jobs", { customer_id: customer.id, technician_id: tech.id, service_type_id: service.id, scheduled_date: "2026-09-15" }, 201)));
  assert.equal(new Set(jobs.map((job) => job.identifier)).size, 4);
  const job = jobs[0];
  assert.match(job.id, uuid); assert.equal(job.technician_id, tech.id); assert.equal(job.price, 125);
  await api("POST", `/api/jobs/${job.id}/checklist`, { label: "Check UUID relations" }, 201);
  await api("POST", "/api/materials", { name: "UUID seal", unit_cost: 10 }, 201);
  const material = (await api("GET", "/api/materials")).materials.find((m) => m.name === "UUID seal");
  assert.match(material.id, uuid);
  await api("POST", `/api/jobs/${job.id}/materials`, { material_id: material.id, quantity: 2 }, 201);
  const detail = (await api("GET", `/api/jobs/${job.id}`)).job;
  assert.match(detail.checklist[0].id, uuid); assert.match(detail.job_materials[0].id, uuid);
  await api("PUT", `/api/checklist/${detail.checklist[0].id}`, { checked: 1 });
  const invoiceResult = await api("POST", `/api/jobs/${job.id}/invoice`, undefined, 201);
  assert.match(invoiceResult.invoice_id, uuid);
  const invoice = (await api("GET", `/api/invoices/${invoiceResult.invoice_id}`)).invoice;
  assert.equal(invoice.job_id, job.id); assert.equal(invoice.total, 145);
  assert.ok(invoice.lines.every((line) => uuid.test(line.id) && line.invoice_id === invoice.id));
  await api("GET", "/api/jobs/1", undefined, 400);
  await api("POST", "/api/jobs", { customer_id: 1, scheduled_date: "2026-09-15" }, 400);
  await api("POST", `/api/jobs/${job.id}/materials`, { material_id: 1, quantity: 1 }, 400);
  await api("PUT", `/api/jobs/${job.id}`, { technician_id: null });
  assert.equal((await api("GET", `/api/jobs/${job.id}`)).job.technician_id, null);
});
