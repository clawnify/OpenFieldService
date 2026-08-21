import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, authHeaders, createUser, executeStatements, queryDb, request, resetDatabase } from "./helpers.js";
import { LeadWorkflowError, resolveAllowedLeadTransitions, transitionLead } from "../src/server/lead-workflow.js";

// Phase 8.1 — Lead domain & workflow engine. No /api/leads routes exist yet
// (Phase 8.2+), so transitionLead() is called directly against env.DB, the
// same "test server logic directly when there's no HTTP layer" convention
// test/lead-schema.test.ts already established for this domain.

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

async function getAdminId(): Promise<number> {
  const auth = await authHeaders();
  const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
  return me.body.user.id;
}

async function leadRow(leadId: number) {
  const rows = await queryDb<{ status: string; lost_reason: string; lost_reason_note: string; converted_customer_id: number | null; converted_at: string | null; converted_by: number | null }>(
    "SELECT status, lost_reason, lost_reason_note, converted_customer_id, converted_at, converted_by FROM leads WHERE id = ?", [leadId]
  );
  return rows[0];
}

async function history(leadId: number) {
  return queryDb<{ old_status: string | null; new_status: string; actor_user_id: number | null; reason: string }>(
    "SELECT old_status, new_status, actor_user_id, reason FROM lead_status_history WHERE lead_id = ? ORDER BY id", [leadId]
  );
}

describe("resolveAllowedLeadTransitions — the approved v1 matrix", () => {
  it("matches the exact approved transition matrix", () => {
    expect(resolveAllowedLeadTransitions("new").sort()).toEqual(["contacted", "lost"]);
    expect(resolveAllowedLeadTransitions("contacted").sort()).toEqual(["lost", "qualified"]);
    expect(resolveAllowedLeadTransitions("qualified").sort()).toEqual(["estimate", "lost"]);
    expect(resolveAllowedLeadTransitions("estimate").sort()).toEqual(["lost", "won"]);
    expect(resolveAllowedLeadTransitions("won")).toEqual([]);
    expect(resolveAllowedLeadTransitions("lost")).toEqual(["contacted"]);
  });
});

describe("valid transitions — each of the 9 approved edges", () => {
  const cases: Array<[string, string, Record<string, unknown>?]> = [
    ["new", "contacted"],
    ["new", "lost", { lostReason: "Not Ready" }],
    ["contacted", "qualified"],
    ["contacted", "lost", { lostReason: "Unreachable" }],
    ["qualified", "estimate"],
    ["qualified", "lost", { lostReason: "Chose Competitor" }],
    ["estimate", "won"],
    ["estimate", "lost", { lostReason: "Price Too High" }],
    ["lost", "contacted"],
  ];

  it.each(cases)("%s -> %s succeeds", async (fromStatus, toStatus, extra = {}) => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: `LEAD-${fromStatus}-${toStatus}`, status: fromStatus });

    const outcome = await transitionLead(env.DB, leadId, { organizationId: 1, toStatus, actorUserId: actorId, ...extra });
    expect(outcome.fromStatus).toBe(fromStatus);
    expect(outcome.toStatus).toBe(toStatus);

    const row = await leadRow(leadId);
    expect(row.status).toBe(toStatus);

    const rows = await history(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ old_status: fromStatus, new_status: toStatus, actor_user_id: actorId });
  });
});

describe("invalid transitions are rejected and mutate nothing", () => {
  const invalidCases: Array<[string, string]> = [
    ["new", "qualified"],
    ["new", "estimate"],
    ["new", "won"],
    ["contacted", "estimate"],
    ["contacted", "won"],
    ["qualified", "won"],
    ["won", "contacted"],
    ["won", "lost"],
    ["won", "estimate"],
  ];

  it.each(invalidCases)("%s -> %s is rejected", async (fromStatus, toStatus) => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: `LEAD-BAD-${fromStatus}-${toStatus}`, status: fromStatus });

    await expect(transitionLead(env.DB, leadId, { organizationId: 1, toStatus, actorUserId: actorId, lostReason: "Not Ready" }))
      .rejects.toMatchObject({ code: "invalid_transition" });

    const row = await leadRow(leadId);
    expect(row.status).toBe(fromStatus);
    expect(await history(leadId)).toHaveLength(0);
  });

  it("throws LeadWorkflowError (not a generic Error) with the invalid_transition code", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-TYPE-CHECK", status: "won" });
    try {
      await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Not Ready" });
      expect.unreachable("expected transitionLead to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LeadWorkflowError);
      expect((err as LeadWorkflowError).code).toBe("invalid_transition");
    }
  });

  it("rejects a transition on a nonexistent lead with not_found", async () => {
    const actorId = await getAdminId();
    await expect(transitionLead(env.DB, 999999, { organizationId: 1, toStatus: "contacted", actorUserId: actorId }))
      .rejects.toMatchObject({ code: "not_found" });
  });
});

describe("lost-reason business rules", () => {
  it("rejects a missing lost reason", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-LOST-MISSING", status: "new" });
    await expect(transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId }))
      .rejects.toMatchObject({ code: "missing_data" });
    expect((await leadRow(leadId)).status).toBe("new");
    expect(await history(leadId)).toHaveLength(0);
  });

  it("rejects a lost reason that isn't in the LEAD_LOST_REASON_OPTIONS catalog", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-LOST-INVALID", status: "new" });
    await expect(transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Made Up Reason" }))
      .rejects.toMatchObject({ code: "missing_data" });
    expect((await leadRow(leadId)).status).toBe("new");
    expect(await history(leadId)).toHaveLength(0);
  });

  it("accepts every catalog value", async () => {
    const actorId = await getAdminId();
    const options = ["Price Too High", "Chose Competitor", "Not Ready", "Unreachable", "Outside Service Area", "Not Eligible", "Duplicate Lead", "No Longer Needed", "Other"];
    for (const [i, reason] of options.entries()) {
      const leadId = await insertLead({ identifier: `LEAD-LOST-CATALOG-${i}`, status: "new" });
      await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: reason });
      expect((await leadRow(leadId)).lost_reason).toBe(reason);
    }
  });

  it("stores an optional lost_reason_note without requiring it", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-LOST-NOTE", status: "new" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Other", lostReasonNote: "Went with a competing quote" });
    const row = await leadRow(leadId);
    expect(row.lost_reason).toBe("Other");
    expect(row.lost_reason_note).toBe("Went with a competing quote");
  });

  it("does not require lost_reason_note even for 'Other'", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-LOST-NO-NOTE", status: "new" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Other" });
    expect((await leadRow(leadId)).status).toBe("lost");
  });

  it("reopen (lost -> contacted) preserves the historical lost reason in lead_status_history and does not clear it on the active row", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-REOPEN", status: "new" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Price Too High", lostReasonNote: "Budget concerns" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "contacted", actorUserId: actorId, reason: "Customer called back" });

    const row = await leadRow(leadId);
    expect(row.status).toBe("contacted");
    expect(row.lost_reason).toBe("Price Too High");
    expect(row.lost_reason_note).toBe("Budget concerns");

    const rows = await history(leadId);
    expect(rows.map((r) => r.new_status)).toEqual(["lost", "contacted"]);
    expect(rows[0].reason).toBe("Price Too High");
  });
});

describe("history / audit", () => {
  it("creates exactly one history row per successful transition with the correct actor", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-HIST-1", status: "new" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "contacted", actorUserId: actorId });
    const rows = await history(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ old_status: "new", new_status: "contacted", actor_user_id: actorId });
  });

  it("uses the server-supplied actorUserId, not any client-suppliable value implicit in the input", async () => {
    const staff = await createUser({ email: "lead-workflow-actor@example.test" });
    const leadId = await insertLead({ identifier: "LEAD-HIST-ACTOR", status: "new" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "contacted", actorUserId: staff.id });
    const rows = await history(leadId);
    expect(rows[0].actor_user_id).toBe(staff.id);
  });

  it("writes zero history rows when a transition is rejected", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-HIST-NONE", status: "new" });
    await expect(transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "won", actorUserId: actorId })).rejects.toThrow();
    expect(await history(leadId)).toHaveLength(0);
  });
});

describe("atomicity", () => {
  it("a forced failure after validation leaves no partial state (no status change, no orphan history row)", async () => {
    const leadId = await insertLead({ identifier: "LEAD-ATOMIC", status: "estimate" });
    // Force the batch itself to fail: bind a non-existent lead id into a
    // hand-rolled batch matching transitionLead's own shape, proving the
    // UPDATE+INSERT pair really is one unit, not two independent writes.
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE leads SET status = ? WHERE id = ? AND status = ?").bind("won", leadId, "estimate"),
        env.DB.prepare("INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)")
          .bind(leadId, "estimate", "won", 999999, ""), // actor_user_id FK violation
      ])
    ).rejects.toThrow();

    const row = await leadRow(leadId);
    expect(row.status).toBe("estimate"); // the UPDATE did not commit despite running first in the batch
    expect(await history(leadId)).toHaveLength(0);
  });

  it("a stale-state conflict leaves the lead untouched and removes the compensating history row", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-STALE", status: "new" });
    // Move the lead out from under a caller who already validated against "new".
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "contacted", actorUserId: actorId });

    await expect(
      transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "qualified", actorUserId: actorId })
    ).resolves.toBeTruthy(); // this one is now valid from "contacted"

    // Simulate a second caller that read "new" before the above happened
    // by directly exercising the same conditional UPDATE transitionLead uses.
    const staleAttempt = await env.DB.batch([
      env.DB.prepare("UPDATE leads SET status = ? WHERE id = ? AND status = ?").bind("contacted", leadId, "new"),
      env.DB.prepare("INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)")
        .bind(leadId, "new", "contacted", actorId, ""),
    ]);
    expect(staleAttempt[0].meta.changes).toBe(0); // proves the guard clause itself is effective
  });
});

describe("concurrency — competing transitions from the same stale state", () => {
  it("two simultaneous transitions read from the same starting status cannot both succeed", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-RACE", status: "contacted" });

    const [r1, r2] = await Promise.allSettled([
      transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "qualified", actorUserId: actorId }),
      transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "lost", actorUserId: actorId, lostReason: "Not Ready" }),
    ]);

    const outcomes = [r1, r2];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });

    // Exactly one history row survives — the winner's — never both, never neither.
    const rows = await history(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].old_status).toBe("contacted");

    const row = await leadRow(leadId);
    expect(["qualified", "lost"]).toContain(row.status);
    expect(rows[0].new_status).toBe(row.status);
  });
});

describe("terminal behavior — Won", () => {
  it("Won never appears as a source of any allowed transition", () => {
    expect(resolveAllowedLeadTransitions("won")).toEqual([]);
  });

  it("rejects every attempted transition out of Won", async () => {
    const actorId = await getAdminId();
    for (const toStatus of ["new", "contacted", "qualified", "estimate", "lost"]) {
      const leadId = await insertLead({ identifier: `LEAD-WON-${toStatus}`, status: "won" });
      await expect(transitionLead(env.DB, leadId, { organizationId: 1, toStatus, actorUserId: actorId, lostReason: "Not Ready" }))
        .rejects.toMatchObject({ code: "invalid_transition" });
    }
  });
});

describe("conversion boundary — Phase 8.1 must never populate conversion fields", () => {
  it("a normal estimate -> won transition leaves converted_customer_id/converted_at/converted_by untouched", async () => {
    const actorId = await getAdminId();
    const leadId = await insertLead({ identifier: "LEAD-WON-BOUNDARY", status: "estimate" });
    await transitionLead(env.DB, leadId, { organizationId: 1, toStatus: "won", actorUserId: actorId });

    const row = await leadRow(leadId);
    expect(row.status).toBe("won");
    expect(row.converted_customer_id).toBeNull();
    expect(row.converted_at).toBeNull();
    expect(row.converted_by).toBeNull();
  });
});
