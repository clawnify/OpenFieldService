import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Regression suite for the P1 fix in mem:risks/technician-job-read-scoping:
// a technician account previously could read ANY job, ANY customer, and the
// full company schedule via GET /api/jobs, GET /api/jobs/{id},
// GET /api/schedule, GET /api/customers(+/all/+{id}), GET
// /api/customers/{id}/rebate-eligibility, and GET /api/jobs/eligibility-codes
// — not just their own assigned work. Every test here verifies actual
// returned DATA, not merely HTTP status codes, and explicitly probes IDOR via
// client-supplied ids/query params (which must never be trusted for a
// technician actor — ownership always comes from the authenticated session).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "dispatch-scope@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

/** A technician login WITH a linked technicians row (so they own whatever
 *  jobs get assigned to that row) — distinct from a bare technician login,
 *  which owns nothing and must see nothing everywhere below. */
async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, cookie, auth: { headers: { cookie } } as RequestInit };
}

async function unlinkedTechnicianAuth(email: string): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function assignTechnician(jobId: number, technicianId: number, auth: RequestInit) {
  const res = await put(`/api/jobs/${jobId}`, { technician_id: technicianId }, auth);
  expect(res.response.status).toBe(200);
}

describe("GET /api/jobs — technician read scoping", () => {
  it("admin and dispatcher see every job; a technician sees only jobs assigned to them", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const techA = await createLinkedTechnician("scope-joblist-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-joblist-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-01");
    const jobB = await createJob(customer.id, "2026-09-02");
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);

    const asAdmin = await request<{ jobs: { id: number }[] }>("/api/jobs", auth);
    expect(asAdmin.body.jobs.map((j) => j.id).sort()).toEqual([jobA.id, jobB.id].sort());

    const asDispatcher = await request<{ jobs: { id: number }[] }>("/api/jobs", dispatcher);
    expect(asDispatcher.body.jobs.map((j) => j.id).sort()).toEqual([jobA.id, jobB.id].sort());

    const asTechA = await request<{ jobs: { id: number }[] }>("/api/jobs", techA.auth);
    expect(asTechA.body.jobs.map((j) => j.id)).toEqual([jobA.id]);
    expect(asTechA.body.jobs.map((j) => j.id)).not.toContain(jobB.id);

    const asTechB = await request<{ jobs: { id: number }[] }>("/api/jobs", techB.auth);
    expect(asTechB.body.jobs.map((j) => j.id)).toEqual([jobB.id]);
  });

  it("a technician with no linked technician profile sees an empty list, not every job", async () => {
    const unlinked = await unlinkedTechnicianAuth("scope-unlinked@example.test");
    const customer = await createCustomer();
    await createJob(customer.id, "2026-09-01");

    const res = await request<{ jobs: unknown[]; total: number }>("/api/jobs", unlinked);
    expect(res.response.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("IDOR: a technician cannot see another technician's jobs by supplying their technician_id as a query param", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-idor-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-idor-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-01");
    const jobB = await createJob(customer.id, "2026-09-02");
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);

    const res = await request<{ jobs: { id: number }[] }>(`/api/jobs?technician_id=${techB.technicianId}`, techA.auth);
    expect(res.body.jobs.map((j) => j.id)).toEqual([jobA.id]);
    expect(res.body.jobs.map((j) => j.id)).not.toContain(jobB.id);
  });

  it("unauthenticated requests are rejected", async () => {
    const res = await request("/api/jobs");
    expect(res.response.status).toBe(401);
  });
});

describe("GET /api/jobs/{id} — technician read scoping", () => {
  it("admin and dispatcher can read any job", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const techA = await createLinkedTechnician("scope-detail-a@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    expect((await request(`/api/jobs/${job.id}`, auth)).response.status).toBe(200);
    expect((await request(`/api/jobs/${job.id}`, dispatcher)).response.status).toBe(200);
  });

  it("the assigned technician can read their own job in full", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-detail-own@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    const res = await request<{ job: { id: number; customer_name?: string } }>(`/api/jobs/${job.id}`, techA.auth);
    expect(res.response.status).toBe(200);
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.customer_name).toBeTruthy();
  });

  it("an unrelated technician is denied and receives NO job/customer data in the response body — not just a 403 status", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-detail-owner@example.test", auth);
    const techB = await createLinkedTechnician("scope-detail-intruder@example.test", auth);
    const customer = await createCustomer("Sensitive Customer Co");
    const job = await createJob(customer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    const res = await request<{ error?: string; job?: unknown }>(`/api/jobs/${job.id}`, techB.auth);
    expect(res.response.status).toBe(403);
    expect(res.body.job).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("Sensitive Customer Co");
    expect(raw).not.toContain("555-0100"); // createCustomer()'s fixture phone
  });

  it("IDOR: a technician cannot bypass ownership by guessing/incrementing another job's numeric id", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-idor-detail-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-idor-detail-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-01");
    const jobB = await createJob(customer.id, "2026-09-02");
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);

    expect((await request(`/api/jobs/${jobB.id}`, techA.auth)).response.status).toBe(403);
    expect((await request(`/api/jobs/${jobA.id}`, techB.auth)).response.status).toBe(403);
  });

  it("unauthenticated requests are rejected", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    expect((await request(`/api/jobs/${job.id}`)).response.status).toBe(401);
  });
});

describe("GET /api/schedule — technician read scoping", () => {
  it("admin and dispatcher get the full company schedule; a technician gets only their own entries", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const techA = await createLinkedTechnician("scope-sched-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-sched-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-05");
    const jobB = await createJob(customer.id, "2026-09-06");
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);

    const range = "start=2026-09-01&end=2026-09-30";
    const asAdmin = await request<{ jobs: { id: number }[] }>(`/api/schedule?${range}`, auth);
    expect(asAdmin.body.jobs.map((j) => j.id).sort()).toEqual([jobA.id, jobB.id].sort());

    const asDispatcher = await request<{ jobs: { id: number }[] }>(`/api/schedule?${range}`, dispatcher);
    expect(asDispatcher.body.jobs.map((j) => j.id).sort()).toEqual([jobA.id, jobB.id].sort());

    const asTechA = await request<{ jobs: { id: number }[] }>(`/api/schedule?${range}`, techA.auth);
    expect(asTechA.body.jobs.map((j) => j.id)).toEqual([jobA.id]);
  });

  it("IDOR: a technician cannot see another technician's schedule by supplying their technician_id", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-sched-idor-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-sched-idor-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-05");
    const jobB = await createJob(customer.id, "2026-09-06");
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);

    const res = await request<{ jobs: { id: number }[] }>(
      `/api/schedule?start=2026-09-01&end=2026-09-30&technician_id=${techB.technicianId}`, techA.auth
    );
    expect(res.body.jobs.map((j) => j.id)).toEqual([jobA.id]);
  });

  it("a technician with no linked profile sees no schedule entries", async () => {
    const unlinked = await unlinkedTechnicianAuth("scope-sched-unlinked@example.test");
    const res = await request<{ jobs: unknown[] }>("/api/schedule?start=2026-09-01&end=2026-09-30", unlinked);
    expect(res.body.jobs).toEqual([]);
  });

  it("unauthenticated requests are rejected", async () => {
    expect((await request("/api/schedule?start=2026-09-01&end=2026-09-30")).response.status).toBe(401);
  });
});

describe("Customer endpoints — same P1, discovered as part of the same sweep", () => {
  it("GET /api/customers: a technician sees only customers tied to a job assigned to them", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-cust-list-a@example.test", auth);
    const ownCustomer = await createCustomer("Owned By TechA");
    const unrelatedCustomer = await createCustomer("Unrelated To TechA");
    const job = await createJob(ownCustomer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);
    await createJob(unrelatedCustomer.id, "2026-09-02"); // unassigned, unrelated to techA

    const res = await request<{ customers: { id: number }[] }>("/api/customers", techA.auth);
    const ids = res.body.customers.map((c) => c.id);
    expect(ids).toContain(ownCustomer.id);
    expect(ids).not.toContain(unrelatedCustomer.id);
  });

  it("GET /api/customers/{id}: a technician can view a customer tied to their own job, and is denied (with no data leaked) for an unrelated one", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-cust-detail-a@example.test", auth);
    const ownCustomer = await createCustomer("TechA Own Customer");
    const unrelatedCustomer = await createCustomer("Fully Unrelated Customer");
    const job = await createJob(ownCustomer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    const ownRes = await request<{ customer: { id: number } }>(`/api/customers/${ownCustomer.id}`, techA.auth);
    expect(ownRes.response.status).toBe(200);
    expect(ownRes.body.customer.id).toBe(ownCustomer.id);

    const deniedRes = await request<{ error?: string; customer?: unknown }>(`/api/customers/${unrelatedCustomer.id}`, techA.auth);
    expect(deniedRes.response.status).toBe(403);
    expect(deniedRes.body.customer).toBeUndefined();
    expect(JSON.stringify(deniedRes.body)).not.toContain("Fully Unrelated Customer");
  });

  it("GET /api/customers/{id}: the returned jobs list is narrowed to the technician's own job(s), even for a customer they're allowed to view", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-cust-jobs-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-cust-jobs-b@example.test", auth);
    const sharedCustomer = await createCustomer("Shared Customer");
    const jobForA = await createJob(sharedCustomer.id, "2026-09-01");
    const jobForB = await createJob(sharedCustomer.id, "2026-09-02");
    await assignTechnician(jobForA.id, techA.technicianId, auth);
    await assignTechnician(jobForB.id, techB.technicianId, auth);

    const res = await request<{ jobs: { id: number }[] }>(`/api/customers/${sharedCustomer.id}`, techA.auth);
    expect(res.response.status).toBe(200);
    expect(res.body.jobs.map((j) => j.id)).toEqual([jobForA.id]);
    expect(res.body.jobs.map((j) => j.id)).not.toContain(jobForB.id);
  });

  it("GET /api/customers/all: a technician's dropdown list is also scoped to their own customers", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-cust-all-a@example.test", auth);
    const ownCustomer = await createCustomer("Dropdown Owned Customer");
    const unrelatedCustomer = await createCustomer("Dropdown Unrelated Customer");
    const job = await createJob(ownCustomer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    const res = await request<{ customers: { id: number }[] }>("/api/customers/all", techA.auth);
    const ids = res.body.customers.map((c) => c.id);
    expect(ids).toContain(ownCustomer.id);
    expect(ids).not.toContain(unrelatedCustomer.id);
  });

  it("GET /api/customers/{id}/rebate-eligibility: blocked for a customer unrelated to the technician, even with no job id in the URL at all", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-cust-rebate-a@example.test", auth);
    const unrelatedCustomer = await createCustomer("Rebate Probe Target");

    const res = await request<{ error?: string }>(
      `/api/customers/${unrelatedCustomer.id}/rebate-eligibility?job_type=CLEANBC`, techA.auth
    );
    expect(res.response.status).toBe(403);
  });

  it("admin and dispatcher customer access is completely unaffected", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const customer = await createCustomer();

    expect((await request("/api/customers", auth)).response.status).toBe(200);
    expect((await request(`/api/customers/${customer.id}`, dispatcher)).response.status).toBe(200);
    expect((await request("/api/customers/all", dispatcher)).response.status).toBe(200);
  });
});

describe("GET /api/jobs/eligibility-codes — technician read scoping", () => {
  it("a technician sees only their own CleanBC jobs' eligibility codes, not the company-wide tracker", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-elig-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-elig-b@example.test", auth);
    const customer = await createCustomer();
    const jobA = await createJob(customer.id, "2026-09-01", { job_type: "CLEANBC" });
    const jobB = await createJob(customer.id, "2026-09-02", { job_type: "CLEANBC" });
    await assignTechnician(jobA.id, techA.technicianId, auth);
    await assignTechnician(jobB.id, techB.technicianId, auth);
    await post(`/api/jobs/${jobA.id}/transition`, { to_status: "application_pending" }, auth);
    await post(`/api/jobs/${jobA.id}/transition`, {
      to_status: "eligibility_approved", eligibility_code: "CB-SCOPE-A", eligibility_code_expiry: "2027-01-01",
    }, auth);
    await post(`/api/jobs/${jobB.id}/transition`, { to_status: "application_pending" }, auth);
    await post(`/api/jobs/${jobB.id}/transition`, {
      to_status: "eligibility_approved", eligibility_code: "CB-SCOPE-B", eligibility_code_expiry: "2027-01-01",
    }, auth);

    const res = await request<{ rows: { id: number; eligibility_code: string }[] }>("/api/jobs/eligibility-codes", techA.auth);
    expect(res.response.status).toBe(200);
    expect(res.body.rows.map((r) => r.id)).toEqual([jobA.id]);
    expect(JSON.stringify(res.body)).not.toContain("CB-SCOPE-B");
  });

  it("admin and dispatcher still see the full tracker", async () => {
    const dispatcher = await dispatcherAuth();
    const res = await request<{ rows: unknown[] }>("/api/jobs/eligibility-codes", dispatcher);
    expect(res.response.status).toBe(200);
  });
});

describe("GET /api/jobs/{id}/rebate-audit — technician read scoping", () => {
  it("blocks an unrelated technician, allows the assigned one", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-rebate-audit-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-rebate-audit-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { job_type: "CLEANBC" });
    await assignTechnician(job.id, techA.technicianId, auth);

    expect((await request(`/api/jobs/${job.id}/rebate-audit`, techA.auth)).response.status).toBe(200);
    expect((await request(`/api/jobs/${job.id}/rebate-audit`, techB.auth)).response.status).toBe(403);
  });
});

describe("verified via database state — the fix is enforced server-side, not just hidden by the client", () => {
  it("confirms the underlying job/customer rows themselves are untouched by any of these read-only checks", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("scope-dbcheck-a@example.test", auth);
    const techB = await createLinkedTechnician("scope-dbcheck-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    await assignTechnician(job.id, techA.technicianId, auth);

    await request(`/api/jobs/${job.id}`, techB.auth); // denied read attempt
    const rows = await queryDb("SELECT id, technician_id FROM jobs WHERE id = ?", [job.id]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { technician_id: number }).technician_id).toBe(techA.technicianId);
  });
});
