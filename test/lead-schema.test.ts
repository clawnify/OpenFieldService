import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createUser, executeStatements,
  queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 8.0 — Lead Management data model. There is deliberately NO API yet
// (that's Phase 8.2+), so every test here exercises the schema directly via
// SQL (queryDb/executeStatements) rather than HTTP — the same "test server
// logic directly when that's the most precise way to prove an invariant"
// convention this project already uses for pure data/DB-level guarantees.
// See mem:backlog/p1-lead-management-pipeline for the full architectural
// record and the approved business decisions this schema implements.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function insertLead(overrides: Record<string, unknown> = {}): Promise<number> {
  const fields = {
    identifier: "LEAD-1", name: "Test Lead", phone: "", email: "", address: "",
    city: "", state: "", zip: "", status: "new", assigned_user_id: null,
    referral_source: "", referral_name: "", referred_by_customer_id: null,
    program_interest: null, estimated_value_cents: null, estimate_notes: "",
    lost_reason: "", lost_reason_note: "", converted_customer_id: null,
    converted_at: null, converted_by: null, notes: "",
    ...overrides,
  };
  const columns = Object.keys(fields);
  await executeStatements([
    `INSERT INTO leads (${columns.join(", ")}) VALUES (${columns.map((c) => {
      const v = fields[c as keyof typeof fields];
      if (v === null) return "NULL";
      if (typeof v === "number") return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    }).join(", ")})`,
  ]);
  const rows = await queryDb<{ id: number }>("SELECT id FROM leads WHERE identifier = ?", [fields.identifier]);
  return rows[0].id;
}

describe("migration applies cleanly and existing data survives", () => {
  it("leaves pre-existing tables (users, customers, global_settings) intact", async () => {
    const admin = await queryDb<{ email: string }>("SELECT email FROM users WHERE id = 1");
    expect(admin[0].email).toBe("admin@fieldscheduler.local");
    const settings = await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM global_settings");
    expect(settings[0].count).toBeGreaterThan(0);
  });

  it("created the leads and lead_status_history tables with the expected columns", async () => {
    const leadsSchema = await queryDb<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'leads'");
    for (const col of [
      "identifier", "name", "status", "assigned_user_id", "referral_source", "referral_name",
      "referred_by_customer_id", "program_interest", "estimated_value_cents", "lost_reason",
      "lost_reason_note", "converted_customer_id", "converted_at", "converted_by", "notes",
    ]) {
      expect(leadsSchema[0].sql).toContain(col);
    }
    const historySchema = await queryDb<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'lead_status_history'");
    for (const col of ["lead_id", "old_status", "new_status", "actor_user_id", "reason"]) {
      expect(historySchema[0].sql).toContain(col);
    }
  });

  it("created every expected index", async () => {
    const indexes = await queryDb<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND (tbl_name = 'leads' OR tbl_name = 'lead_status_history')"
    );
    const names = indexes.map((i) => i.name);
    for (const idx of [
      "idx_leads_status", "idx_leads_assigned_user", "idx_leads_phone", "idx_leads_email",
      "idx_leads_converted_customer", "idx_leads_referred_by", "idx_lead_status_history_lead",
    ]) {
      expect(names).toContain(idx);
    }
  });

  it("seeded the lead_counter/lead_prefix _meta rows", async () => {
    const rows = await queryDb<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key IN ('lead_counter', 'lead_prefix')");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.lead_counter).toBe("0");
    expect(byKey.lead_prefix).toBe("LEAD");
  });
});

describe("a Lead can be created with valid data", () => {
  it("stores a minimal Lead with defaults applied", async () => {
    const id = await insertLead();
    const rows = await queryDb<{ status: string; notes: string; estimated_value_cents: number | null }>(
      "SELECT status, notes, estimated_value_cents FROM leads WHERE id = ?", [id]
    );
    expect(rows[0].status).toBe("new");
    expect(rows[0].notes).toBe("");
    expect(rows[0].estimated_value_cents).toBeNull();
  });

  it("stores an integer-cents estimated value exactly, not a float dollar amount", async () => {
    const id = await insertLead({ identifier: "LEAD-2", estimated_value_cents: 450000 });
    const rows = await queryDb<{ estimated_value_cents: number }>("SELECT estimated_value_cents FROM leads WHERE id = ?", [id]);
    expect(rows[0].estimated_value_cents).toBe(450000);
    expect(Number.isInteger(rows[0].estimated_value_cents)).toBe(true);
  });

  it("enforces the identifier UNIQUE constraint", async () => {
    await insertLead({ identifier: "LEAD-DUP" });
    await expect(insertLead({ identifier: "LEAD-DUP", name: "Second Lead" })).rejects.toThrow();
  });
});

describe("Lead status history — reopen support (approved decision: Lost is NOT terminal)", () => {
  it("records the full new → lost → contacted (reopen) sequence, immutably", async () => {
    const auth = await authHeaders();
    const admin = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const actorId = admin.body.user.id;
    const leadId = await insertLead({ identifier: "LEAD-REOPEN" });

    await executeStatements([
      `INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (${leadId}, NULL, 'new', ${actorId}, 'Lead created')`,
      `INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (${leadId}, 'new', 'lost', ${actorId}, 'Price Too High')`,
      `INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (${leadId}, 'lost', 'contacted', ${actorId}, 'Reopened — customer called back')`,
    ]);
    await executeStatements([`UPDATE leads SET status = 'contacted' WHERE id = ${leadId}`]);

    const history = await queryDb<{ old_status: string | null; new_status: string; reason: string }>(
      "SELECT old_status, new_status, reason FROM lead_status_history WHERE lead_id = ? ORDER BY id", [leadId]
    );
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.new_status)).toEqual(["new", "lost", "contacted"]);
    // The original lost reason is preserved forever in history, even though
    // the Lead has since reopened past it — this is the schema-level
    // guarantee the "immutable history" business decision depends on.
    expect(history[1].reason).toBe("Price Too High");

    const lead = await queryDb<{ status: string }>("SELECT status FROM leads WHERE id = ?", [leadId]);
    expect(lead[0].status).toBe("contacted");
  });

  it("cascades lead_status_history away when the Lead itself is deleted", async () => {
    const leadId = await insertLead({ identifier: "LEAD-CASCADE" });
    await executeStatements([
      `INSERT INTO lead_status_history (lead_id, old_status, new_status, reason) VALUES (${leadId}, NULL, 'new', 'created')`,
    ]);
    expect((await queryDb("SELECT * FROM lead_status_history WHERE lead_id = ?", [leadId])).length).toBe(1);

    await executeStatements([`DELETE FROM leads WHERE id = ${leadId}`]);
    expect((await queryDb("SELECT * FROM lead_status_history WHERE lead_id = ?", [leadId])).length).toBe(0);
  });
});

describe("foreign key behavior", () => {
  it("rejects an invalid assigned_user_id", async () => {
    await expect(insertLead({ identifier: "LEAD-BAD-USER", assigned_user_id: 999999 })).rejects.toThrow();
  });

  it("rejects an invalid referred_by_customer_id", async () => {
    await expect(insertLead({ identifier: "LEAD-BAD-REFERRER", referral_source: "Existing Customer", referred_by_customer_id: 999999 })).rejects.toThrow();
  });

  it("rejects an invalid converted_customer_id", async () => {
    await expect(insertLead({ identifier: "LEAD-BAD-CONVERT", converted_customer_id: 999999 })).rejects.toThrow();
  });

  it("SET NULLs assigned_user_id when the assigned user is deleted — the Lead itself survives", async () => {
    const user = await createUser({ email: "lead-schema-assignee@example.test" });
    const leadId = await insertLead({ identifier: "LEAD-ASSIGNEE", assigned_user_id: user.id });

    await executeStatements([`DELETE FROM users WHERE id = ${user.id}`]);

    const rows = await queryDb<{ assigned_user_id: number | null }>("SELECT assigned_user_id FROM leads WHERE id = ?", [leadId]);
    expect(rows[0].assigned_user_id).toBeNull();
    expect((await queryDb("SELECT id FROM leads WHERE id = ?", [leadId])).length).toBe(1);
  });

  it("SET NULLs converted_customer_id when the converted Customer is deleted — Lead history is preserved", async () => {
    const customer = await createCustomer();
    const leadId = await insertLead({ identifier: "LEAD-CONVERTED", status: "won", converted_customer_id: customer.id });
    await executeStatements([
      `INSERT INTO lead_status_history (lead_id, old_status, new_status, reason) VALUES (${leadId}, 'estimate', 'won', 'Converted to existing customer')`,
    ]);

    const auth = await authHeaders();
    const del = await request(`/api/customers/${customer.id}`, { ...auth, method: "DELETE" });
    expect(del.response.status).toBe(200);

    const rows = await queryDb<{ status: string; converted_customer_id: number | null }>(
      "SELECT status, converted_customer_id FROM leads WHERE id = ?", [leadId]
    );
    expect(rows[0].converted_customer_id).toBeNull();
    expect(rows[0].status).toBe("won"); // the Lead's own historical status is untouched
    expect((await queryDb("SELECT * FROM lead_status_history WHERE lead_id = ?", [leadId])).length).toBe(1);
  });

  it("SET NULLs referred_by_customer_id when the referring Customer is deleted", async () => {
    const referrer = await createCustomer("Lead Schema Referrer");
    const leadId = await insertLead({
      identifier: "LEAD-REFERRED", referral_source: "Existing Customer", referred_by_customer_id: referrer.id,
    });

    const auth = await authHeaders();
    await request(`/api/customers/${referrer.id}`, { ...auth, method: "DELETE" });

    const rows = await queryDb<{ referred_by_customer_id: number | null }>("SELECT referred_by_customer_id FROM leads WHERE id = ?", [leadId]);
    expect(rows[0].referred_by_customer_id).toBeNull();
  });
});

describe("LEAD_LOST_REASON_OPTIONS — Global Settings catalog, not a hardcoded enum", () => {
  it("is exposed through the existing reference-data settings endpoint, no new API", async () => {
    const auth = await authHeaders();
    const res = await request<{ settings: { key: string; value: string }[] }>("/api/settings?category=reference_data", auth);
    const lostReasons = res.body.settings.find((s) => s.key === "LEAD_LOST_REASON_OPTIONS");
    expect(lostReasons).toBeDefined();
    const values = JSON.parse(lostReasons!.value);
    expect(values).toEqual([
      "Price Too High", "Chose Competitor", "Not Ready", "Unreachable",
      "Outside Service Area", "Not Eligible", "Duplicate Lead", "No Longer Needed", "Other",
    ]);
  });

  it("survives resetDatabase() between tests, same as REFERRAL_SOURCE_OPTIONS", async () => {
    const rows = await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM global_settings WHERE key = 'LEAD_LOST_REASON_OPTIONS'");
    expect(rows[0].count).toBe(1);
  });
});

describe("regression: Phase 1–7 functionality is unaffected by this migration", () => {
  it("customers, jobs, and users tables are fully functional after the Lead migration", async () => {
    const customer = await createCustomer();
    expect(customer.id).toBeGreaterThan(0);
    const auth = await authHeaders();
    const jobs = await request<{ jobs: unknown[]; total: number }>("/api/jobs", auth);
    expect(jobs.response.status).toBe(200);
  });
});
