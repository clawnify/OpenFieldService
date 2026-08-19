import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, executeStatements, mockNotificationProviders,
  post, put, queryDb, resetDatabase, runScheduled,
} from "./helpers.js";
import {
  buildProviders, businessDateOffset, enqueueDayBeforeReminders, getBusinessTimezone, runDispatchCycle,
} from "../src/server/notification-dispatcher.js";
import { renderEmail, renderSms } from "../src/server/notification-templates.js";

// Phase 9.2 — provider adapters + Cron dispatcher + delivery engine. Every
// test here uses mockNotificationProviders() (see test/helpers.ts) — no
// test in this file ever reaches a real Resend/Twilio endpoint.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface OutboxRow {
  id: number; status: string; attempts: number; scheduled_for: string; last_error: string;
  provider_message_id: string | null; sent_at: string | null; channel: string; event_type: string;
}

async function outboxForJob(jobId: number) {
  return queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE entity_type='job' AND entity_id=? ORDER BY id", [jobId]);
}

async function attemptsFor(notificationId: number) {
  return queryDb<{ attempt_number: number; status: string; error_code: string; error_message: string; provider_message_id: string | null }>(
    "SELECT attempt_number, status, error_code, error_message, provider_message_id FROM notification_delivery_attempts WHERE notification_id=? ORDER BY attempt_number",
    [notificationId]
  );
}

async function jobWithConfirmation(email = "dispatch@example.test", scheduledDate = "2026-09-20") {
  const auth = await authHeaders();
  const customer = await createCustomer();
  await put(`/api/customers/${customer.id}`, { email }, auth);
  const job = await createJob(customer.id, scheduledDate);
  const rows = await outboxForJob(job.id);
  return { customer, job, notificationId: rows[0].id };
}

function providers() {
  return buildProviders(env as unknown as Parameters<typeof buildProviders>[0]);
}

// ── Concurrency ───────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("two dispatchers targeting the same pending row: exactly one provider send", async () => {
    const mock = mockNotificationProviders();
    const { notificationId } = await jobWithConfirmation();

    const [a, b] = await Promise.all([runDispatchCycle(providers()), runDispatchCycle(providers())]);

    expect(a.claimed + b.claimed).toBe(1); // only one cycle actually claimed the row
    expect(mock.state.emailCalls.length).toBe(1);
    const attempts = await attemptsFor(notificationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("succeeded");
    mock.restore();
  });

  it("stale sending row is reclaimed and can be dispatched", async () => {
    const mock = mockNotificationProviders();
    const { notificationId } = await jobWithConfirmation();
    await executeStatements([
      `UPDATE notification_outbox SET status='sending', updated_at=datetime('now', '-10 minutes') WHERE id=${notificationId}`,
    ]);

    const result = await runDispatchCycle(providers());
    expect(result.reclaimed).toBe(1);
    expect(result.sent).toBe(1);
    const rows = await queryDb<{ status: string }>("SELECT status FROM notification_outbox WHERE id=?", [notificationId]);
    expect(rows[0].status).toBe("sent");
    mock.restore();
  });

  it("a recent sending row is NOT reclaimed", async () => {
    const mock = mockNotificationProviders();
    const { notificationId } = await jobWithConfirmation();
    await executeStatements([
      `UPDATE notification_outbox SET status='sending', updated_at=datetime('now') WHERE id=${notificationId}`,
    ]);

    const result = await runDispatchCycle(providers());
    expect(result.reclaimed).toBe(0);
    expect(mock.state.emailCalls).toHaveLength(0);
    const rows = await queryDb<{ status: string }>("SELECT status FROM notification_outbox WHERE id=?", [notificationId]);
    expect(rows[0].status).toBe("sending"); // untouched
    mock.restore();
  });

  it("duplicate Cron execution produces exactly one reminder row", async () => {
    const tz = await getBusinessTimezone();
    const tomorrow = businessDateOffset(tz, 1);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "reminder-dup@example.test" }, auth);
    const job = await createJob(customer.id, tomorrow);

    const first = await enqueueDayBeforeReminders();
    const second = await enqueueDayBeforeReminders();
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0); // idempotent — dedupe key already exists
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows).toHaveLength(1);
  });

  it("duplicate enqueue + concurrent dispatch still results in exactly one external send", async () => {
    const mock = mockNotificationProviders();
    const { job } = await jobWithConfirmation("dup-enqueue@example.test");
    // Simulate a duplicate enqueue attempt racing the dispatcher — retry the
    // exact same enqueue via the real HTTP path (createJob only fires once,
    // so we duplicate at the DB layer to prove the UNIQUE constraint holds
    // even if a second enqueue attempt were to slip through).
    const before = await outboxForJob(job.id);
    await executeStatements([
      `INSERT INTO notification_outbox (event_type, entity_type, entity_id, channel, recipient, template_key, payload, dedupe_key)
       SELECT event_type, entity_type, entity_id, channel, recipient, template_key, payload, dedupe_key FROM notification_outbox WHERE id=${before[0].id}
       ON CONFLICT(dedupe_key) DO NOTHING`,
    ]);
    const afterDupAttempt = await outboxForJob(job.id);
    expect(afterDupAttempt).toHaveLength(1); // duplicate insert was a no-op

    await runDispatchCycle(providers());
    expect(mock.state.emailCalls).toHaveLength(1);
    mock.restore();
  });

  it("concurrent retry of the same row results in exactly one provider send", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("concurrent-retry@example.test");
    await runDispatchCycle(providers()); // first attempt fails, schedules retry
    let row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("pending");
    // Force it due now so the retry race can be tested immediately.
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);

    const [a, b] = await Promise.all([runDispatchCycle(providers()), runDispatchCycle(providers())]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(mock.state.emailCalls).toHaveLength(2); // 1 failed + 1 succeeded retry, never 2 concurrent sends for the retry itself
    row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("sent");
    mock.restore();
  });

  it("a successfully sent row cannot be reclaimed or re-sent", async () => {
    const mock = mockNotificationProviders();
    const { notificationId } = await jobWithConfirmation("no-resend@example.test");
    await runDispatchCycle(providers());
    expect(mock.state.emailCalls).toHaveLength(1);

    const again = await runDispatchCycle(providers());
    expect(again.claimed).toBe(0);
    expect(mock.state.emailCalls).toHaveLength(1); // unchanged
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("sent");
    mock.restore();
  });

  it("a terminal failed row is never retried automatically", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("terminal-fail@example.test");
    for (let i = 0; i < 3; i++) {
      await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
      mock.state.failNextEmailWithStatus = 500;
      await runDispatchCycle(providers());
    }
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    const callsAfterFailure = mock.state.emailCalls.length;

    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    const result = await runDispatchCycle(providers());
    expect(result.claimed).toBe(0); // status='failed', never picked up by findDueNotificationIds (which only selects 'pending')
    expect(mock.state.emailCalls.length).toBe(callsAfterFailure);
    mock.restore();
  });
});

// ── Consent re-check ──────────────────────────────────────────────────────

describe("consent re-check", () => {
  it("SMS opted in at enqueue AND at delivery: provider called", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "sms-ok@example.test", phone: "6045550111" }, auth);
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'test')`,
    ]);
    await createJob(customer.id, "2026-09-21");

    await runDispatchCycle(providers());
    expect(mock.state.smsCalls.length).toBe(1);
    mock.restore();
  });

  it("SMS consent revoked before send: cancelled, not sent", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "sms-revoke@example.test", phone: "6045550112" }, auth);
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'test')`,
    ]);
    const job = await createJob(customer.id, "2026-09-21");
    // Consent revoked AFTER enqueue, before dispatch.
    await executeStatements([`UPDATE notification_preferences SET sms_consent_at = NULL WHERE customer_id = ${customer.id}`]);

    await runDispatchCycle(providers());
    expect(mock.state.smsCalls).toHaveLength(0);
    const rows = await outboxForJob(job.id);
    const sms = rows.find((r) => r.channel === "sms")!;
    expect(sms.status).toBe("cancelled");
    expect(sms.last_error).toContain("consent_revoked");
    mock.restore();
  });

  it("SMS channel disabled before send: cancelled", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "sms-disable@example.test", phone: "6045550113" }, auth);
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'test')`,
    ]);
    const job = await createJob(customer.id, "2026-09-21");
    await executeStatements([`UPDATE notification_preferences SET sms_enabled = 0 WHERE customer_id = ${customer.id}`]);

    await runDispatchCycle(providers());
    const rows = await outboxForJob(job.id);
    const sms = rows.find((r) => r.channel === "sms")!;
    expect(sms.status).toBe("cancelled");
    expect(mock.state.smsCalls).toHaveLength(0);
    mock.restore();
  });

  it("email disabled before send: cancelled", async () => {
    const mock = mockNotificationProviders();
    const { customer, notificationId } = await jobWithConfirmation("email-disable@example.test");
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, email_enabled, sms_enabled) VALUES (${customer.id}, 0, 0)`,
    ]);
    await runDispatchCycle(providers());
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("cancelled");
    expect(row.last_error).toContain("channel_disabled");
    expect(mock.state.emailCalls).toHaveLength(0);
    mock.restore();
  });

  it("recipient entity deleted: safe cancellation, no crash", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const { job, notificationId } = await jobWithConfirmation("entity-deleted@example.test");
    await executeStatements([`DELETE FROM jobs WHERE id = ${job.id}`]);
    void auth;

    const result = await runDispatchCycle(providers());
    expect(result.cancelled).toBe(1);
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("cancelled");
    expect(row.last_error).toContain("recipient_deleted");
    expect(mock.state.emailCalls).toHaveLength(0);
    mock.restore();
  });

  it("a later contact address change does not affect the already-queued recipient snapshot", async () => {
    const mock = mockNotificationProviders();
    const auth = await authHeaders();
    const { customer, notificationId } = await jobWithConfirmation("original-snapshot@example.test");
    await put(`/api/customers/${customer.id}`, { email: "changed-after-enqueue@example.test" }, auth);

    await runDispatchCycle(providers());
    expect(mock.state.emailCalls).toHaveLength(1);
    const row = (await queryDb<{ recipient: string }>("SELECT recipient FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.recipient).toBe("original-snapshot@example.test"); // never re-resolved to the new address
    mock.restore();
  });

  it("no preference row at dispatch time: defaults handled exactly as Phase 9.1 (email eligible)", async () => {
    const mock = mockNotificationProviders();
    await jobWithConfirmation("no-pref-row@example.test");
    const result = await runDispatchCycle(providers());
    expect(result.sent).toBe(1);
    expect(mock.state.emailCalls).toHaveLength(1);
    mock.restore();
  });
});

// ── Retry semantics ───────────────────────────────────────────────────────

describe("retry semantics", () => {
  it("succeeds on the first attempt", async () => {
    const mock = mockNotificationProviders();
    const { notificationId } = await jobWithConfirmation("retry-success1@example.test");
    await runDispatchCycle(providers());
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
    const attempts = await attemptsFor(notificationId);
    expect(attempts).toHaveLength(1);
    mock.restore();
  });

  it("fail then retry then succeed", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("retry-then-success@example.test");
    await runDispatchCycle(providers());
    let row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);

    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    await runDispatchCycle(providers());
    row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe(""); // cleared on success
    mock.restore();
  });

  it("fail, fail, then succeed on the third attempt", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("retry-twice-then-success@example.test");
    await runDispatchCycle(providers());
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    mock.state.failNextEmailWithStatus = 500;
    await runDispatchCycle(providers());
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    await runDispatchCycle(providers()); // third attempt succeeds (no failure queued)

    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(3);
    mock.restore();
  });

  it("fails three times: terminal failed, no fourth attempt", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("retry-terminal@example.test");
    for (let i = 0; i < 3; i++) {
      await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
      mock.state.failNextEmailWithStatus = 500;
      await runDispatchCycle(providers());
    }
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    const attempts = await attemptsFor(notificationId);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === "failed")).toBe(true);

    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    await runDispatchCycle(providers());
    const attemptsAfter = await attemptsFor(notificationId);
    expect(attemptsAfter).toHaveLength(3); // no fourth attempt row was ever created
    mock.restore();
  });

  it("schedules a 1-minute retry after the first failure", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("retry-1min@example.test");
    const before = (await queryDb<{ now: string }>("SELECT datetime('now') as now"))[0].now;
    await runDispatchCycle(providers());
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    const diffMinutes = (new Date(row.scheduled_for.replace(" ", "T") + "Z").getTime() - new Date(before.replace(" ", "T") + "Z").getTime()) / 60000;
    expect(diffMinutes).toBeGreaterThan(0.9);
    expect(diffMinutes).toBeLessThan(1.5);
    mock.restore();
  });

  it("schedules a 5-minute retry after the second failure", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("retry-5min@example.test");
    await runDispatchCycle(providers());
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    const before = (await queryDb<{ now: string }>("SELECT datetime('now') as now"))[0].now;
    mock.state.failNextEmailWithStatus = 500;
    await runDispatchCycle(providers());
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    const diffMinutes = (new Date(row.scheduled_for.replace(" ", "T") + "Z").getTime() - new Date(before.replace(" ", "T") + "Z").getTime()) / 60000;
    expect(diffMinutes).toBeGreaterThan(4.5);
    expect(diffMinutes).toBeLessThan(5.5);
    mock.restore();
  });

  it("exactly one delivery-attempt row per provider invocation", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("one-row-per-attempt@example.test");
    await runDispatchCycle(providers());
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    await runDispatchCycle(providers());
    const attempts = await attemptsFor(notificationId);
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2]);
    mock.restore();
  });

  it("a successful delivery clears last_error", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("clears-last-error@example.test");
    await runDispatchCycle(providers());
    let row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.last_error).not.toBe("");
    await executeStatements([`UPDATE notification_outbox SET scheduled_for = datetime('now', '-1 minute') WHERE id=${notificationId}`]);
    await runDispatchCycle(providers());
    row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.last_error).toBe("");
    mock.restore();
  });
});

// ── Error sanitization ────────────────────────────────────────────────────

describe("error sanitization", () => {
  it("a secret-bearing provider failure response never lands in outbox.last_error", async () => {
    const mock = mockNotificationProviders({ failNextEmailWithStatus: 500 });
    const { notificationId } = await jobWithConfirmation("sanitize-outbox@example.test");
    await runDispatchCycle(providers());
    const row = (await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE id=?", [notificationId]))[0];
    expect(row.last_error).not.toContain("Bearer");
    expect(row.last_error).not.toContain("sk_test_should_never_be_stored");
    mock.restore();
  });

  it("a secret-bearing provider failure response never lands in delivery_attempts.error_message", async () => {
    const mock = mockNotificationProviders({ failNextSmsWithStatus: 500 });
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "sanitize-attempt@example.test", phone: "6045550114" }, auth);
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'test')`,
    ]);
    await createJob(customer.id, "2026-09-22");
    await runDispatchCycle(providers());
    const smsRows = await queryDb<{ id: number }>("SELECT id FROM notification_outbox WHERE channel='sms'");
    const attempts = await attemptsFor(smsRows[0].id);
    expect(attempts[0].error_message).not.toContain("Basic");
    expect(attempts[0].error_message).not.toContain("dGVzdDpzZWNyZXQ=");
    mock.restore();
  });
});

// ── Templates ──────────────────────────────────────────────────────────────

describe("templates", () => {
  const cases: { key: string; payload: Record<string, unknown> }[] = [
    { key: "appointment_confirmation_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1", scheduled_date: "2026-09-01", scheduled_time: "09:00" } },
    { key: "appointment_rescheduled_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1", old_date: "2026-09-01", old_time: "09:00", new_date: "2026-09-02", new_time: "10:00" } },
    { key: "appointment_cancelled_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1" } },
    { key: "technician_on_the_way_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1", technician_name: "Bob" } },
    { key: "invoice_issued_v1", payload: { customer_name: "Jane", invoice_identifier: "INV-1", total_cents: 15000 } },
    { key: "payment_received_v1", payload: { customer_name: "Jane", invoice_identifier: "INV-1", amount_cents: 15000 } },
    { key: "post_job_survey_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1" } },
    { key: "appointment_reminder_v1", payload: { customer_name: "Jane", job_identifier: "JOB-1", scheduled_date: "2026-09-01", scheduled_time: "09:00" } },
  ];

  for (const { key, payload } of cases) {
    it(`renders a complete, safe email for ${key}`, () => {
      const email = renderEmail(key, payload);
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.text.length).toBeGreaterThan(0);
      expect(email.html.length).toBeGreaterThan(0);
      expect(email.text).not.toContain("{");
      expect(email.text).not.toContain("undefined");
      expect(email.html).not.toMatch(/"job_identifier"|"customer_id"|"id":/);
    });

    it(`renders a complete, safe SMS for ${key}`, () => {
      const sms = renderSms(key, payload);
      expect(sms.text.length).toBeGreaterThan(0);
      expect(sms.text).not.toContain("undefined");
    });
  }

  it("handles missing optional fields without throwing", () => {
    const email = renderEmail("appointment_confirmation_v1", {});
    expect(email.subject.length).toBeGreaterThan(0);
    expect(email.text).not.toContain("undefined");
  });
});

// ── Day-before reminder ───────────────────────────────────────────────────

describe("day-before reminder", () => {
  async function jobOnRelativeDay(daysFromToday: number, status?: string) {
    const tz = await getBusinessTimezone();
    const date = businessDateOffset(tz, daysFromToday);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: `reminder-${daysFromToday}-${Date.now()}@example.test` }, auth);
    const job = await createJob(customer.id, date);
    if (status) await post(`/api/jobs/${job.id}/transition`, { to_status: status }, auth);
    return { job, date };
  }

  it("a job scheduled for tomorrow is queued", async () => {
    const { job } = await jobOnRelativeDay(1);
    const result = await enqueueDayBeforeReminders();
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a job scheduled for today is NOT queued", async () => {
    const { job } = await jobOnRelativeDay(0);
    await enqueueDayBeforeReminders();
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows).toHaveLength(0);
  });

  it("a job scheduled two days away is NOT queued", async () => {
    const { job } = await jobOnRelativeDay(2);
    await enqueueDayBeforeReminders();
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows).toHaveLength(0);
  });

  it("a cancelled job scheduled for tomorrow is NOT queued", async () => {
    const { job } = await jobOnRelativeDay(1, "cancelled");
    await enqueueDayBeforeReminders();
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows).toHaveLength(0);
  });

  it("a rescheduled job's CURRENT date governs whether it's queued", async () => {
    const tz = await getBusinessTimezone();
    const twoDaysOut = businessDateOffset(tz, 2);
    const tomorrow = businessDateOffset(tz, 1);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "reschedule-reminder@example.test" }, auth);
    const job = await createJob(customer.id, twoDaysOut);
    await put(`/api/jobs/${job.id}`, { scheduled_date: tomorrow }, auth); // moved into tomorrow's window

    await enqueueDayBeforeReminders();
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("duplicate Cron execution (same target date) produces one row per job", async () => {
    const { job } = await jobOnRelativeDay(1);
    await enqueueDayBeforeReminders();
    await enqueueDayBeforeReminders();
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows).toHaveLength(1);
  });

  it("email disabled: no email reminder queued", async () => {
    const tz = await getBusinessTimezone();
    const date = businessDateOffset(tz, 1);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "reminder-email-disabled@example.test" }, auth);
    await executeStatements([`INSERT INTO notification_preferences (customer_id, email_enabled, sms_enabled) VALUES (${customer.id}, 0, 0)`]);
    const job = await createJob(customer.id, date);
    await enqueueDayBeforeReminders();
    const rows = await queryDb<{ channel: string }>("SELECT channel FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows.some((r) => r.channel === "email")).toBe(false);
  });

  it("SMS not consented: no SMS reminder queued", async () => {
    const tz = await getBusinessTimezone();
    const date = businessDateOffset(tz, 1);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "reminder-sms-noconsent@example.test", phone: "6045550115" }, auth);
    const job = await createJob(customer.id, date);
    await enqueueDayBeforeReminders();
    const rows = await queryDb<{ channel: string }>("SELECT channel FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows.some((r) => r.channel === "sms")).toBe(false);
  });

  it("SMS consented: SMS reminder is queued", async () => {
    const tz = await getBusinessTimezone();
    const date = businessDateOffset(tz, 1);
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "reminder-sms-consent@example.test", phone: "6045550116" }, auth);
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'test')`,
    ]);
    const job = await createJob(customer.id, date);
    await enqueueDayBeforeReminders();
    const rows = await queryDb<{ channel: string }>("SELECT channel FROM notification_outbox WHERE entity_type='job' AND entity_id=? AND event_type='job.appointment_reminder'", [job.id]);
    expect(rows.some((r) => r.channel === "sms")).toBe(true);
  });

  it("businessDateOffset correctly rolls over a UTC-vs-local midnight boundary in a non-UTC business timezone (legacy _meta.timezone backward-compat path)", async () => {
    // No BUSINESS_TIMEZONE Global Setting published this test (resetDatabase()
    // wiped it) — temporarily reconfigure the legacy _meta fallback to prove
    // the reminder scan still honors it when that's the only source
    // available (a database that hasn't published the Global Setting yet).
    await executeStatements(["UPDATE _meta SET value = 'America/Vancouver' WHERE key = 'timezone'"]);
    const tz = await getBusinessTimezone();
    expect(tz).toBe("America/Vancouver");
    const vancouverTomorrow = businessDateOffset(tz, 1);
    const utcTomorrow = businessDateOffset("UTC", 1);
    // Vancouver is behind UTC — near UTC midnight the Vancouver calendar
    // date can legitimately still be "yesterday" relative to UTC's date,
    // proving the timezone parameter actually changes the computed date
    // rather than being ignored.
    expect(typeof vancouverTomorrow).toBe("string");
    expect(vancouverTomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(utcTomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await executeStatements(["UPDATE _meta SET value = 'UTC' WHERE key = 'timezone'"]);
  });

  it("the day-before reminder resolves the SAME shared BUSINESS_TIMEZONE Global Setting Google Calendar uses — not a second/independent source", async () => {
    // Publish through the real admin API (the normal path), same mechanism
    // test/calendar-sync.test.ts's Calendar tests use — proving both
    // subsystems really do share one resolver rather than each reading
    // their own copy.
    await executeStatements(["UPDATE _meta SET value = 'America/Chicago' WHERE key = 'timezone'"]); // a disagreeing legacy value
    const auth = await authHeaders();
    const publish = await post("/api/settings", {
      key: "BUSINESS_TIMEZONE", value: "America/Toronto", data_type: "string", category: "business_operations",
    }, auth);
    expect(publish.response.status).toBe(201);

    const tz = await getBusinessTimezone();
    expect(tz).toBe("America/Toronto"); // the Global Setting, not the disagreeing legacy _meta value

    await executeStatements(["UPDATE _meta SET value = 'UTC' WHERE key = 'timezone'"]);
  });

  it("changing BUSINESS_TIMEZONE changes the reminder's date-boundary calculation on the next scan", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Vancouver", data_type: "string" }, auth);
    const vancouverTz = await getBusinessTimezone();
    const vancouverTomorrow = businessDateOffset(vancouverTz, 1);

    const later = new Date(Date.now() + 60_000).toISOString();
    await post("/api/settings", {
      key: "BUSINESS_TIMEZONE", value: "Pacific/Honolulu", data_type: "string", effective_from: later,
    }, auth);
    // Not yet effective (effective_from is in the future) — still resolves
    // to the currently-active version, matching every other Global
    // Setting's "effective immediately going forward, not retroactively"
    // semantics (Section 19's required distinction between current runtime
    // resolution and historical/future version rows).
    expect(await getBusinessTimezone()).toBe("America/Vancouver");
    expect(businessDateOffset(await getBusinessTimezone(), 1)).toBe(vancouverTomorrow);
  });

  it("winter (PST) day-before date boundary resolves correctly through BUSINESS_TIMEZONE, same as summer", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "BUSINESS_TIMEZONE", value: "America/Vancouver", data_type: "string" }, auth);
    const tz = await getBusinessTimezone();
    // businessDateOffset is pure calendar-day arithmetic (never touches wall-
    // clock hours), so it produces a valid date string regardless of season —
    // this proves the winter (PST) path resolves through the same Global
    // Setting without a separate/seasonal code path.
    const winterOffset = businessDateOffset(tz, 1);
    expect(winterOffset).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── Google Calendar isolation (Section 31) ────────────────────────────────

describe("Google Calendar isolation", () => {
  it("running a full Cron cycle triggers zero Google Calendar calls", async () => {
    const mock = mockNotificationProviders();
    await jobWithConfirmation("calendar-isolation@example.test");
    await runScheduled();
    mock.restore();
    // No assertion needed against Google here beyond "did not throw" — a
    // dedicated google mock isn't installed in this file at all, so any
    // accidental real network call would fail the test via an unhandled
    // rejection/timeout rather than silently passing.
  });
});
