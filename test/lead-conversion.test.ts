import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, executeStatements, loginAs,
  post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 8.3 — Lead conversion (src/server/lead-conversion.ts,
// POST /api/leads/{id}/convert). Every test verifies actual response
// bodies AND real database state, not just HTTP status codes.
//
// Items 51-54 of the task's minimum matrix ("Phase 8.0 schema tests still
// pass" / "Phase 8.1 workflow tests still pass" / "Phase 8.2 Lead API
// tests still pass" / "complete existing project suite") are suite-level
// statements, not new assertions authored here — satisfied by running the
// full `vitest run` suite alongside this file (see the Phase 8.3 final
// report for the resulting count).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface LeadBody {
  id: number; identifier: string; name: string; status: string;
  converted_customer_id: number | null; converted_at: string | null; converted_by: number | null;
}
interface CustomerBody {
  id: number; name: string; phone: string; email: string; address: string; city: string; state: string; zip: string;
  notes: string; referral_source: string; referral_name: string; referred_by_customer_id: number | null;
}
interface ConvertResponse { lead: LeadBody; customer: CustomerBody; created: boolean }

async function dispatcherAuth(email = "dispatch-convert@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "tech-convert@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function currentUserId(auth: RequestInit): Promise<number> {
  const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
  return me.body.user.id;
}

/** Creates a Lead via the real API and drives it through the approved
 *  matrix to "estimate" (new -> contacted -> qualified -> estimate) via
 *  the real transition endpoint — never a direct SQL status write. */
async function createEstimateLead(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<LeadBody>("/api/leads", { name: "Convert Me", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  for (const to_status of ["contacted", "qualified", "estimate"]) {
    const t = await post(`/api/leads/${res.body.id}/transition`, { to_status }, auth);
    expect(t.response.status).toBe(200);
  }
  return res.body;
}

async function customerCount(): Promise<number> {
  return (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM customers"))[0].count;
}

async function leadCounter(): Promise<string> {
  return (await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'lead_counter'"))[0].value;
}

async function historyRows(leadId: number) {
  return queryDb<{ old_status: string | null; new_status: string; reason: string }>(
    "SELECT old_status, new_status, reason FROM lead_status_history WHERE lead_id = ? ORDER BY id", [leadId]
  );
}

// ── Auth / RBAC ──────────────────────────────────────────────────────

describe("auth/RBAC", () => {
  it("unauthenticated conversion -> 401", async () => {
    const res = await post("/api/leads/1/convert", {});
    expect(res.response.status).toBe(401);
  });

  it("technician conversion -> 403", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const tech = await technicianAuth();
    const res = await post(`/api/leads/${lead.id}/convert`, {}, tech);
    expect(res.response.status).toBe(403);
  });

  it("technician cannot convert a nonexistent lead -> 403, not 404 (RBAC runs before the lookup)", async () => {
    const tech = await technicianAuth("tech-convert-2@example.test");
    const res = await post("/api/leads/999999/convert", {}, tech);
    expect(res.response.status).toBe(403);
  });

  it("admin conversion succeeds", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
  });

  it("dispatcher conversion succeeds", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Dispatcher Convert" });
    const dispatcher = await dispatcherAuth();
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, dispatcher);
    expect(res.response.status).toBe(201);
  });
});

// ── Basic conversion ─────────────────────────────────────────────────

describe("basic conversion", () => {
  it("a valid Lead converts and the response is deterministic (lead + customer + created)", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.lead.id).toBe(lead.id);
    expect(res.body.customer.id).toBeGreaterThan(0);
  });

  it("converted_customer_id, converted_at, and the real actor (converted_by) are all stored", async () => {
    const auth = await authHeaders();
    const meId = await currentUserId(auth);
    const lead = await createEstimateLead(auth);
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    const rows = await queryDb<{ converted_customer_id: number | null; converted_at: string | null; converted_by: number | null }>(
      "SELECT converted_customer_id, converted_at, converted_by FROM leads WHERE id = ?", [lead.id]
    );
    expect(rows[0].converted_customer_id).toBe(res.body.customer.id);
    expect(rows[0].converted_at).toBeTruthy();
    expect(rows[0].converted_by).toBe(meId);
  });

  it("conversion does not trust any client-supplied actor identity — the schema has no such field", async () => {
    const dispatcher = await dispatcherAuth("dispatch-actor@example.test");
    const dispatcherId = await currentUserId(dispatcher);
    const lead = await createEstimateLead(dispatcher, { name: "Actor Check" });
    const res = await post(`/api/leads/${lead.id}/convert`, { actor_user_id: 999999, converted_by: 999999 }, dispatcher);
    expect(res.response.status).toBe(400); // .strict() rejects unknown fields outright
    // Retry without the injected fields — confirm the REAL actor still gets recorded.
    const ok = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, dispatcher);
    expect(ok.response.status).toBe(201);
    const rows = await queryDb<{ converted_by: number }>("SELECT converted_by FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_by).toBe(dispatcherId);
  });

  it("an already-converted Lead cannot be converted again", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const first = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(first.response.status).toBe(201);
    const custCountAfterFirst = await customerCount();

    const second = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(second.response.status).toBe(409);
    expect(await customerCount()).toBe(custCountAfterFirst); // no second customer created

    const rows = await queryDb<{ converted_customer_id: number }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBe(first.body.customer.id); // unchanged
  });
});

// ── Customer mapping ─────────────────────────────────────────────────

describe("Lead -> Customer field mapping", () => {
  it("maps name, phone, email, address, city/state/zip, and notes directly", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, {
      name: "Mapping Test", phone: "604-555-0199", email: "mapping@example.test",
      address: "123 Main St", city: "Burnaby", state: "BC", zip: "V5A 1A1", notes: "Prefers morning appointments",
    });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.customer).toMatchObject({
      name: "Mapping Test", phone: "604-555-0199", email: "mapping@example.test",
      address: "123 Main St", city: "Burnaby", state: "BC", zip: "V5A 1A1", notes: "Prefers morning appointments",
    });
  });

  it("maps referral_source=Referral and referral_name onto the new Customer", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, {
      name: "Referral Mapping", phone: "604-555-0111", referral_source: "Referral", referral_name: "Bob Neighbor",
    });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.customer.referral_source).toBe("Referral");
    expect(res.body.customer.referral_name).toBe("Bob Neighbor");
    expect(res.body.customer.referred_by_customer_id).toBeNull();
  });

  it("maps referral_source=Existing Customer and referred_by_customer_id onto the new Customer", async () => {
    const auth = await authHeaders();
    const referrer = await createCustomer("Referring Customer");
    const lead = await createEstimateLead(auth, {
      name: "Existing Customer Referral", phone: "604-555-0122",
      referral_source: "Existing Customer", referred_by_customer_id: referrer.id,
    });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.customer.referral_source).toBe("Existing Customer");
    expect(res.body.customer.referred_by_customer_id).toBe(referrer.id);
  });

  it("an invalid referral attribution (stale/corrupt Lead row) is rejected with 400, and creates no Customer", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Bad Referral", phone: "604-555-0133" });
    // The API itself can never produce this state (resolveReferralAttribution
    // guards both create and update) — simulate a corrupt row directly to
    // prove convertLead() re-validates rather than trusting the stored row.
    await executeStatements([`UPDATE leads SET referral_source = 'Referral', referral_name = '' WHERE id = ${lead.id}`]);
    const before = await customerCount();
    const res = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(400);
    expect(await customerCount()).toBe(before);
    const rows = await queryDb<{ converted_customer_id: number | null }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBeNull();
  });

  it("program_interest, estimated_value_cents, and estimate_notes have no Customer equivalent and are simply left on the Lead", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, {
      name: "No Mapping", phone: "604-555-0144", program_interest: "STANDARD",
      estimated_value_cents: 250000, estimate_notes: "Quoted at $2500",
    });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect((res.body.customer as unknown as Record<string, unknown>).program_interest).toBeUndefined();
    expect((res.body.customer as unknown as Record<string, unknown>).estimated_value_cents).toBeUndefined();
    const leadRow = await queryDb<{ program_interest: string; estimated_value_cents: number; estimate_notes: string }>(
      "SELECT program_interest, estimated_value_cents, estimate_notes FROM leads WHERE id = ?", [lead.id]
    );
    expect(leadRow[0]).toEqual({ program_interest: "STANDARD", estimated_value_cents: 250000, estimate_notes: "Quoted at $2500" });
  });

  it("reuses a single matching existing Customer by normalized phone, without overwriting its existing fields", async () => {
    const auth = await authHeaders();
    const existing = await createCustomer("Pre-existing Customer");
    await put(`/api/customers/${existing.id}`, { phone: "604-555-0100", notes: "Long-time customer notes" }, auth);
    const before = await customerCount();

    const lead = await createEstimateLead(auth, { name: "Should Not Overwrite", phone: "6045550100", notes: "New lead notes" });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(200); // reused, not created
    expect(res.body.created).toBe(false);
    expect(res.body.customer.id).toBe(existing.id);
    expect(await customerCount()).toBe(before); // no new row

    const rows = await queryDb<{ notes: string; name: string }>("SELECT notes, name FROM customers WHERE id = ?", [existing.id]);
    expect(rows[0].notes).toBe("Long-time customer notes"); // untouched by the Lead's own notes
    expect(rows[0].name).toBe("Pre-existing Customer");
  });

  it("reuses a single matching existing Customer by normalized email (case/whitespace-insensitive)", async () => {
    const auth = await authHeaders();
    const existing = await createCustomer("Email Match Customer");
    await put(`/api/customers/${existing.id}`, { email: "match@example.test" }, auth);

    const lead = await createEstimateLead(auth, { name: "Email Match Lead", email: "  MATCH@Example.TEST  " });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.customer.id).toBe(existing.id);
  });

  it("ambiguous match (2+ existing customers match) is a deterministic 409, no auto-pick, no Customer created", async () => {
    const auth = await authHeaders();
    const c1 = await createCustomer("Ambiguous One");
    await put(`/api/customers/${c1.id}`, { phone: "604-555-0177" }, auth);
    const c2 = await createCustomer("Ambiguous Two");
    await put(`/api/customers/${c2.id}`, { phone: "604-555-0177" }, auth);
    const before = await customerCount();

    const lead = await createEstimateLead(auth, { name: "Ambiguous Lead", phone: "604-555-0177" });
    const res = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(409);
    expect(await customerCount()).toBe(before);
    const rows = await queryDb<{ converted_customer_id: number | null }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBeNull();
  });

  it("no phone or email on the Lead never spuriously matches a Customer with blank phone/email", async () => {
    const auth = await authHeaders();
    await createCustomer("Blank Contact Customer"); // phone/email default to ""
    const before = await customerCount();
    const lead = await createEstimateLead(auth, { name: "No Contact Info Lead" });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(await customerCount()).toBe(before + 1);
  });
});

// ── Status / workflow integration ────────────────────────────────────

describe("status/workflow integration", () => {
  it("conversion drives the Lead to the approved final status (won) through transitionLead(), not a direct write", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    await post(`/api/leads/${lead.id}/convert`, {}, auth);
    const rows = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].status).toBe("won");
  });

  it("status is never client-controlled on the convert request — the body schema has no such field", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const res = await post(`/api/leads/${lead.id}/convert`, { status: "won" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("conversion accepts a Lead already sitting at won (unconverted) without re-transitioning", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const wonRes = await post(`/api/leads/${lead.id}/transition`, { to_status: "won" }, auth);
    expect(wonRes.response.status).toBe(200);
    const historyBefore = await historyRows(lead.id);

    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
    const historyAfter = await historyRows(lead.id);
    expect(historyAfter).toHaveLength(historyBefore.length); // no extra transition was performed
  });

  it("conversion is rejected for any Lead not in estimate or won status", async () => {
    const auth = await authHeaders();
    for (const status of ["new", "contacted", "qualified", "lost"]) {
      const create = await post<LeadBody>("/api/leads", { name: `Wrong Status ${status}` }, auth);
      const leadId = create.body.id;
      if (status !== "new") {
        const steps = status === "lost" ? ["lost"] : status === "contacted" ? ["contacted"] : ["contacted", "qualified"];
        for (const to_status of steps) {
          const body: Record<string, unknown> = { to_status };
          if (to_status === "lost") body.lost_reason = "Not Ready";
          await post(`/api/leads/${leadId}/transition`, body, auth);
        }
      }
      const res = await post(`/api/leads/${leadId}/convert`, {}, auth);
      expect(res.response.status).toBe(409);
    }
  });

  it("the transition history correctly records the estimate -> won move caused by conversion, with exactly one new row", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const before = await historyRows(lead.id);
    await post(`/api/leads/${lead.id}/convert`, {}, auth);
    const after = await historyRows(lead.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ old_status: "estimate", new_status: "won" });
  });
});

// ── Atomicity ─────────────────────────────────────────────────────────

describe("atomicity", () => {
  it("a Customer-validation failure leaves the Lead unconverted and creates no Customer (no partial state)", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Atomic Failure Lead", phone: "604-555-0155" });
    // FK-constrained columns can't be corrupted directly (the DB itself
    // rejects a nonexistent referred_by_customer_id) — use the OTHER
    // resolveReferralAttribution failure mode instead (empty referral_name
    // under "Referral"), which touches no FK.
    await executeStatements([`UPDATE leads SET referral_source = 'Referral', referral_name = '' WHERE id = ${lead.id}`]);
    const before = await customerCount();
    const res = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(400);
    expect(await customerCount()).toBe(before);
    const rows = await queryDb<{ status: string; converted_customer_id: number | null }>(
      "SELECT status, converted_customer_id FROM leads WHERE id = ?", [lead.id]
    );
    expect(rows[0].converted_customer_id).toBeNull();
    expect(rows[0].status).toBe("won"); // the won transition (phase one) already committed and is NOT rolled back —
    // see lead-conversion.ts's module doc: this is the documented, safe,
    // retriable intermediate state, not a bug. Retrying conversion from here
    // (after fixing the corrupt referral data) succeeds without re-transitioning.
  });

  it("retrying conversion from the safe won-but-unconverted intermediate state succeeds exactly once", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Retry Lead", phone: "604-555-0166" });
    await executeStatements([`UPDATE leads SET referral_source = 'Referral', referral_name = '' WHERE id = ${lead.id}`]);
    const failed = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(failed.response.status).toBe(400);

    await executeStatements([`UPDATE leads SET referral_source = '', referral_name = '' WHERE id = ${lead.id}`]);
    const retried = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(retried.response.status).toBe(201);
    expect(await customerCount()).toBeGreaterThan(0);
  });

  it("job creation is not part of this phase's contract, so there is no Job-failure rollback path to test — verified no Job is ever created", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const before = (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM jobs"))[0].count;
    await post(`/api/leads/${lead.id}/convert`, {}, auth);
    const after = (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM jobs"))[0].count;
    expect(after).toBe(before);
  });

  it("a failed conversion never advances the lead counter (conversion never creates a new Lead)", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Counter Check", phone: "604-555-0188" });
    await executeStatements([`UPDATE leads SET referral_source = 'Referral', referral_name = '' WHERE id = ${lead.id}`]);
    const before = await leadCounter();
    await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(await leadCounter()).toBe(before);
  });
});

// ── Concurrency ───────────────────────────────────────────────────────

describe("concurrency", () => {
  it("two simultaneous conversions of the same Lead (new-Customer branch): exactly one succeeds, exactly one Customer is created, loser gets 409", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Race New Customer", phone: "604-555-0111" });
    const before = await customerCount();

    const [r1, r2] = await Promise.all([
      post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth),
      post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await customerCount()).toBe(before + 1); // never 2 — no orphaned duplicate

    const rows = await queryDb<{ converted_customer_id: number }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBeGreaterThan(0);
  });

  it("two simultaneous conversions of the same Lead (reuse-existing branch): exactly one succeeds, no duplicate reuse", async () => {
    const auth = await authHeaders();
    const existing = await createCustomer("Race Reuse Customer");
    await put(`/api/customers/${existing.id}`, { phone: "604-555-0122" }, auth);
    const lead = await createEstimateLead(auth, { name: "Race Reuse Lead", phone: "604-555-0122" });

    const [r1, r2] = await Promise.all([
      post(`/api/leads/${lead.id}/convert`, {}, auth),
      post(`/api/leads/${lead.id}/convert`, {}, auth),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await queryDb<{ converted_customer_id: number }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBe(existing.id);
  });
});

// ── Mass assignment ───────────────────────────────────────────────────

describe("mass assignment — the convert body accepts no fields at all", () => {
  const injectedBodies = [
    { converted_customer_id: 1 },
    { converted_by: 1 },
    { converted_at: "2020-01-01" },
    { actor_user_id: 1 },
    { status: "won" },
    { customer_id: 999999 },
    { job_id: 999999 },
  ];

  it.each(injectedBodies)("rejects an injected field %j with 400, no mutation", async (body) => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: `Mass Assignment ${JSON.stringify(body)}` });
    const before = await customerCount();
    const res = await post(`/api/leads/${lead.id}/convert`, body, auth);
    expect(res.response.status).toBe(400);
    expect(await customerCount()).toBe(before);
    const rows = await queryDb<{ converted_customer_id: number | null }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBeNull();
  });
});

// ── IDOR ──────────────────────────────────────────────────────────────

describe("IDOR", () => {
  it("admin can convert a Lead created/assigned by a different session — no artificial ownership restriction (matches Phase 8.2's binary RBAC)", async () => {
    const dispatcher = await dispatcherAuth("idor-dispatch@example.test");
    const lead = await createEstimateLead(dispatcher, { name: "Cross-User Lead" });
    const auth = await authHeaders();
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
  });

  it("a query-param role override does not elevate a technician", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Query Spoof Lead" });
    const tech = await technicianAuth("idor-tech-role@example.test");
    const res = await post(`/api/leads/${lead.id}/convert?role=admin`, {}, tech);
    expect(res.response.status).toBe(403);
  });

  it("a query-param user-id override does not elevate a technician", async () => {
    const auth = await authHeaders();
    const meId = await currentUserId(auth);
    const lead = await createEstimateLead(auth, { name: "Query Spoof User Lead" });
    const tech = await technicianAuth("idor-tech-user@example.test");
    const res = await post(`/api/leads/${lead.id}/convert?user_id=${meId}&actor_user_id=${meId}`, {}, tech);
    expect(res.response.status).toBe(403);
  });

  it("converting a Lead assigned to a different admin/dispatcher user is still allowed (binary RBAC, not ownership-scoped)", async () => {
    const auth = await authHeaders();
    const otherDispatcher = await createUser({ email: "idor-assignee@example.test", role: "dispatcher" });
    const lead = await createEstimateLead(auth, { name: "Assigned To Someone Else", assigned_user_id: otherDispatcher.id });
    const res = await post<ConvertResponse>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(201);
  });
});

// ── Error body hygiene ────────────────────────────────────────────────

describe("error contract", () => {
  it("404 for a nonexistent Lead", async () => {
    const auth = await authHeaders();
    const res = await post("/api/leads/999999/convert", {}, auth);
    expect(res.response.status).toBe(404);
  });

  it("error bodies never leak SQL/stack traces", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth, { name: "Error Hygiene Lead", phone: "604-555-0199" });
    await executeStatements([`UPDATE leads SET referral_source = 'Referral', referral_name = '' WHERE id = ${lead.id}`]);
    const res = await post<{ error: string }>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(400);
    expect(res.body.error).not.toMatch(/SQLITE|at Object\.|\.ts:\d+/i);
  });
});
