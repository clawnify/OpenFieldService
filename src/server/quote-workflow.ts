import { get, run } from "./db.js";

/**
 * Central Quote-lifecycle engine — the ONLY place Quote status-transition
 * rules live. Mirrors lead-workflow.ts's architecture almost exactly
 * (validation shape, optimistic-concurrency `WHERE status = ?` guard,
 * compensating-delete-on-conflict batch pattern) since Quote's lifecycle is
 * structurally the same shape as Lead's: a small linear-ish pipeline with a
 * couple of terminal/reopenable side branches, not a job-type-varying
 * multi-branch FSM like workflow.ts's Job engine.
 */

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "cancelled"] as const;
export type QuoteStatus = typeof QUOTE_STATUSES[number];

export function isQuoteStatus(value: string): value is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(value);
}

/**
 * The approved v1 transition matrix, exactly:
 *   draft -> sent, cancelled
 *   sent  -> accepted, rejected, expired, cancelled
 *   accepted, rejected, expired, cancelled -> (none — all four are terminal
 *     to a bare status transition)
 *
 * "accepted" is genuinely terminal — Section 7's "accepted immutable/
 * version-protected" is literal: no reopen path exists at all, matching a
 * real signed-adjacent commercial commitment (a customer who wants changes
 * after accepting gets a NEW Quote, not a mutated one — out of this
 * phase's scope to auto-suggest).
 *
 * "rejected"/"expired"/"cancelled" are terminal to resolveAllowedQuoteTransitions
 * (no bare `to_status` transition reopens them) but ARE reachable again via
 * the separate, explicit "Create Revision" operation (quotes.ts's
 * createQuoteRevision), which resets quotes.status to "draft" as part of
 * that operation — same "reopening only through one named, audited
 * mechanism" discipline as Lead's "lost -> contacted" reopen, just modeled
 * as a distinct action here instead of a bare transition, since creating a
 * revision genuinely does more work (a new quote_versions row) than a
 * status flip alone.
 */
const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "rejected", "expired", "cancelled"],
  accepted: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export function resolveAllowedQuoteTransitions(currentStatus: string): QuoteStatus[] {
  if (!isQuoteStatus(currentStatus)) return [];
  return [...QUOTE_TRANSITIONS[currentStatus]];
}

/** Only these 4 statuses can be reached via createQuoteRevision (Section 8) —
 *  "draft" is excluded (already directly editable, no revision needed) and
 *  "accepted" is excluded (terminal, per the matrix comment above). */
export function canCreateRevisionFrom(currentStatus: string): boolean {
  return currentStatus === "sent" || currentStatus === "rejected"
    || currentStatus === "expired" || currentStatus === "cancelled";
}

export type QuoteWorkflowErrorCode = "not_found" | "invalid_transition" | "missing_data" | "conflict" | "expired";

export class QuoteWorkflowError extends Error {
  code: QuoteWorkflowErrorCode;
  constructor(code: QuoteWorkflowErrorCode, message: string) {
    super(message);
    this.name = "QuoteWorkflowError";
    this.code = code;
  }
}

export interface QuoteWorkflowRow {
  id: number;
  status: string;
  organization_id: number;
  current_version_id: number | null;
}

export interface TransitionQuoteInput {
  toStatus: string;
  /** Real, server-resolved actor id — never a value trusted from a request
   *  body. `null` for a system/customer-triggered transition with no
   *  staff actor (Phase 18 — a customer accepting via a public Good/
   *  Better/Best share link) — mirrors contracts.ts's own
   *  `transitionContractInternal(..., null, "Derived from signature
   *  request completion")` precedent for the identical "publicly-triggered
   *  status change" shape. `quote_status_history.actor_user_id` is
   *  already nullable for exactly this reason. */
  actorUserId: number | null;
  /** Real, server-resolved organization id — a quote belonging to a
   *  different organization is treated as not found. */
  organizationId: number;
  /** Free-text context for the history row. Required (non-empty) when
   *  toStatus is "rejected" or "cancelled" — a business decision this
   *  significant should always carry a stated reason, unlike Job's
   *  optional cancel reason. */
  reason?: string;
  /** Phase 18 (Section 22/25) — when toStatus === "accepted" and the
   *  accepted version has Good/Better/Best options, this is the exact
   *  option the customer (or staff, recording a selection) chose. Stored
   *  permanently on `quotes.accepted_option_id`, the same "explicit,
   *  permanent snapshot, never re-inferred" discipline as
   *  `accepted_version_id` itself. `undefined`/omitted for an ordinary
   *  non-Good/Better/Best acceptance — `accepted_option_id` simply stays
   *  NULL, exactly like every pre-Phase-18 accepted Quote. */
  acceptedOptionId?: number | null;
}

export interface QuoteTransitionOutcome {
  fromStatus: QuoteStatus;
  toStatus: QuoteStatus;
}

/** Section 17 — expiration is deterministic (based on the CURRENT version's
 *  stored `expires_at` date) and only ever applied at the moment someone
 *  actually tries to accept a sent Quote — no scheduler, no background
 *  sweep. A quote whose expiry has passed is NOT silently treated as
 *  expired everywhere; it is only ever forced into the "expired" status by
 *  this one check, as a side effect of a blocked accept attempt, and that
 *  side effect is itself a normal, audited transition (recorded in
 *  quote_status_history like any other). */
async function checkExpiry(quoteId: number, versionId: number | null): Promise<boolean> {
  if (versionId === null) return false;
  const version = await get<{ expires_at: string | null }>(
    "SELECT expires_at FROM quote_versions WHERE id = ?", [versionId]
  );
  if (!version?.expires_at) return false;
  const today = new Date().toISOString().slice(0, 10);
  return version.expires_at < today;
}

/**
 * THE authoritative way to change a Quote's status. Throws QuoteWorkflowError
 * for every rejection case. Concurrency: identical shape to
 * transitionLead() — the UPDATE carries a `WHERE status = ?` guard against
 * the status this call actually validated against; a D1 batch does not roll
 * back an earlier 0-row UPDATE just because it affected nothing, so a lost
 * race is detected afterward via the UPDATE's own reported row count and
 * compensated by deleting the just-inserted history row before reporting
 * the conflict.
 */
export async function transitionQuote(
  db: D1Database,
  quoteId: number,
  input: TransitionQuoteInput
): Promise<QuoteTransitionOutcome> {
  const quote = await get<QuoteWorkflowRow>(
    "SELECT id, status, organization_id, current_version_id FROM quotes WHERE id = ? AND organization_id = ?",
    [quoteId, input.organizationId]
  );
  if (!quote) throw new QuoteWorkflowError("not_found", "Quote not found");

  // Lazy expiry check — only on an attempted "accepted" transition, per the
  // checkExpiry() doc comment above.
  if (input.toStatus === "accepted" && quote.status === "sent" && await checkExpiry(quoteId, quote.current_version_id)) {
    await transitionQuoteInternal(db, quote, "expired", input.actorUserId, "Expiration date has passed");
    throw new QuoteWorkflowError("expired", "This quote has expired and cannot be accepted — create a revision to re-propose it");
  }

  const allowed = resolveAllowedQuoteTransitions(quote.status);
  if (!allowed.includes(input.toStatus as QuoteStatus)) {
    throw new QuoteWorkflowError(
      "invalid_transition",
      `Cannot transition quote from "${quote.status}" to "${input.toStatus}"`
    );
  }
  const toStatus = input.toStatus as QuoteStatus;

  if ((toStatus === "rejected" || toStatus === "cancelled") && !(input.reason ?? "").trim()) {
    throw new QuoteWorkflowError("missing_data", `A reason is required to mark a quote as ${toStatus}`);
  }

  return transitionQuoteInternal(db, quote, toStatus, input.actorUserId, input.reason ?? "", input.acceptedOptionId ?? null);
}

async function transitionQuoteInternal(
  db: D1Database,
  quote: QuoteWorkflowRow,
  toStatus: QuoteStatus,
  actorUserId: number | null,
  reason: string,
  acceptedOptionId: number | null = null
): Promise<QuoteTransitionOutcome> {
  // accepted_version_id (hardening addendum): an EXPLICIT, permanent
  // snapshot of quote.current_version_id at this exact moment — not just an
  // inference that current_version_id "happens to" stay put once accepted
  // (true today, since createQuoteRevision() structurally excludes
  // "accepted", but Phase 13 should be able to reference an exact accepted
  // version without depending on that invariant holding forever).
  // accepted_by stays NULL for a customer self-service acceptance (Phase
  // 18's public Good/Better/Best selection, actorUserId===null) — no staff
  // member "recorded" it, which is itself the accurate, honest fact; the
  // column's own type (`number | null`) already allows this.
  const extraSet = toStatus === "accepted"
    ? ", accepted_by = ?, accepted_at = datetime('now'), accepted_version_id = ?, accepted_option_id = ?"
    : toStatus === "rejected"
      ? ", rejected_reason = ?"
      : "";
  const extraParams = toStatus === "accepted" ? [actorUserId, quote.current_version_id, acceptedOptionId] : toStatus === "rejected" ? [reason] : [];

  const updateStmt = db.prepare(
    `UPDATE quotes SET status = ?, updated_at = datetime('now')${extraSet} WHERE id = ? AND status = ?`
  ).bind(toStatus, ...extraParams, quote.id, quote.status);

  const results = await db.batch([
    updateStmt,
    db.prepare(
      "INSERT INTO quote_status_history (quote_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)"
    ).bind(quote.id, quote.status, toStatus, actorUserId, reason),
  ]);

  const updateChanges = results[0]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const historyRowId = results[1]?.meta?.last_row_id;
    if (historyRowId) {
      await run("DELETE FROM quote_status_history WHERE id = ?", [historyRowId]);
    }
    throw new QuoteWorkflowError(
      "conflict",
      "This quote was changed by another request since it was last read — reload and try again"
    );
  }

  return { fromStatus: quote.status as QuoteStatus, toStatus };
}
