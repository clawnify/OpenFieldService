import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 7 — Advanced Scheduler. Covers server-side scheduling validation
// (date/time/duration format, technician existence/active status),
// conflict detection (hard 409, half-open-interval overlap, cancelled-job
// exclusion, self-exclusion on update), the job_schedule_history audit
// trail, RBAC (technician denied any scheduling mutation, admin/dispatcher
// parity), and confirmation that scheduling routes can never touch
// jobs.status. See mem:phase7/advanced-scheduler.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "dispatch-sched@example.test"): Promise<RequestInit> {
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

async function scheduledJob(
  customerId: number, technicianId: number | null, date: string, time: string, duration: number, auth: RequestInit
) {
  const res = await post<{ id: number }>("/api/jobs", {
    customer_id: customerId, technician_id: technicianId,
    scheduled_date: date, scheduled_time: time, duration,
  }, auth);
  return res;
}

describe("scheduling validation — server-side, both create and update", () => {
  it("rejects an invalid scheduled_date on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-02-30" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a malformed scheduled_date on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "not-a-date" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an invalid scheduled_time on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", scheduled_time: "25:00" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a non-positive duration on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", duration: 0 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a nonexistent technician_id on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", technician_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an inactive technician_id on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Inactive Tech" }, auth);
    expect(tech.response.status).toBe(201);
    const deactivate = await put(`/api/technicians/${tech.body.id}`, { active: 0 }, auth);
    expect(deactivate.response.status).toBe(200);

    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", technician_id: tech.body.id }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an invalid scheduled_date on update", async () => {
    const auth = await authHeaders();
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { scheduled_date: "13/40/2026" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a non-positive duration on update", async () => {
    const auth = await authHeaders();
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { duration: -30 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects reassigning to an inactive technician on update", async () => {
    const auth = await authHeaders();
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const tech = await post<{ id: number }>("/api/technicians", { name: "Inactive Tech 2" }, auth);
    await put(`/api/technicians/${tech.body.id}`, { active: 0 }, auth);
    const res = await put(`/api/jobs/${job.id}`, { technician_id: tech.body.id }, auth);
    expect(res.response.status).toBe(400);
  });

  it("does not re-validate an already-assigned (now-inactive) technician on an unrelated field edit", async () => {
    const auth = await authHeaders();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Later Inactive" }, auth);
    const job = await createJob((await createCustomer()).id, "2026-09-01", { technician_id: tech.body.id });
    await put(`/api/technicians/${tech.body.id}`, { active: 0 }, auth);

    const res = await put(`/api/jobs/${job.id}`, { notes: "unrelated edit" }, auth);
    expect(res.response.status).toBe(200);
  });

  it("does not accept an unusable phone-formatted duration or other malformed input silently", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await post("/api/jobs", { customer_id: customer.id, scheduled_date: "2026-09-01", duration: 1.5 }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("scheduling conflict detection — hard 409, half-open interval", () => {
  it("rejects an exact-overlap double-booking on create", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Conflict Tech" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);
    expect(res.response.status).toBe(409);
    const body = res.body as unknown as { error: string; conflict: { job_id: number } };
    expect(body.error).toMatch(/booked/i);
    expect(body.conflict.job_id).toBeGreaterThan(0);
  });

  it("rejects a partial overlap (10:00-11:00 vs 10:30-11:30)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Conflict Tech 2" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:30", 60, auth);
    expect(res.response.status).toBe(409);
  });

  it("rejects a fully-contained overlap (10:00-13:00 contains 11:00-12:00)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Conflict Tech 3" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 180, auth);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "11:00", 60, auth);
    expect(res.response.status).toBe(409);
  });

  it("allows back-to-back bookings (10:00-11:00 then 11:00-12:00) — half-open interval, not a conflict", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Back To Back Tech" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "11:00", 60, auth);
    expect(res.response.status).toBe(201);
  });

  it("does not conflict across different technicians", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techA = await post<{ id: number }>("/api/technicians", { name: "Tech A Diff" }, auth);
    const techB = await post<{ id: number }>("/api/technicians", { name: "Tech B Diff" }, auth);
    await scheduledJob(customer.id, techA.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await scheduledJob(customer.id, techB.body.id, "2026-09-01", "10:00", 60, auth);
    expect(res.response.status).toBe(201);
  });

  it("does not conflict across different dates", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Diff Date Tech" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-02", "10:00", 60, auth);
    expect(res.response.status).toBe(201);
  });

  it("excludes a cancelled job from conflict detection", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Cancelled Tech" }, auth);
    const first = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);
    const cancel = await post(`/api/jobs/${(first.body as { id: number }).id}/transition`, { to_status: "cancelled" }, auth);
    expect(cancel.response.status).toBe(200);

    const res = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);
    expect(res.response.status).toBe(201);
  });

  it("excludes the job being edited from its own conflict check on update", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Self Edit Tech" }, auth);
    const job = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);

    // Moving the SAME job's time by 15 minutes must not conflict with itself.
    const res = await put(`/api/jobs/${(job.body as { id: number }).id}`, { scheduled_time: "10:15" }, auth);
    expect(res.response.status).toBe(200);
  });

  it("rejects a conflict introduced via update (rescheduling job B onto job A's slot)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const tech = await post<{ id: number }>("/api/technicians", { name: "Update Conflict Tech" }, auth);
    await scheduledJob(customer.id, tech.body.id, "2026-09-01", "10:00", 60, auth);
    const jobB = await scheduledJob(customer.id, tech.body.id, "2026-09-01", "14:00", 60, auth);
    expect(jobB.response.status).toBe(201);

    const res = await put(`/api/jobs/${(jobB.body as { id: number }).id}`, { scheduled_time: "10:00" }, auth);
    expect(res.response.status).toBe(409);
    // Confirm the rejected update did not actually change the job's time.
    const rows = await queryDb<{ scheduled_time: string }>("SELECT scheduled_time FROM jobs WHERE id = ?", [(jobB.body as { id: number }).id]);
    expect(rows[0].scheduled_time).toBe("14:00");
  });

  it("rejects a conflict introduced by reassigning a technician onto an occupied slot", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techA = await post<{ id: number }>("/api/technicians", { name: "Reassign Tech A" }, auth);
    const techB = await post<{ id: number }>("/api/technicians", { name: "Reassign Tech B" }, auth);
    await scheduledJob(customer.id, techA.body.id, "2026-09-01", "10:00", 60, auth);
    const jobB = await scheduledJob(customer.id, techB.body.id, "2026-09-01", "10:00", 60, auth);

    const res = await put(`/api/jobs/${(jobB.body as { id: number }).id}`, { technician_id: techA.body.id }, auth);
    expect(res.response.status).toBe(409);
  });
});

describe("scheduling RBAC", () => {
  it("admin and dispatcher may reschedule any job; a technician may not touch any scheduling field, even their own job", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const techA = await createLinkedTechnician("sched-rbac-a@example.test", auth);
    const techB = await createLinkedTechnician("sched-rbac-b@example.test", auth);
    const customer = await createCustomer();
    const job = await scheduledJob(customer.id, techA.technicianId, "2026-09-01", "10:00", 60, auth);
    const jobId = (job.body as { id: number }).id;

    const asAdmin = await put(`/api/jobs/${jobId}`, { scheduled_time: "13:00" }, auth);
    expect(asAdmin.response.status).toBe(200);

    const asDispatcher = await put(`/api/jobs/${jobId}`, { scheduled_time: "14:00" }, dispatcher);
    expect(asDispatcher.response.status).toBe(200);

    const asOwnTech = await put(`/api/jobs/${jobId}`, { scheduled_time: "15:00" }, techA.auth);
    expect(asOwnTech.response.status).toBe(403);

    const asOtherTech = await put(`/api/jobs/${jobId}`, { technician_id: techB.technicianId }, techB.auth);
    expect(asOtherTech.response.status).toBe(403);

    const rows = await queryDb<{ scheduled_time: string; technician_id: number }>(
      "SELECT scheduled_time, technician_id FROM jobs WHERE id = ?", [jobId]
    );
    expect(rows[0].scheduled_time).toBe("14:00");
    expect(rows[0].technician_id).toBe(techA.technicianId);
  });

  it("an unlinked technician is denied the same as any other technician", async () => {
    const unlinked = await unlinkedTechnicianAuth("sched-rbac-unlinked@example.test");
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { scheduled_time: "13:00" }, unlinked);
    expect(res.response.status).toBe(403);
  });

  it("rejects an unauthenticated scheduling attempt", async () => {
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { scheduled_time: "13:00" });
    expect(res.response.status).toBe(401);
  });
});

describe("schedule audit trail (job_schedule_history)", () => {
  it("records old and new values, and the real session actor, on a scheduling change", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techA = await post<{ id: number }>("/api/technicians", { name: "Audit Tech A" }, auth);
    const techB = await post<{ id: number }>("/api/technicians", { name: "Audit Tech B" }, auth);
    const job = await scheduledJob(customer.id, techA.body.id, "2026-09-01", "10:00", 60, auth);
    const jobId = (job.body as { id: number }).id;

    const res = await put(`/api/jobs/${jobId}`, {
      technician_id: techB.body.id, scheduled_date: "2026-09-02", scheduled_time: "13:00", duration: 90,
    }, auth);
    expect(res.response.status).toBe(200);

    const rows = await queryDb<{
      old_technician_id: number; new_technician_id: number;
      old_scheduled_date: string; new_scheduled_date: string;
      old_scheduled_time: string; new_scheduled_time: string;
      old_duration: number; new_duration: number;
      actor_user_id: number;
    }>("SELECT * FROM job_schedule_history WHERE job_id = ?", [jobId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].old_technician_id).toBe(techA.body.id);
    expect(rows[0].new_technician_id).toBe(techB.body.id);
    expect(rows[0].old_scheduled_date).toBe("2026-09-01");
    expect(rows[0].new_scheduled_date).toBe("2026-09-02");
    expect(rows[0].old_scheduled_time).toBe("10:00");
    expect(rows[0].new_scheduled_time).toBe("13:00");
    expect(rows[0].old_duration).toBe(60);
    expect(rows[0].new_duration).toBe(90);
  });

  it("does NOT record a schedule-history row for an update that only touches unrelated fields", async () => {
    const auth = await authHeaders();
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { notes: "just a note", priority: "high" }, auth);
    expect(res.response.status).toBe(200);

    const rows = await queryDb("SELECT * FROM job_schedule_history WHERE job_id = ?", [job.id]);
    expect(rows).toHaveLength(0);
  });

  it("ignores a client-supplied actor_user_id — the real session user is always recorded", async () => {
    const auth = await authHeaders();
    const admin = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const job = await createJob((await createCustomer()).id, "2026-09-01");

    const res = await put(`/api/jobs/${job.id}`, { scheduled_time: "16:00", actor_user_id: 999999 }, auth);
    // The updateJob body schema is .strict() — an unrecognized key is rejected outright.
    expect(res.response.status).toBe(400);

    const legit = await put(`/api/jobs/${job.id}`, { scheduled_time: "16:00" }, auth);
    expect(legit.response.status).toBe(200);
    const rows = await queryDb<{ actor_user_id: number }>("SELECT actor_user_id FROM job_schedule_history WHERE job_id = ?", [job.id]);
    expect(rows[0].actor_user_id).toBe(admin.body.user.id);
  });
});

describe("workflow protection — scheduling routes can never change job status", () => {
  it("rejects a status field on PUT /api/jobs/{id}", async () => {
    const auth = await authHeaders();
    const job = await createJob((await createCustomer()).id, "2026-09-01");
    const res = await put(`/api/jobs/${job.id}`, { status: "completed" }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ status: string }>("SELECT status FROM jobs WHERE id = ?", [job.id]);
    expect(rows[0].status).toBe("scheduled");
  });
});
