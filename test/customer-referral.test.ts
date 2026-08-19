import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, del, loginAs,
  post, put, request, resetDatabase,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface CustomerRow {
  id: number;
  referral_source: string;
  referral_name: string;
  referred_by_customer_id: number | null;
  referred_by_customer_name?: string | null;
}

async function createReferralCustomer(overrides: Record<string, unknown> = {}, auth?: RequestInit) {
  return post<{ id: number }>("/api/customers", {
    name: "Referral Test", email: "referral-test@example.test", phone: "555-0111",
    ...overrides,
  }, auth ?? (await authHeaders()));
}

describe("customer referral attribution — create", () => {
  it("requires referral_name when referral_source is Referral", async () => {
    const res = await createReferralCustomer({ referral_source: "Referral" });
    expect(res.response.status).toBe(400);
  });

  it("succeeds and stores referral_name when referral_source is Referral with a name", async () => {
    const res = await createReferralCustomer({ referral_source: "Referral", referral_name: "Jane Smith" });
    expect(res.response.status).toBe(201);
    const auth = await authHeaders();
    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${(res.body as { id: number }).id}`, auth);
    expect(fetched.body.customer.referral_source).toBe("Referral");
    expect(fetched.body.customer.referral_name).toBe("Jane Smith");
    expect(fetched.body.customer.referred_by_customer_id).toBeNull();
  });

  it("requires referred_by_customer_id when referral_source is Existing Customer", async () => {
    const res = await createReferralCustomer({ referral_source: "Existing Customer" });
    expect(res.response.status).toBe(400);
  });

  it("succeeds and stores the FK when referral_source is Existing Customer with a valid id", async () => {
    const referrer = await createCustomer("Referring Customer");
    const res = await createReferralCustomer({
      referral_source: "Existing Customer", referred_by_customer_id: referrer.id,
    });
    expect(res.response.status).toBe(201);
    const auth = await authHeaders();
    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${(res.body as { id: number }).id}`, auth);
    expect(fetched.body.customer.referred_by_customer_id).toBe(referrer.id);
    expect(fetched.body.customer.referred_by_customer_name).toBe("Referring Customer");
    expect(fetched.body.customer.referral_name).toBe("");
  });

  it("rejects a nonexistent referred_by_customer_id", async () => {
    const res = await createReferralCustomer({ referral_source: "Existing Customer", referred_by_customer_id: 999999 });
    expect(res.response.status).toBe(400);
  });

  it("requires neither field, and clears any stray values, for other referral sources", async () => {
    const res = await createReferralCustomer({
      referral_source: "Google", referral_name: "Should Be Ignored", referred_by_customer_id: 1,
    });
    expect(res.response.status).toBe(201);
    const auth = await authHeaders();
    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${(res.body as { id: number }).id}`, auth);
    expect(fetched.body.customer.referral_name).toBe("");
    expect(fetched.body.customer.referred_by_customer_id).toBeNull();
  });
});

describe("customer referral attribution — edit", () => {
  it("loads referral_name correctly and can be changed to another source, clearing it server-side", async () => {
    const auth = await authHeaders();
    const created = await createReferralCustomer({ referral_source: "Referral", referral_name: "Jane Smith" }, auth);
    const id = (created.body as { id: number }).id;

    const changed = await put(`/api/customers/${id}`, { referral_source: "Word of Mouth" }, auth);
    expect(changed.response.status).toBe(200);

    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${id}`, auth);
    expect(fetched.body.customer.referral_source).toBe("Word of Mouth");
    expect(fetched.body.customer.referral_name).toBe("");
  });

  it("loads the referred-by relationship correctly and can be changed to another source, clearing the FK server-side", async () => {
    const auth = await authHeaders();
    const referrer = await createCustomer("Referring Customer 2");
    const created = await createReferralCustomer(
      { referral_source: "Existing Customer", referred_by_customer_id: referrer.id }, auth
    );
    const id = (created.body as { id: number }).id;

    const changed = await put(`/api/customers/${id}`, { referral_source: "Google" }, auth);
    expect(changed.response.status).toBe(200);

    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${id}`, auth);
    expect(fetched.body.customer.referral_source).toBe("Google");
    expect(fetched.body.customer.referred_by_customer_id).toBeNull();
  });

  it("rejects self-referral on update", async () => {
    const auth = await authHeaders();
    const created = await createReferralCustomer({}, auth);
    const id = (created.body as { id: number }).id;

    const res = await put(`/api/customers/${id}`, {
      referral_source: "Existing Customer", referred_by_customer_id: id,
    }, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects setting referral_source to Referral without a name on update, using the pre-existing empty name", async () => {
    const auth = await authHeaders();
    const created = await createReferralCustomer({}, auth);
    const id = (created.body as { id: number }).id;

    const res = await put(`/api/customers/${id}`, { referral_source: "Referral" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("keeps unrelated customer fields untouched when only referral fields change", async () => {
    const auth = await authHeaders();
    const created = await createReferralCustomer({ notes: "Original notes" }, auth);
    const id = (created.body as { id: number }).id;

    await put(`/api/customers/${id}`, { referral_source: "Referral", referral_name: "Bob" }, auth);

    const fetched = await request<{ customer: CustomerRow & { notes: string } }>(`/api/customers/${id}`, auth);
    expect(fetched.body.customer.notes).toBe("Original notes");
    expect(fetched.body.customer.referral_name).toBe("Bob");
  });
});

describe("customer referral attribution — RBAC", () => {
  it("blocks a technician from setting referral_name or referred_by_customer_id", async () => {
    await createUser({ email: "tech-referral@example.test", password: "TechPass123", role: "technician" });
    const { cookie } = await loginAs("tech-referral@example.test", "TechPass123");
    const techAuth: RequestInit = { headers: { cookie } };

    const create = await post("/api/customers", { name: "X", referral_source: "Referral", referral_name: "Bob" }, techAuth);
    expect(create.response.status).toBe(403);

    const plain = await createReferralCustomer({}, await authHeaders());
    const id = (plain.body as { id: number }).id;
    const update = await put(`/api/customers/${id}`, { referred_by_customer_id: 1 }, techAuth);
    expect(update.response.status).toBe(403);
  });
});

describe("customer referral attribution — data integrity", () => {
  it("SET NULLs referred_by_customer_id (does not delete the referred customer) when the referring customer is deleted", async () => {
    const auth = await authHeaders();
    const referrer = await createCustomer("Referrer To Delete");
    const referred = await createReferralCustomer(
      { referral_source: "Existing Customer", referred_by_customer_id: referrer.id }, auth
    );
    const referredId = (referred.body as { id: number }).id;

    const delRes = await del(`/api/customers/${referrer.id}`, auth);
    expect(delRes.response.status).toBe(200);

    const fetched = await request<{ customer: CustomerRow }>(`/api/customers/${referredId}`, auth);
    expect(fetched.response.status).toBe(200);
    expect(fetched.body.customer.referred_by_customer_id).toBeNull();
  });
});
