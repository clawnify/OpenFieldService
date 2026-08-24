import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createSecondOrganization,
  createUser, del, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 12 — Quotes / Estimates Foundation. Covers CRUD, line items,
// totals/tax/discount computation, versioning/revisions and old-version
// immutability, lifecycle transitions (valid/invalid matrix), tenant
// isolation, RBAC, totals-tampering resistance, mass assignment, Customer/
// Lead/Asset reference safety, search/pagination, and concurrency. Mirrors
// assets.test.ts / tenant-isolation.test.ts's real-API-fixture-through-
// real-session discipline throughout.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface OrgContext {
  organizationId: number;
  auth: RequestInit;
}

async function orgA(): Promise<OrgContext> {
  return { organizationId: DEFAULT_ORGANIZATION_ID, auth: await authHeaders() };
}

async function orgB(): Promise<OrgContext> {
  const fixture = await createSecondOrganization("Org B Quotes Co");
  const { cookie } = await loginAs(fixture.email, fixture.password);
  return { organizationId: fixture.organizationId, auth: { headers: { cookie } } };
}

async function dispatcherAuth(email = "quote-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const userRes = await post<{ user: { id: number } }>("/api/users", {
    name: email, email, password: "TechPass123", role: "technician",
  }, adminAuth);
  expect(userRes.response.status).toBe(201);
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: userRes.body.user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: userRes.body.user.id, technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
}

async function makeCustomer(auth: RequestInit, name = "Quote Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "x@example.test", phone: "555-0100" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeLead(auth: RequestInit, name = "Quote Test Lead") {
  const res = await post<{ id: number }>("/api/leads", { name, phone: "555-0177", email: "lead@example.test" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeQuote(auth: RequestInit, customerId: number, overrides: Record<string, unknown> = {}) {
  const res = await post<{ quote: { id: number; identifier: string } }>("/api/quotes", {
    customer_id: customerId,
    line_items: [{ description: "Install furnace", category: "labor", quantity: 2, unit: "hr", unit_price_cents: 10000 }],
    ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body.quote;
}

describe("Quote CRUD", () => {
  it("admin creates a quote with initial line items and correct computed totals", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post<{ quote: { id: number; identifier: string; status: string } }>("/api/quotes", {
      customer_id: customerId,
      tax_rate: 10,
      line_items: [
        { description: "Furnace unit", category: "equipment", quantity: 1, unit: "ea", unit_price_cents: 500000 },
        { description: "Labor", category: "labor", quantity: 3, unit: "hr", unit_price_cents: 10000 },
      ],
    }, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.quote.identifier).toMatch(/^QUOTE-\d+$/);
    expect(res.body.quote.status).toBe("draft");

    const detail = await request<{ version: { subtotal_cents: number; tax_amount_cents: number; total_cents: number; line_items: unknown[] } }>(`/api/quotes/${res.body.quote.id}`, auth);
    expect(detail.response.status).toBe(200);
    // subtotal = 500000 + 3*10000 = 530000; tax 10% = 53000; total = 583000
    expect(detail.body.version.subtotal_cents).toBe(530000);
    expect(detail.body.version.tax_amount_cents).toBe(53000);
    expect(detail.body.version.total_cents).toBe(583000);
    expect(detail.body.version.line_items).toHaveLength(2);
  });

  it("dispatcher has the same CRUD access as admin", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(dispatcher, customerId);
    const detail = await request(`/api/quotes/${quote.id}`, dispatcher);
    expect(detail.response.status).toBe(200);
  });

  it("creating a quote under a nonexistent customer_id is rejected", async () => {
    const auth = await authHeaders();
    const res = await post("/api/quotes", { customer_id: 999999 }, auth);
    expect(res.response.status).toBe(404);
  });

  it("GET on an unknown quote id 404s", async () => {
    const auth = await authHeaders();
    const res = await request("/api/quotes/999999", auth);
    expect(res.response.status).toBe(404);
  });

  it("deletes a never-sent draft quote; refuses once it has transition history", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);

    const del1 = await del(`/api/quotes/${quote.id}`, auth);
    expect(del1.response.status).toBe(200);

    const quote2 = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote2.id}/transition`, { to_status: "sent" }, auth);
    const del2 = await del(`/api/quotes/${quote2.id}`, auth);
    expect(del2.response.status).toBe(409);
    const stillThere = await queryDb("SELECT id FROM quotes WHERE id = ?", [quote2.id]);
    expect(stillThere).toHaveLength(1);
  });
});

describe("Line items", () => {
  it("adds, updates, and deletes line items on a draft quote, recomputing totals each time", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId, { line_items: [] });

    const add = await post<{ version: { total_cents: number } }>(`/api/quotes/${quote.id}/line-items`, {
      description: "AC unit", category: "equipment", quantity: 1, unit: "ea", unit_price_cents: 200000,
    }, auth);
    expect(add.response.status).toBe(201);
    expect(add.body.version.total_cents).toBe(200000);

    const detail1 = await request<{ version: { line_items: { id: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const lineId = detail1.body.version.line_items[0].id;

    const updated = await put<{ version: { total_cents: number } }>(`/api/quotes/${quote.id}/line-items/${lineId}`, { quantity: 2 }, auth);
    expect(updated.response.status).toBe(200);
    expect(updated.body.version.total_cents).toBe(400000);

    const removed = await del<{ version: { total_cents: number; subtotal_cents: number } }>(`/api/quotes/${quote.id}/line-items/${lineId}`, auth);
    expect(removed.response.status).toBe(200);
    expect(removed.body.version.total_cents).toBe(0);
  });

  it("rejects line-item and version-metadata mutation once the quote leaves draft status", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    const detail = await request<{ version: { line_items: { id: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const lineId = detail.body.version.line_items[0].id;
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);

    const add = await post(`/api/quotes/${quote.id}/line-items`, { description: "x", quantity: 1, unit_price_cents: 100 }, auth);
    expect(add.response.status).toBe(409);
    const update = await put(`/api/quotes/${quote.id}/line-items/${lineId}`, { quantity: 5 }, auth);
    expect(update.response.status).toBe(409);
    const remove = await del(`/api/quotes/${quote.id}/line-items/${lineId}`, auth);
    expect(remove.response.status).toBe(409);
    const version = await put(`/api/quotes/${quote.id}/version`, { notes: "changed" }, auth);
    expect(version.response.status).toBe(409);
  });

  it("an unrecognized line-item category is rejected at the API boundary (400), not silently coerced", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    // The .strict() schema's z.enum() validates category before quotes.ts's
    // own normalizeLineItem()-level "fall back to other" defaulting is ever
    // reached — that fallback exists for defense-in-depth at the data layer,
    // not as a client-facing behavior.
    const res = await post("/api/quotes", { customer_id: customerId, line_items: [{ description: "x", category: "not_a_real_category", quantity: 1, unit_price_cents: 100 }] }, auth);
    expect(res.response.status).toBe(400);
  });

  it("a negative or zero quantity, or a negative unit price, is rejected — never silently drives the total negative", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const negQty = await post("/api/quotes", { customer_id: customerId, line_items: [{ description: "x", quantity: -1, unit_price_cents: 5000 }] }, auth);
    expect(negQty.response.status).toBe(400);
    const zeroQty = await post("/api/quotes", { customer_id: customerId, line_items: [{ description: "x", quantity: 0, unit_price_cents: 5000 }] }, auth);
    expect(zeroQty.response.status).toBe(400);
    const negPrice = await post("/api/quotes", { customer_id: customerId, line_items: [{ description: "x", quantity: 1, unit_price_cents: -5000 }] }, auth);
    expect(negPrice.response.status).toBe(400);
  });
});

describe("Totals / tax / discount", () => {
  it("computes a percent discount correctly and taxes the post-discount subtotal", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post<{ quote: { id: number } }>("/api/quotes", {
      customer_id: customerId,
      discount_type: "percent", discount_percent: 10, tax_rate: 5,
      line_items: [{ description: "x", quantity: 1, unit_price_cents: 100000 }],
    }, auth);
    const detail = await request<{ version: { subtotal_cents: number; discount_cents: number; tax_amount_cents: number; total_cents: number } }>(`/api/quotes/${res.body.quote.id}`, auth);
    // subtotal 100000, discount 10% = 10000, discounted 90000, tax 5% = 4500, total 94500
    expect(detail.body.version.subtotal_cents).toBe(100000);
    expect(detail.body.version.discount_cents).toBe(10000);
    expect(detail.body.version.tax_amount_cents).toBe(4500);
    expect(detail.body.version.total_cents).toBe(94500);
  });

  it("a fixed discount larger than the subtotal is capped, never producing a negative total", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post<{ quote: { id: number } }>("/api/quotes", {
      customer_id: customerId,
      discount_type: "fixed", discount_cents: 999999,
      line_items: [{ description: "x", quantity: 1, unit_price_cents: 5000 }],
    }, auth);
    const detail = await request<{ version: { discount_cents: number; total_cents: number } }>(`/api/quotes/${res.body.quote.id}`, auth);
    expect(detail.body.version.discount_cents).toBe(5000);
    expect(detail.body.version.total_cents).toBe(0);
  });

  it("client-supplied totals fields are rejected as mass assignment, not silently used", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/quotes", {
      customer_id: customerId, total_cents: 1, subtotal_cents: 1, tax_amount_cents: 1,
      line_items: [{ description: "x", quantity: 1, unit_price_cents: 100000 }],
    }, auth);
    expect(res.response.status).toBe(400);
  });

  it("organization_id, version_number, and accepted_by cannot be set via any write route", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const create = await post("/api/quotes", { customer_id: customerId, organization_id: 999 }, auth);
    expect(create.response.status).toBe(400);
    const quote = await makeQuote(auth, customerId);
    const updateVersion = await put(`/api/quotes/${quote.id}/version`, { version_number: 99, accepted_by: 1 }, auth);
    expect(updateVersion.response.status).toBe(400);
  });

  it("accepted_version_id cannot be set via the transition route", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    const res = await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent", accepted_version_id: 999 }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Versioning / revisions", () => {
  it("creates a revision, copying line items, and the OLD version's stored totals never change afterward", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId, { line_items: [{ description: "x", quantity: 1, unit_price_cents: 100000 }] });
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);

    const v1Before = await request<{ version: { total_cents: number; version_number: number } }>(`/api/quotes/${quote.id}/versions/1`, auth);
    expect(v1Before.body.version.version_number).toBe(1);
    expect(v1Before.body.version.total_cents).toBe(100000);

    const revision = await post<{ version: { id: number; version_number: number; total_cents: number } }>(`/api/quotes/${quote.id}/revisions`, {}, auth);
    expect(revision.response.status).toBe(201);
    expect(revision.body.version.version_number).toBe(2);
    expect(revision.body.version.total_cents).toBe(100000); // copied from v1

    // Quote status reset to draft by the revision.
    const quoteAfter = await request<{ quote: { status: string; current_version_id: number } }>(`/api/quotes/${quote.id}`, auth);
    expect(quoteAfter.body.quote.status).toBe("draft");
    expect(quoteAfter.body.quote.current_version_id).toBe(revision.body.version.id);

    // Now edit the NEW (v2) version's line items — v1 must be completely unaffected.
    const detail2 = await request<{ version: { line_items: { id: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const v2LineId = detail2.body.version.line_items[0].id;
    await put(`/api/quotes/${quote.id}/line-items/${v2LineId}`, { unit_price_cents: 500000 }, auth);

    const v1After = await request<{ version: { total_cents: number } }>(`/api/quotes/${quote.id}/versions/1`, auth);
    expect(v1After.body.version.total_cents).toBe(100000); // unchanged — immutable history
    const v2After = await request<{ version: { total_cents: number } }>(`/api/quotes/${quote.id}/versions/2`, auth);
    expect(v2After.body.version.total_cents).toBe(500000);

    const versions = await request<{ versions: { version_number: number }[] }>(`/api/quotes/${quote.id}/versions`, auth);
    expect(versions.body.versions.map((v) => v.version_number).sort()).toEqual([1, 2]);
  });

  it("cannot create a revision from draft (already editable) or accepted (terminal)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const draftQuote = await makeQuote(auth, customerId);
    const draftRev = await post(`/api/quotes/${draftQuote.id}/revisions`, {}, auth);
    expect(draftRev.response.status).toBe(409);

    const acceptedQuote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${acceptedQuote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${acceptedQuote.id}/transition`, { to_status: "accepted" }, auth);
    const acceptedRev = await post(`/api/quotes/${acceptedQuote.id}/revisions`, {}, auth);
    expect(acceptedRev.response.status).toBe(409);
  });

  it("a revision from a rejected quote reopens it to draft and preserves the rejection in status history", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "rejected", reason: "Too expensive" }, auth);

    const revision = await post(`/api/quotes/${quote.id}/revisions`, {}, auth);
    expect(revision.response.status).toBe(201);
    const quoteAfter = await request<{ quote: { status: string } }>(`/api/quotes/${quote.id}`, auth);
    expect(quoteAfter.body.quote.status).toBe("draft");

    const history = await request<{ history: { new_status: string; reason: string }[] }>(`/api/quotes/${quote.id}/status-history`, auth);
    expect(history.body.history.some((h) => h.new_status === "rejected" && h.reason === "Too expensive")).toBe(true);
  });

  it("accepted_version_id snapshots the version accepted at THAT moment, not always version 1", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    // quote_versions.id is a global auto-increment (not per-quote), so
    // capture v1's real id rather than assuming it happens to equal 1.
    const v1Id = (await request<{ quote: { current_version_id: number } }>(`/api/quotes/${quote.id}`, auth)).body.quote.current_version_id;

    // draft -> sent -> rejected -> revision (v2, draft) -> sent -> accepted.
    // A test that only ever accepts version 1 can't distinguish "genuinely
    // snapshotted at accept time" from "the API handler just echoes
    // current_version_id" — both would look identical when there's only
    // ever been one version. Forcing a SECOND version to exist before
    // acceptance is what actually proves the snapshot is real.
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "rejected", reason: "Not ready yet" }, auth);
    const revision = await post<{ version: { id: number; version_number: number } }>(`/api/quotes/${quote.id}/revisions`, {}, auth);
    expect(revision.response.status).toBe(201);
    expect(revision.body.version.version_number).toBe(2);

    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    const accepted = await post<{ quote: { accepted_version_id: number } }>(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.quote.accepted_version_id).toBe(revision.body.version.id);

    // And explicitly NOT version 1 — the actual regression this test guards.
    expect(accepted.body.quote.accepted_version_id).not.toBe(v1Id);
  });
});

describe("Lifecycle / status transitions", () => {
  it("valid transition matrix: draft->sent->accepted", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);

    const allowed1 = await request<{ allowed: string[] }>(`/api/quotes/${quote.id}/transitions`, auth);
    expect(allowed1.body.allowed.sort()).toEqual(["cancelled", "sent"].sort());

    const toSent = await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    expect(toSent.response.status).toBe(200);

    const toAccepted = await post<{ quote: { status: string; accepted_by: number; accepted_at: string; current_version_id: number; accepted_version_id: number } }>(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth);
    expect(toAccepted.response.status).toBe(200);
    expect(toAccepted.body.quote.status).toBe("accepted");
    expect(toAccepted.body.quote.accepted_by).not.toBeNull();
    expect(toAccepted.body.quote.accepted_at).not.toBeNull();
    // Phase 13 (Contracts/E-Sign) hardening: an EXPLICIT, permanent snapshot
    // of exactly which version was accepted, not just an inference from
    // current_version_id.
    expect(toAccepted.body.quote.accepted_version_id).toBe(toAccepted.body.quote.current_version_id);
  });

  it("rejects invalid transitions (no silent jumps): draft cannot go directly to accepted", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    const res = await post(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("accepted is fully terminal — no further transitions and no revision path", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth);

    const allowed = await request<{ allowed: string[]; can_create_revision: boolean }>(`/api/quotes/${quote.id}/transitions`, auth);
    expect(allowed.body.allowed).toEqual([]);
    expect(allowed.body.can_create_revision).toBe(false);

    const reject = await post(`/api/quotes/${quote.id}/transition`, { to_status: "rejected" }, auth);
    expect(reject.response.status).toBe(400);
  });

  it("rejecting or cancelling without a reason is rejected", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);
    const reject = await post(`/api/quotes/${quote.id}/transition`, { to_status: "rejected" }, auth);
    expect(reject.response.status).toBe(400);
    const cancel = await post(`/api/quotes/${quote.id}/transition`, { to_status: "cancelled" }, auth);
    expect(cancel.response.status).toBe(400);
  });

  it("cancelling with a reason is allowed from both draft and sent, and becomes terminal", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);

    const draftQuote = await makeQuote(auth, customerId);
    const cancelDraft = await post<{ quote: { status: string } }>(`/api/quotes/${draftQuote.id}/transition`, { to_status: "cancelled", reason: "No longer needed" }, auth);
    expect(cancelDraft.response.status).toBe(200);
    expect(cancelDraft.body.quote.status).toBe("cancelled");

    const sentQuote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${sentQuote.id}/transition`, { to_status: "sent" }, auth);
    const cancelSent = await post<{ quote: { status: string } }>(`/api/quotes/${sentQuote.id}/transition`, { to_status: "cancelled", reason: "Customer withdrew" }, auth);
    expect(cancelSent.response.status).toBe(200);
    expect(cancelSent.body.quote.status).toBe("cancelled");

    const allowed = await request<{ allowed: string[] }>(`/api/quotes/${sentQuote.id}/transitions`, auth);
    expect(allowed.body.allowed).toEqual([]);
  });

  it("rejected and expired are terminal to a bare transition — no further status changes", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);

    const rejectedQuote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${rejectedQuote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${rejectedQuote.id}/transition`, { to_status: "rejected", reason: "Too expensive" }, auth);
    const rejectedAllowed = await request<{ allowed: string[] }>(`/api/quotes/${rejectedQuote.id}/transitions`, auth);
    expect(rejectedAllowed.body.allowed).toEqual([]);
    const reopenRejected = await post(`/api/quotes/${rejectedQuote.id}/transition`, { to_status: "sent" }, auth);
    expect(reopenRejected.response.status).toBe(400);

    const expiredQuote = await makeQuote(auth, customerId);
    await put(`/api/quotes/${expiredQuote.id}/version`, { expires_at: "2020-01-01" }, auth);
    await post(`/api/quotes/${expiredQuote.id}/transition`, { to_status: "sent" }, auth);
    const expiredDirect = await post<{ quote: { status: string } }>(`/api/quotes/${expiredQuote.id}/transition`, { to_status: "expired", reason: "Past its date" }, auth);
    expect(expiredDirect.response.status).toBe(200);
    expect(expiredDirect.body.quote.status).toBe("expired");
    const expiredAllowed = await request<{ allowed: string[] }>(`/api/quotes/${expiredQuote.id}/transitions`, auth);
    expect(expiredAllowed.body.allowed).toEqual([]);
  });

  it("a quote past its expiry cannot be accepted — it is auto-transitioned to expired instead", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await put(`/api/quotes/${quote.id}/version`, { expires_at: "2020-01-01" }, auth);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);

    const accept = await post(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth);
    expect(accept.response.status).toBe(409);

    const quoteAfter = await request<{ quote: { status: string } }>(`/api/quotes/${quote.id}`, auth);
    expect(quoteAfter.body.quote.status).toBe("expired");
  });
});

describe("Concurrency", () => {
  it("two simultaneous transitions from the same status: exactly one succeeds, the other gets a clean 409 conflict", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);

    const [a, b] = await Promise.all([
      post(`/api/quotes/${quote.id}/transition`, { to_status: "accepted" }, auth),
      post(`/api/quotes/${quote.id}/transition`, { to_status: "rejected", reason: "no" }, auth),
    ]);
    const statuses = [a.response.status, b.response.status].sort((x, y) => x - y);
    // Exactly one of the two competing transitions succeeds (200) — sorts
    // first since it's numerically smallest. The loser gets either a clean
    // 409 conflict (if the two requests genuinely interleaved — the
    // optimistic WHERE status=? guard caught a stale write) or a 400
    // invalid-transition (if they ran effectively sequentially in this
    // single-isolate test harness, so the loser's own read already saw the
    // winner's new — now terminal — status): both are safe, non-double-
    // applying outcomes: default.sort() is lexicographic, not numeric,
    // hence the explicit numeric comparator above.
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    const history = await queryDb("SELECT new_status FROM quote_status_history WHERE quote_id = ? AND new_status IN ('accepted','rejected')", [quote.id]);
    expect(history).toHaveLength(1);
  });

  it("two concurrent revision-creation attempts never produce a duplicate version_number", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, auth);

    // Genuinely race two revision-creation requests against the same sent
    // quote — not a single request racing against nothing. Both are
    // legal from "sent" (canCreateRevisionFrom), so only the UNIQUE(quote_id,
    // version_number) backstop (plus the resulting quote.status flip to
    // draft) can prevent a duplicate version_number.
    const [a, b] = await Promise.all([
      post(`/api/quotes/${quote.id}/revisions`, {}, auth),
      post(`/api/quotes/${quote.id}/revisions`, {}, auth),
    ]);
    const statuses = [a.response.status, b.response.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(201);
    // The loser either loses the UNIQUE-constraint race (400) or, if the two
    // requests ran effectively sequentially in this single-isolate harness,
    // fails canCreateRevisionFrom because the winner already reset the quote
    // to "draft" (409) — both are safe, non-duplicating outcomes.
    expect([400, 409]).toContain(statuses[1]);

    const versions = await queryDb<{ version_number: number }>("SELECT version_number FROM quote_versions WHERE quote_id = ?", [quote.id]);
    const numbers = versions.map((v) => v.version_number);
    expect(new Set(numbers).size).toBe(numbers.length); // no duplicates, UNIQUE(quote_id, version_number) holds
    expect(numbers.length).toBe(2); // exactly one revision was actually created
  });

  it("N concurrent line-item additions on the same draft version never produce a lost total-recompute (row_version CAS)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId, { line_items: [] });

    // All requests target the SAME version's totals-recompute path
    // (recomputeAndStoreVersionTotals) concurrently — before the
    // row_version compare-and-swap fix, a stale read-based write from one
    // request could overwrite a newer total from another (a lost update),
    // leaving the stored total reflecting only SOME of the new line items
    // even though every row was actually inserted.
    //
    // Honesty note (found during review): because every request here
    // follows an identical, equal-length await chain, Node/workerd's
    // Promise scheduling can interleave just 2 concurrent requests in
    // near-lockstep — which happens to converge to the correct total even
    // WITHOUT the CAS fix, making a 2-way race a weak, non-discriminating
    // regression test. Racing more participants (5, not 2) doesn't make
    // this fully deterministic (no mock/fault-injection seam exists in
    // this real-D1 test harness to force a guaranteed collision), but it
    // meaningfully raises the odds that at least one pair's read/write
    // genuinely interleaves out of lockstep, so a regression is more
    // likely to be caught than not. Treat this as probabilistic evidence
    // reinforcing the code-level CAS guarantee, not a substitute for it.
    const prices = [10000, 25000, 5000, 12500, 30000];
    const results = await Promise.all(
      prices.map((cents, i) =>
        post<{ version: { total_cents: number } }>(`/api/quotes/${quote.id}/line-items`, { description: `Item ${i}`, quantity: 1, unit_price_cents: cents }, auth)
      )
    );
    for (const r of results) expect(r.response.status).toBe(201);

    // Every line item must exist — this is a lost-update check, not a
    // conflict-rejection check like the two tests above (unlike a status
    // transition or a revision, adding several DIFFERENT line items is not
    // a conflicting operation — all of them are legitimate and must all
    // survive).
    const detail = await request<{ version: { total_cents: number; subtotal_cents: number; line_items: { description: string }[] } }>(`/api/quotes/${quote.id}`, auth);
    expect(detail.body.version.line_items).toHaveLength(prices.length);
    // The critical assertion: the STORED total reflects EVERY item, not
    // just whichever request's stale read happened to run last.
    const expectedTotal = prices.reduce((sum, c) => sum + c, 0);
    expect(detail.body.version.subtotal_cents).toBe(expectedTotal);
    expect(detail.body.version.total_cents).toBe(expectedTotal);
  });
});

describe("RBAC", () => {
  it("a technician is blanket-blocked from every Quote route", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    const tech = await createLinkedTechnician("quote-rbac-tech@example.test", auth);

    expect((await request("/api/quotes", tech.auth)).response.status).toBe(403);
    expect((await request(`/api/quotes/${quote.id}`, tech.auth)).response.status).toBe(403);
    expect((await post("/api/quotes", { customer_id: customerId }, tech.auth)).response.status).toBe(403);
    expect((await put(`/api/quotes/${quote.id}/version`, { notes: "hacked" }, tech.auth)).response.status).toBe(403);
    expect((await post(`/api/quotes/${quote.id}/transition`, { to_status: "sent" }, tech.auth)).response.status).toBe(403);
    expect((await post(`/api/quotes/${quote.id}/revisions`, {}, tech.auth)).response.status).toBe(403);
    expect((await del(`/api/quotes/${quote.id}`, tech.auth)).response.status).toBe(403);

    const unchanged = await queryDb<{ status: string }>("SELECT status FROM quotes WHERE id = ?", [quote.id]);
    expect(unchanged[0].status).toBe("draft");
  });
});

describe("Customer / Lead reference safety", () => {
  it("a quote can optionally originate from a Lead in the same organization", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const leadId = await makeLead(auth);
    const quote = await makeQuote(auth, customerId, { lead_id: leadId });
    const detail = await request<{ quote: { lead_id: number; lead_identifier: string } }>(`/api/quotes/${quote.id}`, auth);
    expect(detail.body.quote.lead_id).toBe(leadId);
    expect(detail.body.quote.lead_identifier).toMatch(/^LEAD-\d+$/);
  });

  it("rejects a lead_id belonging to a nonexistent lead", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/quotes", { customer_id: customerId, lead_id: 999999 }, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Search / pagination", () => {
  it("filters by status, customer_id, and free-text search", async () => {
    const auth = await authHeaders();
    const customerA = await makeCustomer(auth, "Alpha Customer");
    const customerB = await makeCustomer(auth, "Beta Customer");
    const q1 = await makeQuote(auth, customerA);
    const q2 = await makeQuote(auth, customerB);
    await post(`/api/quotes/${q1.id}/transition`, { to_status: "sent" }, auth);

    const byCustomer = await request<{ quotes: { id: number }[] }>(`/api/quotes?customer_id=${customerA}`, auth);
    expect(byCustomer.body.quotes.map((q) => q.id)).toEqual([q1.id]);

    const byStatus = await request<{ quotes: { id: number }[] }>("/api/quotes?status=sent", auth);
    expect(byStatus.body.quotes.map((q) => q.id)).toEqual([q1.id]);

    const bySearch = await request<{ quotes: { id: number }[] }>(`/api/quotes?search=${encodeURIComponent(q2.identifier)}`, auth);
    expect(bySearch.body.quotes.map((q) => q.id)).toEqual([q2.id]);
  });

  it("respects limit/offset pagination", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    for (let i = 0; i < 5; i++) await makeQuote(auth, customerId);

    const page1 = await request<{ quotes: { id: number }[]; total: number }>("/api/quotes?limit=2&offset=0", auth);
    expect(page1.body.quotes).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(5);
  });

  it("rejects a wildcard-heavy search filter with a clean 400", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/quotes?search=${encodeURIComponent("%_".repeat(60))}`, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Tenant isolation — Quotes", () => {
  it("Org A cannot list, read, update, delete, revise, or transition Org B's quote", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");
    const bQuote = await makeQuote(b.auth, bCustomerId);
    await post(`/api/quotes/${bQuote.id}/transition`, { to_status: "sent" }, b.auth);

    const list = await request<{ quotes: { id: number }[] }>("/api/quotes?limit=200", a.auth);
    expect(list.body.quotes.find((q) => q.id === bQuote.id)).toBeUndefined();

    expect((await request(`/api/quotes/${bQuote.id}`, a.auth)).response.status).toBe(404);
    expect((await put(`/api/quotes/${bQuote.id}/version`, { notes: "hijacked" }, a.auth)).response.status).toBe(404);
    expect((await post(`/api/quotes/${bQuote.id}/revisions`, {}, a.auth)).response.status).toBe(404);
    expect((await post(`/api/quotes/${bQuote.id}/transition`, { to_status: "accepted" }, a.auth)).response.status).toBe(404);
    expect((await del(`/api/quotes/${bQuote.id}`, a.auth)).response.status).toBe(404);

    const stillThere = await queryDb<{ status: string }>("SELECT status FROM quotes WHERE id = ?", [bQuote.id]);
    expect(stillThere[0].status).toBe("sent"); // untouched
  });

  it("Org A cannot create a quote under Org B's customer or attach Org B's lead", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");
    const bLeadId = await makeLead(b.auth, "Org B Lead");

    const res1 = await post("/api/quotes", { customer_id: bCustomerId }, a.auth);
    expect(res1.response.status).toBe(404);

    const aCustomerId = await makeCustomer(a.auth, "Org A Customer");
    const res2 = await post("/api/quotes", { customer_id: aCustomerId, lead_id: bLeadId }, a.auth);
    expect(res2.response.status).toBe(404);

    const rows = await queryDb("SELECT id FROM quotes WHERE customer_id = ?", [bCustomerId]);
    expect(rows).toHaveLength(0);
  });

  it("no cross-org search/count leakage", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");
    await makeQuote(b.auth, bCustomerId);

    const listA = await request<{ quotes: unknown[]; total: number }>("/api/quotes?limit=200", a.auth);
    const listB = await request<{ quotes: unknown[]; total: number }>("/api/quotes?limit=200", b.auth);
    expect(listA.body.total).toBe(0);
    expect(listB.body.total).toBe(1);
  });
});

describe("Cross-customer safety (Asset line-item reference)", () => {
  it("a line item cannot reference an Asset belonging to a different customer", async () => {
    const auth = await authHeaders();
    const customerA = await makeCustomer(auth, "Customer A");
    const customerB = await makeCustomer(auth, "Customer B");
    const assetRes = await post<{ asset: { id: number } }>("/api/assets", { customer_id: customerB, asset_type: "FURNACE" }, auth);
    expect(assetRes.response.status).toBe(201);

    const res = await post("/api/quotes", {
      customer_id: customerA,
      line_items: [{ description: "Service existing unit", asset_id: assetRes.body.asset.id, quantity: 1, unit_price_cents: 10000 }],
    }, auth);
    expect(res.response.status).toBe(404);
  });

  it("a line item CAN reference an Asset belonging to the SAME customer", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetRes = await post<{ asset: { id: number } }>("/api/assets", { customer_id: customerId, asset_type: "FURNACE" }, auth);
    const res = await post<{ quote: { id: number } }>("/api/quotes", {
      customer_id: customerId,
      line_items: [{ description: "Service existing unit", asset_id: assetRes.body.asset.id, quantity: 1, unit_price_cents: 10000 }],
    }, auth);
    expect(res.response.status).toBe(201);
  });
});
