import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calculateTaxes, validateTaxProfileInput, TaxJurisdictionError, type TaxProfile } from "../src/server/tax-jurisdiction.js";
import {
  authHeaders, createSecondOrganization, createUser, loginAs, post, request,
  resetDatabase, applySchema,
} from "./helpers.js";

// Phase 13D — Tax & Jurisdiction Settings.
//
// This file covers the calculation engine as pure unit tests (Section 20:
// minor-unit precision, per-component rounding, inclusive extraction,
// multi-component allocation, fractional-cent behavior, zero-subtotal,
// large amounts) plus the /api/tax-profile RBAC/tenant/validation surface.
// Historical-immutability acceptance (Quote/Contract/Invoice snapshot
// freezing) lives in test/quotes.test.ts, test/contracts.test.ts, and
// test/financial.test.ts alongside the rest of each domain's own suite —
// not duplicated here.

function profile(overrides: Partial<TaxProfile> = {}): TaxProfile {
  return {
    id: 1, organization_id: 1, tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD",
    prices_include_tax: false, default_taxable: true, effective_from: "2026-01-01T00:00:00.000Z", effective_until: null,
    created_by: null, created_at: "2026-01-01T00:00:00.000Z",
    components: [{ id: 1, code: "GST", name: "GST", rate_percent: 5 }, { id: 2, code: "PST", name: "PST", rate_percent: 7 }],
    ...overrides,
  };
}

describe("calculateTaxes (Section 20 — the one authoritative calculation)", () => {
  it("tax disabled (null profile) always yields zero tax, subtotal = total", () => {
    const r = calculateTaxes(null, [{ amountCents: 10000, taxable: true }]);
    expect(r.totalTaxCents).toBe(0);
    expect(r.components).toEqual([]);
    expect(r.subtotalCents).toBe(10000);
    expect(r.totalCents).toBe(10000);
  });

  it("tax_enabled: false on a real profile also yields zero tax", () => {
    const r = calculateTaxes(profile({ tax_enabled: false }), [{ amountCents: 10000, taxable: true }]);
    expect(r.totalTaxCents).toBe(0);
    expect(r.totalCents).toBe(10000);
  });

  it("a profile with zero components yields zero tax even if tax_enabled", () => {
    const r = calculateTaxes(profile({ components: [] }), [{ amountCents: 10000, taxable: true }]);
    expect(r.totalTaxCents).toBe(0);
  });

  it("single component (AB-style GST 5%), exclusive pricing", () => {
    const r = calculateTaxes(profile({ region_code: "AB", components: [{ id: 1, code: "GST", name: "GST", rate_percent: 5 }] }), [
      { amountCents: 10000, taxable: true },
    ]);
    expect(r.taxableBaseCents).toBe(10000);
    expect(r.totalTaxCents).toBe(500);
    expect(r.components).toEqual([{ code: "GST", name: "GST", rate_percent: 5, amount_cents: 500 }]);
    expect(r.subtotalCents).toBe(10000);
    expect(r.totalCents).toBe(10500);
  });

  it("multi-component (BC-style GST 5% + PST 7%), exclusive — components sum exactly to total tax", () => {
    const r = calculateTaxes(profile(), [{ amountCents: 10000, taxable: true }]);
    expect(r.totalTaxCents).toBe(1200); // 12% of 10000
    const gst = r.components.find((c) => c.code === "GST")!;
    const pst = r.components.find((c) => c.code === "PST")!;
    expect(gst.amount_cents + pst.amount_cents).toBe(r.totalTaxCents);
    expect(gst.amount_cents).toBe(500);
    expect(pst.amount_cents).toBe(700);
    expect(r.totalCents).toBe(11200);
  });

  it("ON-style single HST 13% component", () => {
    const r = calculateTaxes(profile({ region_code: "ON", components: [{ id: 1, code: "HST", name: "HST", rate_percent: 13 }] }), [
      { amountCents: 10000, taxable: true },
    ]);
    expect(r.totalTaxCents).toBe(1300);
    expect(r.totalCents).toBe(11300);
  });

  it("QC-style GST 5% + QST 9.975% — fractional rate, components still sum exactly", () => {
    const r = calculateTaxes(profile({ region_code: "QC", components: [
      { id: 1, code: "GST", name: "GST", rate_percent: 5 }, { id: 2, code: "QST", name: "QST", rate_percent: 9.975 },
    ] }), [{ amountCents: 10000, taxable: true }]);
    const sum = r.components.reduce((s, c) => s + c.amount_cents, 0);
    expect(sum).toBe(r.totalTaxCents);
    expect(r.totalTaxCents).toBe(Math.round(10000 * (14.975 / 100)));
  });

  it("mixed taxable/non-taxable lines — tax applies only to the taxable base", () => {
    const r = calculateTaxes(profile(), [
      { amountCents: 10000, taxable: true },
      { amountCents: 5000, taxable: false },
    ]);
    expect(r.taxableBaseCents).toBe(10000);
    expect(r.nonTaxableCents).toBe(5000);
    expect(r.totalTaxCents).toBe(1200); // unaffected by the non-taxable line
    expect(r.subtotalCents).toBe(15000);
    expect(r.totalCents).toBe(16200);
  });

  it("zero subtotal yields zero tax without dividing by zero", () => {
    const r = calculateTaxes(profile(), [{ amountCents: 0, taxable: true }]);
    expect(r.totalTaxCents).toBe(0);
    expect(r.totalCents).toBe(0);
  });

  it("large amounts stay exact integer cents (no float drift)", () => {
    const r = calculateTaxes(profile(), [{ amountCents: 123_456_789, taxable: true }]);
    const sum = r.components.reduce((s, c) => s + c.amount_cents, 0);
    expect(sum).toBe(r.totalTaxCents);
    expect(Number.isInteger(r.totalTaxCents)).toBe(true);
    expect(r.totalCents).toBe(123_456_789 + r.totalTaxCents);
  });

  it("adversarial rounding case: naive independent per-component rounding would be off by a cent — the allocation algorithm is what prevents it (hardening — independent Testing review)", () => {
    // 123,456,789¢ at GST 5% + PST 7%: combined tax = round(123456789*0.12) = 14,814,815.
    // Naive independent rounding: GST=round(123456789*0.05)=6,172,839, PST=round(123456789*0.07)=8,641,975,
    // sum=14,814,814 — one cent short of the real 14,814,815. The allocation
    // algorithm must NOT reproduce that naive result.
    const r = calculateTaxes(profile(), [{ amountCents: 123_456_789, taxable: true }]);
    expect(r.totalTaxCents).toBe(14_814_815);
    const gst = r.components.find((c) => c.code === "GST")!;
    const pst = r.components.find((c) => c.code === "PST")!;
    expect(gst.amount_cents + pst.amount_cents).toBe(14_814_815);
    // The naive (wrong) sum this test guards against:
    const naiveGst = Math.round(123_456_789 * 0.05);
    const naivePst = Math.round(123_456_789 * 0.07);
    expect(naiveGst + naivePst).toBe(14_814_814); // confirms the adversarial case is real
    expect(gst.amount_cents + pst.amount_cents).not.toBe(naiveGst + naivePst);
  });

  it("inclusive pricing — extracts embedded tax, never double-taxes (total unchanged)", () => {
    // A single 13% HST component: $113.00 gross should extract to $100.00 net + $13.00 tax.
    const r = calculateTaxes(profile({ prices_include_tax: true, region_code: "ON", components: [{ id: 1, code: "HST", name: "HST", rate_percent: 13 }] }), [
      { amountCents: 11300, taxable: true },
    ]);
    expect(r.taxableBaseCents).toBe(10000);
    expect(r.totalTaxCents).toBe(1300);
    expect(r.subtotalCents).toBe(10000);
    expect(r.totalCents).toBe(11300); // the gross total is unchanged — tax was already embedded
  });

  it("inclusive pricing with multiple components allocates proportionally and sums exactly", () => {
    const r = calculateTaxes(profile({ prices_include_tax: true }), [{ amountCents: 11200, taxable: true }]);
    const sum = r.components.reduce((s, c) => s + c.amount_cents, 0);
    expect(sum).toBe(r.totalTaxCents);
    expect(r.totalCents).toBe(11200); // never increased by embedded tax being extracted
  });

  it("inclusive pricing never adds tax on top of an already-taxed gross figure", () => {
    const exclusive = calculateTaxes(profile({ prices_include_tax: false }), [{ amountCents: 10000, taxable: true }]);
    const inclusive = calculateTaxes(profile({ prices_include_tax: true }), [{ amountCents: exclusive.totalCents, taxable: true }]);
    // Feeding the exclusive-mode gross total back through inclusive mode
    // must reproduce the same total — never grow further.
    expect(inclusive.totalCents).toBe(exclusive.totalCents);
  });
});

describe("validateTaxProfileInput", () => {
  it("rejects a duplicate component code", () => {
    expect(() => validateTaxProfileInput({
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "gst", name: "GST again", rate_percent: 5 }],
    })).toThrow(TaxJurisdictionError);
  });

  it("rejects an out-of-bounds rate", () => {
    expect(() => validateTaxProfileInput({
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 150 }],
    })).toThrow(TaxJurisdictionError);
    expect(() => validateTaxProfileInput({
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: -1 }],
    })).toThrow(TaxJurisdictionError);
  });

  it("rejects tax_enabled with no country", () => {
    expect(() => validateTaxProfileInput({
      tax_enabled: true, country_code: "", region_code: "", currency: "CAD", prices_include_tax: false, default_taxable: true, components: [],
    })).toThrow(TaxJurisdictionError);
  });

  it("allows tax_enabled: false with no country/components at all (the safe default)", () => {
    expect(() => validateTaxProfileInput({
      tax_enabled: false, country_code: "", region_code: "", currency: "", prices_include_tax: false, default_taxable: true, components: [],
    })).not.toThrow();
  });
});

// ── API: RBAC / tenant isolation / effective dating ──────────────────────

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("GET/POST /api/tax-profile — RBAC (Phase 13D)", () => {
  it("admin can read (null before any Save) and write a tax profile", async () => {
    const auth = await authHeaders();
    const before = await request<{ profile: unknown }>("/api/tax-profile", auth);
    expect(before.response.status).toBe(200);
    expect(before.body.profile).toBeNull();

    const saved = await post<{ profile: { tax_enabled: boolean; components: { code: string }[] } }>("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD",
      prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "PST", name: "PST", rate_percent: 7 }],
    }, auth);
    expect(saved.response.status).toBe(201);
    expect(saved.body.profile.tax_enabled).toBe(true);
    expect(saved.body.profile.components.map((c) => c.code)).toEqual(["GST", "PST"]);
  });

  it("dispatcher is denied GET and POST — stricter than canManageFinancials (admin+dispatcher)", async () => {
    await createUser({ email: "tax-dispatcher@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcher = await loginAs("tax-dispatcher@example.test", "DispatchPass1");
    const getRes = await request("/api/tax-profile", { headers: { cookie: dispatcher.cookie } });
    expect(getRes.response.status).toBe(403);
    const postRes = await post("/api/tax-profile", { tax_enabled: false, country_code: "", region_code: "", currency: "CAD", prices_include_tax: false, default_taxable: true, components: [] }, { headers: { cookie: dispatcher.cookie } });
    expect(postRes.response.status).toBe(403);
  });

  it("technician is denied GET and POST", async () => {
    await createUser({ email: "tax-tech@example.test", password: "TechPass123", role: "technician" });
    const tech = await loginAs("tax-tech@example.test", "TechPass123");
    const getRes = await request("/api/tax-profile", { headers: { cookie: tech.cookie } });
    expect(getRes.response.status).toBe(403);
    const postRes = await post("/api/tax-profile", { tax_enabled: false, country_code: "", region_code: "", currency: "CAD", prices_include_tax: false, default_taxable: true, components: [] }, { headers: { cookie: tech.cookie } });
    expect(postRes.response.status).toBe(403);
  });

  it("unauthenticated is denied with 401, never 403, on every tax-profile route including POST/history/options", async () => {
    expect((await request("/api/tax-profile")).response.status).toBe(401);
    expect((await post("/api/tax-profile", { tax_enabled: false, country_code: "", region_code: "", currency: "CAD", prices_include_tax: false, default_taxable: true, components: [] })).response.status).toBe(401);
    expect((await request("/api/tax-profile/history")).response.status).toBe(401);
    expect((await request("/api/tax-profile/options")).response.status).toBe(401);
  });

  it("history and options routes are also admin-only for both dispatcher and technician", async () => {
    await createUser({ email: "tax-dispatcher2@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcher = await loginAs("tax-dispatcher2@example.test", "DispatchPass1");
    expect((await request("/api/tax-profile/history", { headers: { cookie: dispatcher.cookie } })).response.status).toBe(403);
    expect((await request("/api/tax-profile/options", { headers: { cookie: dispatcher.cookie } })).response.status).toBe(403);

    await createUser({ email: "tax-tech2@example.test", password: "TechPass123", role: "technician" });
    const tech = await loginAs("tax-tech2@example.test", "TechPass123");
    expect((await request("/api/tax-profile/history", { headers: { cookie: tech.cookie } })).response.status).toBe(403);
    expect((await request("/api/tax-profile/options", { headers: { cookie: tech.cookie } })).response.status).toBe(403);
  });

  it("rejects an invalid configuration with 400, not a 500 or a silent accept", async () => {
    const auth = await authHeaders();
    const res = await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "GST", name: "Duplicate", rate_percent: 1 }],
    }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a malformed effective_from with 400 via schema validation, never reaching the ordering logic with a bad value (hardening — independent Security review)", async () => {
    const auth = await authHeaders();
    const res = await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }],
      effective_from: "not-a-date",
    }, auth);
    expect(res.response.status).toBe(400);
  });

  it("an enabled Tax Profile with zero components saves and resolves cleanly end-to-end (always $0 tax, never an error)", async () => {
    const auth = await authHeaders();
    const saved = await post<{ profile: { tax_enabled: boolean; components: unknown[] } }>("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [],
    }, auth);
    expect(saved.response.status).toBe(201);
    expect(saved.body.profile.components).toEqual([]);

    const customer = await post<{ id: number }>("/api/customers", { name: "Zero Component Customer", email: "x@example.test", phone: "555-0100" }, auth);
    const quote = await post<{ quote: { id: number } }>("/api/quotes", {
      customer_id: customer.body.id, line_items: [{ description: "x", quantity: 1, unit_price_cents: 10000 }],
    }, auth);
    expect(quote.response.status).toBe(201);
    const detail = await request<{ version: { tax_amount_cents: number } }>(`/api/quotes/${quote.body.quote.id}`, auth);
    expect(detail.body.version.tax_amount_cents).toBe(0);
  });
});

describe("Tax Profile — tenant isolation and effective-dated versioning", () => {
  it("Org A's tax profile is never visible to Org B's admin", async () => {
    const auth = await authHeaders();
    await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }],
    }, auth);

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    const res = await request<{ profile: unknown }>("/api/tax-profile", secondAuth);
    expect(res.response.status).toBe(200);
    expect(res.body.profile).toBeNull();
  });

  it("saving a new version never edits the prior one in place — history shows both, prior gets an effective_until", async () => {
    const auth = await authHeaders();
    await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "AB", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }],
    }, auth);
    const second = await post<{ profile: { effective_from: string } }>("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "ON", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "HST", name: "HST", rate_percent: 13 }],
      effective_from: new Date(Date.now() + 60_000).toISOString(),
    }, auth);
    expect(second.response.status).toBe(201);

    const history = await request<{ history: { region_code: string; effective_until: string | null }[] }>("/api/tax-profile/history", auth);
    expect(history.body.history.length).toBe(2);
    const closed = history.body.history.find((h) => h.region_code === "AB");
    expect(closed?.effective_until).not.toBeNull();
    const current = history.body.history.find((h) => h.region_code === "ON");
    expect(current?.effective_until).toBeNull();
  });

  it("cannot publish a new version effective before or at the current one", async () => {
    const auth = await authHeaders();
    await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }],
    }, auth);
    const res = await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "ON", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "HST", name: "HST", rate_percent: 13 }],
      effective_from: "2020-01-01T00:00:00.000Z",
    }, auth);
    expect(res.response.status).toBe(400);
  });
});
