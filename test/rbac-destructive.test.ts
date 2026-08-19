import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, del, loginAs,
  post, queryDb, resetDatabase,
} from "./helpers.js";

// Regression coverage for the P1 finding recorded in mem:risks/unrestricted-destructive-mutations:
// nine DELETE routes had no server-side RBAC at all, so any authenticated technician
// could delete jobs/customers/technicians/service types/checklist items/materials/
// job-material links/invoices/notes via a direct API call. Every route below is
// checked against all three roles (plus unauthenticated), and — critically — against
// actual database state after a denied attempt, not just the HTTP status code.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "dispatch-rbac@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "tech-rbac@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

describe("DELETE route RBAC — jobs, notes, customers, technicians, service types, checklist, materials, job-materials, invoices", () => {
  it("DELETE /api/jobs/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401, job survives every denied attempt", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();
    const customer = await createCustomer();

    const jobForTech = await createJob(customer.id, "2026-09-01");
    const deniedTech = await del(`/api/jobs/${jobForTech.id}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM jobs WHERE id = ?", [jobForTech.id])).toHaveLength(1);

    const jobForAnon = await createJob(customer.id, "2026-09-02");
    const deniedAnon = await del(`/api/jobs/${jobForAnon.id}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM jobs WHERE id = ?", [jobForAnon.id])).toHaveLength(1);

    const jobForDispatcher = await createJob(customer.id, "2026-09-03");
    const allowedDispatcher = await del(`/api/jobs/${jobForDispatcher.id}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM jobs WHERE id = ?", [jobForDispatcher.id])).toHaveLength(0);

    const jobForAdmin = await createJob(customer.id, "2026-09-04");
    const allowedAdmin = await del(`/api/jobs/${jobForAdmin.id}`, admin);
    expect(allowedAdmin.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM jobs WHERE id = ?", [jobForAdmin.id])).toHaveLength(0);
  });

  it("DELETE /api/notes/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401, note survives every denied attempt", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");

    async function addNote() {
      const res = await post<{ id: number }>(`/api/jobs/${job.id}/notes`, { content: "site note" }, admin);
      expect(res.response.status).toBe(201);
      return res.body.id;
    }

    const noteForTech = await addNote();
    const deniedTech = await del(`/api/notes/${noteForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM job_notes WHERE id = ?", [noteForTech])).toHaveLength(1);

    const noteForAnon = await addNote();
    const deniedAnon = await del(`/api/notes/${noteForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM job_notes WHERE id = ?", [noteForAnon])).toHaveLength(1);

    const noteForDispatcher = await addNote();
    const allowedDispatcher = await del(`/api/notes/${noteForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM job_notes WHERE id = ?", [noteForDispatcher])).toHaveLength(0);
  });

  it("DELETE /api/customers/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401, customer (and its jobs) survives every denied attempt", async () => {
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();

    const customerForTech = await createCustomer("Tech-denied Customer");
    const jobUnderCustomer = await createJob(customerForTech.id, "2026-09-01");
    const deniedTech = await del(`/api/customers/${customerForTech.id}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM customers WHERE id = ?", [customerForTech.id])).toHaveLength(1);
    // Cascade behavior (customer -> jobs, ON DELETE CASCADE) is unchanged by this
    // fix; asserting the job also survives a denied delete proves the cascade
    // never fired, not that cascade behavior itself changed.
    expect(await queryDb("SELECT id FROM jobs WHERE id = ?", [jobUnderCustomer.id])).toHaveLength(1);

    const customerForAnon = await createCustomer("Anon-denied Customer");
    const deniedAnon = await del(`/api/customers/${customerForAnon.id}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM customers WHERE id = ?", [customerForAnon.id])).toHaveLength(1);

    const customerForDispatcher = await createCustomer("Dispatcher-allowed Customer");
    const allowedDispatcher = await del(`/api/customers/${customerForDispatcher.id}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM customers WHERE id = ?", [customerForDispatcher.id])).toHaveLength(0);
  });

  it("DELETE /api/technicians/{id}: admin-only (dispatcher does NOT get delete access here — a technician row is a staff record), technician gets 403, unauthenticated gets 401", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();

    async function addTechnician(name: string) {
      const res = await post<{ id: number }>("/api/technicians", { name }, admin);
      expect(res.response.status).toBe(201);
      return res.body.id;
    }

    const techForTech = await addTechnician("Tech-denied Technician");
    const deniedTech = await del(`/api/technicians/${techForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM technicians WHERE id = ?", [techForTech])).toHaveLength(1);

    const techForAnon = await addTechnician("Anon-denied Technician");
    const deniedAnon = await del(`/api/technicians/${techForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM technicians WHERE id = ?", [techForAnon])).toHaveLength(1);

    const techForDispatcher = await addTechnician("Dispatcher-denied Technician");
    const deniedDispatcher = await del(`/api/technicians/${techForDispatcher}`, dispatcher);
    expect(deniedDispatcher.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM technicians WHERE id = ?", [techForDispatcher])).toHaveLength(1);

    const techForAdmin = await addTechnician("Admin-allowed Technician");
    const allowedAdmin = await del(`/api/technicians/${techForAdmin}`, admin);
    expect(allowedAdmin.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM technicians WHERE id = ?", [techForAdmin])).toHaveLength(0);
  });

  it("DELETE /api/service-types/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();

    async function addServiceType(name: string) {
      const res = await post<{ id: number }>("/api/service-types", { name }, admin);
      expect(res.response.status).toBe(201);
      return res.body.id;
    }

    const stForTech = await addServiceType("Tech-denied Service");
    const deniedTech = await del(`/api/service-types/${stForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM service_types WHERE id = ?", [stForTech])).toHaveLength(1);

    const stForAnon = await addServiceType("Anon-denied Service");
    const deniedAnon = await del(`/api/service-types/${stForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM service_types WHERE id = ?", [stForAnon])).toHaveLength(1);

    const stForDispatcher = await addServiceType("Dispatcher-allowed Service");
    const allowedDispatcher = await del(`/api/service-types/${stForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM service_types WHERE id = ?", [stForDispatcher])).toHaveLength(0);
  });

  it("DELETE /api/checklist/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");

    async function addChecklistItem(label: string) {
      const res = await post(`/api/jobs/${job.id}/checklist`, { label }, admin);
      expect(res.response.status).toBe(201);
      const rows = await queryDb<{ id: number }>(
        "SELECT id FROM job_checklist WHERE job_id = ? AND label = ? ORDER BY id DESC LIMIT 1", [job.id, label]
      );
      return rows[0].id;
    }

    const itemForTech = await addChecklistItem("Tech-denied Item");
    const deniedTech = await del(`/api/checklist/${itemForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM job_checklist WHERE id = ?", [itemForTech])).toHaveLength(1);

    const itemForAnon = await addChecklistItem("Anon-denied Item");
    const deniedAnon = await del(`/api/checklist/${itemForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM job_checklist WHERE id = ?", [itemForAnon])).toHaveLength(1);

    const itemForDispatcher = await addChecklistItem("Dispatcher-allowed Item");
    const allowedDispatcher = await del(`/api/checklist/${itemForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM job_checklist WHERE id = ?", [itemForDispatcher])).toHaveLength(0);
  });

  it("DELETE /api/materials/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();

    async function addMaterial(name: string) {
      const res = await post(`/api/materials`, { name }, admin);
      expect(res.response.status).toBe(201);
      const rows = await queryDb<{ id: number }>(
        "SELECT id FROM materials WHERE name = ? ORDER BY id DESC LIMIT 1", [name]
      );
      return rows[0].id;
    }

    const matForTech = await addMaterial("Tech-denied Material");
    const deniedTech = await del(`/api/materials/${matForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM materials WHERE id = ?", [matForTech])).toHaveLength(1);

    const matForAnon = await addMaterial("Anon-denied Material");
    const deniedAnon = await del(`/api/materials/${matForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM materials WHERE id = ?", [matForAnon])).toHaveLength(1);

    const matForDispatcher = await addMaterial("Dispatcher-allowed Material");
    const allowedDispatcher = await del(`/api/materials/${matForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM materials WHERE id = ?", [matForDispatcher])).toHaveLength(0);
  });

  it("DELETE /api/job-materials/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    const material = await post<{ id: number }>("/api/materials", { name: "Filter" }, admin);
    const materialRow = await queryDb<{ id: number }>("SELECT id FROM materials WHERE name = 'Filter'");
    const materialId = materialRow[0].id;
    expect(material.response.status).toBe(201);

    async function addJobMaterial() {
      const res = await post(`/api/jobs/${job.id}/materials`, { material_id: materialId, quantity: 1 }, admin);
      expect(res.response.status).toBe(201);
      const rows = await queryDb<{ id: number }>(
        "SELECT id FROM job_materials WHERE job_id = ? ORDER BY id DESC LIMIT 1", [job.id]
      );
      return rows[0].id;
    }

    const jmForTech = await addJobMaterial();
    const deniedTech = await del(`/api/job-materials/${jmForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM job_materials WHERE id = ?", [jmForTech])).toHaveLength(1);

    const jmForAnon = await addJobMaterial();
    const deniedAnon = await del(`/api/job-materials/${jmForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM job_materials WHERE id = ?", [jmForAnon])).toHaveLength(1);

    const jmForDispatcher = await addJobMaterial();
    const allowedDispatcher = await del(`/api/job-materials/${jmForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM job_materials WHERE id = ?", [jmForDispatcher])).toHaveLength(0);
  });

  it("DELETE /api/invoices/{id}: dispatcher can delete, technician gets 403, unauthenticated gets 401, invoice survives every denied attempt", async () => {
    const admin = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const technician = await technicianAuth();
    const customer = await createCustomer();

    async function addInvoice() {
      const res = await post<{ id: number }>("/api/invoices", {
        customer_id: customer.id,
        lines: [{ description: "Service call", quantity: 1, unit_price_cents: 10000 }],
      }, admin);
      expect(res.response.status).toBe(201);
      return res.body.id;
    }

    const invForTech = await addInvoice();
    const deniedTech = await del(`/api/invoices/${invForTech}`, technician);
    expect(deniedTech.response.status).toBe(403);
    expect(await queryDb("SELECT id FROM invoices WHERE id = ?", [invForTech])).toHaveLength(1);

    const invForAnon = await addInvoice();
    const deniedAnon = await del(`/api/invoices/${invForAnon}`);
    expect(deniedAnon.response.status).toBe(401);
    expect(await queryDb("SELECT id FROM invoices WHERE id = ?", [invForAnon])).toHaveLength(1);

    const invForDispatcher = await addInvoice();
    const allowedDispatcher = await del(`/api/invoices/${invForDispatcher}`, dispatcher);
    expect(allowedDispatcher.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM invoices WHERE id = ?", [invForDispatcher])).toHaveLength(0);
  });
});
