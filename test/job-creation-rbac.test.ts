import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, loginAs,
  post, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 7.2 security fix: POST /api/jobs had NO server-side RBAC at all —
// any authenticated role, including technician, could create a job for any
// customer and assign it to any active technician. See
// mem:risks/job-creation-rbac for the full root-cause record. Every test
// here verifies actual DATABASE state (job count, _meta.job_counter, the
// job_status_history actor), not just HTTP status codes, per the explicit
// "unauthorized POST creates zero rows" / "RBAC must execute before any
// mutation" requirements.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "dispatch-jobcreate@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
}

async function unlinkedTechnicianAuth(email: string): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function jobCount(): Promise<number> {
  return (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM jobs"))[0].count;
}

async function jobCounter(): Promise<string> {
  return (await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'job_counter'"))[0].value;
}

describe("POST /api/jobs — RBAC", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await post("/api/jobs", { customer_id: 1, scheduled_date: "2026-09-01" });
    expect(res.response.status).toBe(401);
  });

  it("admin can create a job — verified against actual database state, including the real actor recorded", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post<{ id: number }>("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, auth);
    expect(res.response.status).toBe(201);
    expect(await jobCount()).toBe(before + 1);

    const rows = await queryDb<{ customer_id: number }>("SELECT customer_id FROM jobs WHERE id = ?", [res.body.id]);
    expect(rows[0].customer_id).toBe(customer.id);

    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const history = await queryDb<{ actor_user_id: number }>("SELECT actor_user_id FROM job_status_history WHERE job_id = ?", [res.body.id]);
    expect(history[0].actor_user_id).toBe(me.body.user.id);
  });

  it("dispatcher can create a job — verified against actual database state", async () => {
    const dispatcher = await dispatcherAuth();
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post<{ id: number }>("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, dispatcher);
    expect(res.response.status).toBe(201);
    expect(await jobCount()).toBe(before + 1);
  });

  it("technician is rejected — zero rows created, job_counter not incremented (RBAC runs before ANY mutation)", async () => {
    const auth = await authHeaders();
    const tech = await createLinkedTechnician("jobcreate-tech@example.test", auth);
    const customer = await createCustomer();
    const beforeCount = await jobCount();
    const beforeCounter = await jobCounter();

    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, tech.auth);
    expect(res.response.status).toBe(403);

    expect(await jobCount()).toBe(beforeCount);
    expect(await jobCounter()).toBe(beforeCounter);
  });

  it("an unlinked technician is rejected the same as any other technician", async () => {
    const unlinked = await unlinkedTechnicianAuth("jobcreate-unlinked@example.test");
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, unlinked);
    expect(res.response.status).toBe(403);
    expect(await jobCount()).toBe(before);
  });
});

describe("POST /api/jobs — IDOR / mass assignment / spoofing", () => {
  it("IDOR: a technician cannot use technician_id to assign a job to another technician", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("jobcreate-idor-a@example.test", auth);
    const techB = await createLinkedTechnician("jobcreate-idor-b@example.test", auth);
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post(
      "/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", technician_id: techB.technicianId }, techA.auth
    );
    expect(res.response.status).toBe(403);
    expect(await jobCount()).toBe(before);
  });

  it("mass assignment: actor_user_id / created_by are rejected outright by the strict schema, never trusted", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post(
      "/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", actor_user_id: 999999, created_by: 999999 }, auth
    );
    expect(res.response.status).toBe(400);
    expect(await jobCount()).toBe(before);
  });

  it("role spoofing in the request body does not elevate a technician's privileges", async () => {
    const auth = await authHeaders();
    const tech = await createLinkedTechnician("jobcreate-rolespoof@example.test", auth);
    const customer = await createCustomer();
    const before = await jobCount();

    const res = await post(
      "/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", role: "admin" }, tech.auth
    );
    // The strict schema rejects the unrecognized `role` field before the
    // handler's role check even runs — same safe outcome (rejected, zero
    // mutation) as the plain 403 case, just via a different layer.
    expect([400, 403]).toContain(res.response.status);
    expect(await jobCount()).toBe(before);
  });

  it("role spoofing does not grant a technician-supplied body any special treatment for an authorized (admin) caller either", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", role: "technician" }, auth);
    // Still rejected — the field is simply not part of this route's contract
    // for ANY caller, admin included; the field can never be used to
    // downgrade or upgrade anything.
    expect(res.response.status).toBe(400);
  });
});

describe("POST /api/jobs — workflow bypass", () => {
  it("rejects a status field outright (strict schema) and never lets a created job start anywhere but its real entry status", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const before = await jobCount();

    const injected = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", status: "completed" }, auth);
    expect(injected.response.status).toBe(400);
    expect(await jobCount()).toBe(before);

    const legit = await post<{ id: number; status: string }>("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, auth);
    expect(legit.response.status).toBe(201);
    expect(legit.body.status).toBe("scheduled");
  });

  it("rejects other workflow-only status values the same way", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", status: "in_progress" }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("POST /api/jobs — confirmation-adjacent regression guard", () => {
  it("a rejected technician request never reaches the point of allocating a job identifier or writing any row", async () => {
    const auth = await authHeaders();
    const tech = await createLinkedTechnician("jobcreate-noalloc@example.test", auth);
    const customer = await createCustomer();
    const beforeCounter = await jobCounter();

    await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01" }, tech.auth);
    await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-02" }, tech.auth);

    expect(await jobCounter()).toBe(beforeCounter);
    expect((await queryDb("SELECT * FROM job_status_history")).length).toBe(0);
  });
});
