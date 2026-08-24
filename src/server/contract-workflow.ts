import { get, query, run } from "./db.js";

/**
 * Phase 13 — Contract lifecycle engine. Mirrors quote-workflow.ts's
 * architecture (validation shape, optimistic-concurrency `WHERE status = ?`
 * guard, compensating-delete-on-conflict batch pattern) for the BARE,
 * user-triggered transitions (draft/sent/cancelled/voided). Unlike Quotes,
 * "signed"/"declined"/"partially_signed"/"expired" are never reached via a
 * bare `to_status` transition here — they are exclusively DERIVED from the
 * aggregate status of a Contract's signature requests (see
 * `recalculateContractStatus()` in contracts.ts, which mirrors
 * financial.ts's `recalculateStatus()` deriving `partially_paid`/`paid`
 * from payment aggregation — the same proven precedent, applied to
 * signature completion instead of payment completion).
 */

export const CONTRACT_STATUSES = ["draft", "sent", "partially_signed", "signed", "declined", "expired", "cancelled", "voided"] as const;
export type ContractStatus = typeof CONTRACT_STATUSES[number];

export function isContractStatus(value: string): value is ContractStatus {
  return (CONTRACT_STATUSES as readonly string[]).includes(value);
}

/**
 * The approved v1 transition matrix for BARE (user-triggered) transitions
 * only:
 *   draft -> sent, cancelled
 *   sent, partially_signed, signed, declined, expired -> voided
 *   cancelled, voided -> (none — terminal)
 *
 * "cancelled" is reachable ONLY from draft — Section 39's "cancelled
 * before completion" — a Contract that was never issued for signature.
 * "voided" is reachable from anything that WAS issued (sent), at any
 * point in its subsequent life including after full signature — Section
 * 39's "voided after issuance/signature" — a deliberate, explicit,
 * reason-required action to formally invalidate an issued Contract,
 * never a silent state change and never a delete (Section 40: signed
 * evidence is retained, only its effective status changes).
 *
 * "signed"/"declined"/"partially_signed"/"expired" are deliberately ABSENT
 * from this matrix — see module doc comment above.
 */
const CONTRACT_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["voided"],
  partially_signed: ["voided"],
  signed: ["voided"],
  declined: ["voided"],
  expired: ["voided"],
  cancelled: [],
  voided: [],
};

export function resolveAllowedContractTransitions(currentStatus: string): ContractStatus[] {
  if (!isContractStatus(currentStatus)) return [];
  return [...CONTRACT_TRANSITIONS[currentStatus]];
}

/** A new Contract Version may only be created while the current version is
 *  still draft (ordinary continued editing — no new version needed) is
 *  handled elsewhere; THIS governs the "start a fresh version after the
 *  current one was sent/terminal" path, mirroring Quotes'
 *  `canCreateRevisionFrom`. Signed is deliberately excluded — a signed
 *  Contract Version is final; changed terms require a brand-new Contract
 *  from a new Quote acceptance, not a revision of a signed one (stricter
 *  than Quotes, matching Section 11's "signed version permanently
 *  identifiable" and Section 38's "signed versions never change"). */
export function canCreateContractRevisionFrom(currentStatus: string): boolean {
  return currentStatus === "sent" || currentStatus === "partially_signed"
    || currentStatus === "declined" || currentStatus === "expired" || currentStatus === "cancelled";
}

export type ContractWorkflowErrorCode = "not_found" | "invalid_transition" | "missing_data" | "conflict";

export class ContractWorkflowError extends Error {
  code: ContractWorkflowErrorCode;
  constructor(code: ContractWorkflowErrorCode, message: string) {
    super(message);
    this.name = "ContractWorkflowError";
    this.code = code;
  }
}

export interface ContractWorkflowRow {
  id: number;
  status: string;
  organization_id: number;
}

export interface TransitionContractInput {
  toStatus: string;
  actorUserId: number;
  organizationId: number;
  /** Required (non-empty) for "voided" — a formal invalidation always
   *  needs a stated reason, matching Quotes' rejected/cancelled precedent. */
  reason?: string;
}

export interface ContractTransitionOutcome {
  fromStatus: ContractStatus;
  toStatus: ContractStatus;
}

export async function transitionContract(
  db: D1Database,
  contractId: number,
  input: TransitionContractInput
): Promise<ContractTransitionOutcome> {
  const contract = await get<ContractWorkflowRow>(
    "SELECT id, status, organization_id FROM contracts WHERE id = ? AND organization_id = ?",
    [contractId, input.organizationId]
  );
  if (!contract) throw new ContractWorkflowError("not_found", "Contract not found");

  const allowed = resolveAllowedContractTransitions(contract.status);
  if (!allowed.includes(input.toStatus as ContractStatus)) {
    throw new ContractWorkflowError(
      "invalid_transition",
      `Cannot transition contract from "${contract.status}" to "${input.toStatus}"`
    );
  }
  const toStatus = input.toStatus as ContractStatus;

  if (toStatus === "voided" && !(input.reason ?? "").trim()) {
    throw new ContractWorkflowError("missing_data", "A reason is required to void a contract");
  }

  return transitionContractInternal(db, contract, toStatus, input.actorUserId, input.reason ?? "");
}

/** Internal — also called by contracts.ts's `recalculateContractStatus()`
 *  for DERIVED transitions (signed/declined/partially_signed/expired),
 *  which bypass the bare-transition matrix above by construction (they are
 *  never reachable from `transitionContract()`'s public entry point) but
 *  reuse this exact same atomic-write-plus-history-row mechanism so every
 *  status change of any kind is uniformly recorded. */
export async function transitionContractInternal(
  db: D1Database,
  contract: ContractWorkflowRow,
  toStatus: ContractStatus,
  actorUserId: number | null,
  reason: string
): Promise<ContractTransitionOutcome> {
  const extraSet = toStatus === "voided" ? ", voided_at = datetime('now'), void_reason = ?" : "";
  const extraParams = toStatus === "voided" ? [reason] : [];

  const updateStmt = db.prepare(
    `UPDATE contracts SET status = ?, updated_at = datetime('now')${extraSet} WHERE id = ? AND status = ?`
  ).bind(toStatus, ...extraParams, contract.id, contract.status);

  const results = await db.batch([
    updateStmt,
    db.prepare(
      "INSERT INTO contract_status_history (contract_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)"
    ).bind(contract.id, contract.status, toStatus, actorUserId, reason),
  ]);

  const updateChanges = results[0]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const historyRowId = results[1]?.meta?.last_row_id;
    if (historyRowId) {
      await run("DELETE FROM contract_status_history WHERE id = ?", [historyRowId]);
    }
    throw new ContractWorkflowError(
      "conflict",
      "This contract was changed by another request since it was last read — reload and try again"
    );
  }

  return { fromStatus: contract.status as ContractStatus, toStatus };
}

export interface ContractStatusHistoryRow {
  id: number;
  contract_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export async function getContractStatusHistory(contractId: number): Promise<ContractStatusHistoryRow[]> {
  return query<ContractStatusHistoryRow>(
    "SELECT * FROM contract_status_history WHERE contract_id = ? ORDER BY created_at DESC, id DESC", [contractId]
  );
}
