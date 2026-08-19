import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  post, queryDb, request, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";

// Pre-Phase-7 security fix: GET /api/stats had zero RBAC — any authenticated
// role, including technician, received the full company-wide aggregate
// (job/customer/technician/service-type counts AND revenue/invoice
// financial totals). See mem:risks/technician-stats-financial-exposure.
// Every test here asserts actual response BODY values, not just status
// codes, and explicitly probes IDOR-style query-param manipulation.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface StatsBody {
  jobs: number; customers: number; technicians: number; service_types: number;
  today_jobs: number; upcoming_jobs: number; completed_jobs: number;
  revenue: number; invoices_outstanding: number; invoices_overdue: number;
}

async function dispatcherAuth(email = "dispatch-stats@example.test"): Promise<RequestInit> {
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

async function transition(jobId: number, toStatus: string, auth: RequestInit) {
  const res = await post(`/api/jobs/${jobId}/transition`, { to_status: toStatus }, auth);
  expect(res.response.status).toBe(200);
}

/** Walks a STANDARD job all the way to "completed" through the real
 *  workflow engine (never fabricates status/price directly) — this also
 *  triggers Phase 5's automatic invoice generation, giving both `revenue`
 *  and `invoices_outstanding` real non-zero company data to prove the
 *  technician response actually differs, not just "everyone gets 0". */
async function completeAssignedJob(customerId: number, technicianId: number, auth: RequestInit, price: number, todayDate: string) {
  const job = await createJob(customerId, todayDate, { price, technician_id: technicianId });
  await transition(job.id, "in_progress", auth);
  await satisfyCompletionRequirements(job.id, auth);
  await transition(job.id, "completed", auth);
  return job;
}

async function issueInvoiceForJob(jobId: number, auth: RequestInit) {
  const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [jobId]))[0].id;
  const issued = await post(`/api/invoices/${invId}/issue`, {}, auth);
  expect(issued.response.status).toBe(200);
}

const TODAY = new Date().toISOString().split("T")[0];

describe("GET /api/stats — role scoping", () => {
  it("admin and dispatcher receive the full company-wide aggregate, technicians do not", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const techA = await createLinkedTechnician("stats-tech-a@example.test", auth);
    const techB = await createLinkedTechnician("stats-tech-b@example.test", auth);
    const customer = await createCustomer();

    // Tech A: one completed+invoiced job (real revenue + invoice data), one
    // additional open job scheduled today.
    const completedJob = await completeAssignedJob(customer.id, techA.technicianId, auth, 150, TODAY);
    await issueInvoiceForJob(completedJob.id, auth);
    // A distinct time from completeAssignedJob's default 09:00/60min slot —
    // otherwise this would now correctly 409 as a real scheduling conflict
    // (Phase 7 — Advanced Scheduler).
    await createJob(customer.id, TODAY, { technician_id: techA.technicianId, scheduled_time: "14:00" });

    // Tech B: one unrelated job — must never appear in Tech A's counts.
    await createJob(customer.id, TODAY, { technician_id: techB.technicianId });

    const asAdmin = await request<StatsBody>("/api/stats", auth);
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body.jobs).toBe(3);
    expect(asAdmin.body.revenue).toBe(150);
    expect(asAdmin.body.invoices_outstanding).toBe(1);
    expect(asAdmin.body.technicians).toBe(2);

    const asDispatcher = await request<StatsBody>("/api/stats", dispatcher);
    expect(asDispatcher.response.status).toBe(200);
    expect(asDispatcher.body).toEqual(asAdmin.body);

    const asTechA = await request<StatsBody>("/api/stats", techA.auth);
    expect(asTechA.response.status).toBe(200);
    // Scoped-but-legitimate fields: only Tech A's own 2 jobs (1 completed + 1 open), not all 3.
    expect(asTechA.body.jobs).toBe(2);
    expect(asTechA.body.today_jobs).toBe(2);
    expect(asTechA.body.completed_jobs).toBe(1);
    expect(asTechA.body.customers).toBe(1);
    // Hard-zeroed fields: no financial access, ever — not even for their own job.
    expect(asTechA.body.revenue).toBe(0);
    expect(asTechA.body.invoices_outstanding).toBe(0);
    expect(asTechA.body.invoices_overdue).toBe(0);
    // Not used by any technician-facing UI — zeroed, not company-wide.
    expect(asTechA.body.technicians).toBe(0);
    expect(asTechA.body.service_types).toBe(0);

    const asTechB = await request<StatsBody>("/api/stats", techB.auth);
    expect(asTechB.body.jobs).toBe(1);
    expect(asTechB.body.jobs).not.toBe(asAdmin.body.jobs);
  });

  it("an unlinked technician (no technicians row) receives all zeros, not company-wide or another technician's data", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("stats-tech-linked@example.test", auth);
    const customer = await createCustomer();
    await completeAssignedJob(customer.id, techA.technicianId, auth, 200, TODAY);

    const unlinked = await unlinkedTechnicianAuth("stats-tech-unlinked@example.test");
    const res = await request<StatsBody>("/api/stats", unlinked);
    expect(res.response.status).toBe(200);
    expect(res.body).toEqual({
      jobs: 0, customers: 0, technicians: 0, service_types: 0,
      today_jobs: 0, upcoming_jobs: 0, completed_jobs: 0,
      revenue: 0, invoices_outstanding: 0, invoices_overdue: 0,
    });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request("/api/stats");
    expect(res.response.status).toBe(401);
  });

  it("IDOR: a technician cannot obtain company-wide or another technician's stats via query-string manipulation", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("stats-idor-a@example.test", auth);
    const techB = await createLinkedTechnician("stats-idor-b@example.test", auth);
    const customer = await createCustomer();
    await createJob(customer.id, TODAY, { technician_id: techA.technicianId });
    await createJob(customer.id, TODAY, { technician_id: techB.technicianId });

    const baseline = await request<StatsBody>("/api/stats", techA.auth);
    expect(baseline.body.jobs).toBe(1);

    // Attempt to smuggle another technician's id, a job id, and a role
    // override through the query string — none of these are (or should
    // ever become) real parameters this route reads; the actor's identity
    // must come only from the authenticated session.
    const attempts = [
      `/api/stats?technician_id=${techB.technicianId}`,
      `/api/stats?technician_id=${techB.technicianId}&role=admin`,
      "/api/stats?role=admin",
      "/api/stats?job_id=1&job_id=2&job_id=3",
    ];
    for (const path of attempts) {
      const res = await request<StatsBody>(path, techA.auth);
      expect(res.response.status).toBe(200);
      expect(res.body.jobs).toBe(1);
      expect(res.body.revenue).toBe(0);
      expect(res.body.invoices_outstanding).toBe(0);
    }
  });
});
