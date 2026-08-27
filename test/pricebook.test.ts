import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createSecondOrganization,
  createUser, del, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 17 — Pricebook. Covers Admin CRUD (items + categories), Dispatcher
// read-only with cost stripped, Technician full denial, tenant isolation,
// SKU uniqueness (including the concurrent-race defense-in-depth path),
// negative-price rejection, equipment/warranty metadata JSON validation,
// search-filter wildcard-density guard, category delete-when-referenced
// protection, audit-log recording, and — the phase's central invariant —
// Quote line-item snapshot creation plus historical price integrity (a
// later Pricebook price change never retroactively touches an already-
// created Quote line item). Mirrors quotes.test.ts/assets.test.ts's real-
// API-fixture-through-real-session discipline throughout.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "pb-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "pb-tech@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

interface PricebookItemBody {
  id: number;
  type: string;
  name: string;
  sku: string;
  cost_cents?: number;
  sell_price_cents: number;
  taxable: boolean;
  status: string;
  internal_notes?: string;
  preferred_vendor?: string;
  vendor_sku?: string;
}

async function makeItem(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<{ item: PricebookItemBody }>("/api/pricebook", {
    type: "PART", name: "Test Part", sku: "", sell_price_cents: 5000, cost_cents: 2000,
    ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body.item;
}

async function makeCustomer(auth: RequestInit, name = "Pricebook Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "pb@example.test", phone: "555-0199" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeQuote(auth: RequestInit, customerId: number) {
  const res = await post<{ quote: { id: number } }>("/api/quotes", { customer_id: customerId, line_items: [] }, auth);
  expect(res.response.status).toBe(201);
  return res.body.quote;
}

describe("Pricebook — Admin item CRUD", () => {
  it("creates, lists, gets, updates, and archives/reactivates an item", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Furnace Filter", sku: "FLT-100", manufacturer: "Acme", model: "X1" });
    expect(item.sku).toBe("FLT-100");

    const list = await request<{ items: PricebookItemBody[]; total: number }>("/api/pricebook", auth);
    expect(list.response.status).toBe(200);
    expect(list.body.total).toBe(1);

    const get = await request<{ item: PricebookItemBody }>(`/api/pricebook/${item.id}`, auth);
    expect(get.response.status).toBe(200);
    expect(get.body.item.name).toBe("Furnace Filter");

    const updated = await put<{ item: PricebookItemBody }>(`/api/pricebook/${item.id}`, { sell_price_cents: 7500 }, auth);
    expect(updated.response.status).toBe(200);
    expect(updated.body.item.sell_price_cents).toBe(7500);

    const archived = await post<{ item: PricebookItemBody }>(`/api/pricebook/${item.id}/archive`, {}, auth);
    expect(archived.response.status).toBe(200);
    expect(archived.body.item.status).toBe("inactive");

    const reactivated = await post<{ item: PricebookItemBody }>(`/api/pricebook/${item.id}/activate`, {}, auth);
    expect(reactivated.response.status).toBe(200);
    expect(reactivated.body.item.status).toBe("active");
  });

  it("rejects a missing name and an invalid type", async () => {
    const auth = await authHeaders();
    const noName = await post("/api/pricebook", { type: "PART" }, auth);
    expect(noName.response.status).toBe(400);
    const badType = await post("/api/pricebook", { type: "NOT_A_TYPE", name: "x" }, auth);
    expect(badType.response.status).toBe(400);
  });

  it("rejects negative cost and negative sell price", async () => {
    const auth = await authHeaders();
    const negCost = await post("/api/pricebook", { type: "PART", name: "x", cost_cents: -1 }, auth);
    expect(negCost.response.status).toBe(400);
    const negPrice = await post("/api/pricebook", { type: "PART", name: "x", sell_price_cents: -1 }, auth);
    expect(negPrice.response.status).toBe(400);
  });

  it("filters by type, status, category, and free-text search; paginates results", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { type: "EQUIPMENT", name: "Heat Pump", sku: "HP-1", manufacturer: "Carrier" });
    await makeItem(auth, { type: "PART", name: "Filter", sku: "FLT-1" });
    for (let i = 0; i < 5; i++) await makeItem(auth, { type: "PART", name: `Bulk Part ${i}`, sku: "" });

    const byType = await request<{ items: PricebookItemBody[]; total: number }>("/api/pricebook?type=EQUIPMENT", auth);
    expect(byType.body.total).toBe(1);

    const bySearch = await request<{ items: PricebookItemBody[]; total: number }>("/api/pricebook?search=Carrier", auth);
    expect(bySearch.body.total).toBe(1);
    expect(bySearch.body.items[0].name).toBe("Heat Pump");

    const page1 = await request<{ items: PricebookItemBody[]; total: number }>("/api/pricebook?limit=3&offset=0", auth);
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.total).toBe(7);
  });

  it("rejects an overly complex search filter", async () => {
    const auth = await authHeaders();
    const wild = "_".repeat(25);
    const res = await request(`/api/pricebook?search=${encodeURIComponent(wild)}`, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Pricebook — SKU uniqueness", () => {
  it("rejects a duplicate non-empty SKU per organization, but allows repeated blank SKUs", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "First", sku: "DUP-1" });
    const dup = await post("/api/pricebook", { type: "PART", name: "Second", sku: "DUP-1" }, auth);
    expect(dup.response.status).toBe(409);

    const blank1 = await makeItem(auth, { name: "Blank A", sku: "" });
    const blank2 = await makeItem(auth, { name: "Blank B", sku: "" });
    expect(blank1.id).not.toBe(blank2.id);
  });

  it("rejects a duplicate SKU introduced via update", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "Existing", sku: "SKU-A" });
    const other = await makeItem(auth, { name: "Other", sku: "SKU-B" });
    const res = await put(`/api/pricebook/${other.id}`, { sku: "SKU-A" }, auth);
    expect(res.response.status).toBe(409);
  });

  it("under concurrent creation, exactly one of two identical new SKUs succeeds (UNIQUE-constraint race defense)", async () => {
    const auth = await authHeaders();
    const [a, b] = await Promise.all([
      post<{ item: PricebookItemBody }>("/api/pricebook", { type: "PART", name: "Race A", sku: "RACE-1" }, auth),
      post<{ item: PricebookItemBody }>("/api/pricebook", { type: "PART", name: "Race B", sku: "RACE-1" }, auth),
    ]);
    const statuses = [a.response.status, b.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await queryDb("SELECT id FROM pricebook_items WHERE sku = 'RACE-1'");
    expect(rows).toHaveLength(1);
  });
});

describe("Pricebook — equipment/warranty metadata validation", () => {
  it("accepts a well-formed JSON object and rejects a non-object / malformed / oversized value", async () => {
    const auth = await authHeaders();
    const ok = await post("/api/pricebook", { type: "EQUIPMENT", name: "AC Unit", equipment_metadata: JSON.stringify({ capacity: "3 ton" }) }, auth);
    expect(ok.response.status).toBe(201);

    const arrayBody = await post("/api/pricebook", { type: "EQUIPMENT", name: "x", equipment_metadata: "[]" }, auth);
    expect(arrayBody.response.status).toBe(400);

    const malformed = await post("/api/pricebook", { type: "EQUIPMENT", name: "x", warranty_metadata: "{not json" }, auth);
    expect(malformed.response.status).toBe(400);

    const oversized = await post("/api/pricebook", { type: "EQUIPMENT", name: "x", equipment_metadata: JSON.stringify({ blob: "a".repeat(8001) }) }, auth);
    expect(oversized.response.status).toBe(400);
  });
});

describe("Pricebook — categories", () => {
  it("creates, updates, and deletes an unreferenced category", async () => {
    const auth = await authHeaders();
    const created = await post<{ category: { id: number; name: string } }>("/api/pricebook/categories", { name: "HVAC Parts" }, auth);
    expect(created.response.status).toBe(201);
    const id = created.body.category.id;

    const updated = await put(`/api/pricebook/categories/${id}`, { name: "HVAC Parts & Accessories" }, auth);
    expect(updated.response.status).toBe(200);

    const deleted = await del(`/api/pricebook/categories/${id}`, auth);
    expect(deleted.response.status).toBe(200);
  });

  it("blocks deleting a category that has items, and a category that has child categories", async () => {
    const auth = await authHeaders();
    const parent = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Parent" }, auth);
    const child = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Child", parent_category_id: parent.body.category.id }, auth);
    const deleteParent = await del(`/api/pricebook/categories/${parent.body.category.id}`, auth);
    expect(deleteParent.response.status).toBe(409);

    const withItem = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Has Items" }, auth);
    await makeItem(auth, { name: "Categorized", category_id: withItem.body.category.id });
    const deleteWithItem = await del(`/api/pricebook/categories/${withItem.body.category.id}`, auth);
    expect(deleteWithItem.response.status).toBe(409);

    // child itself has no dependents, so it is deletable.
    const deleteChild = await del(`/api/pricebook/categories/${child.body.category.id}`, auth);
    expect(deleteChild.response.status).toBe(200);
  });

  it("rejects a category being made its own parent", async () => {
    const auth = await authHeaders();
    const cat = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Self" }, auth);
    const res = await put(`/api/pricebook/categories/${cat.body.category.id}`, { parent_category_id: cat.body.category.id }, auth);
    // "invalid_category" is mapped to 404 by pricebookErrorResponse (same
    // bucket as "category not found") — a deliberate, if slightly coarse,
    // shared-error-mapper choice (src/server/index.ts), not a 400.
    expect(res.response.status).toBe(404);
  });

  it("rejects assigning an item to a category from another organization", async () => {
    const auth = await authHeaders();
    const fixture = await createSecondOrganization("Other Org Pricebook");
    const { cookie } = await loginAs(fixture.email, fixture.password);
    const otherAuth: RequestInit = { headers: { cookie } };
    const otherCategory = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Other Org Category" }, otherAuth);

    const res = await post("/api/pricebook", { type: "PART", name: "x", category_id: otherCategory.body.category.id }, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Pricebook — RBAC", () => {
  it("dispatcher can read the catalog but never sees cost/internal fields, and cannot manage it", async () => {
    const admin = await authHeaders();
    const item = await makeItem(admin, { name: "Visible To Dispatcher", cost_cents: 1234, internal_notes: "secret vendor terms", preferred_vendor: "Acme Supply", vendor_sku: "V-1" });
    const dispatch = await dispatcherAuth();

    const list = await request<{ items: PricebookItemBody[] }>("/api/pricebook", dispatch);
    expect(list.response.status).toBe(200);
    expect(list.body.items[0].cost_cents).toBeUndefined();
    expect(list.body.items[0].internal_notes).toBeUndefined();
    expect(list.body.items[0].preferred_vendor).toBeUndefined();
    expect(list.body.items[0].vendor_sku).toBeUndefined();

    const get = await request<{ item: PricebookItemBody }>(`/api/pricebook/${item.id}`, dispatch);
    expect(get.response.status).toBe(200);
    expect(get.body.item.cost_cents).toBeUndefined();
    expect(JSON.stringify(get.body.item)).not.toContain("secret vendor terms");

    const create = await post("/api/pricebook", { type: "PART", name: "x" }, dispatch);
    expect(create.response.status).toBe(403);
    const update = await put(`/api/pricebook/${item.id}`, { name: "y" }, dispatch);
    expect(update.response.status).toBe(403);
    const archive = await post(`/api/pricebook/${item.id}/archive`, {}, dispatch);
    expect(archive.response.status).toBe(403);
    const category = await post("/api/pricebook/categories", { name: "x" }, dispatch);
    expect(category.response.status).toBe(403);
  });

  it("technician is denied all Pricebook routes", async () => {
    const admin = await authHeaders();
    const item = await makeItem(admin);
    const tech = await technicianAuth();

    expect((await request("/api/pricebook", tech)).response.status).toBe(403);
    expect((await request(`/api/pricebook/${item.id}`, tech)).response.status).toBe(403);
    expect((await post("/api/pricebook", { type: "PART", name: "x" }, tech)).response.status).toBe(403);
    expect((await request("/api/pricebook/categories", tech)).response.status).toBe(403);
  });
});

describe("Pricebook — tenant isolation", () => {
  it("an item created in one organization is invisible and unreachable from another", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Org A Item" });

    const fixture = await createSecondOrganization("Org B Pricebook");
    const { cookie } = await loginAs(fixture.email, fixture.password);
    const orgBAuth: RequestInit = { headers: { cookie } };

    const get = await request(`/api/pricebook/${item.id}`, orgBAuth);
    expect(get.response.status).toBe(404);
    const update = await put(`/api/pricebook/${item.id}`, { name: "Hijacked" }, orgBAuth);
    expect(update.response.status).toBe(404);
    const list = await request<{ items: PricebookItemBody[]; total: number }>("/api/pricebook", orgBAuth);
    expect(list.body.total).toBe(0);
  });

  it("an org can reuse the same SKU another organization already uses", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "Org A", sku: "SHARED-SKU" });

    const fixture = await createSecondOrganization("Org B SKU Reuse");
    const { cookie } = await loginAs(fixture.email, fixture.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const res = await post("/api/pricebook", { type: "PART", name: "Org B", sku: "SHARED-SKU" }, orgBAuth);
    expect(res.response.status).toBe(201);
  });
});

describe("Pricebook — audit log", () => {
  it("records created, price_changed, and deactivated events", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { sell_price_cents: 1000, cost_cents: 500 });

    await put(`/api/pricebook/${item.id}`, { sell_price_cents: 1500 }, auth);
    await post(`/api/pricebook/${item.id}/archive`, {}, auth);

    const audit = await request<{ audit: { event_type: string }[] }>(`/api/pricebook/${item.id}/audit`, auth);
    expect(audit.response.status).toBe(200);
    const events = audit.body.audit.map((a) => a.event_type);
    expect(events).toContain("created");
    expect(events).toContain("price_changed");
    expect(events).toContain("deactivated");
  });

  it("does not record a price_changed event for an unrelated field edit", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth);
    await put(`/api/pricebook/${item.id}`, { description: "updated description only" }, auth);
    const audit = await request<{ audit: { event_type: string }[] }>(`/api/pricebook/${item.id}/audit`, auth);
    const priceChanges = audit.body.audit.filter((a) => a.event_type === "price_changed");
    expect(priceChanges).toHaveLength(0);
  });
});

describe("Pricebook — Quote line-item integration and historical price integrity", () => {
  it("creating a line item from a Pricebook selection snapshots its fields", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Snapshot Test Item", unit: "ea", sell_price_cents: 4200, taxable: true });
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);

    const add = await post(`/api/quotes/${quote.id}/line-items`, { pricebook_item_id: item.id, quantity: 1 }, auth);
    expect(add.response.status).toBe(201);

    const detail = await request<{ version: { line_items: { id: number; description: string; unit_price_cents: number; unit: string; taxable: number; pricebook_item_id: number | null }[] } }>(`/api/quotes/${quote.id}`, auth);
    const line = detail.body.version.line_items.find((l) => l.pricebook_item_id === item.id)!;
    expect(line).toBeTruthy();
    expect(line.description).toBe("Snapshot Test Item");
    expect(line.unit).toBe("ea");
    expect(line.unit_price_cents).toBe(4200);
    expect(!!line.taxable).toBe(true);
  });

  it("rejects a line item referencing a nonexistent Pricebook item", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    const res = await post(`/api/quotes/${quote.id}/line-items`, { pricebook_item_id: 999999, quantity: 1 }, auth);
    expect(res.response.status).toBe(404);
  });

  it("a later Pricebook price change never retroactively alters an already-created Quote line item", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Price Drift Item", sell_price_cents: 10000 });
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);

    const add = await post(`/api/quotes/${quote.id}/line-items`, { pricebook_item_id: item.id, quantity: 1 }, auth);
    expect(add.response.status).toBe(201);
    const afterAdd = await request<{ version: { line_items: { id: number; unit_price_cents: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const lineId = afterAdd.body.version.line_items[0].id;

    // Change the catalog price AFTER the line item was created.
    const changed = await put(`/api/pricebook/${item.id}`, { sell_price_cents: 99999 }, auth);
    expect(changed.response.status).toBe(200);

    const reread = await request<{ version: { line_items: { id: number; unit_price_cents: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const line = reread.body.version.line_items.find((l) => l.id === lineId)!;
    expect(line.unit_price_cents).toBe(10000); // unchanged — the snapshot, not the live catalog price.

    // A brand-new line item added now DOES pick up the new price.
    await post(`/api/quotes/${quote.id}/line-items`, { pricebook_item_id: item.id, quantity: 1 }, auth);
    const rereadAgain = await request<{ version: { line_items: { unit_price_cents: number; pricebook_item_id: number | null }[] } }>(`/api/quotes/${quote.id}`, auth);
    const newLine = rereadAgain.body.version.line_items.find((l) => l.pricebook_item_id === item.id && l.unit_price_cents === 99999);
    expect(newLine).toBeTruthy();
  });

  it("archiving a Pricebook item does not affect a Quote that already selected it", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Archive-safe Item", sell_price_cents: 3000 });
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/line-items`, { pricebook_item_id: item.id, quantity: 1 }, auth);

    await post(`/api/pricebook/${item.id}/archive`, {}, auth);

    const reread = await request<{ version: { line_items: { unit_price_cents: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    expect(reread.body.version.line_items[0].unit_price_cents).toBe(3000);
  });
});

describe("Pricebook — mass assignment", () => {
  it("rejects an unknown field on create", async () => {
    const auth = await authHeaders();
    const res = await post("/api/pricebook", { type: "PART", name: "x", not_a_real_field: "hack" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an unknown field on category create", async () => {
    const auth = await authHeaders();
    const res = await post("/api/pricebook/categories", { name: "x", organization_id: 999 }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Pricebook — organization_id isolation via default org", () => {
  it("every item created lands in the actor's own organization_id", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "Scoped" });
    const rows = await queryDb<{ organization_id: number }>("SELECT organization_id FROM pricebook_items WHERE name = 'Scoped'");
    expect(rows[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);
  });
});

// Independent testing review (Phase 17) found several real coverage gaps
// in the sections above — closed here rather than by padding the existing
// tests, so each gap maps to one clearly-named test.

describe("Pricebook — category list endpoint and cross-org category isolation", () => {
  it("lists categories with their fields, and active_only filters out inactive ones", async () => {
    const auth = await authHeaders();
    await post("/api/pricebook/categories", { name: "Active Cat" }, auth);
    const inactive = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Inactive Cat", active: false }, auth);
    expect(inactive.response.status).toBe(201);

    const all = await request<{ categories: { name: string; active: boolean }[] }>("/api/pricebook/categories", auth);
    expect(all.response.status).toBe(200);
    expect(all.body.categories.map((c) => c.name).sort()).toEqual(["Active Cat", "Inactive Cat"]);

    const activeOnly = await request<{ categories: { name: string }[] }>("/api/pricebook/categories?active_only=true", auth);
    expect(activeOnly.body.categories.map((c) => c.name)).toEqual(["Active Cat"]);
  });

  it("a category created in one organization is unreachable (PUT/DELETE) from another", async () => {
    const auth = await authHeaders();
    const cat = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Org A Category" }, auth);

    const fixture = await createSecondOrganization("Org B Category Isolation");
    const { cookie } = await loginAs(fixture.email, fixture.password);
    const orgBAuth: RequestInit = { headers: { cookie } };

    const update = await put(`/api/pricebook/categories/${cat.body.category.id}`, { name: "Hijacked" }, orgBAuth);
    expect(update.response.status).toBe(404);
    const deleted = await del(`/api/pricebook/categories/${cat.body.category.id}`, orgBAuth);
    expect(deleted.response.status).toBe(404);
  });
});

describe("Pricebook — RBAC: technician denied on every route", () => {
  it("returns 403 for archive, activate, audit, and every category route", async () => {
    const admin = await authHeaders();
    const item = await makeItem(admin);
    const cat = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "Tech Denied Cat" }, admin);
    const tech = await technicianAuth();

    expect((await put(`/api/pricebook/${item.id}`, { name: "x" }, tech)).response.status).toBe(403);
    expect((await post(`/api/pricebook/${item.id}/archive`, {}, tech)).response.status).toBe(403);
    expect((await post(`/api/pricebook/${item.id}/activate`, {}, tech)).response.status).toBe(403);
    expect((await request(`/api/pricebook/${item.id}/audit`, tech)).response.status).toBe(403);
    expect((await put(`/api/pricebook/categories/${cat.body.category.id}`, { name: "x" }, tech)).response.status).toBe(403);
    expect((await del(`/api/pricebook/categories/${cat.body.category.id}`, tech)).response.status).toBe(403);
  });
});

describe("Pricebook — mass assignment on update paths", () => {
  it("rejects an unknown field on item update", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth);
    const res = await put(`/api/pricebook/${item.id}`, { name: "y", not_a_real_field: "hack" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects an unknown field on category update", async () => {
    const auth = await authHeaders();
    const cat = await post<{ category: { id: number } }>("/api/pricebook/categories", { name: "x" }, auth);
    const res = await put(`/api/pricebook/categories/${cat.body.category.id}`, { name: "y", id: 999 }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Pricebook — search escaping and cross-org search leakage", () => {
  it("treats literal LIKE metacharacters (%, _) in search as literal text, not wildcards, and never 500s on a wildcard-heavy value", async () => {
    const auth = await authHeaders();
    const literalMatch = await makeItem(auth, { name: "Acme_Part%Co", sku: "" });
    await makeItem(auth, { name: "AcmeXPartYCo", sku: "" });

    const literal = await request<{ items: { id: number }[] }>(`/api/pricebook?search=${encodeURIComponent("Acme_Part%Co")}`, auth);
    expect(literal.response.status).toBe(200);
    expect(literal.body.items.map((i) => i.id)).toEqual([literalMatch.id]);

    const heavy = "%_".repeat(60);
    const res = await request(`/api/pricebook?search=${encodeURIComponent(heavy)}`, auth);
    expect(res.response.status).toBe(400);
  });

  it("a search in one organization never returns a same-named item from another organization", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "Cross Org Search Target", sku: "" });

    const fixture = await createSecondOrganization("Org B Search Leakage");
    const { cookie } = await loginAs(fixture.email, fixture.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    await post("/api/pricebook", { type: "PART", name: "Cross Org Search Target", sku: "" }, orgBAuth);

    const orgASearch = await request<{ items: { id: number }[]; total: number }>("/api/pricebook?search=Cross+Org+Search+Target", auth);
    expect(orgASearch.body.total).toBe(1);
  });
});

describe("Pricebook — pagination edge cases", () => {
  it("returns an empty array (not an error) when offset exceeds the total", async () => {
    const auth = await authHeaders();
    await makeItem(auth, { name: "Only Item", sku: "" });
    const res = await request<{ items: unknown[]; total: number }>("/api/pricebook?offset=50", auth);
    expect(res.response.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(1);
  });

  it("clamps an out-of-range limit instead of erroring", async () => {
    const auth = await authHeaders();
    for (let i = 0; i < 3; i++) await makeItem(auth, { name: `Clamp ${i}`, sku: "" });
    const zero = await request<{ items: unknown[] }>("/api/pricebook?limit=0", auth);
    expect(zero.response.status).toBe(200);
    expect(zero.body.items.length).toBeGreaterThan(0);
    const huge = await request<{ items: unknown[] }>("/api/pricebook?limit=99999", auth);
    expect(huge.response.status).toBe(200);
  });
});

describe("Pricebook — audit log detail content", () => {
  it("records the old and new price in the price_changed event's details", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { sell_price_cents: 1000, cost_cents: 500 });
    await put(`/api/pricebook/${item.id}`, { sell_price_cents: 1500, cost_cents: 700 }, auth);

    const audit = await request<{ audit: { event_type: string; details: string }[] }>(`/api/pricebook/${item.id}/audit`, auth);
    const priceChange = audit.body.audit.find((a) => a.event_type === "price_changed")!;
    expect(priceChange).toBeTruthy();
    const details = JSON.parse(priceChange.details);
    expect(details.old_sell_price_cents).toBe(1000);
    expect(details.new_sell_price_cents).toBe(1500);
    expect(details.old_cost_cents).toBe(500);
    expect(details.new_cost_cents).toBe(700);
  });
});

describe("Pricebook — Quote line-item update path", () => {
  it("rejects updating a line item to reference a nonexistent Pricebook item", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/line-items`, { description: "Manual line", quantity: 1, unit_price_cents: 100 }, auth);
    const detail = await request<{ version: { line_items: { id: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const lineId = detail.body.version.line_items[0].id;

    const res = await put(`/api/quotes/${quote.id}/line-items/${lineId}`, { pricebook_item_id: 999999 }, auth);
    expect(res.response.status).toBe(404);
  });

  it("updating a line item's pricebook_item_id does not re-snapshot description/price/taxable (update ≠ create)", async () => {
    const auth = await authHeaders();
    const item = await makeItem(auth, { name: "Update Snapshot Item", unit: "ea", sell_price_cents: 8000, taxable: true });
    const customerId = await makeCustomer(auth);
    const quote = await makeQuote(auth, customerId);
    await post(`/api/quotes/${quote.id}/line-items`, { description: "Original manual description", quantity: 1, unit_price_cents: 111, taxable: false }, auth);
    const detail = await request<{ version: { line_items: { id: number }[] } }>(`/api/quotes/${quote.id}`, auth);
    const lineId = detail.body.version.line_items[0].id;

    const res = await put(`/api/quotes/${quote.id}/line-items/${lineId}`, { pricebook_item_id: item.id }, auth);
    expect(res.response.status).toBe(200);

    const reread = await request<{ version: { line_items: { id: number; description: string; unit_price_cents: number; taxable: number; pricebook_item_id: number | null }[] } }>(`/api/quotes/${quote.id}`, auth);
    const line = reread.body.version.line_items.find((l) => l.id === lineId)!;
    expect(line.pricebook_item_id).toBe(item.id);
    // Unchanged — only the provenance pointer was updated, not the line's
    // own already-stored description/price/taxable (update deliberately
    // does not re-snapshot, unlike create).
    expect(line.description).toBe("Original manual description");
    expect(line.unit_price_cents).toBe(111);
    expect(!!line.taxable).toBe(false);
  });
});
