import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  post, put, queryDb, request, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function publishThreshold(key: string, value: string, auth: RequestInit, effectiveFrom?: string) {
  const res = await post("/api/settings", {
    key, value, data_type: "number", category: "rebate", effective_from: effectiveFrom,
  }, auth);
  expect(res.response.status).toBe(201);
}

async function createRebateCustomer(overrides: Record<string, unknown> = {}, auth?: RequestInit) {
  const res = await post<{ id: number }>("/api/customers", {
    name: "Rebate Household", email: "rebate@example.test", phone: "555-0199", address: "1 Rebate Ln",
    house_size: 1600, primary_heating_source: "Natural Gas", number_of_adults: 2, number_of_children: 1,
    household_income: 85000, referral_source: "Google",
    ...overrides,
  }, auth ?? (await authHeaders()));
  expect(res.response.status).toBe(201);
  return res.body;
}

async function createCleanBCJob(customerId: number, auth: RequestInit) {
  const res = await post<{ id: number; status: string }>("/api/jobs", {
    customer_id: customerId, job_type: "CLEANBC", scheduled_date: "2026-09-01",
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body;
}

describe("referral source and rebate customer profile", () => {
  it("stores referral source and rebate fields on a customer", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const fetched = await request<{ customer: { referral_source: string; house_size: number; household_income: number } }>(
      `/api/customers/${customer.id}`, auth
    );
    expect(fetched.body.customer).toMatchObject({
      referral_source: "Google", house_size: 1600, household_income: 85000,
    });
  });

  it("leaves rebate fields blank for a non-rebate customer (not assumed required)", async () => {
    const customer = await createCustomer();
    const auth = await authHeaders();
    const fetched = await request<{ customer: { house_size: number | null; referral_source: string } }>(
      `/api/customers/${customer.id}`, auth
    );
    expect(fetched.body.customer.house_size).toBeNull();
    expect(fetched.body.customer.referral_source).toBe("");
  });

  it("exposes the configurable referral-source and heating-source option lists via Global Settings", async () => {
    const auth = await authHeaders();
    const res = await request<{ settings: { key: string; value: string }[] }>("/api/settings?category=reference_data", auth);
    const referral = res.body.settings.find((s) => s.key === "REFERRAL_SOURCE_OPTIONS");
    const heating = res.body.settings.find((s) => s.key === "HEATING_SOURCE_OPTIONS");
    expect(JSON.parse(referral!.value)).toContain("Word of Mouth");
    expect(JSON.parse(heating!.value)).toContain("Heat Pump");
  });

  it("rejects a technician from setting rebate/referral fields on a customer", async () => {
    await createUser({ email: "tech-cust@example.test", password: "TechPass123", role: "technician" });
    const { cookie } = await loginAs("tech-cust@example.test", "TechPass123");
    const techAuth: RequestInit = { headers: { cookie } };

    const create = await post("/api/customers", { name: "X", house_size: 1500 }, techAuth);
    expect(create.response.status).toBe(403);

    const plainCreate = await post("/api/customers", { name: "X", email: "x@example.test" }, techAuth);
    expect(plainCreate.response.status).toBe(201); // ordinary fields still fine for a technician

    const update = await put(`/api/customers/${(plainCreate.body as { id: number }).id}`, { household_income: 50000 }, techAuth);
    expect(update.response.status).toBe(403);
  });
});

describe("rebate eligibility calculator (Global Settings driven)", () => {
  it("reports unconfigured thresholds as null, not a false pass or fail", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const result = await request<{ allowed: boolean | null; criteria: { satisfied: boolean | null }[] }>(
      `/api/customers/${customer.id}/rebate-eligibility?job_type=CLEANBC`, auth
    );
    expect(result.response.status).toBe(200);
    expect(result.body.allowed).toBeNull();
    expect(result.body.criteria.every((c) => c.satisfied === null)).toBe(true);
  });

  it("evaluates CleanBC eligibility against configured house-size and income thresholds", async () => {
    const auth = await authHeaders();
    await publishThreshold("CLEANBC_MAX_HOUSE_SIZE", "1800", auth);
    await publishThreshold("CLEANBC_MAX_HOUSEHOLD_INCOME", "100000", auth);

    const eligible = await createRebateCustomer({ house_size: 1600, household_income: 85000 }, auth);
    const eligibleResult = await request<{ allowed: boolean }>(`/api/customers/${eligible.id}/rebate-eligibility?job_type=CLEANBC`, auth);
    expect(eligibleResult.body.allowed).toBe(true);

    const ineligible = await createRebateCustomer({ email: "big@example.test", house_size: 3000, household_income: 200000 }, auth);
    const ineligibleResult = await request<{ allowed: boolean; criteria: { satisfied: boolean }[] }>(
      `/api/customers/${ineligible.id}/rebate-eligibility?job_type=CLEANBC`, auth
    );
    expect(ineligibleResult.body.allowed).toBe(false);
    expect(ineligibleResult.body.criteria.every((c) => c.satisfied === false)).toBe(true);
  });

  it("evaluates BC Hydro on income only — never requires CleanBC-only fields", async () => {
    const auth = await authHeaders();
    await publishThreshold("BC_HYDRO_MAX_HOUSEHOLD_INCOME", "90000", auth);
    const customer = await createRebateCustomer({ house_size: null, household_income: 60000 }, auth);

    const result = await request<{ allowed: boolean; criteria: { key: string }[] }>(
      `/api/customers/${customer.id}/rebate-eligibility?job_type=BC_HYDRO`, auth
    );
    expect(result.response.status).toBe(200);
    expect(result.body.allowed).toBe(true);
    expect(result.body.criteria.map((c) => c.key)).toEqual(["household_income"]);
  });

  it("rejects an eligibility check for a STANDARD job", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await createJob(customer.id, "2026-09-01");
    const result = await post(`/api/jobs/${job.id}/eligibility-check`, {}, auth);
    expect(result.response.status).toBe(400);
  });

  it("rejects a technician from running an eligibility check", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await createCleanBCJob(customer.id, auth);
    await createUser({ email: "tech-elig@example.test", password: "TechPass123", role: "technician" });
    const { cookie } = await loginAs("tech-elig@example.test", "TechPass123");

    const result = await post(`/api/jobs/${job.id}/eligibility-check`, {}, { headers: { cookie } });
    expect(result.response.status).toBe(403);
  });
});

describe("historical rule reproducibility", () => {
  it("keeps a past eligibility check's recorded thresholds stable after Global Settings changes", async () => {
    const auth = await authHeaders();
    await publishThreshold("CLEANBC_MAX_HOUSE_SIZE", "1800", auth);
    await publishThreshold("CLEANBC_MAX_HOUSEHOLD_INCOME", "100000", auth);

    const customer = await createRebateCustomer({ house_size: 1600, household_income: 85000 }, auth);
    const job = await createCleanBCJob(customer.id, auth);

    const firstCheck = await post<{ allowed: boolean }>(`/api/jobs/${job.id}/eligibility-check`, {}, auth);
    expect(firstCheck.response.status).toBe(200);
    expect(firstCheck.body.allowed).toBe(true);

    // Tighten the income threshold well below this customer's income, effective in the future.
    const future = new Date(Date.now() + 60_000).toISOString();
    await publishThreshold("CLEANBC_MAX_HOUSEHOLD_INCOME", "50000", auth, future);

    const rows = await queryDb<{ details: string }>(
      "SELECT details FROM job_rebate_audit WHERE job_id = ? AND event_type = 'eligibility_check' ORDER BY id ASC", [job.id]
    );
    expect(rows).toHaveLength(1);
    const snapshot = JSON.parse(rows[0].details);
    expect(snapshot.result.allowed).toBe(true); // untouched by the later threshold change
    expect(snapshot.result.thresholds_used.CLEANBC_MAX_HOUSEHOLD_INCOME).toBe(100000);
  });
});

describe("eligibility code correction and audit trail", () => {
  it("records a code/expiry correction after eligibility approval, and rejects before it", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await createCleanBCJob(customer.id, auth);

    const tooEarly = await put(`/api/jobs/${job.id}/eligibility`, { eligibility_code: "CB-999" }, auth);
    expect(tooEarly.response.status).toBe(400);

    await post(`/api/jobs/${job.id}/transition`, { to_status: "application_pending" }, auth);
    await post(`/api/jobs/${job.id}/transition`, {
      to_status: "eligibility_approved", eligibility_code: "CB-100", eligibility_code_expiry: "2027-06-01",
    }, auth);

    const corrected = await put(`/api/jobs/${job.id}/eligibility`, { eligibility_code: "CB-101" }, auth);
    expect(corrected.response.status).toBe(200);

    const audit = await request<{ audit: { event_type: string; details: string }[] }>(`/api/jobs/${job.id}/rebate-audit`, auth);
    const codeUpdate = audit.body.audit.find((a) => a.event_type === "code_updated");
    expect(codeUpdate).toBeTruthy();
    expect(JSON.parse(codeUpdate!.details)).toMatchObject({ old: "CB-100", new: "CB-101" });
  });

  it("rejects a technician from correcting an eligibility code", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await createCleanBCJob(customer.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "application_pending" }, auth);
    await post(`/api/jobs/${job.id}/transition`, {
      to_status: "eligibility_approved", eligibility_code: "CB-1", eligibility_code_expiry: "2027-06-01",
    }, auth);

    await createUser({ email: "tech-edit@example.test", password: "TechPass123", role: "technician" });
    const { cookie } = await loginAs("tech-edit@example.test", "TechPass123");
    const result = await put(`/api/jobs/${job.id}/eligibility`, { eligibility_code: "CB-2" }, { headers: { cookie } });
    expect(result.response.status).toBe(403);
  });

  it("rejects an eligibility edit on a BC Hydro job (no eligibility code concept)", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customer.id, job_type: "BC_HYDRO", scheduled_date: "2026-09-01" }, auth);
    const result = await put(`/api/jobs/${job.body.id}/eligibility`, { eligibility_code: "X" }, auth);
    expect(result.response.status).toBe(400);
  });
});

describe("eligibility code tracker", () => {
  it("classifies active, expiring soon, expired, and submitted codes correctly", async () => {
    const auth = await authHeaders();
    await publishThreshold("CLEANBC_ELIGIBILITY_WARNING_DAYS", "10", auth);
    const customer = await createRebateCustomer({}, auth);

    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().split("T")[0];
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString().split("T")[0];
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];

    async function approvedJob(expiry: string) {
      const job = await createCleanBCJob(customer.id, auth);
      await post(`/api/jobs/${job.id}/transition`, { to_status: "application_pending" }, auth);
      await post(`/api/jobs/${job.id}/transition`, {
        to_status: "eligibility_approved", eligibility_code: `CB-${job.id}`, eligibility_code_expiry: expiry,
      }, auth);
      return job.id;
    }

    const expiringId = await approvedJob(soon);
    const activeId = await approvedJob(far);
    const expiredId = await approvedJob(past);
    const submittedId = await approvedJob(far);
    // Drive the submitted job all the way to gov_portal_submitted.
    const tech = await post<{ id: number }>("/api/technicians", { name: "Tracker Tech" }, auth);
    await put(`/api/jobs/${submittedId}`, { technician_id: tech.body.id }, auth);
    for (const status of ["install_scheduled", "in_progress", "completed", "gov_portal_submitted"]) {
      if (status === "completed") await satisfyCompletionRequirements(submittedId, auth);
      await post(`/api/jobs/${submittedId}/transition`, { to_status: status }, auth);
    }

    const tracker = await request<{ rows: { id: number; code_status: string }[]; warning_days_configured: boolean }>(
      "/api/jobs/eligibility-codes", auth
    );
    expect(tracker.body.warning_days_configured).toBe(true);
    const byId = Object.fromEntries(tracker.body.rows.map((r) => [r.id, r.code_status]));
    expect(byId[expiringId]).toBe("expiring_soon");
    expect(byId[activeId]).toBe("active");
    expect(byId[expiredId]).toBe("expired");
    expect(byId[submittedId]).toBe("submitted");
  });

  it("reports warning_days_configured: false when the setting is unset, instead of guessing a window", async () => {
    const auth = await authHeaders();
    const customer = await createRebateCustomer({}, auth);
    const job = await createCleanBCJob(customer.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "application_pending" }, auth);
    await post(`/api/jobs/${job.id}/transition`, {
      to_status: "eligibility_approved", eligibility_code: "CB-1",
      eligibility_code_expiry: new Date(Date.now() + 5 * 86_400_000).toISOString().split("T")[0],
    }, auth);

    const tracker = await request<{ rows: { code_status: string }[]; warning_days_configured: boolean }>("/api/jobs/eligibility-codes", auth);
    expect(tracker.body.warning_days_configured).toBe(false);
    expect(tracker.body.rows[0].code_status).toBe("active"); // never silently "expiring_soon" without a configured window
  });
});

describe("standard jobs unaffected by Phase 3", () => {
  it("still creates and transitions a STANDARD job with no rebate fields involved", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    const tech = await post<{ id: number }>("/api/technicians", { name: "Std Tech" }, auth);
    await put(`/api/jobs/${job.id}`, { technician_id: tech.body.id }, auth);
    const result = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    expect(result.response.status).toBe(200);
  });
});
