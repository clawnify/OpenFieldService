import { get, query, run } from "./db.js";
import { MEMBERSHIP_STATUSES, type MembershipStatus } from "./maintenance-workflow.js";

/**
 * Phase 19B — Membership = the active service entitlement produced by an
 * effective (signed/active) Maintenance Agreement (Section 8's preferred
 * conceptual model). 1:1 with an Agreement (`UNIQUE(agreement_id)`).
 * `visits_consumed` is NEVER a stored column — always summed live from
 * `maintenance_entitlement_events`, the same ledger-over-mutable-counter
 * discipline `getInvoiceFinancials()` established for
 * `amount_paid_cents`/`balance_cents` (Phase 5) — required here because
 * Section 21 explicitly demands "retries/concurrency must not
 * double-consume", which only an idempotency-keyed append-only ledger can
 * structurally guarantee.
 */

export interface Actor {
  id: number;
  role: "admin" | "dispatcher" | "technician";
}

export function canManageMemberships(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class MembershipError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state";
  constructor(code: MembershipError["code"], message: string) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
  }
}

export interface MembershipRow {
  id: number;
  organization_id: number;
  agreement_id: number;
  customer_id: number;
  plan_id: number;
  status: MembershipStatus;
  effective_start: string | null;
  effective_end: string | null;
  visits_included: number | null;
  cancelled_at: string | null;
  cancel_reason: string;
  cancelled_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface MembershipEntitlement {
  membership: MembershipRow;
  visitsIncluded: number | null;
  visitsConsumed: number;
  visitsRemaining: number | null;
}

async function recordMembershipStatusHistory(membershipId: number, oldStatus: string | null, newStatus: string, actorUserId: number | null, reason: string): Promise<void> {
  await run(
    "INSERT INTO maintenance_membership_status_history (membership_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)",
    [membershipId, oldStatus, newStatus, actorUserId, reason]
  );
}

/** Idempotent side-effect of an Agreement reaching `active` — mirrors
 *  `generateInvoiceForJob()`'s idempotent-side-effect pattern (Phase 5):
 *  fast-path check first, `UNIQUE(agreement_id)` is the real DB-level
 *  guard against a duplicate row under concurrent calls. */
export async function activateMembership(organizationId: number, agreementId: number, customerId: number, planId: number, agreementVersionId: number): Promise<MembershipRow> {
  const existing = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE agreement_id = ?", [agreementId]);
  if (existing) return existing;

  const version = await get<{ plan_snapshot: string; effective_date: string | null; expires_at: string | null }>(
    "SELECT plan_snapshot, effective_date, expires_at FROM maintenance_agreement_versions WHERE id = ?", [agreementVersionId]
  );
  const planSnapshot = version ? JSON.parse(version.plan_snapshot) : {};
  const visitsIncluded: number | null = planSnapshot.visit_entitlement_count ?? null;

  let membershipId: number;
  try {
    const result = await run(
      `INSERT INTO maintenance_memberships (organization_id, agreement_id, customer_id, plan_id, status, effective_start, effective_end, visits_included)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [organizationId, agreementId, customerId, planId, version?.effective_date ?? new Date().toISOString(), version?.expires_at ?? null, visitsIncluded]
    );
    membershipId = Number(result.lastInsertRowid);
  } catch {
    // Lost the race — another concurrent call already created it.
    const adopted = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE agreement_id = ?", [agreementId]);
    if (adopted) return adopted;
    throw new MembershipError("invalid_state", "Failed to create or adopt membership");
  }

  await recordMembershipStatusHistory(membershipId, null, "active", null, "Activated from a fully signed agreement");

  // Section 21 — a plan's included visits are granted as a positive ledger
  // entry, not a separate stored counter, so entitlement math (included -
  // consumed) always derives from one single source of truth.
  if (visitsIncluded !== null) {
    await run(
      "INSERT INTO maintenance_entitlement_events (membership_id, event_type, visit_delta, idempotency_key) VALUES (?, 'grant', ?, ?)",
      [membershipId, visitsIncluded, `membership:${membershipId}:initial-grant`]
    );
  }

  const created = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE id = ?", [membershipId]);
  if (!created) throw new MembershipError("not_found", "Failed to load newly created membership");
  return created;
}

export async function listMemberships(organizationId: number, filters: { customerId?: number; status?: string } = {}): Promise<MembershipRow[]> {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (filters.customerId) { conditions.push("customer_id = ?"); params.push(filters.customerId); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  return query<MembershipRow>(`SELECT * FROM maintenance_memberships WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`, params);
}

export async function getMembership(organizationId: number, membershipId: number): Promise<MembershipRow | null> {
  const row = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE id = ? AND organization_id = ?", [membershipId, organizationId]);
  return row ?? null;
}

export async function getMembershipByAgreement(organizationId: number, agreementId: number): Promise<MembershipRow | null> {
  const row = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE agreement_id = ? AND organization_id = ?", [agreementId, organizationId]);
  return row ?? null;
}

/** The ledger holds one "grant" event (+visits_included) plus one "consume"
 *  event (-1) per visit used, so SUM(visit_delta) is directly "visits
 *  remaining"; visitsConsumed is simply included - remaining. An unlimited
 *  plan (visits_included IS NULL) never has a grant event and always
 *  reports remaining/included as null (unbounded), consumed as the raw
 *  count of consume events for informational display only. */
export async function getEntitlement(organizationId: number, membershipId: number): Promise<MembershipEntitlement> {
  const membership = await getMembership(organizationId, membershipId);
  if (!membership) throw new MembershipError("not_found", "Membership not found");

  if (membership.visits_included === null) {
    const row = await get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM maintenance_entitlement_events WHERE membership_id = ? AND event_type = 'consume'", [membershipId]
    );
    return { membership, visitsIncluded: null, visitsConsumed: row?.count ?? 0, visitsRemaining: null };
  }

  const row = await get<{ total: number | null }>("SELECT SUM(visit_delta) AS total FROM maintenance_entitlement_events WHERE membership_id = ?", [membershipId]);
  const visitsRemaining = row?.total ?? 0;
  return { membership, visitsIncluded: membership.visits_included, visitsConsumed: membership.visits_included - visitsRemaining, visitsRemaining };
}

/** Consumes exactly one visit against a membership's entitlement, keyed by
 *  an idempotency_key unique to the triggering Service Report — a retry or
 *  concurrent duplicate call is a safe no-op (Section 21's explicit
 *  requirement), never a double-decrement. Silently a no-op if the
 *  membership has unlimited visits (visits_included is null) or doesn't
 *  exist — a maintenance visit not tied to a membership is not an error. */
export async function consumeEntitlement(membershipId: number | null, jobId: number, serviceReportId: number, actorUserId: number | null): Promise<void> {
  if (membershipId === null) return;
  const membership = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE id = ?", [membershipId]);
  if (!membership || membership.visits_included === null) return;

  try {
    await run(
      `INSERT INTO maintenance_entitlement_events (membership_id, event_type, visit_delta, related_job_id, related_service_report_id, idempotency_key, actor_user_id)
       VALUES (?, 'consume', -1, ?, ?, ?, ?)`,
      [membershipId, jobId, serviceReportId, `report:${serviceReportId}:consume`, actorUserId]
    );
  } catch {
    // Already consumed for this report — idempotent no-op, not an error.
  }
}

export async function cancelMembership(organizationId: number, actorUserId: number, membershipId: number, reason: string): Promise<MembershipRow> {
  const membership = await getMembership(organizationId, membershipId);
  if (!membership) throw new MembershipError("not_found", "Membership not found");
  if (!["pending", "active", "paused"].includes(membership.status)) throw new MembershipError("invalid_state", `Cannot cancel a membership in status "${membership.status}"`);
  if (!reason.trim()) throw new MembershipError("invalid_input", "A cancellation reason is required");

  await run(
    "UPDATE maintenance_memberships SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, cancelled_by = ?, updated_at = datetime('now') WHERE id = ?",
    [reason, actorUserId, membershipId]
  );
  await recordMembershipStatusHistory(membershipId, membership.status, "cancelled", actorUserId, reason);

  const updated = await getMembership(organizationId, membershipId);
  if (!updated) throw new MembershipError("not_found", "Failed to reload cancelled membership");
  return updated;
}

export interface MembershipStatusHistoryRow {
  id: number;
  membership_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export async function getMembershipStatusHistory(membershipId: number): Promise<MembershipStatusHistoryRow[]> {
  return query<MembershipStatusHistoryRow>(
    "SELECT * FROM maintenance_membership_status_history WHERE membership_id = ? ORDER BY created_at DESC, id DESC", [membershipId]
  );
}

export { MEMBERSHIP_STATUSES };
