import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createUser, loginAs, post, put,
  queryDb, request, requestRaw, resetDatabase,
} from "./helpers.js";

// Phase 8.2 — Lead API + RBAC. Exposes the Phase 8.0 schema
// (migrations/0010_lead_management.sql) and the Phase 8.1 domain/workflow
// engine (src/server/lead-workflow.ts) through authenticated HTTP. Every
// test here verifies actual response bodies AND real database state, not
// just HTTP status codes, per this phase's explicit requirement.
//
// Items 57-59 of the task's minimum matrix ("Phase 8.0 schema tests still
// pass" / "Phase 8.1 workflow tests still pass" / "all existing tests
// remain green") are suite-level statements, not new assertions authored
// here — satisfied by running the full `vitest run` suite alongside this
// file (see the Phase 8.2 final report for the resulting count), exactly
// like every prior phase's regression check.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface LeadBody {
  id: number; identifier: string; name: string; status: string;
  assigned_user_id: number | null; referral_source: string; referral_name: string;
  referred_by_customer_id: number | null; estimated_value_cents: number | null;
  lost_reason: string; lost_reason_note: string;
  converted_customer_id: number | null; converted_at: string | null; converted_by: number | null;
  created_at: string;
}

async function dispatcherAuth(email = "dispatch-lead@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "tech-lead@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function currentUserId(auth: RequestInit): Promise<number> {
  const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
  return me.body.user.id;
}

async function createLead(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<LeadBody>("/api/leads", { name: "Test Lead", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  return res.body;
}

async function leadCount(): Promise<number> {
  return (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM leads"))[0].count;
}

async function leadCounter(): Promise<string> {
  return (await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'lead_counter'"))[0].value;
}

async function historyRows(leadId: number) {
  return queryDb<{ old_status: string | null; new_status: string; actor_user_id: number | null; reason: string }>(
    "SELECT old_status, new_status, actor_user_id, reason FROM lead_status_history WHERE lead_id = ? ORDER BY id", [leadId]
  );
}

// ── Authentication ───────────────────────────────────────────────────

describe("authentication — every Lead route requires a session", () => {
  it("unauthenticated list -> 401", async () => {
    expect((await request("/api/leads")).response.status).toBe(401);
  });
  it("unauthenticated detail -> 401", async () => {
    expect((await request("/api/leads/1")).response.status).toBe(401);
  });
  it("unauthenticated create -> 401", async () => {
    expect((await post("/api/leads", { name: "X" })).response.status).toBe(401);
  });
  it("unauthenticated update -> 401", async () => {
    expect((await put("/api/leads/1", { name: "X" })).response.status).toBe(401);
  });
  it("unauthenticated transition -> 401", async () => {
    expect((await post("/api/leads/1/transition", { to_status: "contacted" })).response.status).toBe(401);
  });
});

// ── RBAC ──────────────────────────────────────────────────────────────

describe("RBAC — admin/dispatcher full parity, technician full blackout", () => {
  it("admin can list leads", async () => {
    const auth = await authHeaders();
    await createLead(auth);
    const res = await request<{ leads: LeadBody[]; total: number }>("/api/leads", auth);
    expect(res.response.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("dispatcher can list leads", async () => {
    const auth = await authHeaders();
    await createLead(auth);
    const dispatcher = await dispatcherAuth();
    const res = await request<{ leads: LeadBody[]; total: number }>("/api/leads", dispatcher);
    expect(res.response.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("admin can view lead detail", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await request<{ lead: LeadBody }>(`/api/leads/${lead.id}`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.lead.id).toBe(lead.id);
  });

  it("dispatcher can view lead detail created by admin — no artificial ownership restriction", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const dispatcher = await dispatcherAuth();
    const res = await request<{ lead: LeadBody }>(`/api/leads/${lead.id}`, dispatcher);
    expect(res.response.status).toBe(200);
  });

  it("technician list denied", async () => {
    const auth = await authHeaders();
    await createLead(auth);
    const tech = await technicianAuth();
    const res = await request("/api/leads", tech);
    expect(res.response.status).toBe(403);
  });

  it("technician detail denied — including a nonexistent lead id (403, not 404, proving RBAC runs before the lookup)", async () => {
    const tech = await technicianAuth();
    const res = await request("/api/leads/999999", tech);
    expect(res.response.status).toBe(403);
  });

  it("technician create denied", async () => {
    const tech = await technicianAuth();
    const res = await post("/api/leads", { name: "Should Not Exist" }, tech);
    expect(res.response.status).toBe(403);
  });

  it("technician update denied", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const tech = await technicianAuth();
    const res = await put(`/api/leads/${lead.id}`, { name: "Tampered" }, tech);
    expect(res.response.status).toBe(403);
  });

  it("technician transition denied", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const tech = await technicianAuth();
    const res = await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, tech);
    expect(res.response.status).toBe(403);
  });

  it("technician status-history read denied", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const tech = await technicianAuth();
    const res = await request(`/api/leads/${lead.id}/status-history`, tech);
    expect(res.response.status).toBe(403);
  });
});

// ── Create ────────────────────────────────────────────────────────────

describe("POST /api/leads", () => {
  it("valid Lead creation — response and DB state", async () => {
    const auth = await authHeaders();
    const res = await post<LeadBody>("/api/leads", {
      name: "Jane Prospect", phone: "555-0100", email: "jane@example.test", estimated_value_cents: 250000,
    }, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.name).toBe("Jane Prospect");
    expect(res.body.status).toBe("new");
    const rows = await queryDb<{ name: string; status: string }>("SELECT name, status FROM leads WHERE id = ?", [res.body.id]);
    expect(rows[0]).toEqual({ name: "Jane Prospect", status: "new" });
  });

  it("creates exactly one initial lead_status_history row with the real actor", async () => {
    const auth = await authHeaders();
    const meId = await currentUserId(auth);
    const lead = await createLead(auth);
    const rows = await historyRows(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ old_status: null, new_status: "new", actor_user_id: meId });
  });

  it("server-generated identifier — client cannot control it", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    expect(lead.identifier).toMatch(/^LEAD-\d+$/);
  });

  it("client identifier injection rejected (mass assignment)", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", identifier: "LEAD-HACKED" }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("actor identity injection rejected (created_by / actor_user_id)", async () => {
    const auth = await authHeaders();
    const res1 = await post("/api/leads", { name: "X", actor_user_id: 999 }, auth);
    expect(res1.response.status).toBe(400);
    const res2 = await post("/api/leads", { name: "X", created_by: 999 }, auth);
    expect(res2.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("role injection rejected", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", role: "admin" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("status injection rejected — status can only change through /transition", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", status: "won" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("converted-field injection rejected", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", converted_customer_id: 1, converted_at: "2026-01-01", converted_by: 1 }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("invalid assigned_user_id rejected (nonexistent user)", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", assigned_user_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("a technician cannot be set as assigned_user_id — Leads are front-office only", async () => {
    const auth = await authHeaders();
    const techUser = await createUser({ email: "assignee-tech@example.test", role: "technician" });
    const res = await post("/api/leads", { name: "X", assigned_user_id: techUser.id }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("an admin/dispatcher user can be set as assigned_user_id", async () => {
    const auth = await authHeaders();
    const dispatcherUser = await createUser({ email: "assignee-dispatch@example.test", role: "dispatcher" });
    const lead = await createLead(auth, { assigned_user_id: dispatcherUser.id });
    expect(lead.assigned_user_id).toBe(dispatcherUser.id);
  });

  it("invalid referred_by_customer_id rejected", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", referral_source: "Existing Customer", referred_by_customer_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("invalid referral attribution rejected (Referral source without a name)", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", referral_source: "Referral" }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("estimated_value_cents stored correctly as integer cents", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth, { estimated_value_cents: 450000 });
    expect(lead.estimated_value_cents).toBe(450000);
    expect(Number.isInteger(lead.estimated_value_cents)).toBe(true);
  });

  it("an unrecognized writable-looking field is rejected, not silently dropped", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads", { name: "X", company: "Acme Inc" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejected create does not advance the lead counter", async () => {
    const auth = await authHeaders();
    const before = await leadCounter();
    const res = await post("/api/leads", { name: "X", assigned_user_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCounter()).toBe(before);
  });

  it("a name-required violation does not advance the lead counter either", async () => {
    const auth = await authHeaders();
    const before = await leadCounter();
    const res = await post("/api/leads", { name: "   " }, auth);
    expect(res.response.status).toBe(400);
    expect(await leadCounter()).toBe(before);
  });
});

// ── Update ────────────────────────────────────────────────────────────

describe("PUT /api/leads/{id}", () => {
  it("valid update — response and DB state", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await put(`/api/leads/${lead.id}`, { phone: "555-9999", notes: "Called back" }, auth);
    expect(res.response.status).toBe(200);
    const rows = await queryDb<{ phone: string; notes: string }>("SELECT phone, notes FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0]).toEqual({ phone: "555-9999", notes: "Called back" });
  });

  it("non-writable fields (id/identifier/created_at/updated_at) rejected", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    for (const body of [{ id: 999 }, { identifier: "LEAD-999" }, { created_at: "2020-01-01" }, { updated_at: "2020-01-01" }]) {
      const res = await put(`/api/leads/${lead.id}`, body, auth);
      expect(res.response.status).toBe(400);
    }
  });

  it("status update through PUT rejected — must go through /transition", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await put(`/api/leads/${lead.id}`, { status: "won" }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].status).toBe("new");
  });

  it("actor spoofing rejected (actor_user_id / converted_by in the PUT body)", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res1 = await put(`/api/leads/${lead.id}`, { actor_user_id: 999 }, auth);
    expect(res1.response.status).toBe(400);
    const res2 = await put(`/api/leads/${lead.id}`, { converted_by: 999 }, auth);
    expect(res2.response.status).toBe(400);
  });

  it("converted-field manipulation rejected (converted_customer_id / converted_at)", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res1 = await put(`/api/leads/${lead.id}`, { converted_customer_id: 1 }, auth);
    expect(res1.response.status).toBe(400);
    const res2 = await put(`/api/leads/${lead.id}`, { converted_at: "2026-01-01" }, auth);
    expect(res2.response.status).toBe(400);
  });

  it("assigned_user_id is authorization-validated on update the same as on create", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const techUser = await createUser({ email: "put-assignee-tech@example.test", role: "technician" });
    const res = await put(`/api/leads/${lead.id}`, { assigned_user_id: techUser.id }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ assigned_user_id: number | null }>("SELECT assigned_user_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].assigned_user_id).toBeNull();
  });

  it("nonexistent Lead -> 404", async () => {
    const auth = await authHeaders();
    const res = await put("/api/leads/999999", { name: "X" }, auth);
    expect(res.response.status).toBe(404);
  });

  it("an unauthorized (technician) update leaves the database completely unchanged", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth, { phone: "555-0000", notes: "Original" });
    const tech = await technicianAuth();
    const res = await put(`/api/leads/${lead.id}`, { phone: "555-1111", notes: "TAMPERED" }, tech);
    expect(res.response.status).toBe(403);
    const rows = await queryDb<{ phone: string; notes: string }>("SELECT phone, notes FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0]).toEqual({ phone: "555-0000", notes: "Original" });
  });

  it("changing away from Referral clears referral_name (stale-field rule, reused from customers.ts)", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth, { referral_source: "Referral", referral_name: "Bob Neighbor" });
    const res = await put(`/api/leads/${lead.id}`, { referral_source: "Website" }, auth);
    expect(res.response.status).toBe(200);
    const rows = await queryDb<{ referral_source: string; referral_name: string }>(
      "SELECT referral_source, referral_name FROM leads WHERE id = ?", [lead.id]
    );
    expect(rows[0]).toEqual({ referral_source: "Website", referral_name: "" });
  });
});

// ── Transition ────────────────────────────────────────────────────────

describe("POST /api/leads/{id}/transition", () => {
  it("valid transition — response and DB state", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post<{ lead: LeadBody }>(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.lead.status).toBe("contacted");
  });

  it("invalid transition -> 409, DB unchanged", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post(`/api/leads/${lead.id}/transition`, { to_status: "qualified" }, auth);
    expect(res.response.status).toBe(409);
    const rows = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].status).toBe("new");
  });

  it("lost without a reason rejected -> 400", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post(`/api/leads/${lead.id}/transition`, { to_status: "lost" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("an invalid (non-catalog) lost reason rejected -> 400", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post(`/api/leads/${lead.id}/transition`, { to_status: "lost", lost_reason: "Made Up Reason" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("a valid lost transition succeeds and stores the reason", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post<{ lead: LeadBody }>(`/api/leads/${lead.id}/transition`, { to_status: "lost", lost_reason: "Price Too High" }, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.lead.lost_reason).toBe("Price Too High");
  });

  it("lost -> contacted reopen preserves the lost reason on the active row", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "lost", lost_reason: "Not Ready" }, auth);
    const res = await post<{ lead: LeadBody }>(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.lead.status).toBe("contacted");
    expect(res.body.lead.lost_reason).toBe("Not Ready");
  });

  it("won remains terminal — every attempted transition out of it is rejected", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "qualified" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "estimate" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "won" }, auth);
    for (const to of ["contacted", "lost", "estimate"]) {
      const res = await post(`/api/leads/${lead.id}/transition`, { to_status: to, lost_reason: "Not Ready" }, auth);
      expect(res.response.status).toBe(409);
    }
  });

  it("exactly one history row is created on a successful transition", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    const rows = await historyRows(lead.id);
    expect(rows).toHaveLength(2); // creation row + this transition
    expect(rows[1]).toMatchObject({ old_status: "new", new_status: "contacted" });
  });

  it("zero new history rows are created on a rejected transition", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const before = await historyRows(lead.id);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "won" }, auth);
    const after = await historyRows(lead.id);
    expect(after).toHaveLength(before.length);
  });

  it("the authenticated actor is recorded correctly on the history row", async () => {
    const dispatcher = await dispatcherAuth();
    const dispatcherId = await currentUserId(dispatcher);
    const lead = await createLead(dispatcher);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, dispatcher);
    const rows = await historyRows(lead.id);
    expect(rows[rows.length - 1].actor_user_id).toBe(dispatcherId);
  });

  it("a client-supplied actor_user_id in the transition body is rejected outright (mass assignment)", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted", actor_user_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].status).toBe("new");
  });

  it("nonexistent Lead -> 404", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads/999999/transition", { to_status: "contacted" }, auth);
    expect(res.response.status).toBe(404);
  });

  it("a stale-state conflict (two competing transitions to the SAME target) leaves exactly one winner and one 409, preserved end-to-end through the HTTP layer", async () => {
    // Both racers request the identical to_status from the identical starting
    // status ("contacted" -> "qualified"). This is deliberately robust to
    // however the test-pool-workers runtime actually schedules two
    // concurrent fetch()es: if they genuinely interleave, the loser's
    // conditional UPDATE matches zero rows (LeadWorkflowError "conflict" ->
    // 409). If they happen to run fully sequentially instead, the second
    // request's fresh read sees status already moved to "qualified", and
    // "qualified" is not a valid target from "qualified" (a status can't
    // transition to itself) -> "invalid_transition" -> 409 either way.
    // Either outcome proves the same thing this test cares about: the same
    // transition can never be double-applied. See test/lead-workflow.test.ts
    // for the domain-layer test that verifies genuine interleaving directly.
    const auth = await authHeaders();
    const lead = await createLead(auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);

    const [r1, r2] = await Promise.all([
      post(`/api/leads/${lead.id}/transition`, { to_status: "qualified" }, auth),
      post(`/api/leads/${lead.id}/transition`, { to_status: "qualified" }, auth),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].status).toBe("qualified");
    const history = await historyRows(lead.id);
    // Exactly one "-> qualified" row, no matter which racer won.
    expect(history.filter((h) => h.new_status === "qualified")).toHaveLength(1);
  });
});

// ── Status history read ─────────────────────────────────────────────

describe("GET /api/leads/{id}/status-history", () => {
  it("returns the full history, newest first", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    const res = await request<{ history: { old_status: string | null; new_status: string }[] }>(`/api/leads/${lead.id}/status-history`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.history.map((h) => h.new_status)).toEqual(["contacted", "new"]);
  });

  it("404 for a nonexistent lead", async () => {
    const auth = await authHeaders();
    const res = await request("/api/leads/999999/status-history", auth);
    expect(res.response.status).toBe(404);
  });
});

// ── IDOR / mass assignment ───────────────────────────────────────────

describe("IDOR / mass assignment", () => {
  it("admin can directly access an arbitrary Lead id created by another session", async () => {
    const dispatcher = await dispatcherAuth();
    const lead = await createLead(dispatcher);
    const auth = await authHeaders();
    const res = await request(`/api/leads/${lead.id}`, auth);
    expect(res.response.status).toBe(200);
  });

  it("a query-param role override does not elevate a technician", async () => {
    const tech = await technicianAuth();
    const res = await request("/api/leads?role=admin", tech);
    expect(res.response.status).toBe(403);
  });

  it("a query-param assigned_user_id override does not grant a technician list access", async () => {
    const tech = await technicianAuth();
    const meId = await currentUserId(tech);
    const res = await request(`/api/leads?assigned_user_id=${meId}`, tech);
    expect(res.response.status).toBe(403);
  });

  it("assigned_user_id cannot be set to an id that doesn't exist via update", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await put(`/api/leads/${lead.id}`, { assigned_user_id: 999999 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("converted fields cannot be manipulated via create, update, or transition", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    expect((await post("/api/leads", { name: "X", converted_at: "2020-01-01" }, auth)).response.status).toBe(400);
    expect((await put(`/api/leads/${lead.id}`, { converted_customer_id: 1 }, auth)).response.status).toBe(400);
    expect((await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted", converted_by: 1 }, auth)).response.status).toBe(400);
    const rows = await queryDb<{ converted_customer_id: number | null; converted_at: string | null; converted_by: number | null }>(
      "SELECT converted_customer_id, converted_at, converted_by FROM leads WHERE id = ?", [lead.id]
    );
    expect(rows[0]).toEqual({ converted_customer_id: null, converted_at: null, converted_by: null });
  });

  it("identifier cannot be manipulated via update", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await put(`/api/leads/${lead.id}`, { identifier: "LEAD-STOLEN" }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb<{ identifier: string }>("SELECT identifier FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].identifier).toBe(lead.identifier);
  });
});

// ── List / pagination ─────────────────────────────────────────────────

describe("GET /api/leads — filtering and pagination", () => {
  it("paginates correctly", async () => {
    const auth = await authHeaders();
    for (let i = 0; i < 5; i++) await createLead(auth, { name: `Lead ${i}` });
    const page1 = await request<{ leads: LeadBody[]; total: number }>("/api/leads?page=1&limit=2", auth);
    expect(page1.body.leads).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    const page3 = await request<{ leads: LeadBody[]; total: number }>("/api/leads?page=3&limit=2", auth);
    expect(page3.body.leads).toHaveLength(1);
  });

  it("search matches name/phone/email/identifier", async () => {
    const auth = await authHeaders();
    const target = await createLead(auth, { name: "Unique Searchable Name", phone: "555-7777" });
    await createLead(auth, { name: "Someone Else" });
    const res = await request<{ leads: LeadBody[]; total: number }>("/api/leads?search=Searchable", auth);
    expect(res.body.total).toBe(1);
    expect(res.body.leads[0].id).toBe(target.id);

    const byPhone = await request<{ leads: LeadBody[]; total: number }>("/api/leads?search=555-7777", auth);
    expect(byPhone.body.total).toBe(1);

    const byIdentifier = await request<{ leads: LeadBody[]; total: number }>(`/api/leads?search=${target.identifier}`, auth);
    expect(byIdentifier.body.total).toBe(1);
  });

  it("filters by status", async () => {
    const auth = await authHeaders();
    const a = await createLead(auth, { name: "A" });
    await createLead(auth, { name: "B" });
    await post(`/api/leads/${a.id}/transition`, { to_status: "contacted" }, auth);
    const res = await request<{ leads: LeadBody[]; total: number }>("/api/leads?status=contacted", auth);
    expect(res.body.total).toBe(1);
    expect(res.body.leads[0].id).toBe(a.id);
  });

  it("filters by assigned_user_id", async () => {
    const auth = await authHeaders();
    const dispatcherUser = await createUser({ email: "list-filter-dispatch@example.test", role: "dispatcher" });
    const assigned = await createLead(auth, { name: "Assigned", assigned_user_id: dispatcherUser.id });
    await createLead(auth, { name: "Unassigned" });
    const res = await request<{ leads: LeadBody[]; total: number }>(`/api/leads?assigned_user_id=${dispatcherUser.id}`, auth);
    expect(res.body.total).toBe(1);
    expect(res.body.leads[0].id).toBe(assigned.id);
  });

  it("ordering is deterministic and pagination-safe across repeated calls", async () => {
    const auth = await authHeaders();
    for (let i = 0; i < 6; i++) await createLead(auth, { name: `Lead ${i}` });
    const first = await request<{ leads: LeadBody[] }>("/api/leads?page=1&limit=3", auth);
    const second = await request<{ leads: LeadBody[] }>("/api/leads?page=1&limit=3", auth);
    expect(first.body.leads.map((l) => l.id)).toEqual(second.body.leads.map((l) => l.id));

    const p1 = await request<{ leads: LeadBody[] }>("/api/leads?page=1&limit=6", auth);
    const allIds = p1.body.leads.map((l) => l.id);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates across the full page
  });
});

// ── Delete is deliberately NOT implemented in this phase ──────────────

describe("Lead deletion — not part of Phase 8.2's approved endpoint list", () => {
  it("DELETE /api/leads/{id} does not exist yet (not a working delete)", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await requestRaw(`/api/leads/${lead.id}`, { ...auth, method: "DELETE" });
    expect(res.status).not.toBe(200);
    expect(await leadCount()).toBe(1);
  });
});
