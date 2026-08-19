import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  mockGoogleApi, post, put, queryDb, request, requestRaw, resetDatabase, satisfyCompletionRequirements,
  type GoogleMock,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

let google: GoogleMock | undefined;
afterEach(() => {
  google?.restore();
  google = undefined;
});

async function transition(jobId: number, toStatus: string, init: RequestInit, extra: Record<string, unknown> = {}) {
  return post<{ job?: { status: string }; error?: string }>(
    `/api/jobs/${jobId}/transition`, { to_status: toStatus, ...extra }, init
  );
}

async function getJob(jobId: number, init: RequestInit) {
  const res = await request<{ job: { status: string; job_type: string; technician_id: number | null } }>(
    `/api/jobs/${jobId}`, init
  );
  return res.body.job;
}

async function assignTechnician(jobId: number, technicianId: number, init: RequestInit) {
  const res = await put(`/api/jobs/${jobId}`, { technician_id: technicianId }, init);
  expect(res.response.status).toBe(200);
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, cookie };
}

describe("STANDARD workflow", () => {
  it("walks the full happy path: scheduled -> in_progress -> completed -> invoiced", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    expect((await getJob(job.id, auth)).status).toBe("scheduled");

    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    const toInProgress = await transition(job.id, "in_progress", auth);
    expect(toInProgress.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("in_progress");

    await satisfyCompletionRequirements(job.id, auth);
    const toCompleted = await transition(job.id, "completed", auth);
    expect(toCompleted.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("completed");

    const toInvoiced = await transition(job.id, "invoiced", auth);
    expect(toInvoiced.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("invoiced");
  });

  it("rejects skipping a step (scheduled -> completed directly)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const result = await transition(job.id, "completed", auth);
    expect(result.response.status).toBe(409);
  });

  it("rejects an unknown target status", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const result = await transition(job.id, "not_a_real_status", auth);
    expect(result.response.status).toBe(409);
  });
});

async function createTechnicianRow(adminAuth: RequestInit) {
  const res = await post<{ id: number }>("/api/technicians", { name: "Unlinked Tech" }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body;
}

describe("CleanBC workflow", () => {
  it("walks the full happy path including the eligibility gate", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { job_type: "CLEANBC" });
    expect((await getJob(job.id, auth)).status).toBe("free_estimate");

    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    expect((await transition(job.id, "application_pending", auth)).response.status).toBe(200);

    const noCode = await transition(job.id, "eligibility_approved", auth);
    expect(noCode.response.status).toBe(400);

    const withCode = await transition(job.id, "eligibility_approved", auth, {
      eligibility_code: "CB-12345", eligibility_code_expiry: "2027-01-01",
    });
    expect(withCode.response.status).toBe(200);

    expect((await transition(job.id, "install_scheduled", auth)).response.status).toBe(200);
    expect((await transition(job.id, "in_progress", auth)).response.status).toBe(200);
    await satisfyCompletionRequirements(job.id, auth);
    expect((await transition(job.id, "completed", auth)).response.status).toBe(200);
    expect((await transition(job.id, "gov_portal_submitted", auth)).response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("gov_portal_submitted");
  });

  it("rejects application_pending -> eligibility_approved without a code (skipping isn't the only gate)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { job_type: "CLEANBC" });
    await transition(job.id, "application_pending", auth);

    const result = await transition(job.id, "eligibility_approved", auth, { eligibility_code: "CB-1" });
    expect(result.response.status).toBe(400); // expiry still missing
  });

  it("does not let a CleanBC job skip straight to eligibility_approved", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { job_type: "CLEANBC" });

    const result = await transition(job.id, "eligibility_approved", auth, {
      eligibility_code: "CB-1", eligibility_code_expiry: "2027-01-01",
    });
    expect(result.response.status).toBe(409);
  });
});

describe("BC Hydro workflow", () => {
  it("walks the full happy path (no eligibility pre-approval step)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { job_type: "BC_HYDRO" });
    expect((await getJob(job.id, auth)).status).toBe("free_estimate");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    expect((await transition(job.id, "install_scheduled", auth)).response.status).toBe(200);
    expect((await transition(job.id, "in_progress", auth)).response.status).toBe(200);
    await satisfyCompletionRequirements(job.id, auth);
    expect((await transition(job.id, "completed", auth)).response.status).toBe(200);
    expect((await transition(job.id, "gov_portal_submitted", auth)).response.status).toBe(200);
  });

  it("does not accept CleanBC-only statuses", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20", { job_type: "BC_HYDRO" });

    const result = await transition(job.id, "application_pending", auth);
    expect(result.response.status).toBe(409);
  });
});

describe("cancellation and reopen", () => {
  it("cancels from a non-terminal status and reopens back to the prior status", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);
    await transition(job.id, "in_progress", auth);

    const cancel = await transition(job.id, "cancelled", auth);
    expect(cancel.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("cancelled");

    const allowed = await request<{ allowed: string[] }>(`/api/jobs/${job.id}/transitions`, auth);
    expect(allowed.body.allowed).toEqual(["in_progress"]);

    const reopen = await transition(job.id, "in_progress", auth);
    expect(reopen.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("in_progress");
  });

  it("rejects cancelling a terminal job", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);
    await transition(job.id, "in_progress", auth);
    await satisfyCompletionRequirements(job.id, auth);
    await transition(job.id, "completed", auth);
    await transition(job.id, "invoiced", auth);

    const result = await transition(job.id, "cancelled", auth);
    expect(result.response.status).toBe(409);
  });
});

describe("canCompleteJob gate", () => {
  it("blocks completion until a technician is assigned, and unblocks once one is", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await transition(job.id, "in_progress", auth);

    const before = await request<{ allowed: boolean; requirements: { key: string; satisfied: boolean }[] }>(
      `/api/jobs/${job.id}/can-complete`, auth
    );
    expect(before.body.allowed).toBe(false);
    expect(before.body.requirements.find((r) => r.key === "technician_assigned")?.satisfied).toBe(false);

    const blocked = await transition(job.id, "completed", auth);
    expect(blocked.response.status).toBe(400);

    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);
    // Technician assignment alone isn't enough once Phase 4's compliance
    // requirements exist too — satisfy those as well before expecting `allowed`.
    await satisfyCompletionRequirements(job.id, auth);
    const after = await request<{ allowed: boolean }>(`/api/jobs/${job.id}/can-complete`, auth);
    expect(after.body.allowed).toBe(true);

    const unblocked = await transition(job.id, "completed", auth);
    expect(unblocked.response.status).toBe(200);
  });
});

describe("RBAC", () => {
  it("lets a dispatcher perform any valid transition on any job", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    await createUser({ email: "dispatch@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("dispatch@example.test", "DispatchPass1");

    const result = await transition(job.id, "in_progress", { headers: { cookie } });
    expect(result.response.status).toBe(200);
  });

  it("lets an assigned technician start and complete their own job, nothing else", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    const tech = await createLinkedTechnician("tech1@example.test", auth);
    await assignTechnician(job.id, tech.technicianId, auth);
    const techAuth: RequestInit = { headers: { cookie: tech.cookie } };

    const start = await transition(job.id, "in_progress", techAuth);
    expect(start.response.status).toBe(200);

    const cancelAttempt = await transition(job.id, "cancelled", techAuth);
    expect(cancelAttempt.response.status).toBe(403);

    await satisfyCompletionRequirements(job.id, techAuth);
    const complete = await transition(job.id, "completed", techAuth);
    expect(complete.response.status).toBe(200);
  });

  it("rejects a technician transitioning a job assigned to a different technician", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    const techA = await createLinkedTechnician("techA@example.test", auth);
    const techB = await createLinkedTechnician("techB@example.test", auth);
    await assignTechnician(job.id, techA.technicianId, auth);

    const result = await transition(job.id, "in_progress", { headers: { cookie: techB.cookie } });
    expect(result.response.status).toBe(403);
  });

  it("rejects a technician-role user with no linked technician profile", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await createUser({ email: "unlinked@example.test", password: "UnlinkedPass1", role: "technician" });
    const { cookie } = await loginAs("unlinked@example.test", "UnlinkedPass1");

    const result = await transition(job.id, "in_progress", { headers: { cookie } });
    expect(result.response.status).toBe(403);
  });

  it("rejects an unauthenticated transition attempt", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const result = await transition(job.id, "in_progress", {});
    expect(result.response.status).toBe(401);
  });
});

describe("schedule-edit protection", () => {
  // P0/P1 fix (mem:risks/job-update-ownership-bypass): this test used to
  // assert that a technician COULD successfully edit "ordinary" fields
  // (notes) on PUT /api/jobs/{id} — that was the vulnerability itself
  // encoded as expected behavior (the same class of mistake the read-
  // scoping fix found and rewrote two of, see
  // mem:risks/technician-job-read-scoping). No client code anywhere in this
  // codebase ever calls PUT /api/jobs/{id} on behalf of a technician actor
  // — there is no legitimate technician use of this route, ownership of
  // the job included — so the route now blocks a technician unconditionally,
  // even on their own assigned job, even for non-scheduling fields.
  it("blocks a technician from editing a job via PUT entirely, even their own job, even non-scheduling fields", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    const tech = await createLinkedTechnician("tech2@example.test", auth);
    await assignTechnician(job.id, tech.technicianId, auth);
    const techAuth: RequestInit = { headers: { cookie: tech.cookie } };

    const reschedule = await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-08-25" }, techAuth);
    expect(reschedule.response.status).toBe(403);

    const reassign = await put(`/api/jobs/${job.id}`, { technician_id: null }, techAuth);
    expect(reassign.response.status).toBe(403);

    const noteEdit = await put(`/api/jobs/${job.id}`, { notes: "on site" }, techAuth);
    expect(noteEdit.response.status).toBe(403);

    const rows = await queryDb<{ scheduled_date: string; notes: string }>(
      "SELECT scheduled_date, notes FROM jobs WHERE id = ?", [job.id]
    );
    expect(rows[0].scheduled_date).toBe("2026-08-20");
    expect(rows[0].notes).toBe("");
  });

  it("allows dispatchers and admins to edit schedule fields", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const result = await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-08-25" }, auth);
    expect(result.response.status).toBe(200);
    expect((await getJob(job.id, auth)).status).toBe("scheduled"); // unaffected
  });

  it("rejects status in the generic update endpoint — it cannot bypass the transition engine", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");

    const bypass = await put(`/api/jobs/${job.id}`, { status: "completed" } as unknown as Record<string, unknown>, auth);
    expect(bypass.response.status).toBe(400);
    expect((await getJob(job.id, auth)).status).toBe("scheduled");
  });
});

describe("transition history", () => {
  it("records every transition and never overwrites a prior entry", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    await transition(job.id, "in_progress", auth);
    await satisfyCompletionRequirements(job.id, auth);
    await transition(job.id, "completed", auth);
    await transition(job.id, "invoiced", auth);

    const history = await queryDb<{ from_status: string | null; to_status: string; actor_user_id: number }>(
      "SELECT from_status, to_status, actor_user_id FROM job_status_history WHERE job_id = ? ORDER BY id ASC", [job.id]
    );
    expect(history.map((h) => [h.from_status, h.to_status])).toEqual([
      [null, "scheduled"], // creation
      ["scheduled", "in_progress"],
      ["in_progress", "completed"],
      ["completed", "invoiced"],
    ]);
    expect(history.every((h) => h.actor_user_id === 1)).toBe(true); // admin (seeded id 1)
  });
});

/** Mirrors the connect helper in calendar-sync.test.ts — drives the full mocked
 *  OAuth round trip so the user ends up with a connected calendar_integrations row. */
async function connectGoogleCalendar(cookie: string) {
  const connectRes = await requestRaw("/api/integrations/google-calendar/connect", { headers: { cookie } });
  expect(connectRes.status).toBe(302);
  const authUrl = new URL(connectRes.headers.get("location")!);
  const state = authUrl.searchParams.get("state")!;
  const callbackRes = await requestRaw(
    `/api/integrations/google-calendar/callback?code=mock-auth-code&state=${state}`,
    { headers: { cookie } }
  );
  expect(callbackRes.status).toBe(302);
}

describe("Google Calendar regression: no duplicate events from a transition", () => {
  it("a single transition triggers exactly one sync call and never creates a duplicate event", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);

    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);
    expect(google.state.events.size).toBe(1); // created on job creation

    google.state.calls = [];
    const result = await transition(job.id, "in_progress", auth);
    expect(result.response.status).toBe(200);

    // Exactly one Google-side write for this transition — a PATCH to the existing
    // event, never a second POST (which would mean a duplicate event was created).
    const writeCalls = google.state.calls.filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].method).toBe("PATCH");
    expect(google.state.events.size).toBe(1); // still exactly one event for this job

    const mappings = await queryDb<{ external_event_id: string }>(
      "SELECT external_event_id FROM calendar_event_mappings WHERE job_id = ?", [job.id]
    );
    expect(mappings).toHaveLength(1); // one mapping row, not one per transition
  });

  it("PUT (ordinary field edit) and POST transition never both fire sync for the same request", async () => {
    // Regression guard for the double-sync failure mode: a status change must go
    // through /transition only, an ordinary-field edit through PUT only — never
    // both paths firing for what the user perceives as one action.
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-08-20");
    await assignTechnician(job.id, (await createTechnicianRow(auth)).id, auth);

    google.state.calls = [];
    await put(`/api/jobs/${job.id}`, { notes: "updated" }, auth);
    const afterPut = google.state.calls.filter((c) => c.method === "PATCH").length;
    expect(afterPut).toBe(1);

    google.state.calls = [];
    await transition(job.id, "in_progress", auth);
    const afterTransition = google.state.calls.filter((c) => c.method === "PATCH").length;
    expect(afterTransition).toBe(1);
  });
});
