import { env, exports as workerExports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

interface JsonResponse<T> {
  response: Response;
  body: T;
}

async function request<T>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await workerExports.default.fetch(`http://example.test${path}`, init);
  const body = await response.json() as T;
  return { response, body };
}

async function post<T>(path: string, body: unknown): Promise<JsonResponse<T>> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createCustomer(name = "Ada Heating") {
  const result = await post<{ id: number; name: string }>("/api/customers", {
    name,
    email: "service@example.test",
    phone: "555-0100",
    address: "100 Main St",
    city: "Burnaby",
    state: "BC",
    zip: "V5A 1A1",
  });
  expect(result.response.status).toBe(201);
  return result.body;
}

async function createJob(customerId: number, scheduledDate: string, overrides: Record<string, unknown> = {}) {
  const result = await post<{ id: number; scheduled_date: string }>("/api/jobs", {
    customer_id: customerId,
    service_type_id: 1,
    scheduled_date: scheduledDate,
    ...overrides,
  });
  expect(result.response.status).toBe(201);
  return result.body;
}

async function executeStatements(statements: string[]) {
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

async function applySchema() {
  await executeStatements(JSON.parse(env.TEST_SCHEMA_STATEMENTS) as string[]);
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await executeStatements([
    "DELETE FROM invoice_lines",
    "DELETE FROM invoices",
    "DELETE FROM job_materials",
    "DELETE FROM materials",
    "DELETE FROM job_checklist",
    "DELETE FROM job_notes",
    "DELETE FROM jobs",
    "DELETE FROM service_types",
    "DELETE FROM technicians",
    "DELETE FROM customers",
    "UPDATE _meta SET value = '0' WHERE key IN ('job_counter', 'invoice_counter')",
    "DELETE FROM sqlite_sequence",
  ]);
  await applySchema();
});

describe("existing field service API", () => {
  it("creates, searches, updates, and reads customers with service history", async () => {
    const customer = await createCustomer();
    await createJob(customer.id, "2026-01-10");

    const update = await request<{ ok: boolean }>(`/api/customers/${customer.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "555-0199" }),
    });
    const search = await request<{ customers: Array<{ id: number; job_count: number }>; total: number }>(
      "/api/customers?search=Ada&page=1&limit=50",
    );
    const detail = await request<{ customer: { phone: string }; jobs: Array<{ scheduled_date: string }> }>(
      `/api/customers/${customer.id}`,
    );

    expect(update.body.ok).toBe(true);
    expect(search.body).toMatchObject({ total: 1, customers: [{ id: customer.id, job_count: 1 }] });
    expect(detail.body.customer.phone).toBe("555-0199");
    expect(detail.body.jobs).toHaveLength(1);
  });

  it("creates, updates, and lists technicians", async () => {
    const created = await post<{ id: number; name: string; active: number }>("/api/technicians", {
      name: "Grace Hopper",
      email: "grace@example.test",
      color: "#123456",
    });
    const update = await request<{ ok: boolean }>(`/api/technicians/${created.body.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: 0 }),
    });
    const list = await request<{ technicians: Array<{ id: number; active: number }> }>("/api/technicians");
    const activeLookup = await request<{ technicians: Array<{ id: number }> }>("/api/technicians/all");

    expect(created.response.status).toBe(201);
    expect(update.body.ok).toBe(true);
    expect(list.body.technicians).toContainEqual(expect.objectContaining({ id: created.body.id, active: 0 }));
    expect(activeLookup.body.technicians).not.toContainEqual(expect.objectContaining({ id: created.body.id }));
  });

  it("retains seeded service types and supports catalog CRUD", async () => {
    const initial = await request<{ service_types: Array<{ id: number }> }>("/api/service-types");
    const created = await post<{ id: number; name: string }>("/api/service-types", {
      name: "Heat Pump Tune-up",
      default_duration: 75,
      default_price: 189.5,
      color: "#abcdef",
    });
    const update = await request<{ ok: boolean }>(`/api/service-types/${created.body.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_duration: 90 }),
    });
    const removed = await request<{ ok: boolean }>(`/api/service-types/${created.body.id}`, { method: "DELETE" });

    expect(initial.body.service_types).toHaveLength(6);
    expect(created.response.status).toBe(201);
    expect(update.body.ok).toBe(true);
    expect(removed.body.ok).toBe(true);
  });

  it("retains seeded materials and supports inventory catalog CRUD", async () => {
    const initial = await request<{ materials: Array<{ id: number }> }>("/api/materials");
    const created = await post<{ ok: boolean }>("/api/materials", {
      name: "Contactor",
      unit: "ea",
      unit_cost: 42.25,
      in_stock: 8,
    });
    const list = await request<{ materials: Array<{ id: number; name: string; unit_cost: number }> }>("/api/materials");
    const contactor = list.body.materials.find((material) => material.name === "Contactor");
    const update = await request<{ ok: boolean }>(`/api/materials/${contactor?.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ in_stock: 7 }),
    });

    expect(initial.body.materials).toHaveLength(5);
    expect(created.response.status).toBe(201);
    expect(contactor).toMatchObject({ unit_cost: 42.25 });
    expect(update.body.ok).toBe(true);
  });

  it("applies existing customer-address and service defaults when creating jobs", async () => {
    const customer = await createCustomer();
    const created = await createJob(customer.id, "2026-03-14", { scheduled_time: "10:30" });
    const detail = await request<{ job: {
      identifier: string;
      address: string;
      duration: number;
      price: number;
      scheduled_time: string;
    } }>(`/api/jobs/${created.id}`);

    expect(detail.body.job).toMatchObject({
      identifier: "JOB-1",
      address: "100 Main St, Burnaby, BC, V5A 1A1",
      duration: 60,
      price: 150,
      scheduled_time: "10:30",
    });
  });

  it("adds job materials and returns them from job detail", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-04-01");
    const added = await post<{ ok: boolean }>(`/api/jobs/${job.id}/materials`, {
      material_id: 2,
      quantity: 2,
    });
    const detail = await request<{ job: { job_materials: Array<{ material_name: string; quantity: number; unit_cost: number }> } }>(
      `/api/jobs/${job.id}`,
    );

    expect(added.body.ok).toBe(true);
    expect(detail.body.job.job_materials).toEqual([
      expect.objectContaining({ material_name: "Filter Replacement", quantity: 2, unit_cost: 25 }),
    ]);
  });

  it("creates invoices with calculated line and tax totals", async () => {
    const customer = await createCustomer();
    const created = await post<{ id: number; identifier: string; subtotal: number; tax_amount: number; total: number }>(
      "/api/invoices",
      {
        customer_id: customer.id,
        tax_rate: 5,
        due_date: "2026-05-31",
        lines: [
          { description: "Diagnostic", quantity: 1, unit_price: 100 },
          { description: "Part", quantity: 2, unit_price: 25 },
        ],
      },
    );
    const detail = await request<{ invoice: { lines: unknown[]; total: number } }>(`/api/invoices/${created.body.id}`);

    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ identifier: "INV-1", subtotal: 150, tax_amount: 7.5, total: 157.5 });
    expect(detail.body.invoice.lines).toHaveLength(2);
    expect(detail.body.invoice.total).toBe(157.5);
  });

  it("returns arbitrary schedule ranges longer than seven days with inclusive boundaries", async () => {
    const customer = await createCustomer();
    await createJob(customer.id, "2026-01-01");
    await createJob(customer.id, "2026-01-20");
    await createJob(customer.id, "2026-02-15");

    const schedule = await request<{ jobs: Array<{ scheduled_date: string }> }>(
      "/api/schedule?start=2026-01-01&end=2026-01-31",
    );

    expect(schedule.response.status).toBe(200);
    expect(schedule.body.jobs.map((job) => job.scheduled_date)).toEqual(["2026-01-01", "2026-01-20"]);
  });
});
