import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, loginAs,
  mockGoogleApi, post, put, queryDb, request, resetDatabase, type GoogleMock,
} from "./helpers.js";

// Phase 8.5 — Lead security & data-integrity sweep. Deliberately NOT a
// re-run of every RBAC/IDOR/mass-assignment case already covered
// per-route in test/lead-api.test.ts (68 tests) and
// test/lead-conversion.test.ts (42 tests) — this file focuses on
// cross-cutting attack scenarios and the genuinely new surface this phase
// touched: the GET /api/users/assignable endpoint, the atomic Lead
// identifier counter, and edge cases those two existing files didn't
// already exercise (a deleted referring customer surfacing during
// conversion, an ambiguous-match-specific phase-two failure and recovery,
// and explicit Calendar/Financial non-coupling proof).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface LeadBody {
  id: number; identifier: string; status: string; converted_customer_id: number | null;
}

async function dispatcherAuth(email = "dispatch-sec@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "tech-sec@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createEstimateLead(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<LeadBody>("/api/leads", { name: "Sec Test Lead", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  for (const to_status of ["contacted", "qualified", "estimate"]) {
    const t = await post(`/api/leads/${res.body.id}/transition`, { to_status }, auth);
    expect(t.response.status).toBe(200);
  }
  return res.body;
}

// ── Full-route RBAC matrix, consolidated ────────────────────────────────

describe("technician is denied on every Lead route, no exceptions", () => {
  it("blocks list/detail/history/create/update/transition/convert", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    const tech = await technicianAuth();

    const attempts: Promise<{ response: Response }>[] = [
      request(`/api/leads`, tech),
      request(`/api/leads/${lead.id}`, tech),
      request(`/api/leads/${lead.id}/status-history`, tech),
      post(`/api/leads`, { name: "X" }, tech),
      put(`/api/leads/${lead.id}`, { name: "X" }, tech),
      post(`/api/leads/${lead.id}/transition`, { to_status: "won" }, tech),
      post(`/api/leads/${lead.id}/convert`, {}, tech),
    ];
    const results = await Promise.all(attempts);
    for (const r of results) expect(r.response.status).toBe(403);
  });

  it("blocks the same 7 routes for an unauthenticated caller with 401", async () => {
    const results = await Promise.all([
      request(`/api/leads`),
      request(`/api/leads/1`),
      request(`/api/leads/1/status-history`),
      post(`/api/leads`, { name: "X" }),
      put(`/api/leads/1`, { name: "X" }),
      post(`/api/leads/1/transition`, { to_status: "won" }),
      post(`/api/leads/1/convert`, {}),
    ]);
    for (const r of results) expect(r.response.status).toBe(401);
  });
});

// ── GET /api/users/assignable (Phase 8.5 fix) ────────────────────────────

describe("GET /api/users/assignable", () => {
  it("unauthenticated -> 401", async () => {
    expect((await request("/api/users/assignable")).response.status).toBe(401);
  });

  it("admin can list assignable users", async () => {
    const auth = await authHeaders();
    const res = await request<{ users: { id: number; name: string; role: string }[] }>("/api/users/assignable", auth);
    expect(res.response.status).toBe(200);
    expect(res.body.users.some((u) => u.role === "admin")).toBe(true);
  });

  it("dispatcher can list assignable users — this is the actual fix", async () => {
    const dispatcher = await dispatcherAuth();
    const res = await request<{ users: { id: number; name: string; role: string }[] }>("/api/users/assignable", dispatcher);
    expect(res.response.status).toBe(200);
  });

  it("technician is denied", async () => {
    const tech = await technicianAuth();
    expect((await request("/api/users/assignable", tech)).response.status).toBe(403);
  });

  it("never returns a technician, and returns only id/name/role — no email, password_hash, active, or timestamps", async () => {
    await createUser({ email: "assignable-tech-check@example.test", role: "technician", name: "Should Never Appear" });
    const dispatcherUser = await createUser({ email: "assignable-dispatch-check@example.test", role: "dispatcher", name: "Should Appear" });
    const auth = await authHeaders();
    const res = await request<{ users: Record<string, unknown>[] }>("/api/users/assignable", auth);
    const names = res.body.users.map((u) => u.name);
    expect(names).not.toContain("Should Never Appear");
    expect(names).toContain("Should Appear");

    const entry = res.body.users.find((u) => u.id === dispatcherUser.id)!;
    expect(Object.keys(entry).sort()).toEqual(["id", "name", "role"]);
  });
});

// ── Lead identifier counter concurrency ─────────────────────────────────

describe("Lead identifier counter — atomic UPDATE...RETURNING (Phase 8.5 fix)", () => {
  it("concurrent Lead creation never produces a duplicate or skipped identifier", async () => {
    const auth = await authHeaders();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post<LeadBody & { identifier: string }>("/api/leads", { name: `Concurrent ${i}` }, auth))
    );
    for (const r of results) expect(r.response.status).toBe(201);

    const identifiers = results.map((r) => r.body.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length); // no duplicates

    const numbers = identifiers.map((id) => parseInt(id.replace("LEAD-", ""), 10)).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // no gaps, no skips

    const counter = await queryDb<{ value: string }>("SELECT value FROM _meta WHERE key = 'lead_counter'");
    expect(counter[0].value).toBe("8");
  });
});

// ── Search parameter safety ─────────────────────────────────────────────

describe("GET /api/leads — query parameter safety", () => {
  it("a SQL-injection-shaped search string is treated as a literal, not executed", async () => {
    const auth = await authHeaders();
    await createEstimateLead(auth, { name: "Safe Lead" });
    const res = await request<{ leads: unknown[]; total: number }>(
      `/api/leads?search=${encodeURIComponent("'; DROP TABLE leads; --")}`, auth
    );
    expect(res.response.status).toBe(200);
    expect(res.body.total).toBe(0); // no match, table still intact for the next assertion
    const stillThere = await request<{ leads: unknown[]; total: number }>("/api/leads", auth);
    expect(stillThere.body.total).toBe(1);
  });

  it("a malformed page/limit does not crash the route", async () => {
    const auth = await authHeaders();
    const res = await request("/api/leads?page=not-a-number&limit=also-not-a-number", auth);
    expect(res.response.status).toBe(200);
  });
});

// ── Conversion edge cases not covered by Phase 8.3's own suite ─────────

describe("conversion — referring customer deleted before conversion", () => {
  it("fails loudly (400) rather than silently converting with broken referral data", async () => {
    const auth = await authHeaders();
    const referrer = await createCustomer("Will Be Deleted Referrer");
    const lead = await createEstimateLead(auth, {
      name: "Orphaned Referral Lead", referral_source: "Existing Customer", referred_by_customer_id: referrer.id,
    });

    // Deleting the referrer SET NULLs referred_by_customer_id but leaves
    // referral_source = "Existing Customer" — an inconsistent combination
    // resolveReferralAttribution() (reused unmodified) correctly rejects
    // rather than silently accepting.
    await request(`/api/customers/${referrer.id}`, { ...auth, method: "DELETE" });

    const res = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(res.response.status).toBe(400);

    const rows = await queryDb<{ converted_customer_id: number | null }>("SELECT converted_customer_id FROM leads WHERE id = ?", [lead.id]);
    expect(rows[0].converted_customer_id).toBeNull();
  });
});

describe("conversion — ambiguous-match phase-two failure leaves a safely-retriable won-unconverted Lead", () => {
  it("retrying after resolving the ambiguity (deleting one duplicate) succeeds exactly once", async () => {
    const auth = await authHeaders();
    const c1 = await createCustomer("Retry Amb One");
    await put(`/api/customers/${c1.id}`, { phone: "604-555-0900" }, auth);
    const c2 = await createCustomer("Retry Amb Two");
    await put(`/api/customers/${c2.id}`, { phone: "604-555-0900" }, auth);

    const lead = await createEstimateLead(auth, { name: "Retry Ambiguous Lead", phone: "604-555-0900" });
    const failed = await post(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(failed.response.status).toBe(409);

    const midState = await queryDb<{ status: string; converted_customer_id: number | null }>(
      "SELECT status, converted_customer_id FROM leads WHERE id = ?", [lead.id]
    );
    expect(midState[0].status).toBe("won"); // phase one already committed
    expect(midState[0].converted_customer_id).toBeNull(); // phase two correctly did not

    // Resolve the ambiguity by removing one duplicate, then retry.
    await request(`/api/customers/${c2.id}`, { ...auth, method: "DELETE" });
    const retried = await post<{ created: boolean; customer: { id: number } }>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(retried.response.status).toBe(200);
    expect(retried.body.customer.id).toBe(c1.id);

    const historyCount = await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM lead_status_history WHERE lead_id = ?", [lead.id]);
    // creation + 3 ordinary transitions + the phase-one estimate->won
    // transition (which DID commit before phase two hit the ambiguous
    // match) = 5. The retry must NOT add a 6th row — it skips phase one
    // entirely since the Lead is already "won".
    expect(historyCount[0].count).toBe(5);
  });
});

// ── Cross-domain boundary: no Calendar, no Financial coupling ──────────

describe("cross-domain isolation", () => {
  let google: GoogleMock;

  it("a full Lead lifecycle including conversion triggers zero Google Calendar calls", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    google.state.calls = [];

    const lead = await createEstimateLead(auth, { name: "No Calendar Lead" });
    await post(`/api/leads/${lead.id}/convert`, {}, auth);

    expect(google.state.calls).toHaveLength(0);
    google.restore();
  });

  it("a full Lead lifecycle including conversion creates zero invoices, payments, or jobs", async () => {
    const auth = await authHeaders();
    const before = await queryDb<{ invoices: number; payments: number; jobs: number }>(
      "SELECT (SELECT COUNT(*) FROM invoices) as invoices, (SELECT COUNT(*) FROM payments) as payments, (SELECT COUNT(*) FROM jobs) as jobs"
    );

    const lead = await createEstimateLead(auth, { name: "No Financial Coupling Lead", estimated_value_cents: 999999 });
    await post(`/api/leads/${lead.id}/convert`, {}, auth);

    const after = await queryDb<{ invoices: number; payments: number; jobs: number }>(
      "SELECT (SELECT COUNT(*) FROM invoices) as invoices, (SELECT COUNT(*) FROM payments) as payments, (SELECT COUNT(*) FROM jobs) as jobs"
    );
    expect(after[0]).toEqual(before[0]);
  });
});

// ── Direct status-mutation search — statically confirmed, spot-checked here ──

describe("no route can write leads.status outside the workflow authority", () => {
  it("PUT with a status field is rejected regardless of the target Lead's current state", async () => {
    const auth = await authHeaders();
    const lead = await createEstimateLead(auth);
    for (const status of ["won", "lost", "new", "contacted", "qualified", "bogus_status"]) {
      const res = await put(`/api/leads/${lead.id}`, { status }, auth);
      expect(res.response.status).toBe(400);
    }
    const row = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [lead.id]);
    expect(row[0].status).toBe("estimate");
  });
});
