import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  mockGoogleApi, post, put, queryDb, requestRaw, resetDatabase,
  type GoogleMock,
} from "./helpers.js";

// P0/P1 security fix (mem:risks/job-update-ownership-bypass): PUT
// /api/jobs/{id} previously only gated SCHEDULING_FIELDS for a technician
// actor — every other field (customer_id, price, notes, priority, address,
// completion_notes, is_recurring, recurrence_interval) had NO ownership or
// role check at all, letting any technician — even an unlinked one, even
// for a job they cannot even GET — rewrite any job's price, notes, or
// customer relationship. Live-confirmed against a real running server
// before this fix (see the risk memory). The fix traced every client call
// site and found zero legitimate technician use of this route at all, so
// the policy is now an unconditional technician block on the whole route,
// not a field-level allowlist or an ownership-scoped partial grant.
//
// Every test here verifies actual DATABASE state after a denied request,
// not just the HTTP status code, per the explicit requirement that an
// unauthorized PUT must leave the row (and any side-effect table) exactly
// as it was.

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

async function dispatcherAuth(email = "dispatch-jobupdate@example.test"): Promise<RequestInit> {
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

async function jobRow(jobId: number) {
  const rows = await queryDb<{
    customer_id: number; technician_id: number | null; price: number; notes: string;
    priority: string; address: string; scheduled_date: string; scheduled_time: string;
  }>("SELECT customer_id, technician_id, price, notes, priority, address, scheduled_date, scheduled_time FROM jobs WHERE id = ?", [jobId]);
  return rows[0];
}

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

describe("PUT /api/jobs/{id} — ownership bypass fix", () => {
  it("Test 1: Technician A cannot update Technician B's job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: techB.technicianId });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { notes: "tampered" }, techA.auth);
    expect(res.response.status).toBe(403);
    expect(await jobRow(job.id)).toEqual(before);
  });

  it("Test 2: Technician A cannot update an unassigned job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-unassigned@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { notes: "tampered" }, techA.auth);
    expect(res.response.status).toBe(403);
    expect(await jobRow(job.id)).toEqual(before);
  });

  it("Test 3: an unlinked technician cannot update any job", async () => {
    const unlinked = await unlinkedTechnicianAuth("owner-bypass-unlinked@example.test");
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { notes: "tampered" }, unlinked);
    expect(res.response.status).toBe(403);
    expect(await jobRow(job.id)).toEqual(before);
  });

  it("Test 4: Technician A cannot reassign Technician B's job to a different customer", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-customer-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-customer-b@example.test", auth);
    const customerOriginal = await createCustomer("Original Customer");
    const customerTarget = await createCustomer("Target Customer");
    const job = await createJob(customerOriginal.id, "2026-09-01", { technician_id: techB.technicianId });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { customer_id: customerTarget.id }, techA.auth);
    expect(res.response.status).toBe(403);
    const after = await jobRow(job.id);
    expect(after).toEqual(before);
    expect(after.customer_id).toBe(customerOriginal.id);
  });

  it("Test 5: Technician A cannot modify the price on Technician B's job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-price-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-price-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: techB.technicianId, price: 250 });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { price: 0 }, techA.auth);
    expect(res.response.status).toBe(403);
    const after = await jobRow(job.id);
    expect(after).toEqual(before);
    expect(after.price).toBe(250);
  });

  it("Test 6: Technician A cannot modify the notes on Technician B's job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-notes-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-notes-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: techB.technicianId, notes: "original notes" });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { notes: "TAMPERED" }, techA.auth);
    expect(res.response.status).toBe(403);
    const after = await jobRow(job.id);
    expect(after).toEqual(before);
    expect(after.notes).toBe("original notes");
  });

  it("Test 7: Technician A cannot modify priority or address on Technician B's job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-priority-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-priority-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", {
      technician_id: techB.technicianId, priority: "low", address: "1 Original St",
    });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { priority: "urgent", address: "999 Tampered Ave" }, techA.auth);
    expect(res.response.status).toBe(403);
    const after = await jobRow(job.id);
    expect(after).toEqual(before);
    expect(after.priority).toBe("low");
    expect(after.address).toBe("1 Original St");
  });

  it("Test 8: Technician A cannot perform a scheduling mutation even on their OWN job — the ownership fix does not accidentally enable technician scheduling", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("owner-bypass-own-schedule@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: techA.technicianId });
    const before = await jobRow(job.id);

    const res = await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-09-05" }, techA.auth);
    expect(res.response.status).toBe(403);
    expect(await jobRow(job.id)).toEqual(before);
  });

  // Test 9 (technician performing a legitimate PUT mutation) intentionally
  // omitted — traced every client call site (job-detail.tsx,
  // schedule-edit-modal.tsx, technician mobile) and confirmed none of them
  // ever call PUT /api/jobs/{id} as a technician. No legitimate technician
  // use of this route exists to test; inventing one would contradict the
  // fix itself.

  it("Test 10: dispatcher can still update another technician's job — existing behavior unchanged", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const tech = await createLinkedTechnician("owner-bypass-disp-target@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: tech.technicianId });

    const res = await put(`/api/jobs/${job.id}`, { notes: "dispatcher note" }, dispatcher);
    expect(res.response.status).toBe(200);
    expect((await jobRow(job.id)).notes).toBe("dispatcher note");
  });

  it("Test 11: admin can still update another technician's job — existing behavior unchanged", async () => {
    const auth = await authHeaders();
    const tech = await createLinkedTechnician("owner-bypass-admin-target@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: tech.technicianId });

    const res = await put(`/api/jobs/${job.id}`, { notes: "admin note" }, auth);
    expect(res.response.status).toBe(200);
    expect((await jobRow(job.id)).notes).toBe("admin note");
  });

  it("Test 12: rejects an unauthenticated PUT", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");

    const res = await put(`/api/jobs/${job.id}`, { notes: "x" });
    expect(res.response.status).toBe(401);
  });
});

describe("PUT /api/jobs/{id} — mass assignment / workflow bypass regression (unchanged by this fix)", () => {
  it("still rejects an unrecognized field via the strict schema", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");

    const res = await put(`/api/jobs/${job.id}`, { actor_user_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
    expect((await jobRow(job.id)).notes).toBe("");
  });

  it("still rejects status injection — status can only change through /transition", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");

    const res = await put(`/api/jobs/${job.id}`, { status: "completed" }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ status: string }>("SELECT status FROM jobs WHERE id = ?", [job.id]);
    expect(rows[0].status).toBe("scheduled");
  });
});

describe("PUT /api/jobs/{id} — no side effects on a denied request", () => {
  it("a denied technician PUT triggers zero Calendar sync calls and writes no audit row; an authorized PUT still triggers exactly one", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);

    const techA = await createLinkedTechnician("owner-bypass-calendar-a@example.test", auth);
    const techB = await createLinkedTechnician("owner-bypass-calendar-b@example.test", auth);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { technician_id: techB.technicianId });
    expect(google.state.events.size).toBe(1); // the one Calendar event from job creation itself

    google.state.calls = [];
    const denied = await put(`/api/jobs/${job.id}`, { notes: "tampered" }, techA.auth);
    expect(denied.response.status).toBe(403);
    expect(google.state.calls.length).toBe(0);
    expect((await queryDb("SELECT * FROM job_schedule_history WHERE job_id = ?", [job.id])).length).toBe(0);

    google.state.calls = [];
    const authorized = await put(`/api/jobs/${job.id}`, { notes: "legit update" }, auth);
    expect(authorized.response.status).toBe(200);
    expect(google.state.calls.filter((c) => c.method === "PATCH").length).toBe(1);
  });
});
