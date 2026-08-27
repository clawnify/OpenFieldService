import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createJob, createSecondOrganization,
  createUser, del, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 11.4 — Assets / Equipment Generalization. Covers CRUD, customer
// ownership, tenant isolation (Org A vs Org B), cross-customer denial within
// one org, RBAC (admin/dispatcher manage, technician read-linked-only), Job
// linking, search/pagination, and invalid-input validation. Mirrors
// tenant-isolation.test.ts's real-API-fixture-through-real-session
// discipline throughout — never fabricates cross-org state via raw SQL
// except where helpers.ts itself already does (createSecondOrganization).

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
  const fixture = await createSecondOrganization("Org B HVAC Co");
  const { cookie } = await loginAs(fixture.email, fixture.password);
  return { organizationId: fixture.organizationId, auth: { headers: { cookie } } };
}

async function dispatcherAuth(email = "asset-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

// NOTE: deliberately does NOT reuse helpers.ts's createUser() — that helper
// always posts via the DEFAULT organization's cached admin session
// (authHeaders()), which would silently create the user under Org A even
// when `adminAuth` here belongs to Org B. Every user this helper creates
// must belong to the SAME organization as `adminAuth`'s actor, so the POST
// itself is made directly with `adminAuth`.
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

async function makeCustomer(auth: RequestInit, name = "Asset Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "x@example.test", phone: "555-0100" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeAsset(auth: RequestInit, customerId: number, overrides: Record<string, unknown> = {}) {
  const res = await post<{ asset: { id: number } }>("/api/assets", {
    customer_id: customerId, asset_type: "FURNACE", display_name: "Basement Furnace",
    manufacturer: "Carrier", model: "59TP6", serial_number: "SN-1001", installation_date: "2024-05-01",
    ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body.asset.id;
}

describe("GET /api/assets/types", () => {
  it("returns the composed registry (Core + HVAC contributions) to any authenticated role", async () => {
    const auth = await authHeaders();
    const res = await request<{ types: { key: string; label: string }[] }>("/api/assets/types", auth);
    expect(res.response.status).toBe(200);
    const keys = res.body.types.map((t) => t.key);
    expect(keys).toContain("FURNACE");
    expect(keys).toContain("HEAT_PUMP");
    expect(keys).toContain("BOILER");
    expect(keys).toContain("AIR_CONDITIONER");
    expect(keys).toContain("WATER_HEATER");
    expect(keys).toContain("THERMOSTAT");
    expect(keys).toContain("AIR_HANDLER");
  });

  it("is reachable by every authenticated role, including technician (unlike the rest of the Asset routes)", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const tech = await createLinkedTechnician("asset-types-tech@example.test", auth);

    const asAdmin = await request<{ types: { key: string }[] }>("/api/assets/types", auth);
    const asDispatcher = await request<{ types: { key: string }[] }>("/api/assets/types", dispatcher);
    const asTechnician = await request<{ types: { key: string }[] }>("/api/assets/types", tech.auth);

    expect(asAdmin.response.status).toBe(200);
    expect(asDispatcher.response.status).toBe(200);
    expect(asTechnician.response.status).toBe(200);
    const sortedKeys = (r: typeof asAdmin) => r.body.types.map((t) => t.key).sort();
    expect(sortedKeys(asDispatcher)).toEqual(sortedKeys(asAdmin));
    expect(sortedKeys(asTechnician)).toEqual(sortedKeys(asAdmin));
  });
});

describe("Asset CRUD", () => {
  it("admin creates, reads, updates, and deletes an unreferenced asset", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);

    const detail = await request<{ asset: { display_name: string; asset_type: string; status: string } }>(`/api/assets/${assetId}`, auth);
    expect(detail.response.status).toBe(200);
    expect(detail.body.asset.display_name).toBe("Basement Furnace");
    expect(detail.body.asset.asset_type).toBe("FURNACE");
    expect(detail.body.asset.status).toBe("active");

    const updated = await put<{ asset: { manufacturer: string; status: string } }>(`/api/assets/${assetId}`, { manufacturer: "Trane", status: "inactive" }, auth);
    expect(updated.response.status).toBe(200);
    expect(updated.body.asset.manufacturer).toBe("Trane");
    expect(updated.body.asset.status).toBe("inactive");

    const deleted = await del(`/api/assets/${assetId}`, auth);
    expect(deleted.response.status).toBe(200);
    const gone = await request(`/api/assets/${assetId}`, auth);
    expect(gone.response.status).toBe(404);
  });

  it("dispatcher has the same CRUD access as admin", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const customerId = await makeCustomer(auth);

    const create = await post<{ asset: { id: number } }>("/api/assets", { customer_id: customerId, asset_type: "BOILER" }, dispatcher);
    expect(create.response.status).toBe(201);
    const assetId = create.body.asset.id;

    const update = await put(`/api/assets/${assetId}`, { notes: "Serviced" }, dispatcher);
    expect(update.response.status).toBe(200);

    const deleted = await del(`/api/assets/${assetId}`, dispatcher);
    expect(deleted.response.status).toBe(200);
  });

  it("creating an asset under a nonexistent customer_id is rejected", async () => {
    const auth = await authHeaders();
    const res = await post("/api/assets", { customer_id: 999999, asset_type: "FURNACE" }, auth);
    expect(res.response.status).toBe(404);
  });

  it("GET on an unknown asset id 404s", async () => {
    const auth = await authHeaders();
    const res = await request("/api/assets/999999", auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Asset delete/retire semantics", () => {
  it("deleting an asset linked to a job is refused (409) — retire instead", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-10");
    const link = await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, auth);
    expect(link.response.status).toBe(201);

    const deleted = await del(`/api/assets/${assetId}`, auth);
    expect(deleted.response.status).toBe(409);
    const stillThere = await queryDb("SELECT id FROM assets WHERE id = ?", [assetId]);
    expect(stillThere).toHaveLength(1);

    // Retiring (a normal status edit) always succeeds, even while linked.
    const retired = await put<{ asset: { status: string } }>(`/api/assets/${assetId}`, { status: "retired" }, auth);
    expect(retired.response.status).toBe(200);
    expect(retired.body.asset.status).toBe("retired");
  });

  it("reassigning a linked asset to a different customer is refused (409) — would silently break cross-customer safety", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth, "Original Customer");
    const otherCustomerId = await makeCustomer(auth, "Different Customer");
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-20");
    await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, auth);

    const reparent = await put(`/api/assets/${assetId}`, { customer_id: otherCustomerId }, auth);
    expect(reparent.response.status).toBe(409);
    const unchanged = await queryDb<{ customer_id: number }>("SELECT customer_id FROM assets WHERE id = ?", [assetId]);
    expect(unchanged[0].customer_id).toBe(customerId);

    // Unlinking first clears the way for a legitimate reassignment.
    await del(`/api/jobs/${job.id}/assets/${assetId}`, auth);
    const reparentAfterUnlink = await put(`/api/assets/${assetId}`, { customer_id: otherCustomerId }, auth);
    expect(reparentAfterUnlink.response.status).toBe(200);
  });

  it("deleting an asset with zero job links succeeds", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const deleted = await del(`/api/assets/${assetId}`, auth);
    expect(deleted.response.status).toBe(200);
  });
});

describe("Asset validation", () => {
  it("rejects an unrecognized asset_type", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/assets", { customer_id: customerId, asset_type: "FLYING_SAUCER" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an invalid installation_date format", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/assets", { customer_id: customerId, asset_type: "FURNACE", installation_date: "not-a-date" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects oversized string fields", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/assets", { customer_id: customerId, display_name: "x".repeat(500) }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects mass-assignment of organization_id or unknown fields", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const res = await post("/api/assets", { customer_id: customerId, organization_id: 999 }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Asset RBAC", () => {
  it("a technician is blocked from listing, reading, creating, updating, and deleting assets directly", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const tech = await createLinkedTechnician("asset-rbac-tech@example.test", auth);

    expect((await request("/api/assets", tech.auth)).response.status).toBe(403);
    expect((await request(`/api/assets/${assetId}`, tech.auth)).response.status).toBe(403);
    expect((await post("/api/assets", { customer_id: customerId, asset_type: "FURNACE" }, tech.auth)).response.status).toBe(403);
    expect((await put(`/api/assets/${assetId}`, { notes: "hacked" }, tech.auth)).response.status).toBe(403);
    expect((await del(`/api/assets/${assetId}`, tech.auth)).response.status).toBe(403);

    const unchanged = await queryDb<{ notes: string }>("SELECT notes FROM assets WHERE id = ?", [assetId]);
    expect(unchanged[0].notes).toBe("");
  });
});

describe("Job <-> Asset linking", () => {
  it("links and unlinks an asset to a job it belongs to (same customer)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-11");

    const link = await post("/api/jobs/" + job.id + "/assets", { asset_id: assetId }, auth);
    expect(link.response.status).toBe(201);

    const listed = await request<{ assets: { id: number }[] }>(`/api/jobs/${job.id}/assets`, auth);
    expect(listed.response.status).toBe(200);
    expect(listed.body.assets.map((a) => a.id)).toEqual([assetId]);

    const unlink = await del(`/api/jobs/${job.id}/assets/${assetId}`, auth);
    expect(unlink.response.status).toBe(200);
    const listedAfter = await request<{ assets: { id: number }[] }>(`/api/jobs/${job.id}/assets`, auth);
    expect(listedAfter.body.assets).toHaveLength(0);
  });

  it("many-to-many: one asset can be linked to multiple jobs independently, and unlinking from one leaves the others (and the asset itself) untouched", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const jobA = await createJob(customerId, "2026-09-21");
    const jobB = await createJob(customerId, "2026-09-22");

    await post(`/api/jobs/${jobA.id}/assets`, { asset_id: assetId }, auth);
    await post(`/api/jobs/${jobB.id}/assets`, { asset_id: assetId }, auth);

    const listA = await request<{ assets: { id: number }[] }>(`/api/jobs/${jobA.id}/assets`, auth);
    const listB = await request<{ assets: { id: number }[] }>(`/api/jobs/${jobB.id}/assets`, auth);
    expect(listA.body.assets.map((a) => a.id)).toEqual([assetId]);
    expect(listB.body.assets.map((a) => a.id)).toEqual([assetId]);

    // Deleting the asset while linked to TWO jobs is still refused.
    expect((await del(`/api/assets/${assetId}`, auth)).response.status).toBe(409);

    // Unlinking from job A must not affect job B's link or the asset row.
    await del(`/api/jobs/${jobA.id}/assets/${assetId}`, auth);
    const listAAfter = await request<{ assets: { id: number }[] }>(`/api/jobs/${jobA.id}/assets`, auth);
    const listBAfter = await request<{ assets: { id: number }[] }>(`/api/jobs/${jobB.id}/assets`, auth);
    expect(listAAfter.body.assets).toHaveLength(0);
    expect(listBAfter.body.assets.map((a) => a.id)).toEqual([assetId]);
    const stillExists = await queryDb("SELECT id FROM assets WHERE id = ?", [assetId]);
    expect(stillExists).toHaveLength(1);
  });

  it("rejects linking an asset already linked to that job (no duplicate)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-12");
    await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, auth);
    const again = await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, auth);
    expect(again.response.status).toBe(409);
  });

  it("cross-customer safety: default DENY linking an asset to a job of a different customer", async () => {
    const auth = await authHeaders();
    const customerA = await makeCustomer(auth, "Customer A");
    const customerB = await makeCustomer(auth, "Customer B");
    const assetForA = await makeAsset(auth, customerA);
    const jobForB = await createJob(customerB, "2026-09-13");

    const link = await post(`/api/jobs/${jobForB.id}/assets`, { asset_id: assetForA }, auth);
    expect(link.response.status).toBe(409);
    const rows = await queryDb("SELECT id FROM job_assets WHERE job_id = ?", [jobForB.id]);
    expect(rows).toHaveLength(0);
  });

  it("unlinking a nonexistent job 404s; unlinking a non-linked asset is a harmless no-op", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-14");

    expect((await del(`/api/jobs/999999/assets/${assetId}`, auth)).response.status).toBe(404);
    const noop = await del(`/api/jobs/${job.id}/assets/${assetId}`, auth);
    expect(noop.response.status).toBe(200);
  });

  it("a technician is blocked from linking or unlinking equipment, even on their own assigned job", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const job = await createJob(customerId, "2026-09-15");
    const tech = await createLinkedTechnician("asset-link-tech@example.test", auth);
    await put(`/api/jobs/${job.id}`, { technician_id: tech.technicianId }, auth);

    const link = await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, tech.auth);
    expect(link.response.status).toBe(403);

    await post(`/api/jobs/${job.id}/assets`, { asset_id: assetId }, auth); // admin links it for the next assertion
    const unlink = await del(`/api/jobs/${job.id}/assets/${assetId}`, tech.auth);
    expect(unlink.response.status).toBe(403);
  });

  it("a technician can view linked equipment on their own assigned job, but not on another technician's job", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const assetId = await makeAsset(auth, customerId);
    const ownJob = await createJob(customerId, "2026-09-16");
    const otherJob = await createJob(customerId, "2026-09-17");
    await post(`/api/jobs/${ownJob.id}/assets`, { asset_id: assetId }, auth);
    await post(`/api/jobs/${otherJob.id}/assets`, { asset_id: assetId }, auth);

    const techA = await createLinkedTechnician("asset-view-tech-a@example.test", auth);
    const techB = await createLinkedTechnician("asset-view-tech-b@example.test", auth);
    await put(`/api/jobs/${ownJob.id}`, { technician_id: techA.technicianId }, auth);
    await put(`/api/jobs/${otherJob.id}`, { technician_id: techB.technicianId }, auth);

    const ownView = await request<{ assets: { id: number }[] }>(`/api/jobs/${ownJob.id}/assets`, techA.auth);
    expect(ownView.response.status).toBe(200);
    expect(ownView.body.assets.map((a) => a.id)).toEqual([assetId]);

    const otherView = await request(`/api/jobs/${otherJob.id}/assets`, techA.auth);
    expect(otherView.response.status).toBe(403);
  });
});

describe("Search / pagination", () => {
  it("filters by customer_id, asset_type, status, manufacturer, and free-text search", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const otherCustomerId = await makeCustomer(auth, "Other Customer");
    const furnace = await makeAsset(auth, customerId, { asset_type: "FURNACE", manufacturer: "Carrier", serial_number: "SN-AAA" });
    const ac = await makeAsset(auth, customerId, { asset_type: "AIR_CONDITIONER", manufacturer: "Trane", serial_number: "SN-BBB", display_name: "Rooftop Unit" });
    // Deliberately a DIFFERENT manufacturer than the furnace above — this
    // other customer's asset must never appear in the manufacturer="Carrier"
    // assertion below, which is intentionally unscoped by customer_id (a
    // manufacturer search spans the whole organization, not one customer).
    await makeAsset(auth, otherCustomerId, { asset_type: "FURNACE", manufacturer: "Goodman" });

    const byCustomer = await request<{ assets: { id: number }[]; total: number }>(`/api/assets?customer_id=${customerId}`, auth);
    expect(byCustomer.body.assets.map((a) => a.id).sort()).toEqual([furnace, ac].sort());
    expect(byCustomer.body.total).toBe(2);

    const byType = await request<{ assets: { id: number }[] }>(`/api/assets?customer_id=${customerId}&asset_type=AIR_CONDITIONER`, auth);
    expect(byType.body.assets.map((a) => a.id)).toEqual([ac]);

    const byManufacturer = await request<{ assets: { id: number }[] }>(`/api/assets?manufacturer=Carrier`, auth);
    expect(byManufacturer.body.assets.map((a) => a.id)).toEqual([furnace]);

    const bySearch = await request<{ assets: { id: number }[] }>(`/api/assets?search=Rooftop`, auth);
    expect(bySearch.body.assets.map((a) => a.id)).toEqual([ac]);

    await put(`/api/assets/${furnace}`, { status: "retired" }, auth);
    const byStatus = await request<{ assets: { id: number }[] }>(`/api/assets?customer_id=${customerId}&status=retired`, auth);
    expect(byStatus.body.assets.map((a) => a.id)).toEqual([furnace]);
  });

  it("treats literal LIKE metacharacters (%, _) in search/manufacturer as literal text, not wildcards, and never 500s on a wildcard-heavy value (security review finding)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const literalMatch = await makeAsset(auth, customerId, { manufacturer: "Acme_HVAC%Co", serial_number: "SN-LIT" });
    await makeAsset(auth, customerId, { manufacturer: "AcmeXHVACYCo", serial_number: "SN-NOTLIT" });

    // "_" and "%" here must match ONLY the literal characters, not act as
    // SQL wildcards — if they were unescaped, both assets above would match.
    const literal = await request<{ assets: { id: number }[] }>(`/api/assets?manufacturer=${encodeURIComponent("Acme_HVAC%Co")}`, auth);
    expect(literal.response.status).toBe(200);
    expect(literal.body.assets.map((a) => a.id)).toEqual([literalMatch]);

    // A pathological wildcard-heavy value (enough raw %/_ characters to trip
    // D1/SQLite's own "LIKE pattern too complex" limit even once escaped —
    // confirmed live that escaping alone does NOT prevent that engine-level
    // error) must be rejected with a clean 400, never an uncaught 500.
    const heavy = "%_".repeat(60);
    const res = await request(`/api/assets?search=${encodeURIComponent(heavy)}`, auth);
    expect(res.response.status).toBe(400);

    // A realistic, low-wildcard-count value must still work normally.
    const fine = await request(`/api/assets?search=${encodeURIComponent("50%_off")}`, auth);
    expect(fine.response.status).toBe(200);
  });

  it("respects limit/offset pagination", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    for (let i = 0; i < 5; i++) await makeAsset(auth, customerId, { serial_number: `SN-${i}` });

    const page1 = await request<{ assets: { id: number }[]; total: number }>(`/api/assets?customer_id=${customerId}&limit=2&offset=0`, auth);
    expect(page1.body.assets).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    const page2 = await request<{ assets: { id: number }[] }>(`/api/assets?customer_id=${customerId}&limit=2&offset=2`, auth);
    expect(page2.body.assets).toHaveLength(2);
    expect(new Set([...page1.body.assets, ...page2.body.assets].map((a) => a.id)).size).toBe(4);
  });
});

describe("Tenant isolation — Assets", () => {
  it("Org A cannot list, read, update, or delete Org B's asset", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");
    const bAssetId = await makeAsset(b.auth, bCustomerId);

    const list = await request<{ assets: { id: number }[] }>("/api/assets?limit=200", a.auth);
    expect(list.body.assets.find((x) => x.id === bAssetId)).toBeUndefined();

    const detail = await request(`/api/assets/${bAssetId}`, a.auth);
    expect(detail.response.status).toBe(404);

    const update = await put(`/api/assets/${bAssetId}`, { notes: "Hijacked" }, a.auth);
    expect(update.response.status).toBe(404);
    const notHijacked = await queryDb<{ notes: string }>("SELECT notes FROM assets WHERE id = ?", [bAssetId]);
    expect(notHijacked[0]?.notes).toBe("");

    const delResult = await del(`/api/assets/${bAssetId}`, a.auth);
    expect(delResult.response.status).toBe(404);
    const stillThere = await queryDb("SELECT id FROM assets WHERE id = ?", [bAssetId]);
    expect(stillThere).toHaveLength(1);
  });

  it("Org A cannot reassign its own asset to Org B's customer via update", async () => {
    const a = await orgA();
    const b = await orgB();
    const aCustomerId = await makeCustomer(a.auth, "Org A Customer");
    const aAssetId = await makeAsset(a.auth, aCustomerId);
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");

    const res = await put(`/api/assets/${aAssetId}`, { customer_id: bCustomerId }, a.auth);
    expect(res.response.status).toBe(404);
    const unchanged = await queryDb<{ customer_id: number }>("SELECT customer_id FROM assets WHERE id = ?", [aAssetId]);
    expect(unchanged[0].customer_id).toBe(aCustomerId);
  });

  it("Org A cannot create an asset under Org B's customer", async () => {
    const a = await orgA();
    const b = await orgB();
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");

    const res = await post("/api/assets", { customer_id: bCustomerId, asset_type: "FURNACE" }, a.auth);
    expect(res.response.status).toBe(404);
    const rows = await queryDb("SELECT id FROM assets WHERE customer_id = ?", [bCustomerId]);
    expect(rows).toHaveLength(0);
  });

  it("Org A cannot link Org B's asset to an Org A job (or vice versa)", async () => {
    const a = await orgA();
    const b = await orgB();
    const aCustomerId = await makeCustomer(a.auth, "Org A Customer");
    const aJob = await createJob(aCustomerId, "2026-09-18");
    const bCustomerId = await makeCustomer(b.auth, "Org B Customer");
    const bAssetId = await makeAsset(b.auth, bCustomerId);

    // Org A links its own job against Org B's asset id — the asset lookup
    // is itself org-scoped, so this must resolve as "asset not found", not
    // a cross-customer/cross-org leak.
    const link = await post(`/api/jobs/${aJob.id}/assets`, { asset_id: bAssetId }, a.auth);
    expect(link.response.status).toBe(404);
    const rows = await queryDb("SELECT id FROM job_assets WHERE job_id = ?", [aJob.id]);
    expect(rows).toHaveLength(0);
  });

  it("a Org B technician cannot view an Org A job's linked assets", async () => {
    const a = await orgA();
    const b = await orgB();
    const aCustomerId = await makeCustomer(a.auth, "Org A Customer");
    const aAssetId = await makeAsset(a.auth, aCustomerId);
    const aJob = await createJob(aCustomerId, "2026-09-19");
    await post(`/api/jobs/${aJob.id}/assets`, { asset_id: aAssetId }, a.auth);

    const bTech = await createLinkedTechnician("orgb-asset-tech@example.test", b.auth);
    const res = await request(`/api/jobs/${aJob.id}/assets`, bTech.auth);
    expect(res.response.status).toBe(404); // job itself is org-scoped — never leaks existence
  });

  it("GET /api/assets/types is identical/available across organizations (not tenant-scoped — it's a static registry)", async () => {
    const a = await orgA();
    const b = await orgB();
    const resA = await request<{ types: { key: string }[] }>("/api/assets/types", a.auth);
    const resB = await request<{ types: { key: string }[] }>("/api/assets/types", b.auth);
    expect(resA.body.types.map((t) => t.key).sort()).toEqual(resB.body.types.map((t) => t.key).sort());
  });
});

// Phase 17 — Pricebook. `pricebook_item_id` is a pure provenance pointer to
// the catalog Equipment definition an Asset was sold/installed from
// (Section 40) — nullable, never re-derives the Asset's own independently-
// editable manufacturer/model/serial fields. Added per an independent
// architecture review finding that the column was schema-only and
// unreachable via any API route.
describe("Assets — Pricebook provenance link (Phase 17)", () => {
  async function makePricebookItem(auth: RequestInit, name = "Linked Equipment") {
    const res = await post<{ item: { id: number } }>("/api/pricebook", { type: "EQUIPMENT", name }, auth);
    expect(res.response.status).toBe(201);
    return res.body.item.id;
  }

  it("sets and clears pricebook_item_id on create and update without touching the Asset's own identity fields", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const pricebookItemId = await makePricebookItem(auth);

    const assetId = await makeAsset(auth, customerId, { pricebook_item_id: pricebookItemId });
    const detail = await request<{ asset: { pricebook_item_id: number | null; manufacturer: string } }>(`/api/assets/${assetId}`, auth);
    expect(detail.body.asset.pricebook_item_id).toBe(pricebookItemId);
    expect(detail.body.asset.manufacturer).toBe("Carrier"); // Asset's own field, untouched by the link.

    const cleared = await put<{ asset: { pricebook_item_id: number | null } }>(`/api/assets/${assetId}`, { pricebook_item_id: null }, auth);
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.asset.pricebook_item_id).toBeNull();
  });

  it("rejects a pricebook_item_id from another organization on both create and update", async () => {
    const a = await orgA();
    const b = await orgB();
    const customerId = await makeCustomer(a.auth);
    const orgBItemId = await makePricebookItem(b.auth, "Org B Equipment");

    const created = await post("/api/assets", { customer_id: customerId, pricebook_item_id: orgBItemId }, a.auth);
    expect(created.response.status).toBe(404);

    const assetId = await makeAsset(a.auth, customerId);
    const updated = await put(`/api/assets/${assetId}`, { pricebook_item_id: orgBItemId }, a.auth);
    expect(updated.response.status).toBe(404);
  });
});
