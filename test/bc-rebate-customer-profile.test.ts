import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createCustomer, del, executeStatements,
  post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

// The exact backfill statement from migrations/0014_bc_rebate_customer_profile.sql,
// re-run here against synthetic rows inserted directly via raw SQL (bypassing the
// app's own API) to simulate customers that already existed BEFORE this migration
// — the standard per-test-file applySchema() flow only ever exercises a fresh DB,
// so this is the smallest realistic harness for the actual upgrade-path backfill
// logic, per this phase's own explicit allowance for that constraint.
const BACKFILL_SQL = `
  INSERT INTO bc_rebate_customer_profiles
    (customer_id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income, created_at, updated_at)
  SELECT id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income, created_at, updated_at
  FROM customers
  WHERE id = ?
    AND (house_size IS NOT NULL OR primary_heating_source != '' OR number_of_adults IS NOT NULL
         OR number_of_children IS NOT NULL OR household_income IS NOT NULL)
`;

describe("bc_rebate_customer_profiles migration and backfill", () => {
  it("applies cleanly to a fresh database (proven by every other test file in this suite booting via the same applySchema())", async () => {
    const rows = await queryDb("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bc_rebate_customer_profiles'");
    expect(rows).toHaveLength(1);
  });

  it("backfills a pre-existing rebate customer's exact values, and leaves a blank customer with no row", async () => {
    // Simulate two "pre-migration" customer rows via raw SQL — direct column
    // writes, exactly what the old customers.house_size/etc columns held
    // before Phase 11.3, never touching the new table.
    await executeStatements([
      `INSERT INTO customers (id, name, email, phone, address, city, state, zip, notes,
         referral_source, referral_name, referred_by_customer_id,
         house_size, primary_heating_source, number_of_adults, number_of_children, household_income)
       VALUES (9001, 'Legacy Rebate Household', 'legacy@example.test', '555-0001', '1 Old Rd', 'Burnaby', 'BC', 'V5A 1A1', '',
         'Google', '', NULL, 1750, 'Heat Pump', 2, 1, 92000)`,
      `INSERT INTO customers (id, name, email, phone, address, city, state, zip, notes,
         referral_source, referral_name, referred_by_customer_id,
         house_size, primary_heating_source, number_of_adults, number_of_children, household_income)
       VALUES (9002, 'Legacy Plain Household', 'legacy2@example.test', '555-0002', '2 Old Rd', 'Burnaby', 'BC', 'V5A 1A1', '',
         '', '', NULL, NULL, '', NULL, NULL, NULL)`,
    ]);

    await executeStatements([BACKFILL_SQL.replace("?", "9001")]);
    await executeStatements([BACKFILL_SQL.replace("?", "9002")]);

    const migrated = await queryDb<{
      customer_id: number; house_size: number; primary_heating_source: string;
      number_of_adults: number; number_of_children: number; household_income: number;
    }>("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = 9001");
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      house_size: 1750, primary_heating_source: "Heat Pump", number_of_adults: 2, number_of_children: 1, household_income: 92000,
    });

    // A customer with no rebate data on file never gets a row — matches the
    // original "do not assume these fields apply to every customer" intent.
    const blank = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = 9002");
    expect(blank).toHaveLength(0);

    // Unrelated customer fields (name/email/etc.) are completely untouched by the backfill.
    const customerRow = await queryDb<{ name: string; email: string }>("SELECT name, email FROM customers WHERE id = 9001");
    expect(customerRow[0]).toMatchObject({ name: "Legacy Rebate Household", email: "legacy@example.test" });
  });

  it("backfill preserves null fields as null, not zero or empty defaults", async () => {
    await executeStatements([
      `INSERT INTO customers (id, name, email, phone, address, city, state, zip, notes,
         referral_source, referral_name, referred_by_customer_id,
         house_size, primary_heating_source, number_of_adults, number_of_children, household_income)
       VALUES (9003, 'Partial Rebate Household', 'partial@example.test', '555-0003', '3 Old Rd', 'Burnaby', 'BC', 'V5A 1A1', '',
         '', '', NULL, NULL, 'Natural Gas', NULL, NULL, NULL)`,
    ]);
    await executeStatements([BACKFILL_SQL.replace("?", "9003")]);

    const rows = await queryDb<{ house_size: number | null; household_income: number | null; primary_heating_source: string }>(
      "SELECT house_size, household_income, primary_heating_source FROM bc_rebate_customer_profiles WHERE customer_id = 9003"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].house_size).toBeNull();
    expect(rows[0].household_income).toBeNull();
    expect(rows[0].primary_heating_source).toBe("Natural Gas");
  });

  it("enforces at most one profile row per customer at the database level", async () => {
    await executeStatements([
      `INSERT INTO customers (id, name, email, phone, address, city, state, zip, notes,
         referral_source, referral_name, referred_by_customer_id,
         house_size, primary_heating_source, number_of_adults, number_of_children, household_income)
       VALUES (9004, 'Dup Test Household', 'dup@example.test', '555-0004', '4 Old Rd', 'Burnaby', 'BC', 'V5A 1A1', '',
         '', '', NULL, 1500, 'Electric', 1, 0, 60000)`,
      "INSERT INTO bc_rebate_customer_profiles (customer_id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income) VALUES (9004, 1500, 'Electric', 1, 0, 60000)",
    ]);
    await expect(
      executeStatements(["INSERT INTO bc_rebate_customer_profiles (customer_id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income) VALUES (9004, 9999, 'Oil', 5, 5, 999999)"])
    ).rejects.toThrow();

    // The original row is untouched by the rejected duplicate insert attempt.
    const rows = await queryDb<{ house_size: number }>("SELECT house_size FROM bc_rebate_customer_profiles WHERE customer_id = 9004");
    expect(rows).toHaveLength(1);
    expect(rows[0].house_size).toBe(1500);
  });

  it("cascades profile deletion when the owning customer is deleted", async () => {
    const auth = await authHeaders();
    const customer = await post<{ id: number }>("/api/customers", {
      name: "Cascade Test", house_size: 1200, primary_heating_source: "Oil",
    }, auth);
    expect(customer.response.status).toBe(201);
    const before = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [customer.body.id]);
    expect(before).toHaveLength(1);

    const deleted = await del(`/api/customers/${customer.body.id}`, auth);
    expect(deleted.response.status).toBe(200);

    const after = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [customer.body.id]);
    expect(after).toHaveLength(0);
  });
});

describe("customer rebate profile — authoritative storage and API compatibility", () => {
  it("does not create a profile row for a customer with no rebate fields", async () => {
    const customer = await createCustomer();
    const rows = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [customer.id]);
    expect(rows).toHaveLength(0);
  });

  it("round-trips rebate fields through create, matching the pre-extraction API contract exactly", async () => {
    const auth = await authHeaders();
    const created = await post<{ id: number; house_size: number; primary_heating_source: string; number_of_adults: number; number_of_children: number; household_income: number }>(
      "/api/customers",
      { name: "Round Trip", house_size: 2100, primary_heating_source: "Propane", number_of_adults: 3, number_of_children: 2, household_income: 110000 },
      auth
    );
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ house_size: 2100, primary_heating_source: "Propane", number_of_adults: 3, number_of_children: 2, household_income: 110000 });

    // The legacy customers columns are no longer written — proves the new
    // table is the sole authoritative write path, not a dual write.
    const legacyRow = await queryDb<{ house_size: number | null }>("SELECT house_size FROM customers WHERE id = ?", [created.body.id]);
    expect(legacyRow[0].house_size).toBeNull();

    const profileRow = await queryDb<{ house_size: number }>("SELECT house_size FROM bc_rebate_customer_profiles WHERE customer_id = ?", [created.body.id]);
    expect(profileRow).toHaveLength(1);
    expect(profileRow[0].house_size).toBe(2100);
  });

  it("updates only the fields touched by a partial PUT, preserving the rest of the profile", async () => {
    const auth = await authHeaders();
    const created = await post<{ id: number }>("/api/customers", {
      name: "Partial Update", house_size: 1600, primary_heating_source: "Electric", number_of_adults: 2, number_of_children: 0, household_income: 80000,
    }, auth);

    const updated = await put(`/api/customers/${created.body.id}`, { household_income: 95000 }, auth);
    expect(updated.response.status).toBe(200);

    const fetched = await request<{ customer: { house_size: number; primary_heating_source: string; household_income: number } }>(
      `/api/customers/${created.body.id}`, auth
    );
    expect(fetched.body.customer).toMatchObject({ house_size: 1600, primary_heating_source: "Electric", household_income: 95000 });

    // Still exactly one profile row — an UPSERT, never a second row.
    const rows = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [created.body.id]);
    expect(rows).toHaveLength(1);
  });

  it("creates a profile row on first update for a customer that had none, without touching unrelated fields", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();

    const plainUpdate = await put(`/api/customers/${customer.id}`, { phone: "555-9999" }, auth);
    expect(plainUpdate.response.status).toBe(200);
    let rows = await queryDb("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [customer.id]);
    expect(rows).toHaveLength(0); // an unrelated field never creates a profile row

    const rebateUpdate = await put(`/api/customers/${customer.id}`, { house_size: 1400 }, auth);
    expect(rebateUpdate.response.status).toBe(200);
    rows = await queryDb<{ house_size: number; primary_heating_source: string }>("SELECT * FROM bc_rebate_customer_profiles WHERE customer_id = ?", [customer.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].house_size).toBe(1400);
    expect(rows[0].primary_heating_source).toBe(""); // untouched field defaults, not fabricated

    const fetched = await request<{ customer: { phone: string; house_size: number } }>(`/api/customers/${customer.id}`, auth);
    expect(fetched.body.customer.phone).toBe("555-9999"); // the earlier plain update is preserved too
  });

  it("a Lead-converted customer (never touches rebate fields) shows blank rebate data via the compatibility read path", async () => {
    const auth = await authHeaders();
    const lead = await post<{ id: number }>("/api/leads", {
      name: "Converted Lead", phone: "555-0177", email: "convert@example.test",
    }, auth);
    expect(lead.response.status).toBe(201);
    for (const to_status of ["contacted", "qualified", "estimate"]) {
      const t = await post(`/api/leads/${lead.body.id}/transition`, { to_status }, auth);
      expect(t.response.status).toBe(200);
    }
    const converted = await post<{ customer: { id: number; house_size: number | null; primary_heating_source: string } }>(
      `/api/leads/${lead.body.id}/convert`, {}, auth
    );
    expect(converted.response.status).toBe(201);
    expect(converted.body.customer.house_size).toBeNull();
    expect(converted.body.customer.primary_heating_source).toBe("");

    // getCustomer's own SELECT (not just the conversion response) agrees.
    const fetched = await request<{ customer: { house_size: number | null; primary_heating_source: string } }>(
      `/api/customers/${converted.body.customer.id}`, auth
    );
    expect(fetched.body.customer.house_size).toBeNull();
    expect(fetched.body.customer.primary_heating_source).toBe("");
  });

  it("listCustomers reflects the profile-table source of truth, not stale legacy columns", async () => {
    const auth = await authHeaders();
    const created = await post<{ id: number }>("/api/customers", { name: "List Check", house_size: 1900 }, auth);
    await put(`/api/customers/${created.body.id}`, { house_size: 2200 }, auth);

    const list = await request<{ customers: { id: number; house_size: number }[] }>("/api/customers?limit=50", auth);
    const found = list.body.customers.find((c) => c.id === created.body.id);
    expect(found?.house_size).toBe(2200);
  });
});

describe("rebate program registry", () => {
  it("keeps CLEANBC and BC_HYDRO independently registered with their own criteria sets", async () => {
    const { evaluateRebateEligibility } = await import("../src/server/modules/programs/bc/rebate.js");
    const profile = { house_size: 1500, primary_heating_source: "Electric", number_of_adults: 2, number_of_children: 0, household_income: 50000 };
    const cleanbc = await evaluateRebateEligibility(DEFAULT_ORGANIZATION_ID, "CLEANBC", profile);
    const bcHydro = await evaluateRebateEligibility(DEFAULT_ORGANIZATION_ID, "BC_HYDRO", profile);
    expect(cleanbc.criteria.map((c) => c.key).sort()).toEqual(["house_size", "household_income"]);
    expect(bcHydro.criteria.map((c) => c.key)).toEqual(["household_income"]);
  });

  it("a job type with no registered program (STANDARD) safely yields zero criteria, never a crash or a borrowed program's rules", async () => {
    const { evaluateRebateEligibility } = await import("../src/server/modules/programs/bc/rebate.js");
    const profile = { house_size: null, primary_heating_source: "", number_of_adults: null, number_of_children: null, household_income: null };
    const result = await evaluateRebateEligibility(DEFAULT_ORGANIZATION_ID, "STANDARD", profile);
    expect(result.criteria).toEqual([]);
    expect(result.allowed).toBeNull();
    expect(result.thresholds_used).toEqual({});
  });

  it("an unrecognized job type is rejected safely by the registry, not silently mapped to CleanBC/BC Hydro's rules", async () => {
    const { evaluateRebateEligibility } = await import("../src/server/modules/programs/bc/rebate.js");
    const profile = { house_size: 1500, primary_heating_source: "Electric", number_of_adults: 2, number_of_children: 0, household_income: 50000 };
    // Cast through unknown — TypeScript's JobType union normally prevents this
    // at compile time; this proves the runtime registry itself is also safe,
    // not just the type system, per the task's explicit "no 500 from unknown
    // program lookup" requirement.
    const result = await evaluateRebateEligibility(DEFAULT_ORGANIZATION_ID, "UNKNOWN_PROGRAM" as unknown as "STANDARD", profile);
    expect(result.criteria).toEqual([]);
    expect(result.allowed).toBeNull();
  });
});
