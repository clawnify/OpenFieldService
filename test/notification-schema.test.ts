import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, createCustomer, executeStatements, queryDb, resetDatabase } from "./helpers.js";

// Phase 9.0 — Notifications data model. Schema/migration ONLY (no
// NotificationService, no provider, no Cron, no real send) — see
// mem:phase9/notifications-architecture-audit for the full architecture
// this migration is the foundation of. Every test here exercises the
// schema directly via SQL (executeStatements/queryDb), same "no API
// exists yet, test the schema directly" convention test/lead-schema.test.ts
// already established for a brand-new domain.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

const DEDUPE = (n: number) => `job:${n}:email:test@example.test:v1`;

async function insertOutbox(overrides: Record<string, unknown> = {}): Promise<number> {
  const fields = {
    event_type: "job.scheduled", entity_type: "job", entity_id: 1, channel: "email",
    recipient: "test@example.test", template_key: "job_scheduled_v1", dedupe_key: DEDUPE(1),
    ...overrides,
  };
  const columns = Object.keys(fields);
  await executeStatements([
    `INSERT INTO notification_outbox (${columns.join(", ")}) VALUES (${columns.map((c) => {
      const v = fields[c as keyof typeof fields];
      if (v === null) return "NULL";
      if (typeof v === "number") return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    }).join(", ")})`,
  ]);
  const rows = await queryDb<{ id: number }>("SELECT id FROM notification_outbox WHERE dedupe_key = ?", [fields.dedupe_key]);
  return rows[0].id;
}

describe("notification_outbox", () => {
  it("accepts a valid row insert", async () => {
    const id = await insertOutbox();
    expect(id).toBeGreaterThan(0);
  });

  it("enforces required fields (NOT NULL columns reject omission)", async () => {
    await expect(executeStatements([
      "INSERT INTO notification_outbox (entity_type, entity_id, channel, recipient, template_key, dedupe_key) VALUES ('job',1,'email','x@example.test','k','dk1')",
    ])).rejects.toThrow(); // event_type omitted
  });

  it("enforces a real UNIQUE constraint on dedupe_key, not just an app-side check", async () => {
    await insertOutbox({ dedupe_key: "dup-key" });
    await expect(insertOutbox({ dedupe_key: "dup-key", entity_id: 2 })).rejects.toThrow();
  });

  it("allows distinct dedupe keys for otherwise-identical rows", async () => {
    await insertOutbox({ dedupe_key: "key-a" });
    const id2 = await insertOutbox({ dedupe_key: "key-b" });
    expect(id2).toBeGreaterThan(0);
  });

  it("supports an immediate scheduled_for (defaults to now)", async () => {
    const id = await insertOutbox();
    const rows = await queryDb<{ scheduled_for: string }>("SELECT scheduled_for FROM notification_outbox WHERE id = ?", [id]);
    expect(rows[0].scheduled_for).toBeTruthy();
  });

  it("supports a future scheduled_for for reminders", async () => {
    const future = "2030-01-01T09:00:00.000Z";
    const id = await insertOutbox({ scheduled_for: future });
    const rows = await queryDb<{ scheduled_for: string }>("SELECT scheduled_for FROM notification_outbox WHERE id = ?", [id]);
    expect(rows[0].scheduled_for).toBe(future);
  });

  it("defaults status to pending", async () => {
    const id = await insertOutbox();
    const rows = await queryDb<{ status: string }>("SELECT status FROM notification_outbox WHERE id = ?", [id]);
    expect(rows[0].status).toBe("pending");
  });

  it("defaults attempts to zero", async () => {
    const id = await insertOutbox();
    const rows = await queryDb<{ attempts: number }>("SELECT attempts FROM notification_outbox WHERE id = ?", [id]);
    expect(rows[0].attempts).toBe(0);
  });

  it("supports the status+scheduled_for query path a future dispatcher scan needs", async () => {
    await insertOutbox({ dedupe_key: "due-1", status: "pending", scheduled_for: "2020-01-01T00:00:00.000Z" });
    await insertOutbox({ dedupe_key: "due-2", status: "sent", scheduled_for: "2020-01-01T00:00:00.000Z" });
    await insertOutbox({ dedupe_key: "due-3", status: "pending", scheduled_for: "2099-01-01T00:00:00.000Z" });
    const due = await queryDb<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM notification_outbox WHERE status = 'pending' AND scheduled_for <= ?", ["2025-01-01T00:00:00.000Z"]
    );
    expect(due.map((r) => r.dedupe_key)).toEqual(["due-1"]);
  });

  it("defaults payload to an empty JSON object, not null", async () => {
    const id = await insertOutbox();
    const rows = await queryDb<{ payload: string }>("SELECT payload FROM notification_outbox WHERE id = ?", [id]);
    expect(rows[0].payload).toBe("{}");
  });
});

describe("notification_preferences", () => {
  it("accepts a Customer preference row", async () => {
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id = ?", [customer.id]);
    expect(rows).toHaveLength(1);
  });

  it("accepts a Lead preference row", async () => {
    await executeStatements([
      "INSERT INTO leads (identifier, name, status) VALUES ('LEAD-PREF-1', 'Pref Test Lead', 'new')",
    ]);
    const lead = await queryDb<{ id: number }>("SELECT id FROM leads WHERE identifier = 'LEAD-PREF-1'");
    await executeStatements([`INSERT INTO notification_preferences (lead_id) VALUES (${lead[0].id})`]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE lead_id = ?", [lead[0].id]);
    expect(rows).toHaveLength(1);
  });

  it("rejects a row with both customer_id and lead_id set", async () => {
    const customer = await createCustomer();
    await executeStatements(["INSERT INTO leads (identifier, name, status) VALUES ('LEAD-PREF-2', 'X', 'new')"]);
    const lead = await queryDb<{ id: number }>("SELECT id FROM leads WHERE identifier = 'LEAD-PREF-2'");
    await expect(executeStatements([
      `INSERT INTO notification_preferences (customer_id, lead_id) VALUES (${customer.id}, ${lead[0].id})`,
    ])).rejects.toThrow();
  });

  it("rejects a row with neither customer_id nor lead_id set", async () => {
    await expect(executeStatements([
      "INSERT INTO notification_preferences (customer_id, lead_id) VALUES (NULL, NULL)",
    ])).rejects.toThrow();
  });

  it("rejects a second preference row for the same Customer", async () => {
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`]);
    await expect(executeStatements([
      `INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`,
    ])).rejects.toThrow();
  });

  it("rejects a second preference row for the same Lead", async () => {
    await executeStatements(["INSERT INTO leads (identifier, name, status) VALUES ('LEAD-PREF-3', 'X', 'new')"]);
    const lead = await queryDb<{ id: number }>("SELECT id FROM leads WHERE identifier = 'LEAD-PREF-3'");
    await executeStatements([`INSERT INTO notification_preferences (lead_id) VALUES (${lead[0].id})`]);
    await expect(executeStatements([
      `INSERT INTO notification_preferences (lead_id) VALUES (${lead[0].id})`,
    ])).rejects.toThrow();
  });

  it("defaults sms_enabled to disabled (opt-in required) and email_enabled to enabled (approved operational default)", async () => {
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`]);
    const rows = await queryDb<{ email_enabled: number; sms_enabled: number }>(
      "SELECT email_enabled, sms_enabled FROM notification_preferences WHERE customer_id = ?", [customer.id]
    );
    expect(rows[0]).toEqual({ email_enabled: 1, sms_enabled: 0 });
  });

  it("leaves consent timestamps nullable", async () => {
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`]);
    const rows = await queryDb<{ email_consent_at: string | null; sms_consent_at: string | null }>(
      "SELECT email_consent_at, sms_consent_at FROM notification_preferences WHERE customer_id = ?", [customer.id]
    );
    expect(rows[0]).toEqual({ email_consent_at: null, sms_consent_at: null });
  });

  it("stores a consent source as free text", async () => {
    const customer = await createCustomer();
    await executeStatements([
      `INSERT INTO notification_preferences (customer_id, sms_enabled, sms_consent_at, sms_consent_source) VALUES (${customer.id}, 1, datetime('now'), 'staff')`,
    ]);
    const rows = await queryDb<{ sms_consent_source: string }>("SELECT sms_consent_source FROM notification_preferences WHERE customer_id = ?", [customer.id]);
    expect(rows[0].sms_consent_source).toBe("staff");
  });

  it("cascades away when the Customer is deleted", async () => {
    const customer = await createCustomer();
    await executeStatements([`INSERT INTO notification_preferences (customer_id) VALUES (${customer.id})`]);
    await executeStatements([`DELETE FROM customers WHERE id = ${customer.id}`]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE customer_id = ?", [customer.id]);
    expect(rows).toHaveLength(0);
  });

  it("cascades away when the Lead is deleted", async () => {
    await executeStatements(["INSERT INTO leads (identifier, name, status) VALUES ('LEAD-PREF-4', 'X', 'new')"]);
    const lead = await queryDb<{ id: number }>("SELECT id FROM leads WHERE identifier = 'LEAD-PREF-4'");
    await executeStatements([`INSERT INTO notification_preferences (lead_id) VALUES (${lead[0].id})`]);
    await executeStatements([`DELETE FROM leads WHERE id = ${lead[0].id}`]);
    const rows = await queryDb("SELECT id FROM notification_preferences WHERE lead_id = ?", [lead[0].id]);
    expect(rows).toHaveLength(0);
  });
});

describe("notification_delivery_attempts", () => {
  it("accepts a valid delivery-attempt insert", async () => {
    const outboxId = await insertOutbox();
    await executeStatements([
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (${outboxId}, 1, 'started')`,
    ]);
    const rows = await queryDb("SELECT id FROM notification_delivery_attempts WHERE notification_id = ?", [outboxId]);
    expect(rows).toHaveLength(1);
  });

  it("supports multiple attempts for one notification with attempt_number preserved", async () => {
    const outboxId = await insertOutbox();
    await executeStatements([
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (${outboxId}, 1, 'failed')`,
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (${outboxId}, 2, 'succeeded')`,
    ]);
    const rows = await queryDb<{ attempt_number: number; status: string }>(
      "SELECT attempt_number, status FROM notification_delivery_attempts WHERE notification_id = ? ORDER BY attempt_number", [outboxId]
    );
    expect(rows.map((r) => [r.attempt_number, r.status])).toEqual([[1, "failed"], [2, "succeeded"]]);
  });

  it("leaves provider_message_id nullable (a failed attempt has none)", async () => {
    const outboxId = await insertOutbox();
    await executeStatements([
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (${outboxId}, 1, 'failed')`,
    ]);
    const rows = await queryDb<{ provider_message_id: string | null }>(
      "SELECT provider_message_id FROM notification_delivery_attempts WHERE notification_id = ?", [outboxId]
    );
    expect(rows[0].provider_message_id).toBeNull();
  });

  it("preserves error_code/error_message on a failed attempt", async () => {
    const outboxId = await insertOutbox();
    await executeStatements([
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status, error_code, error_message) VALUES (${outboxId}, 1, 'failed', 'rate_limited', 'Too many requests')`,
    ]);
    const rows = await queryDb<{ error_code: string; error_message: string }>(
      "SELECT error_code, error_message FROM notification_delivery_attempts WHERE notification_id = ?", [outboxId]
    );
    expect(rows[0]).toEqual({ error_code: "rate_limited", error_message: "Too many requests" });
  });

  it("rejects a delivery attempt referencing a nonexistent notification (real FK, not app-only)", async () => {
    await expect(executeStatements([
      "INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (999999, 1, 'started')",
    ])).rejects.toThrow();
  });

  it("cascades away when its outbox row is deleted (no delete API exists yet — this proves the FK policy itself, not a feature)", async () => {
    const outboxId = await insertOutbox();
    await executeStatements([
      `INSERT INTO notification_delivery_attempts (notification_id, attempt_number, status) VALUES (${outboxId}, 1, 'started')`,
    ]);
    await executeStatements([`DELETE FROM notification_outbox WHERE id = ${outboxId}`]);
    const rows = await queryDb("SELECT id FROM notification_delivery_attempts WHERE notification_id = ?", [outboxId]);
    expect(rows).toHaveLength(0);
  });
});

describe("concurrency/idempotency", () => {
  it("a concurrent duplicate dedupe_key insert leaves exactly one outbox row (INSERT ... ON CONFLICT DO NOTHING)", async () => {
    const insertOnce = () => executeStatements([
      "INSERT INTO notification_outbox (event_type, entity_type, entity_id, channel, recipient, template_key, dedupe_key) " +
      "VALUES ('job.scheduled','job',1,'email','race@example.test','k','race-dedupe-key') " +
      "ON CONFLICT(dedupe_key) DO NOTHING",
    ]);
    const results = await Promise.allSettled([insertOnce(), insertOnce()]);
    // Both calls succeed (DO NOTHING never errors) — the guarantee is about
    // row count, not about one call throwing.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE dedupe_key = 'race-dedupe-key'");
    expect(rows).toHaveLength(1);
  });

  it("no duplicate outbox records exist after repeated identical enqueue attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await executeStatements([
        "INSERT INTO notification_outbox (event_type, entity_type, entity_id, channel, recipient, template_key, dedupe_key) " +
        "VALUES ('job.scheduled','job',1,'email','repeat@example.test','k','repeat-dedupe-key') " +
        "ON CONFLICT(dedupe_key) DO NOTHING",
      ]);
    }
    const rows = await queryDb("SELECT id FROM notification_outbox WHERE dedupe_key = 'repeat-dedupe-key'");
    expect(rows).toHaveLength(1);
  });
});

describe("regression: Phase 1–8 functionality is unaffected by this migration", () => {
  it("customers and leads remain fully functional after the notification migration", async () => {
    const customer = await createCustomer();
    expect(customer.id).toBeGreaterThan(0);
    await executeStatements(["INSERT INTO leads (identifier, name, status) VALUES ('LEAD-REGRESSION-1', 'X', 'new')"]);
    const lead = await queryDb("SELECT id FROM leads WHERE identifier = 'LEAD-REGRESSION-1'");
    expect(lead).toHaveLength(1);
  });
});
