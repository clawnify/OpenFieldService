import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, executeStatements, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "pref-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "pref-tech@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createLead(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<{ id: number }>("/api/leads", { name: "Pref Test Lead", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  return res.body;
}

interface PreferencesResponse {
  preferences: {
    hasRow: boolean;
    email: { enabled: boolean; consentAt: string | null; consentSource: string };
    sms: { enabled: boolean; consentAt: string | null; consentSource: string };
  };
  sms_consent_sources: string[];
}

describe("Customer notification preferences", () => {
  it("1. reports effective defaults with no preference row", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await request<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.hasRow).toBe(false);
    expect(res.body.preferences.email.enabled).toBe(true);
    expect(res.body.preferences.sms.enabled).toBe(false);
    expect(res.body.sms_consent_sources.length).toBeGreaterThan(0);
  });

  it("3. admin can read", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await request(`/api/customers/${customer.id}/notification-preferences`, auth);
    expect(res.response.status).toBe(200);
  });

  it("4. dispatcher can read", async () => {
    const customer = await createCustomer();
    const res = await request(`/api/customers/${customer.id}/notification-preferences`, await dispatcherAuth());
    expect(res.response.status).toBe(200);
  });

  it("5. technician is denied (read)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await request(`/api/customers/${customer.id}/notification-preferences`, await technicianAuth());
    expect(res.response.status).toBe(403);
    void auth;
  });

  it("5b. technician is denied (write)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, await technicianAuth());
    expect(res.response.status).toBe(403);
    void auth;
  });

  it("6. unauthenticated is 401", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await request(`/api/customers/${customer.id}/notification-preferences`);
    expect(res.response.status).toBe(401);
    void auth;
  });

  it("7. can disable email", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.email.enabled).toBe(false);
  });

  it("8. can re-enable email", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth);
    const res = await put<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: true }, auth);
    expect(res.body.preferences.email.enabled).toBe(true);
  });

  it("9. enabling SMS with a valid consent source succeeds", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put<PreferencesResponse>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth
    );
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.sms.enabled).toBe(true);
    expect(res.body.preferences.sms.consentAt).toBeTruthy();
    expect(res.body.preferences.sms.consentSource).toBe("phone");
  });

  it("10. enabling SMS without a consent source is rejected", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(res.response.status).toBe(400);
    const row = await queryDb<{ sms_enabled: number }>("SELECT sms_enabled FROM notification_preferences WHERE customer_id=?", [customer.id]);
    expect(row).toHaveLength(0); // no row created at all on rejection
  });

  it("10b. enabling SMS with an invalid consent source is rejected", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "telepathy" }, auth
    );
    expect(res.response.status).toBe(400);
  });

  it("11. consent timestamp is server-generated (recent, not far future/past)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const before = Date.now();
    const res = await put<PreferencesResponse>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "web" }, auth
    );
    const consentAtMs = new Date(res.body.preferences.sms.consentAt!.replace(" ", "T") + "Z").getTime();
    expect(Math.abs(consentAtMs - before)).toBeLessThan(15000);
  });

  it("12. a client-supplied consent timestamp field is rejected outright (.strict())", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(
      `/api/customers/${customer.id}/notification-preferences`,
      { sms_enabled: true, sms_consent_source: "phone", sms_consent_at: "2020-01-01T00:00:00.000Z" },
      auth
    );
    expect(res.response.status).toBe(400);
  });

  it("13. disabling SMS preserves the previously recorded consent timestamp", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const enabled = await put<PreferencesResponse>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "written" }, auth
    );
    const originalConsentAt = enabled.body.preferences.sms.consentAt;
    const disabled = await put<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: false }, auth);
    expect(disabled.body.preferences.sms.enabled).toBe(false);
    expect(disabled.body.preferences.sms.consentAt).toBe(originalConsentAt);
    expect(disabled.body.preferences.sms.consentSource).toBe("written");
  });

  it("13b. Phase 9.4 policy: re-enabling SMS after a disable REQUIRES a fresh consent source, even though a prior consent timestamp is preserved", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "in_person" }, auth);
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: false }, auth);
    // Bare re-enable with no source is now rejected — the preserved consent
    // from before the disable is no longer sufficient to silently
    // re-authorize a new enable action.
    const bareReEnable = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(bareReEnable.response.status).toBe(400);

    const reEnabled = await put<PreferencesResponse>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "web" }, auth
    );
    expect(reEnabled.response.status).toBe(200);
    expect(reEnabled.body.preferences.sms.enabled).toBe(true);
    expect(reEnabled.body.preferences.sms.consentSource).toBe("web"); // the NEW source, not the preserved "in_person"
  });

  it("14. does not create a duplicate preference row across repeated updates", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth);
    await put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: true }, auth);
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id=?", [customer.id]);
    expect(rows).toHaveLength(1);
  });

  it("14b. concurrent first-time updates for the same customer never create two rows", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await Promise.all([
      put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth),
      put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth),
    ]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id=?", [customer.id]);
    expect(rows).toHaveLength(1);
  });

  it("15. an arbitrary/nonexistent customer ID returns 404, not another customer's data", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/customers/999999/notification-preferences`, auth);
    expect(res.response.status).toBe(404);
  });

  it("16. rejects an unknown field (strict mass-assignment protection)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { role: "admin", customer_id: 99 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("updating email does not alter an already-set SMS preference", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth);
    const res = await put<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth);
    expect(res.body.preferences.sms.enabled).toBe(true); // untouched
  });
});

describe("Lead notification preferences", () => {
  it("2. reports effective defaults with no preference row", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await request<PreferencesResponse>(`/api/leads/${lead.id}/notification-preferences`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.hasRow).toBe(false);
    expect(res.body.preferences.email.enabled).toBe(true);
    expect(res.body.preferences.sms.enabled).toBe(false);
  });

  it("technician is denied", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const res = await request(`/api/leads/${lead.id}/notification-preferences`, await technicianAuth());
    expect(res.response.status).toBe(403);
  });

  it("dispatcher can update", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth);
    const dispatcher = await dispatcherAuth();
    const res = await put<PreferencesResponse>(`/api/leads/${lead.id}/notification-preferences`, { email_enabled: false }, dispatcher);
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.email.enabled).toBe(false);
  });

  it("15b. an arbitrary/nonexistent lead ID returns 404", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/leads/999999/notification-preferences`, auth);
    expect(res.response.status).toBe(404);
  });

  it("a converted Lead and its resulting Customer keep separate preference rows", async () => {
    const auth = await authHeaders();
    const lead = await createLead(auth, { email: "convert-pref@example.test", phone: "6045550120" });
    await put(`/api/leads/${lead.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "contacted" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "qualified" }, auth);
    await post(`/api/leads/${lead.id}/transition`, { to_status: "estimate" }, auth);
    const conv = await post<{ customer: { id: number } }>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect(conv.response.status).toBeLessThan(300);
    const customerPrefs = await request<PreferencesResponse>(`/api/customers/${conv.body.customer.id}/notification-preferences`, auth);
    expect(customerPrefs.body.preferences.hasRow).toBe(false); // no merge occurred
    const leadPrefs = await request<PreferencesResponse>(`/api/leads/${lead.id}/notification-preferences`, auth);
    expect(leadPrefs.body.preferences.sms.enabled).toBe(true); // Lead's own row untouched
  });
});

describe("legacy/corrupted consent data (Section 6)", () => {
  it("an sms_enabled=1 row with a null consent_at reports as enabled but without a consent timestamp", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id, sms_enabled) VALUES (${customer.id}, 1)`]);
    const res = await request<PreferencesResponse>(`/api/customers/${customer.id}/notification-preferences`, auth);
    expect(res.body.preferences.sms.enabled).toBe(true);
    expect(res.body.preferences.sms.consentAt).toBeNull();
  });

  it("re-affirming sms_enabled=true against that corrupted state requires a fresh consent source", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id, sms_enabled) VALUES (${customer.id}, 1)`]);
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(res.response.status).toBe(400);
  });
});
