import { get, query, run } from "./db.js";

/**
 * Phase 19B — Maintenance Agreement lifecycle engine. Mirrors
 * contract-workflow.ts's architecture (validation shape, optimistic-
 * concurrency `WHERE status = ?` guard, compensating-delete-on-conflict
 * batch pattern) for the BARE, user-triggered transitions. "signed",
 * "active", "expired", and "superseded" are never reached via a bare
 * `to_status` transition here — they are exclusively DERIVED, exactly
 * mirroring how Contracts' "signed"/"declined"/"partially_signed"/
 * "expired" are absent from CONTRACT_TRANSITIONS but reachable via
 * transitionContractInternal. See maintenance-agreements.ts's
 * recalculateAgreementStatus()/supersedeAgreement().
 *
 * Deliberately no "partially_signed" (unlike Contracts) — this phase does
 * not require multi-signer partial-completion tracking.
 */

export const AGREEMENT_STATUSES = ["draft", "sent", "viewed", "signed", "active", "cancelled", "expired", "superseded"] as const;
export type AgreementStatus = typeof AGREEMENT_STATUSES[number];

export function isAgreementStatus(value: string): value is AgreementStatus {
  return (AGREEMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Bare (user-triggered) transitions only:
 *   draft -> sent, cancelled
 *   sent, viewed, signed, active -> cancelled
 *   cancelled, expired, superseded -> (none — terminal)
 *
 * A signed/active Agreement can still be cancelled (an explicit,
 * reason-required action — mirrors Contracts' "voided after issuance").
 * Replacing an active Agreement's terms goes through supersedeAgreement()
 * (a distinct, explicit action), never a bare status transition.
 */
const AGREEMENT_TRANSITIONS: Record<AgreementStatus, readonly AgreementStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["cancelled"],
  viewed: ["cancelled"],
  signed: ["cancelled"],
  active: ["cancelled"],
  cancelled: [],
  expired: [],
  superseded: [],
};

export function resolveAllowedAgreementTransitions(currentStatus: string): AgreementStatus[] {
  if (!isAgreementStatus(currentStatus)) return [];
  return [...AGREEMENT_TRANSITIONS[currentStatus]];
}

export type AgreementWorkflowErrorCode = "not_found" | "invalid_transition" | "missing_data" | "conflict";

export class AgreementWorkflowError extends Error {
  code: AgreementWorkflowErrorCode;
  constructor(code: AgreementWorkflowErrorCode, message: string) {
    super(message);
    this.name = "AgreementWorkflowError";
    this.code = code;
  }
}

export interface AgreementWorkflowRow {
  id: number;
  status: string;
  organization_id: number;
}

export interface TransitionAgreementInput {
  toStatus: string;
  actorUserId: number;
  organizationId: number;
  /** Required (non-empty) for "cancelled". */
  reason?: string;
}

export interface AgreementTransitionOutcome {
  fromStatus: AgreementStatus;
  toStatus: AgreementStatus;
}

export async function transitionAgreement(
  db: D1Database,
  agreementId: number,
  input: TransitionAgreementInput
): Promise<AgreementTransitionOutcome> {
  const agreement = await get<AgreementWorkflowRow>(
    "SELECT id, status, organization_id FROM maintenance_agreements WHERE id = ? AND organization_id = ?",
    [agreementId, input.organizationId]
  );
  if (!agreement) throw new AgreementWorkflowError("not_found", "Maintenance agreement not found");

  const allowed = resolveAllowedAgreementTransitions(agreement.status);
  if (!allowed.includes(input.toStatus as AgreementStatus)) {
    throw new AgreementWorkflowError(
      "invalid_transition",
      `Cannot transition maintenance agreement from "${agreement.status}" to "${input.toStatus}"`
    );
  }
  const toStatus = input.toStatus as AgreementStatus;

  if (toStatus === "cancelled" && !(input.reason ?? "").trim()) {
    throw new AgreementWorkflowError("missing_data", "A reason is required to cancel a maintenance agreement");
  }

  return transitionAgreementInternal(db, agreement, toStatus, input.actorUserId, input.reason ?? "");
}

/** Internal — also called for DERIVED transitions (signed/active/expired/
 *  superseded) by maintenance-agreements.ts, which bypass the bare
 *  transition matrix above by construction. */
export async function transitionAgreementInternal(
  db: D1Database,
  agreement: AgreementWorkflowRow,
  toStatus: AgreementStatus,
  actorUserId: number | null,
  reason: string
): Promise<AgreementTransitionOutcome> {
  const extraSet = toStatus === "cancelled" ? ", cancelled_at = datetime('now'), cancel_reason = ?" : "";
  const extraParams = toStatus === "cancelled" ? [reason] : [];

  const updateStmt = db.prepare(
    `UPDATE maintenance_agreements SET status = ?, updated_at = datetime('now')${extraSet} WHERE id = ? AND status = ?`
  ).bind(toStatus, ...extraParams, agreement.id, agreement.status);

  const results = await db.batch([
    updateStmt,
    db.prepare(
      "INSERT INTO maintenance_agreement_status_history (agreement_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)"
    ).bind(agreement.id, agreement.status, toStatus, actorUserId, reason),
  ]);

  const updateChanges = results[0]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const historyRowId = results[1]?.meta?.last_row_id;
    if (historyRowId) {
      await run("DELETE FROM maintenance_agreement_status_history WHERE id = ?", [historyRowId]);
    }
    throw new AgreementWorkflowError(
      "conflict",
      "This maintenance agreement was changed by another request since it was last read — reload and try again"
    );
  }

  return { fromStatus: agreement.status as AgreementStatus, toStatus };
}

export interface AgreementStatusHistoryRow {
  id: number;
  agreement_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export async function getAgreementStatusHistory(agreementId: number): Promise<AgreementStatusHistoryRow[]> {
  return query<AgreementStatusHistoryRow>(
    "SELECT * FROM maintenance_agreement_status_history WHERE agreement_id = ? ORDER BY created_at DESC, id DESC", [agreementId]
  );
}

export const MEMBERSHIP_STATUSES = ["pending", "active", "paused", "cancelled", "expired", "superseded"] as const;
export type MembershipStatus = typeof MEMBERSHIP_STATUSES[number];
