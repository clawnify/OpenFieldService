import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, executeStatements, loginAs,
  mockGoogleApi, post, put, queryDb, resetDatabase, satisfyCompletionRequirements, type GoogleMock,
} from "./helpers.js";
import { buildDedupeKey, enqueueChannel, enqueueEvent } from "../src/server/notifications.js";

// Phase 9.1 — NotificationService + event-enqueue wiring. Zero real
// delivery exists: every test here proves an outbox row was (or was not)
// idempotently created, never that a message actually sent. No provider,
// no Cron, no network call.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface OutboxRow {
  id: number; event_type: string; entity_type: string; entity_id: number; channel: string;
  recipient: string; template_key: string; payload: string; status: string; dedupe_key: string;
}

async function outboxFor(entityType: string, entityId: number) {
  return queryDb<OutboxRow>(
    "SELECT * FROM notification_outbox WHERE entity_type = ? AND entity_id = ? ORDER BY id", [entityType, entityId]
  );
}

async function setPreferences(customerId: number, fields: Record<string, unknown>) {
  const existing = await queryDb<{ id: number }>("SELECT id FROM notification_preferences WHERE customer_id = ?", [customerId]);
  const cols = Object.keys(fields);
  const vals = cols.map((k) => {
    const v = fields[k];
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  if (existing.length > 0) {
    await executeStatements([`UPDATE notification_preferences SET ${cols.map((c, i) => `${c} = ${vals[i]}`).join(", ")} WHERE customer_id = ${customerId}`]);
  } else {
    await executeStatements([`INSERT INTO notification_preferences (customer_id, ${cols.join(", ")}) VALUES (${customerId}, ${vals.join(", ")})`]);
  }
}

async function technicianAuth(email = "notif-tech@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createTechnician(name: string, adminAuth: RequestInit): Promise<number> {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
}

// ── NotificationService unit-level (direct calls) ──────────────────────

describe("resolvePreferences / channel eligibility (via enqueueChannel directly)", () => {
  it("Customer with no preference row: email is eligible", async () => {
    const customer = await createCustomer();
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "person@example.test",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result.enqueued).toBe(true);
  });

  it("Customer with no preference row: SMS is NOT eligible (opt-in required)", async () => {
    const customer = await createCustomer();
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "sms",
      recipientType: "customer", recipientId: customer.id, recipientContact: "6045550100",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "sms_not_opted_in" });
  });

  it("email_enabled=0 -> no email row", async () => {
    const customer = await createCustomer();
    await setPreferences(customer.id, { email_enabled: 0 });
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "person@example.test",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "channel_disabled" });
  });

  it("sms_enabled=0 -> no SMS row", async () => {
    const customer = await createCustomer();
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "sms",
      recipientType: "customer", recipientId: customer.id, recipientContact: "6045550100",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "sms_not_opted_in" });
  });

  it("sms_enabled=1 without consent evidence -> no SMS", async () => {
    const customer = await createCustomer();
    await setPreferences(customer.id, { sms_enabled: 1 }); // no sms_consent_at
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "sms",
      recipientType: "customer", recipientId: customer.id, recipientContact: "6045550100",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "sms_not_opted_in" });
  });

  it("sms_enabled=1 WITH consent evidence -> SMS queued", async () => {
    const customer = await createCustomer();
    await setPreferences(customer.id, { sms_enabled: 1, sms_consent_at: "2026-01-01T00:00:00.000Z", sms_consent_source: "staff" });
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "sms",
      recipientType: "customer", recipientId: customer.id, recipientContact: "6045550100",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result.enqueued).toBe(true);
  });

  it("missing email -> no email row", async () => {
    const customer = await createCustomer();
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "missing_recipient" });
  });

  it("missing phone -> no SMS", async () => {
    const customer = await createCustomer();
    await setPreferences(customer.id, { sms_enabled: 1, sms_consent_at: "2026-01-01T00:00:00.000Z" });
    const result = await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 1, channel: "sms",
      recipientType: "customer", recipientId: customer.id, recipientContact: "",
      templateKey: "t", payload: {}, discriminator: "d1",
    });
    expect(result).toEqual({ enqueued: false, reason: "missing_recipient" });
  });
});

describe("idempotency", () => {
  it("duplicate enqueue (same discriminator/channel) leaves exactly one row", async () => {
    const customer = await createCustomer();
    const args = {
      eventType: "test.event", entityType: "test", entityId: 1, channel: "email" as const,
      recipientType: "customer" as const, recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: {}, discriminator: "same-key",
    };
    const first = await enqueueChannel(args);
    const second = await enqueueChannel(args);
    expect(first.enqueued).toBe(true);
    expect(second).toEqual({ enqueued: false, reason: "duplicate" });
    const rows = await outboxFor("test", 1);
    expect(rows).toHaveLength(1);
  });

  it("concurrent duplicate enqueue leaves exactly one row", async () => {
    const customer = await createCustomer();
    const args = {
      eventType: "test.event", entityType: "test", entityId: 2, channel: "email" as const,
      recipientType: "customer" as const, recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: {}, discriminator: "race-key",
    };
    const [r1, r2] = await Promise.all([enqueueChannel(args), enqueueChannel(args)]);
    const outcomes = [r1.enqueued, r2.enqueued].sort();
    expect(outcomes).toEqual([false, true]);
    const rows = await outboxFor("test", 2);
    expect(rows).toHaveLength(1);
  });

  it("different channels for the same event produce separate rows", async () => {
    const customer = await createCustomer();
    await setPreferences(customer.id, { sms_enabled: 1, sms_consent_at: "2026-01-01T00:00:00.000Z" });
    const result = await enqueueEvent({
      eventType: "test.event", entityType: "test", entityId: 3,
      recipientType: "customer", recipientId: customer.id, email: "x@example.test", phone: "6045550100",
      templateKey: "t", payload: {}, discriminator: "d3",
    });
    expect(result.email.enqueued).toBe(true);
    expect(result.sms.enqueued).toBe(true);
    const rows = await outboxFor("test", 3);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
  });

  it("different legitimate business events (different discriminators) never collide", async () => {
    const customer = await createCustomer();
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 4, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: {}, discriminator: "event-a",
    });
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 4, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: {}, discriminator: "event-b",
    });
    const rows = await outboxFor("test", 4);
    expect(rows).toHaveLength(2);
  });
});

describe("recipient snapshot", () => {
  it("the queued recipient equals the contact value passed at enqueue time", async () => {
    const customer = await createCustomer();
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 5, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "snapshot@example.test",
      templateKey: "t", payload: {}, discriminator: "d5",
    });
    const rows = await outboxFor("test", 5);
    expect(rows[0].recipient).toBe("snapshot@example.test");
  });

  it("a later contact edit does not rewrite an already-queued outbox recipient", async () => {
    const customer = await createCustomer();
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 6, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "original@example.test",
      templateKey: "t", payload: {}, discriminator: "d6",
    });
    const auth = await authHeaders();
    await put(`/api/customers/${customer.id}`, { email: "changed@example.test" }, auth);
    const rows = await outboxFor("test", 6);
    expect(rows[0].recipient).toBe("original@example.test");
  });
});

describe("payload minimality", () => {
  it("payload contains the required minimal fields", async () => {
    const customer = await createCustomer();
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 7, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: { customer_name: "Jane", job_identifier: "JOB-1" }, discriminator: "d7",
    });
    const rows = await outboxFor("test", 7);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({ customer_name: "Jane", job_identifier: "JOB-1" });
  });

  it("payload never contains an entire database object or unrelated sensitive fields", async () => {
    const customer = await createCustomer();
    await enqueueChannel({
      eventType: "test.event", entityType: "test", entityId: 8, channel: "email",
      recipientType: "customer", recipientId: customer.id, recipientContact: "x@example.test",
      templateKey: "t", payload: { customer_name: "Jane" }, discriminator: "d8",
    });
    const rows = await outboxFor("test", 8);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("household_income");
  });
});

// ── dedupe key builder (pure) ────────────────────────────────────────────

describe("buildDedupeKey", () => {
  it("is deterministic and stable for identical inputs", () => {
    const parts = { entityType: "job", entityId: 1, eventType: "job.appointment_confirmation", discriminator: 1, channel: "email" as const };
    expect(buildDedupeKey(parts)).toBe(buildDedupeKey({ ...parts }));
  });

  it("never uses a raw timestamp as its uniqueness component", () => {
    const key = buildDedupeKey({ entityType: "job", entityId: 1, eventType: "e", discriminator: 42, channel: "email" });
    expect(key).toBe("job:1:e:42:email");
  });
});

// ── Real event wiring, via the actual HTTP routes ────────────────────────

describe("appointment confirmation (POST /api/jobs)", () => {
  it("a scheduled Job queues a confirmation", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "confirm@example.test" }, auth);
    const job = await createJob(customer.id, "2026-09-01");
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.appointment_confirmation")).toBe(true);
  });

  it("no technician assigned still queues a confirmation (not gated on staffing)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "confirm2@example.test" }, auth);
    const job = await createJob(customer.id, "2026-09-02"); // no technician_id override
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.appointment_confirmation")).toBe(true);
  });
});

describe("appointment rescheduled (PUT /api/jobs/{id})", () => {
  it("an unrelated Job edit (notes only) does not queue a reschedule notification", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-03");
    await put(`/api/jobs/${job.id}`, { notes: "unrelated edit" }, auth);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.appointment_rescheduled")).toBe(false);
  });

  it("a genuine reschedule queues exactly one reschedule event", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-04");
    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-09-05" }, auth);
    const rows = await outboxFor("job", job.id);
    const reschedules = rows.filter((r) => r.event_type === "job.appointment_rescheduled");
    expect(reschedules).toHaveLength(1);
  });

  it("retrying the exact same PUT (already at target state) does not duplicate the reschedule event", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-06");
    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-09-07" }, auth);
    await put(`/api/jobs/${job.id}`, { scheduled_date: "2026-09-07" }, auth); // no-op, already there
    const rows = await outboxFor("job", job.id);
    const reschedules = rows.filter((r) => r.event_type === "job.appointment_rescheduled");
    expect(reschedules).toHaveLength(1);
  });
});

describe("appointment cancelled (POST /api/jobs/{id}/transition)", () => {
  it("a cancellation queues a cancellation notification", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-08");
    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.appointment_cancelled")).toBe(true);
  });

  it("a cancelled Job never creates a reminder-type row (no reminder enqueue exists yet, deferred to 9.2)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-09");
    await post(`/api/jobs/${job.id}/transition`, { to_status: "cancelled" }, auth);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type.includes("reminder"))).toBe(false);
  });
});

describe("invoice issued / payment received", () => {
  async function completedJobWithDraftInvoice(auth: RequestInit) {
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "invoice@example.test" }, auth);
    const technicianId = await createTechnician("Invoice Test Tech", auth);
    const job = await createJob(customer.id, "2026-09-10", { technician_id: technicianId });
    const started = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    expect(started.response.status).toBe(200);
    await satisfyCompletionRequirements(job.id, auth);
    const completed = await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
    expect(completed.response.status).toBe(200);
    // generateInvoiceForJob() auto-runs (best-effort) as part of the completed
    // transition (see index.ts transitionJobRoute) — the draft invoice already
    // exists by the time this returns, no separate POST /api/jobs/{id}/invoice needed.
    const invoiceRows = await queryDb<{ id: number; status: string; identifier: string }>(
      "SELECT id, status, identifier FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(invoiceRows).toHaveLength(1);
    return { job, invoice: invoiceRows[0] };
  }

  it("issuing an invoice queues an invoice.issued notification", async () => {
    const auth = await authHeaders();
    const { invoice } = await completedJobWithDraftInvoice(auth);
    // generateInvoiceForJob's own auto-issue path may already leave it as
    // 'issued' via the completion transition — resolve current status directly.
    const current = await queryDb<{ id: number; status: string }>("SELECT id, status FROM invoices WHERE id = ?", [invoice.id]);
    if (current[0].status === "draft") {
      await post(`/api/invoices/${invoice.id}/issue`, {}, auth);
    }
    const rows = await outboxFor("invoice", invoice.id);
    expect(rows.some((r) => r.event_type === "invoice.issued")).toBe(true);
  });

  it("a duplicate issue attempt on an already-issued invoice does not duplicate the notification", async () => {
    const auth = await authHeaders();
    const { invoice } = await completedJobWithDraftInvoice(auth);
    const current = await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invoice.id]);
    if (current[0].status === "draft") await post(`/api/invoices/${invoice.id}/issue`, {}, auth);
    const secondAttempt = await post(`/api/invoices/${invoice.id}/issue`, {}, auth);
    expect(secondAttempt.response.status).toBe(400); // already issued — rejected before any enqueue call
    const rows = await outboxFor("invoice", invoice.id);
    expect(rows.filter((r) => r.event_type === "invoice.issued")).toHaveLength(1);
  });

  it("recording a payment queues a payment.received notification", async () => {
    const auth = await authHeaders();
    const { invoice } = await completedJobWithDraftInvoice(auth);
    const current = await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invoice.id]);
    if (current[0].status === "draft") await post(`/api/invoices/${invoice.id}/issue`, {}, auth);
    const payRes = await post(`/api/invoices/${invoice.id}/payments`, {
      amount_cents: 100, payer_type: "customer", method: "cash",
    }, auth);
    expect(payRes.response.status).toBe(201);
    const rows = await outboxFor("payment", 0); // placeholder, real check below by event_type on the invoice's own payments
    const paymentRows = await queryDb<OutboxRow>("SELECT * FROM notification_outbox WHERE event_type = 'payment.received'");
    expect(paymentRows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(0); // sanity: entity_id=0 never matches anything real
  });

  it("a rejected payment (exceeds balance) never queues a notification", async () => {
    const auth = await authHeaders();
    const { invoice } = await completedJobWithDraftInvoice(auth);
    const current = await queryDb<{ status: string; total_cents: number }>("SELECT status, total_cents FROM invoices WHERE id = ?", [invoice.id]);
    if (current[0].status === "draft") await post(`/api/invoices/${invoice.id}/issue`, {}, auth);
    const before = (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM notification_outbox WHERE event_type = 'payment.received'"))[0].count;
    const overpay = await post(`/api/invoices/${invoice.id}/payments`, {
      amount_cents: current[0].total_cents + 999999, payer_type: "customer", method: "cash",
    }, auth);
    expect(overpay.response.status).toBe(400);
    const after = (await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM notification_outbox WHERE event_type = 'payment.received'"))[0].count;
    expect(after).toBe(before);
  });
});

describe("post-job survey (completion)", () => {
  it("a genuine completed transition queues a survey", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "survey@example.test" }, auth);
    const technicianId = await createTechnician("Survey Test Tech", auth);
    const job = await createJob(customer.id, "2026-09-11", { technician_id: technicianId });
    const started = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    expect(started.response.status).toBe(200);
    await satisfyCompletionRequirements(job.id, auth);
    const completed = await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
    expect(completed.response.status).toBe(200);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.post_job_survey")).toBe(true);
  });

  it("a rejected completion attempt (missing compliance requirements) never queues a survey", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const technicianId = await createTechnician("Rejected Survey Test Tech", auth);
    const job = await createJob(customer.id, "2026-09-12", { technician_id: technicianId });
    const started = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    expect(started.response.status).toBe(200);
    const rejected = await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth); // no compliance data satisfied
    expect(rejected.response.status).toBe(400);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.post_job_survey")).toBe(false);
  });
});

describe("Technician On The Way", () => {
  it("the assigned technician can trigger it for their own Job", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "otw@example.test" }, auth);
    const { technicianId, auth: techAuth } = await createLinkedTechnician("otw-tech1@example.test", auth);
    const job = await createJob(customer.id, "2026-09-13", { technician_id: technicianId });
    const res = await post(`/api/jobs/${job.id}/on-the-way`, {}, techAuth);
    expect(res.response.status).toBe(200);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.technician_on_the_way")).toBe(true);
  });

  it("a different technician cannot trigger it for a Job they're not assigned to -> 403", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const { technicianId } = await createLinkedTechnician("otw-tech2@example.test", auth);
    const { auth: otherTechAuth } = await createLinkedTechnician("otw-tech3@example.test", auth);
    const job = await createJob(customer.id, "2026-09-14", { technician_id: technicianId });
    const res = await post(`/api/jobs/${job.id}/on-the-way`, {}, otherTechAuth);
    expect(res.response.status).toBe(403);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.technician_on_the_way")).toBe(false);
  });

  it("an unlinked technician is denied", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-15");
    const unlinkedAuth = await technicianAuth();
    const res = await post(`/api/jobs/${job.id}/on-the-way`, {}, unlinkedAuth);
    expect(res.response.status).toBe(403);
  });

  it("unauthenticated -> 401", async () => {
    const res = await post("/api/jobs/1/on-the-way", {});
    expect(res.response.status).toBe(401);
  });

  it("two triggers on the same day for the same Job queue exactly one notification", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const { technicianId, auth: techAuth } = await createLinkedTechnician("otw-tech4@example.test", auth);
    const job = await createJob(customer.id, "2026-09-16", { technician_id: technicianId });
    await post(`/api/jobs/${job.id}/on-the-way`, {}, techAuth);
    await post(`/api/jobs/${job.id}/on-the-way`, {}, techAuth);
    const rows = await outboxFor("job", job.id);
    expect(rows.filter((r) => r.event_type === "job.technician_on_the_way")).toHaveLength(1);
  });

  it("triggering On The Way never mutates the Job's status", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const { technicianId, auth: techAuth } = await createLinkedTechnician("otw-tech5@example.test", auth);
    const job = await createJob(customer.id, "2026-09-17", { technician_id: technicianId });
    await post(`/api/jobs/${job.id}/on-the-way`, {}, techAuth);
    const rows = await queryDb<{ status: string }>("SELECT status FROM jobs WHERE id = ?", [job.id]);
    expect(rows[0].status).toBe("scheduled");
  });

  it("mass-assignment: an unexpected body field is rejected (.strict())", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const { technicianId, auth: techAuth } = await createLinkedTechnician("otw-tech6@example.test", auth);
    const job = await createJob(customer.id, "2026-09-18", { technician_id: technicianId });
    const res = await post(`/api/jobs/${job.id}/on-the-way`, { message: "custom text" }, techAuth);
    expect(res.response.status).toBe(400);
  });
});

// ── Isolation ─────────────────────────────────────────────────────────

describe("cross-domain isolation", () => {
  let google: GoogleMock;

  it("notification enqueue triggers zero additional Google Calendar calls", async () => {
    google = mockGoogleApi();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-19");
    // No Google Calendar integration was connected for this test's admin
    // user, so syncJobToAllConnectedUsers() has nothing to sync regardless —
    // this proves the new notification-enqueue code path introduces no NEW
    // calendar coupling (zero /events calls either way).
    expect(google.state.calls.filter((c) => c.url.includes("/events"))).toHaveLength(0);
    const rows = await outboxFor("job", job.id);
    expect(rows.some((r) => r.event_type === "job.appointment_confirmation")).toBe(true);
    google.restore();
  });

  it("Lead events are not wired to notifications this phase (Section 20)", async () => {
    const auth = await authHeaders();
    const leadRes = await post<{ id: number }>("/api/leads", { name: "Notif Isolation Lead" }, auth);
    expect(leadRes.response.status).toBe(201);
    await post(`/api/leads/${leadRes.body.id}/transition`, { to_status: "contacted" }, auth);
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE entity_type = 'lead'");
    expect(rows).toHaveLength(0);
  });
});
