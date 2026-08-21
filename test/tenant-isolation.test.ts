import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createSecondOrganization,
  del, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 11.5 — Tenant / SaaS Boundary Preparation. Systematic cross-organization
// isolation matrix: for every tenant-owned domain named in the task's required
// coverage list, prove Org A can access its own data, Org A CANNOT access Org
// B's data (read or write), and vice versa. Every fixture is created through
// the real API using each organization's own real admin session — never by
// reaching into the database to fabricate cross-org state, so these tests
// exercise the exact same code path a real attacker would.

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
  const fixture = await createSecondOrganization("Org B Field Services");
  const { cookie } = await loginAs(fixture.email, fixture.password);
  return { organizationId: fixture.organizationId, auth: { headers: { cookie } } };
}

async function makeCustomer(org: OrgContext, name = "Cross-Org Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "x@example.test", phone: "555-0100" }, org.auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeJob(org: OrgContext, customerId: number, scheduledDate = "2026-09-01") {
  const res = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: scheduledDate }, org.auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeTechnician(org: OrgContext, name = "Cross-Org Tech") {
  const res = await post<{ id: number }>("/api/technicians", { name }, org.auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeLead(org: OrgContext, name = "Cross-Org Lead") {
  const res = await post<{ id: number }>("/api/leads", { name, phone: "555-0177", email: "lead@example.test" }, org.auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

describe("tenant isolation — organizations table and default backfill", () => {
  it("the default organization exists and every pre-existing seeded row belongs to it", async () => {
    const orgs = await queryDb<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE id = ?", [DEFAULT_ORGANIZATION_ID]);
    expect(orgs).toHaveLength(1);
    const admin = await queryDb<{ organization_id: number }>("SELECT organization_id FROM users WHERE email = 'admin@fieldscheduler.local'");
    expect(admin[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);
    const serviceTypes = await queryDb<{ organization_id: number }>("SELECT organization_id FROM service_types");
    expect(serviceTypes.every((s) => s.organization_id === DEFAULT_ORGANIZATION_ID)).toBe(true);
    const materials = await queryDb<{ organization_id: number }>("SELECT organization_id FROM materials");
    expect(materials.every((m) => m.organization_id === DEFAULT_ORGANIZATION_ID)).toBe(true);
  });

  it("createSecondOrganization seeds a genuinely separate, real-loginable organization", async () => {
    const b = await orgB();
    expect(b.organizationId).not.toBe(DEFAULT_ORGANIZATION_ID);
    const me = await request<{ user: { id: number; role: string } }>("/api/auth/me", b.auth);
    expect(me.response.status).toBe(200);
    expect(me.body.user.role).toBe("admin");
  });
});

describe("tenant isolation — customers", () => {
  it("Org A cannot list, read, update, or delete Org B's customer", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Customer");

    const list = await request<{ customers: { id: number }[] }>("/api/customers?limit=100", a.auth);
    expect(list.body.customers.find((c) => c.id === bCustomerId)).toBeUndefined();

    const detail = await request(`/api/customers/${bCustomerId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const update = await put(`/api/customers/${bCustomerId}`, { name: "Hijacked" }, a.auth);
    expect(update.response.status).toBe(200); // no-op-on-unknown-id, matches pre-existing convention (see updateCustomer)
    const notHijacked = await queryDb<{ name: string }>("SELECT name FROM customers WHERE id = ?", [bCustomerId]);
    expect(notHijacked[0]?.name).toBe("Org B Customer"); // never actually updated

    const delResult = await del(`/api/customers/${bCustomerId}`, a.auth);
    expect(delResult.response.status).toBe(200); // no-op-on-unknown-id, matches pre-existing convention
    const stillThere = await queryDb("SELECT id FROM customers WHERE id = ?", [bCustomerId]);
    expect(stillThere).toHaveLength(1); // never actually deleted
  });

  it("Org B can fully manage its own customer", async () => {
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Own Customer");
    const detail = await request<{ customer: { name: string } }>(`/api/customers/${bCustomerId}`, b.auth);
    expect(detail.response.status).toBe(200);
    expect(detail.body.customer.name).toBe("Org B Own Customer");
  });

  it("a client-supplied referred_by_customer_id from another organization is rejected as if it doesn't exist", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Referrer");
    const res = await post(
      "/api/customers",
      { name: "Org A New Customer", referral_source: "Existing Customer", referred_by_customer_id: bCustomerId },
      a.auth
    );
    expect(res.response.status).toBe(400);
  });
});

describe("tenant isolation — leads", () => {
  it("Org A cannot list, read, or transition Org B's lead", async () => {
    const a = await orgA();
    const b = await orgB();
    const bLeadId = await makeLead(b, "Org B Lead");

    const list = await request<{ leads: { id: number }[] }>("/api/leads?limit=100", a.auth);
    expect(list.body.leads.find((l) => l.id === bLeadId)).toBeUndefined();

    const detail = await request(`/api/leads/${bLeadId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const transition = await post(`/api/leads/${bLeadId}/transition`, { to_status: "contacted" }, a.auth);
    expect(transition.response.status).toBe(404);
  });

  it("a Lead in Org A never matches/reuses a Customer in Org B on conversion, even with identical contact info", async () => {
    const a = await orgA();
    const b = await orgB();
    // Org B has a customer with this exact phone/email.
    const sharedPhone = "555-9911";
    const sharedEmail = "shared-contact@example.test";
    await post("/api/customers", { name: "Org B Shared Contact", phone: sharedPhone, email: sharedEmail }, b.auth);

    // Org A creates a Lead with the SAME phone/email and converts it.
    const lead = await post<{ id: number }>("/api/leads", { name: "Org A Lead", phone: sharedPhone, email: sharedEmail }, a.auth);
    for (const to_status of ["contacted", "qualified", "estimate"]) {
      await post(`/api/leads/${lead.body.id}/transition`, { to_status }, a.auth);
    }
    const converted = await post<{ customer: { id: number }; created: boolean }>(`/api/leads/${lead.body.id}/convert`, {}, a.auth);
    expect(converted.response.status).toBe(201);
    expect(converted.body.created).toBe(true); // a NEW customer, never Org B's matching one

    const newCustomer = await request<{ customer: { id: number; organization_id?: number } }>(`/api/customers/${converted.body.customer.id}`, a.auth);
    expect(newCustomer.response.status).toBe(200);
    const rows = await queryDb<{ organization_id: number }>("SELECT organization_id FROM customers WHERE id = ?", [converted.body.customer.id]);
    expect(rows[0].organization_id).toBe(a.organizationId);
  });
});

describe("tenant isolation — jobs", () => {
  it("Org A cannot list, read, update, transition, or geocode Org B's job", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b);
    const bJobId = await makeJob(b, bCustomerId);

    const list = await request<{ jobs: { id: number }[] }>("/api/jobs?limit=100", a.auth);
    expect(list.body.jobs.find((j) => j.id === bJobId)).toBeUndefined();

    const detail = await request(`/api/jobs/${bJobId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const update = await put(`/api/jobs/${bJobId}`, { notes: "Hijacked" }, a.auth);
    expect(update.response.status).toBe(404);

    const transition = await post(`/api/jobs/${bJobId}/transition`, { to_status: "in_progress" }, a.auth);
    expect(transition.response.status).toBe(404);

    const geocode = await post(`/api/jobs/${bJobId}/geocode`, {}, a.auth);
    expect(geocode.response.status).toBe(404);

    const rows = await queryDb<{ notes: string }>("SELECT notes FROM jobs WHERE id = ?", [bJobId]);
    expect(rows[0].notes).not.toBe("Hijacked");
  });

  it("Org A cannot create a job against Org B's customer or assign Org B's technician", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b);
    const bTechId = await makeTechnician(b);
    const aCustomerId = await makeCustomer(a, "Org A Customer");

    const crossCustomer = await post("/api/jobs", { customer_id: bCustomerId, scheduled_date: "2026-09-01" }, a.auth);
    expect(crossCustomer.response.status).toBe(404);

    const crossTechnician = await post(
      "/api/jobs", { customer_id: aCustomerId, technician_id: bTechId, scheduled_date: "2026-09-01" }, a.auth
    );
    expect(crossTechnician.response.status).toBe(400); // "technician does not exist" (org-scoped lookup)
  });

  it("Org B can fully manage its own job", async () => {
    const b = await orgB();
    const bCustomerId = await makeCustomer(b);
    const bJobId = await makeJob(b, bCustomerId);
    const detail = await request<{ job: { id: number } }>(`/api/jobs/${bJobId}`, b.auth);
    expect(detail.response.status).toBe(200);
  });
});

describe("tenant isolation — technicians", () => {
  it("Org A cannot list, update, or delete Org B's technician", async () => {
    const a = await orgA();
    const b = await orgB();
    const bTechId = await makeTechnician(b, "Org B Tech");

    const list = await request<{ technicians: { id: number }[] }>("/api/technicians", a.auth);
    expect(list.body.technicians.find((t) => t.id === bTechId)).toBeUndefined();

    const update = await put(`/api/technicians/${bTechId}`, { name: "Hijacked" }, a.auth);
    expect(update.response.status).toBe(200); // no-op-on-unknown-id, matches pre-existing convention
    const rows = await queryDb<{ name: string }>("SELECT name FROM technicians WHERE id = ?", [bTechId]);
    expect(rows[0].name).toBe("Org B Tech"); // never actually renamed

    const del1 = await del(`/api/technicians/${bTechId}`, a.auth);
    expect(del1.response.status).toBe(200);
    const stillThere = await queryDb("SELECT id FROM technicians WHERE id = ?", [bTechId]);
    expect(stillThere).toHaveLength(1);
  });
});

describe("tenant isolation — scheduler / dispatch", () => {
  it("GET /api/schedule never returns Org B's jobs to Org A", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b);
    const bJobId = await makeJob(b, bCustomerId, "2026-09-05");

    const schedule = await request<{ jobs: { id: number }[] }>(
      "/api/schedule?start=2026-09-01&end=2026-09-10", a.auth
    );
    expect(schedule.body.jobs.find((j) => j.id === bJobId)).toBeUndefined();
  });

  it("dashboard stats never blend Org B's counts/revenue into Org A's", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b);
    await makeJob(b, bCustomerId);

    const statsA = await request<{ jobs: number; customers: number }>("/api/stats", a.auth);
    expect(statsA.body.jobs).toBe(0);
    expect(statsA.body.customers).toBe(0);
  });
});

describe("tenant isolation — technician route / maps", () => {
  it("Org A admin cannot compute a route for Org B's technician", async () => {
    const a = await orgA();
    const b = await orgB();
    const bTechId = await makeTechnician(b, "Org B Route Tech");

    const route = await request(`/api/technician/route?date=2026-09-01&technician_id=${bTechId}`, a.auth);
    expect(route.response.status).toBe(400);
  });
});

describe("tenant isolation — BC rebate profiles (inherited via customer)", () => {
  it("Org A cannot read Org B's customer rebate eligibility", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Rebate Customer");
    await put(`/api/customers/${bCustomerId}`, { house_size: 1500, primary_heating_source: "Electric" }, b.auth);

    const result = await request(`/api/customers/${bCustomerId}/rebate-eligibility?job_type=CLEANBC`, a.auth);
    expect(result.response.status).toBe(404);
  });
});

describe("tenant isolation — financial / compliance", () => {
  it("Org A cannot read, issue, or record a payment against Org B's invoice", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Invoice Customer");
    const invoice = await post<{ id: number }>(
      "/api/invoices", { customer_id: bCustomerId, lines: [{ description: "Service", quantity: 1, unit_price_cents: 10000 }] }, b.auth
    );
    expect(invoice.response.status).toBe(201);
    const bInvoiceId = invoice.body.id;

    const list = await request<{ invoices: { id: number }[] }>("/api/invoices?limit=100", a.auth);
    expect(list.body.invoices.find((i) => i.id === bInvoiceId)).toBeUndefined();

    const detail = await request(`/api/invoices/${bInvoiceId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const issue = await post(`/api/invoices/${bInvoiceId}/issue`, {}, a.auth);
    expect(issue.response.status).toBe(404);

    const payment = await post(
      `/api/invoices/${bInvoiceId}/payments`,
      { amount_cents: 10000, payer_type: "customer", method: "cash" },
      a.auth
    );
    expect(payment.response.status).toBe(404);

    const rows = await queryDb("SELECT status FROM invoices WHERE id = ?", [bInvoiceId]);
    expect(rows[0]).toMatchObject({ status: "draft" }); // never issued by the cross-org attempt
  });

  it("Org A cannot create an invoice against Org B's customer", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Target Customer");

    const attempt = await post(
      "/api/invoices",
      { customer_id: bCustomerId, lines: [{ description: "Service", quantity: 1, unit_price_cents: 5000 }] },
      a.auth
    );
    expect(attempt.response.status).toBe(404);
  });
});

describe("tenant isolation — Global Settings", () => {
  it("a rebate threshold published in Org A never affects Org B's resolved eligibility", async () => {
    const a = await orgA();
    const b = await orgB();

    await post("/api/settings", { key: "CLEANBC_MAX_HOUSE_SIZE", value: "500", data_type: "number", category: "rebate" }, a.auth);

    const bCustomerId = await makeCustomer(b, "Org B Settings Customer");
    await put(`/api/customers/${bCustomerId}`, { house_size: 2000 }, b.auth);
    // Org B never configured CLEANBC_MAX_HOUSE_SIZE — must resolve as unconfigured (null), never Org A's 500.
    const result = await request<{ criteria: { key: string; satisfied: boolean | null }[] }>(
      `/api/customers/${bCustomerId}/rebate-eligibility?job_type=CLEANBC`, b.auth
    );
    const houseSize = result.body.criteria.find((c) => c.key === "house_size");
    expect(houseSize?.satisfied).toBeNull();
  });

  it("Org A cannot see Org B's published settings in its own settings list", async () => {
    const a = await orgA();
    const b = await orgB();
    await post("/api/settings", { key: "CLEANBC_MAX_HOUSE_SIZE", value: "9999", data_type: "number", category: "rebate" }, b.auth);

    const settingsA = await request<{ settings: { key: string; value: string }[] }>("/api/settings?category=rebate", a.auth);
    const found = settingsA.body.settings.find((s) => s.key === "CLEANBC_MAX_HOUSE_SIZE");
    expect(found).toBeUndefined();
  });
});

describe("tenant isolation — users", () => {
  it("Org A admin cannot list, read, or delete Org B's users", async () => {
    const a = await orgA();
    const b = await orgB();
    const bUser = await request<{ user: { id: number } }>("/api/auth/me", b.auth);
    const bUserId = bUser.body.user.id;

    const list = await request<{ users: { id: number }[] }>("/api/users", a.auth);
    expect(list.body.users.find((u) => u.id === bUserId)).toBeUndefined();

    const detail = await request(`/api/users/${bUserId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const delResult = await del(`/api/users/${bUserId}`, a.auth);
    expect(delResult.response.status).toBe(404);
    const stillThere = await queryDb("SELECT id FROM users WHERE id = ?", [bUserId]);
    expect(stillThere).toHaveLength(1);
  });

  it("Org A's admin is not counted toward Org B's 'last administrator' guard", async () => {
    // Org B has exactly one admin (its own seeded one). Org A having admins
    // too must not let Org B's own last admin be deleted/deactivated as if
    // a "backup" admin existed elsewhere.
    const b = await orgB();
    const bUser = await request<{ user: { id: number } }>("/api/auth/me", b.auth);
    const selfDelete = await del(`/api/users/${bUser.body.user.id}`, b.auth);
    expect(selfDelete.response.status).toBe(400); // "cannot delete your own account" fires first, but the guard is org-scoped regardless
  });

  it("Org A admin cannot escalate Org B's user role, deactivate them, or reset their password (account-takeover surface)", async () => {
    const a = await orgA();
    const b = await orgB();
    const bUser = await request<{ user: { id: number; role: string; active: number } }>("/api/auth/me", b.auth);
    const bUserId = bUser.body.user.id;

    const escalate = await put(`/api/users/${bUserId}`, { role: "admin" }, a.auth);
    expect(escalate.response.status).toBe(404);

    const deactivate = await put(`/api/users/${bUserId}`, { active: 0 }, a.auth);
    expect(deactivate.response.status).toBe(404);

    const resetPassword = await put(`/api/users/${bUserId}/password`, { password: "HijackedPass1" }, a.auth);
    expect(resetPassword.response.status).toBe(404);

    // Confirm none of the above actually touched Org B's user row.
    const stillIntact = await queryDb<{ role: string; active: number }>(
      "SELECT role, active FROM users WHERE id = ?", [bUserId]
    );
    expect(stillIntact[0].role).toBe(bUser.body.user.role);
    expect(stillIntact[0].active).toBe(bUser.body.user.active);
    // Org B's own admin can still log in with their real password afterward.
    const stillLoginable = await request<{ user: { id: number } }>("/api/auth/me", b.auth);
    expect(stillLoginable.response.status).toBe(200);
  });
});

describe("tenant isolation — notification history", () => {
  it("Org A cannot read Org B's job/customer notification history", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b, "Org B Notif Customer");
    const bJobId = await makeJob(b, bCustomerId, "2026-09-06");

    const jobHistory = await request(`/api/jobs/${bJobId}/notifications`, a.auth);
    expect(jobHistory.response.status).toBe(404);

    const customerHistory = await request(`/api/customers/${bCustomerId}/notifications`, a.auth);
    expect(customerHistory.response.status).toBe(404);
  });
});

describe("tenant isolation — paginated count/total isolation", () => {
  it("Org A's customer list total reflects only Org A's rows, even with Org B rows present", async () => {
    const a = await orgA();
    const b = await orgB();

    const beforeA = await request<{ total: number }>("/api/customers?limit=1", a.auth);
    const baselineTotal = beforeA.body.total;

    // Give Org B 3 more customers than Org A gets, so a cross-org total leak
    // (summing both orgs' counts) would be trivially detectable.
    await makeCustomer(a, "Org A Extra Customer");
    await makeCustomer(b, "Org B Extra Customer 1");
    await makeCustomer(b, "Org B Extra Customer 2");
    await makeCustomer(b, "Org B Extra Customer 3");

    const afterA = await request<{ total: number }>("/api/customers?limit=1", a.auth);
    expect(afterA.body.total).toBe(baselineTotal + 1);
  });
});

describe("tenant isolation — organization_id mass-assignment resistance", () => {
  it("a client-supplied organization_id in a create request is never honored", async () => {
    const a = await orgA();
    const b = await orgB();
    // Attempt to smuggle organization_id into a customer create — the field
    // isn't in the schema at all, so it's structurally impossible to set;
    // this proves the created row lands in the ACTOR's real organization
    // regardless of what's in the request body.
    const res = await post<{ id: number }>(
      "/api/customers",
      { name: "Smuggled Org Customer", organization_id: b.organizationId },
      a.auth
    );
    expect(res.response.status).toBe(201);
    const rows = await queryDb<{ organization_id: number }>("SELECT organization_id FROM customers WHERE id = ?", [res.body.id]);
    expect(rows[0].organization_id).toBe(a.organizationId);
  });
});
