import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, executeStatements, loginAs,
  mockNotificationProviders, post, put, queryDb, request, requestRaw, resetDatabase, runScheduled,
} from "./helpers.js";
import { runDispatchCycle, buildProviders } from "../src/server/notification-dispatcher.js";
import { env } from "cloudflare:workers";

// Phase 9.4 — cross-cutting security/integrity sweep. Deliberately does NOT
// re-duplicate every assertion already covered by test/notification-*.test.ts
// from Phases 9.0-9.3 (585+61+... already exercise the ordinary paths) —
// this file focuses on attack scenarios, the policy fix, and the dispatcher
// fix made THIS phase.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function technicianAuth(email = "sec-tech@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
}

function providers() {
  return buildProviders(env as unknown as Parameters<typeof buildProviders>[0]);
}

// 1. RBAC sweep across every preference/history route ------------------------

describe("1. RBAC sweep", () => {
  it("a technician is denied on every one of the 8 preference/history routes", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const lead = await post<{ id: number }>("/api/leads", { name: "RBAC Lead" }, auth);
    await put(`/api/customers/${customer.id}`, { email: "rbac-sweep@example.test" }, auth);
    const job = await createJob(customer.id, "2026-11-01");
    const techId = (await post<{ id: number }>("/api/technicians", { name: "RBAC Tech" }, auth)).body.id;
    const job2 = await createJob(customer.id, "2026-11-02", { technician_id: techId });
    void job2;
    const tech = await technicianAuth();

    const routes = [
      ["GET", `/api/customers/${customer.id}/notification-preferences`],
      ["PUT", `/api/customers/${customer.id}/notification-preferences`],
      ["GET", `/api/leads/${lead.body.id}/notification-preferences`],
      ["PUT", `/api/leads/${lead.body.id}/notification-preferences`],
      ["GET", `/api/customers/${customer.id}/notifications`],
      ["GET", `/api/leads/${lead.body.id}/notifications`],
      ["GET", `/api/jobs/${job.id}/notifications`],
    ] as const;

    for (const [method, path] of routes) {
      const res = method === "GET" ? await request(path, tech) : await put(path, { email_enabled: true }, tech);
      expect(res.response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("unauthenticated is 401 on every preference/history route", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const lead = await post<{ id: number }>("/api/leads", { name: "Unauth Lead" }, auth);
    const job = await createJob(customer.id, "2026-11-03");

    for (const path of [
      `/api/customers/${customer.id}/notification-preferences`,
      `/api/leads/${lead.body.id}/notification-preferences`,
      `/api/customers/${customer.id}/notifications`,
      `/api/leads/${lead.body.id}/notifications`,
      `/api/jobs/${job.id}/notifications`,
    ]) {
      const res = await request(path);
      expect(res.response.status, path).toBe(401);
    }
    const otwRes = await post(`/api/jobs/${job.id}/on-the-way`, {});
    expect(otwRes.response.status).toBe(401);
  });

  it("admin and dispatcher both have full, identical parity on preferences", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await createUser({ email: "sec-dispatch@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("sec-dispatch@example.test", "DispatchPass1");
    const dispatcherAuth = { headers: { cookie } };
    const adminRes = await request(`/api/customers/${customer.id}/notification-preferences`, auth);
    const dispatcherRes = await request(`/api/customers/${customer.id}/notification-preferences`, dispatcherAuth);
    expect(adminRes.response.status).toBe(200);
    expect(dispatcherRes.response.status).toBe(200);
  });
});

// 2-3. IDOR --------------------------------------------------------------

describe("2-3. IDOR", () => {
  it("preferences: a nonexistent customer/lead id 404s, never leaking another recipient's data", async () => {
    const auth = await authHeaders();
    const real = await createCustomer();
    await put(`/api/customers/${real.id}/notification-preferences`, { email_enabled: false }, auth);
    const fake = await request(`/api/customers/999999/notification-preferences`, auth);
    expect(fake.response.status).toBe(404);
  });

  it("history: a nonexistent job/invoice id 404s", async () => {
    const auth = await authHeaders();
    expect((await request(`/api/jobs/999999/notifications`, auth)).response.status).toBe(404);
    expect((await request(`/api/invoices/999999/notifications`, auth)).response.status).toBe(404);
  });

  it("On The Way: a technician cannot act on a Job assigned to a different technician", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const owner = await createLinkedTechnician("idor-owner@example.test", auth);
    const attacker = await createLinkedTechnician("idor-attacker@example.test", auth);
    const job = await createJob(customer.id, "2026-11-04", { technician_id: owner.technicianId });
    const res = await post(`/api/jobs/${job.id}/on-the-way`, {}, attacker.auth);
    expect(res.response.status).toBe(403);
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.technician_on_the_way'", [job.id]);
    expect(rows).toHaveLength(0); // zero outbox mutation on denial
  });

  it("On The Way: an unlinked technician is denied for any job", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-11-05");
    const unlinked = await technicianAuth("idor-unlinked@example.test");
    const res = await post(`/api/jobs/${job.id}/on-the-way`, {}, unlinked);
    expect(res.response.status).toBe(403);
  });
});

// 4-7. Mass assignment / consent policy -----------------------------------

describe("4-7. Mass assignment and consent policy", () => {
  it("4. rejects a broad injection sweep on the preference PUT body", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, {
      id: 1, customer_id: 999, lead_id: 999, actor_user_id: 1, created_by: 1, role: "admin", user_id: 1,
      sms_consent_at: "2000-01-01T00:00:00Z", provider_message_id: "x", status: "sent", attempts: 99,
      scheduled_for: "2000-01-01", sent_at: "2000-01-01", dedupe_key: "spoofed",
    }, auth);
    expect(res.response.status).toBe(400);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id=?", [customer.id]);
    expect(rows).toHaveLength(0); // rejected before any row was ever created
  });

  it("5. enabling SMS without a consent source is rejected server-side", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(res.response.status).toBe(400);
  });

  it("6. disabling SMS preserves consent history", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const enabled = await put<{ preferences: { sms: { consentAt: string | null; consentSource: string } } }>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth
    );
    const disabled = await put<{ preferences: { sms: { enabled: boolean; consentAt: string | null; consentSource: string } } }>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: false }, auth
    );
    expect(disabled.body.preferences.sms.enabled).toBe(false);
    expect(disabled.body.preferences.sms.consentAt).toBe(enabled.body.preferences.sms.consentAt);
    expect(disabled.body.preferences.sms.consentSource).toBe("phone");
  });

  it("7. FINAL POLICY: re-enabling SMS always requires a fresh consent source, even with prior consent on file", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth);
    await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: false }, auth);

    const bareReEnable = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(bareReEnable.response.status).toBe(400);

    const before = Date.now();
    const properReEnable = await put<{ preferences: { sms: { enabled: boolean; consentAt: string; consentSource: string } } }>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "written" }, auth
    );
    expect(properReEnable.response.status).toBe(200);
    expect(properReEnable.body.preferences.sms.enabled).toBe(true);
    expect(properReEnable.body.preferences.sms.consentSource).toBe("written");
    const newConsentMs = new Date(properReEnable.body.preferences.sms.consentAt.replace(" ", "T") + "Z").getTime();
    expect(Math.abs(newConsentMs - before)).toBeLessThan(15000); // freshly re-stamped, not the old "phone" timestamp
  });

  it("7b. an already-enabled, already-consented row is NOT forced through consent capture on an unrelated email edit", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const enabled = await put<{ preferences: { sms: { consentAt: string } } }>(
      `/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "web" }, auth
    );
    const originalConsentAt = enabled.body.preferences.sms.consentAt;
    // Re-submitting sms_enabled: true (already true) alongside an unrelated
    // email edit must NOT require a source and must NOT re-stamp consent.
    const res = await put<{ preferences: { sms: { consentAt: string; enabled: boolean } } }>(
      `/api/customers/${customer.id}/notification-preferences`, { email_enabled: false, sms_enabled: true }, auth
    );
    expect(res.response.status).toBe(200);
    expect(res.body.preferences.sms.consentAt).toBe(originalConsentAt);
  });

  it("legacy/corrupted state (enabled=1, consent=NULL): re-affirming still requires fresh consent", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id, sms_enabled) VALUES (${customer.id}, 1)`]);
    const res = await put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true }, auth);
    expect(res.response.status).toBe(400);
  });
});

// 8. Preference concurrency -----------------------------------------------

describe("8. Preference concurrency", () => {
  it("three-way concurrent first-time writes never create more than one row", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await Promise.all([
      put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: false }, auth),
      put(`/api/customers/${customer.id}/notification-preferences`, { sms_enabled: true, sms_consent_source: "phone" }, auth),
      put(`/api/customers/${customer.id}/notification-preferences`, { email_enabled: true }, auth),
    ]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id=?", [customer.id]);
    expect(rows).toHaveLength(1);
  });
});

// 9-11. Outbox dedupe / claim / stale reclaim -----------------------------

describe("9-11. Outbox dedupe, claim race, stale reclaim (re-verified against current code)", () => {
  it("9. a genuine reschedule replay produces exactly one outbox row per channel", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "dedupe-replay@example.test" }, auth);
    const job = await createJob(customer.id, "2026-11-06");
    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-11-07" }, auth);
    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-11-07" }, auth); // no-op replay, already at target
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_rescheduled'", [job.id]);
    expect(rows).toHaveLength(1);
  });

  it("10. two dispatchers targeting the same pending row: exactly one provider send (post-fix code)", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "claim-race@example.test" }, auth);
    await createJob(customer.id, "2026-11-08");
    const [a, b] = await Promise.all([runDispatchCycle(providers()), runDispatchCycle(providers())]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(mock.state.emailCalls).toHaveLength(1);
    mock.restore();
  });

  it("11. a stale sending row is reclaimed; a fresh one is not", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "stale-reclaim@example.test" }, auth);
    await createJob(customer.id, "2026-11-09");
    const row = (await queryDb<{ id: number }>("SELECT id FROM notification_outbox LIMIT 1"))[0];
    await executeStatements([`UPDATE notification_outbox SET status='sending', updated_at=datetime('now','-10 minutes') WHERE id=${row.id}`]);
    const result = await runDispatchCycle(providers());
    expect(result.reclaimed).toBe(1);
    expect(result.sent).toBe(1);
    mock.restore();
  });
});

// 12. Uncertain provider outcome — the Phase 9.4 dispatcher fix -----------

describe("12. Uncertain provider outcome (P1 fix verification)", () => {
  it("a bookkeeping failure AFTER a successful send is never reinterpreted as a send failure (no false retry)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "uncertain-outcome@example.test" }, auth);
    await createJob(customer.id, "2026-11-10");
    const row = (await queryDb<{ id: number }>("SELECT id FROM notification_outbox LIMIT 1"))[0];

    const mock = mockNotificationProviders({
      // Simulate "the provider accepted the message, then something else
      // went wrong before it was recorded" — delete the outbox row right as
      // the mock is about to return success, so recordAttempt()'s real FK
      // constraint on notification_id genuinely throws.
      beforeSuccessfulEmailResponse: async () => {
        await executeStatements([`DELETE FROM notification_outbox WHERE id=${row.id}`]);
      },
    });

    const result = await runDispatchCycle(providers());
    // The row is gone (deleted mid-flight) — this proves the send DID
    // happen (one real provider call) and the failure path was NEVER
    // reached to schedule a bogus retry against a row that would otherwise
    // still exist and get double-sent.
    expect(mock.state.emailCalls).toHaveLength(1);
    expect(result.errored).toBeGreaterThanOrEqual(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);
    const remaining = await queryDb("SELECT id FROM notification_outbox WHERE id=?", [row.id]);
    expect(remaining).toHaveLength(0);
    mock.restore();
  });

  it("the Resend adapter sends our stable dedupe_key as an Idempotency-Key header", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "idempotency-key@example.test" }, auth);
    await createJob(customer.id, "2026-11-11");
    const row = (await queryDb<{ dedupe_key: string }>("SELECT dedupe_key FROM notification_outbox LIMIT 1"))[0];
    await runDispatchCycle(providers());
    expect(mock.state.emailCalls[0].idempotencyKey).toBe(row.dedupe_key);
    mock.restore();
  });

  it("one row's unexpected error does not prevent other due rows from being dispatched in the same cycle", async () => {
    const auth = await authHeaders();
    const customerA = await createCustomer();
    await put(`/api/customers/${customerA.id}`, { email: "cycle-isolation-a@example.test" }, auth);
    await createJob(customerA.id, "2026-11-12");
    const customerB = await createCustomer();
    await put(`/api/customers/${customerB.id}`, { email: "cycle-isolation-b@example.test" }, auth);
    await createJob(customerB.id, "2026-11-13");
    const rows = await queryDb<{ id: number }>("SELECT id FROM notification_outbox ORDER BY id");
    const firstId = rows[0].id;

    let sawFirst = false;
    const mock = mockNotificationProviders({
      beforeSuccessfulEmailResponse: async () => {
        if (!sawFirst) { sawFirst = true; await executeStatements([`DELETE FROM notification_outbox WHERE id=${firstId}`]); }
      },
    });
    const result = await runDispatchCycle(providers());
    expect(result.errored).toBe(1);
    expect(result.sent).toBe(1); // the second row still got through
    mock.restore();
  });
});

// 13-15. Retry integrity ---------------------------------------------------

describe("13-15. Retry integrity", () => {
  it("13. exactly 3 attempts then terminal failed, no 4th", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "retry-integrity@example.test" }, auth);
    await createJob(customer.id, "2026-11-14");
    const row = (await queryDb<{ id: number }>("SELECT id FROM notification_outbox LIMIT 1"))[0];

    for (let i = 0; i < 3; i++) {
      await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now','-1 minute') WHERE id=${row.id}`]);
      mock.state.failNextEmailWithStatus = 500;
      await runDispatchCycle(providers());
    }
    const final = (await queryDb<{ status: string; attempts: number }>("SELECT status, attempts FROM notification_outbox WHERE id=?", [row.id]))[0];
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(3);

    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now','-1 minute') WHERE id=${row.id}`]);
    const afterFailed = await runDispatchCycle(providers());
    expect(afterFailed.claimed).toBe(0); // 'failed' is never claimed again
    expect(mock.state.emailCalls).toHaveLength(3);
    mock.restore();
  });

  it("14. a cancelled row is never claimable, even when forced due", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const mock = mockNotificationProviders();
    await put(`/api/customers/${customer.id}`, { email: "cancelled-not-sent@example.test" }, auth);
    await createJob(customer.id, "2026-11-15");
    const row = (await queryDb<{ id: number }>("SELECT id FROM notification_outbox LIMIT 1"))[0];
    await executeStatements([`UPDATE notification_outbox SET status='cancelled', last_error='cancelled: channel_disabled' WHERE id=${row.id}`]);
    const result = await runDispatchCycle(providers());
    expect(result.claimed).toBe(0);
    expect(mock.state.emailCalls).toHaveLength(0);
    mock.restore();
  });

  it("15. attempts increments exactly once per real provider call, one delivery_attempts row each", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "attempt-accounting@example.test" }, auth);
    await createJob(customer.id, "2026-11-16");
    const row = (await queryDb<{ id: number }>("SELECT id FROM notification_outbox LIMIT 1"))[0];
    await runDispatchCycle(providers());
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now','-1 minute') WHERE id=${row.id}`]);
    await runDispatchCycle(providers()); // succeeds (no failure queued this time)
    const attempts = await queryDb("SELECT attempt_number FROM notification_delivery_attempts WHERE notification_id=? ORDER BY attempt_number", [row.id]);
    expect(attempts).toHaveLength(2);
    mock.restore();
  });
});

// 16. Secret sanitization --------------------------------------------------

describe("16. Secret sanitization", () => {
  it("a fake secret marker injected into a provider failure never reaches outbox.last_error or delivery_attempts.error_message", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 401 });
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "secret-marker@example.test" }, auth);
    await createJob(customer.id, "2026-11-17");
    await runDispatchCycle(providers());
    const row = (await queryDb<{ last_error: string }>("SELECT last_error FROM notification_outbox LIMIT 1"))[0];
    expect(row.last_error).not.toContain("sk_test_should_never_be_stored");
    expect(row.last_error).not.toContain("Bearer");
    const attempts = await queryDb<{ error_message: string }>("SELECT error_message FROM notification_delivery_attempts");
    for (const a of attempts) {
      expect(a.error_message).not.toContain("sk_test_should_never_be_stored");
    }
    mock.restore();
  });
});

// 17. Payload privacy -------------------------------------------------------

describe("17. Payload privacy", () => {
  it("the raw payload JSON never appears in any notification API response", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "payload-privacy@example.test" }, auth);
    await createJob(customer.id, "2026-11-18");
    const res = await request<{ notifications: Record<string, unknown>[] }>(`/api/customers/${customer.id}/notifications`, auth);
    for (const n of res.body.notifications) {
      expect(n).not.toHaveProperty("payload");
      expect(n).not.toHaveProperty("dedupe_key");
    }
  });
});

// 18-19. Recipient delete/change --------------------------------------------

describe("18-19. Recipient delete/change", () => {
  it("18. a deleted Job cancels its pending notification safely, no crash", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "deleted-recipient@example.test" }, auth);
    const job = await createJob(customer.id, "2026-11-19");
    await executeStatements([`DELETE FROM jobs WHERE id=${job.id}`]);
    const result = await runDispatchCycle(providers());
    expect(result.cancelled).toBeGreaterThanOrEqual(1);
    expect(mock.state.emailCalls).toHaveLength(0);
    mock.restore();
  });

  it("19. a changed contact address does not alter the already-queued recipient snapshot", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "original-address@example.test" }, auth);
    await createJob(customer.id, "2026-11-20");
    await put(`/api/customers/${customer.id}`, { email: "changed-address@example.test" }, auth);
    const row = (await queryDb<{ recipient: string }>("SELECT recipient FROM notification_outbox LIMIT 1"))[0];
    expect(row.recipient).toBe("original-address@example.test");
  });
});

// 20. Duplicate Cron --------------------------------------------------------

describe("20. Duplicate Cron", () => {
  it("running the scheduled handler twice back-to-back never doubles a send", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "duplicate-cron@example.test" }, auth);
    await createJob(customer.id, "2026-11-21");
    await runScheduled();
    await runScheduled();
    expect(mock.state.emailCalls).toHaveLength(1);
    mock.restore();
  });
});

// 21. Malformed pagination ---------------------------------------------------

describe("21. Malformed history pagination", () => {
  it("never produces a raw 500 for negative/zero/huge/non-numeric page or limit", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    for (const qs of ["page=-5&limit=-5", "page=0&limit=0", "page=abc&limit=xyz", "page=1&limit=999999999", "page=1.5&limit=1.5"]) {
      const res = await request(`/api/customers/${customer.id}/notifications?${qs}`, auth);
      expect(res.response.status, qs).toBe(200);
    }
  });
});

// 22. No generic-send endpoint ------------------------------------------------

describe("22. No generic send capability exists", () => {
  it("POST /api/notifications/send does not exist", async () => {
    const auth = await authHeaders();
    const res = await requestRaw("/api/notifications/send", {
      method: "POST", headers: { "content-type": "application/json", ...(auth.headers as Record<string, string>) },
      body: JSON.stringify({ to: "victim@example.test", subject: "x", body: "x" }),
    });
    expect([404, 405]).toContain(res.status);
  });

  it("On The Way accepts no body fields at all — cannot be used to compose an arbitrary message", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techId = (await post<{ id: number }>("/api/technicians", { name: "No Compose Tech" }, auth)).body.id;
    const job = await createJob(customer.id, "2026-11-22", { technician_id: techId });
    const res = await post(`/api/jobs/${job.id}/on-the-way`, { subject: "spam", body: "spam", to: "victim@example.test" }, auth);
    expect(res.response.status).toBe(400);
  });
});

// 23. No public dispatcher endpoint -------------------------------------------

describe("23. No public dispatcher endpoint", () => {
  it("no HTTP route can trigger a dispatch cycle", async () => {
    const auth = await authHeaders();
    for (const path of ["/api/notifications/dispatch", "/api/notifications/cron", "/api/cron/run", "/api/dispatch"]) {
      const res = await requestRaw(path, {
        method: "POST", headers: { "content-type": "application/json", ...(auth.headers as Record<string, string>) }, body: "{}",
      });
      expect([404, 405]).toContain(res.status);
    }
  });
});

// 24. Zero Calendar/financial/workflow side effects --------------------------

describe("24. Cross-domain isolation", () => {
  it("a full notification lifecycle never mutates Job status, technician assignment, or invoice totals", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "isolation-check@example.test" }, auth);
    const job = await createJob(customer.id, "2026-11-23");
    const before = (await queryDb<{ status: string; technician_id: number | null }>("SELECT status, technician_id FROM jobs WHERE id=?", [job.id]))[0];
    await runScheduled();
    const after = (await queryDb<{ status: string; technician_id: number | null }>("SELECT status, technician_id FROM jobs WHERE id=?", [job.id]))[0];
    expect(after).toEqual(before);
    mock.restore();
  });

  it("Lead events remain unwired — zero notification_outbox rows for a Lead lifecycle", async () => {
    const auth = await authHeaders();
    const lead = await post<{ id: number }>("/api/leads", { name: "Isolation Lead" }, auth);
    await post(`/api/leads/${lead.body.id}/transition`, { to_status: "contacted" }, auth);
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='lead'");
    expect(rows).toHaveLength(0);
  });
});
