import { get, run } from "./db.js";
import { getSettingValue } from "./settings.js";

/**
 * Central Lead-workflow engine — the ONLY place Lead status-transition rules
 * live. Mirrors workflow.ts's architecture (validation shape, atomic
 * batch write, typed errors) but is a deliberately SEPARATE module: Lead and
 * Job are different domains with different lifecycles, and this file must
 * never be merged into workflow.ts or vice versa.
 *
 * Two intentional deviations from workflow.ts's precedent, both driven by
 * this phase's approved scope (Phase 8.1 — domain/workflow only):
 *
 * 1. No RBAC. transitionLead() takes a plain `actorUserId: number`, not a
 *    full `Actor { id, role }`, and never consults a role. Full Lead RBAC is
 *    Phase 8.2's job; this module's only security obligation this phase is
 *    making it impossible to bypass *actor identity* (every history row
 *    requires a real, server-supplied actor id — see TransitionLeadInput).
 * 2. Optimistic concurrency. workflow.ts's transitionJob() validates against
 *    a freshly-read status and then writes unconditionally — it has no
 *    guard against a stale read. transitionLead() adds one (a conditional
 *    `WHERE status = ?` on the UPDATE), because it must — see
 *    transitionLead()'s own comment for the exact mechanism.
 */

export const LEAD_STATUSES = ["new", "contacted", "qualified", "estimate", "won", "lost"] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

/** Forward pipeline order — index order IS the forward-progression rule.
 *  "lost" is deliberately not listed here: like Job's "cancelled", it's a
 *  universal transition available from any non-terminal pipeline status. */
const LEAD_PIPELINE: readonly LeadStatus[] = ["new", "contacted", "qualified", "estimate", "won"];

/** The approved v1 transition matrix, exactly:
 *    new -> contacted, new -> lost
 *    contacted -> qualified, contacted -> lost
 *    qualified -> estimate, qualified -> lost
 *    estimate -> won, estimate -> lost
 *    lost -> contacted
 *  "won" is terminal (no approved decision allows reopening a Won lead).
 *  "lost" reopens to "contacted" specifically — not derived from history
 *  (unlike Job's cancel/reopen), because the approved matrix names exactly
 *  one reopen target, not "whatever it was before". */
export function resolveAllowedLeadTransitions(currentStatus: string): LeadStatus[] {
  if (!isLeadStatus(currentStatus)) return [];
  if (currentStatus === "won") return [];
  if (currentStatus === "lost") return ["contacted"];
  const idx = LEAD_PIPELINE.indexOf(currentStatus as LeadStatus);
  if (idx === -1) return [];
  const next: LeadStatus[] = [];
  if (idx < LEAD_PIPELINE.length - 1) next.push(LEAD_PIPELINE[idx + 1]);
  next.push("lost");
  return next;
}

const LEAD_LOST_REASON_SETTING_KEY = "LEAD_LOST_REASON_OPTIONS";

/** Resolved against the existing Global Settings catalog (migration 0010) —
 *  never hardcoded here. Returns [] (rejecting every "lost" transition) if
 *  the catalog is somehow missing rather than silently accepting anything. */
async function getLeadLostReasonCatalog(): Promise<string[]> {
  const options = await getSettingValue<string[]>(LEAD_LOST_REASON_SETTING_KEY);
  return options ?? [];
}

export type LeadWorkflowErrorCode = "not_found" | "invalid_transition" | "missing_data" | "conflict";

export class LeadWorkflowError extends Error {
  code: LeadWorkflowErrorCode;
  constructor(code: LeadWorkflowErrorCode, message: string) {
    super(message);
    this.name = "LeadWorkflowError";
    this.code = code;
  }
}

export interface LeadWorkflowRow {
  id: number;
  status: string;
  lost_reason: string;
  lost_reason_note: string;
}

export interface TransitionLeadInput {
  toStatus: string;
  /** Real, server-resolved actor id (e.g. from the authenticated session) —
   *  NEVER a value trusted from a request body. Recorded on the history row
   *  exactly as given; this module does no identity resolution of its own. */
  actorUserId: number;
  /** Free-text context for the history row; irrelevant when toStatus is
   *  "lost" (lostReason is used instead — see below). */
  reason?: string;
  /** Required, and validated against the LEAD_LOST_REASON_OPTIONS catalog,
   *  when toStatus is "lost". Ignored for every other toStatus. */
  lostReason?: string;
  /** Optional free text alongside lostReason (meaningful mainly when
   *  lostReason is "Other"). Never required. */
  lostReasonNote?: string;
}

export interface LeadTransitionOutcome {
  lead: LeadWorkflowRow;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
}

/**
 * THE authoritative way to change a Lead's status. Validates the current
 * status and the requested transition, resolves lost-reason requirements
 * against the Global Settings catalog, then persists the status change and
 * its history row atomically (mirrors transitionJob()'s single-db.batch()
 * shape). Throws LeadWorkflowError for every rejection case.
 *
 * Concurrency: unlike transitionJob(), the UPDATE here carries a
 * `WHERE status = ?` guard against the status this call actually validated
 * against — "write only if current status is still the expected status"
 * (Section 10). A D1 batch does not roll back a statement just because an
 * earlier one in the same batch affected zero rows (a 0-row UPDATE is a
 * successful statement, not a SQL error), so the paired history INSERT
 * still runs even when the UPDATE is a stale-state no-op. Rather than lean
 * on unverified cross-statement SQLite state (e.g. changes() carrying over
 * between batched statements), this function detects that case afterward
 * via the UPDATE's own reported row count and compensates by deleting
 * exactly the just-inserted history row (by primary key) before reporting
 * the conflict — so a losing racer never leaves a trace in either table.
 */
export async function transitionLead(
  db: D1Database,
  leadId: number,
  input: TransitionLeadInput
): Promise<LeadTransitionOutcome> {
  const lead = await get<LeadWorkflowRow>(
    "SELECT id, status, lost_reason, lost_reason_note FROM leads WHERE id = ?",
    [leadId]
  );
  if (!lead) throw new LeadWorkflowError("not_found", "Lead not found");

  const allowed = resolveAllowedLeadTransitions(lead.status);
  if (!allowed.includes(input.toStatus as LeadStatus)) {
    throw new LeadWorkflowError(
      "invalid_transition",
      `Cannot transition lead from "${lead.status}" to "${input.toStatus}"`
    );
  }
  const toStatus = input.toStatus as LeadStatus;

  // Only a transition INTO "lost" touches lost_reason/lost_reason_note.
  // Every other transition — including "lost" -> "contacted" (reopen) —
  // leaves them exactly as they were: Section 12 requires a transition to
  // modify only the fields necessary for itself, and no approved Phase 8
  // decision calls for clearing the prior lost reason on reopen (the
  // point-in-time record already lives forever in lead_status_history).
  let lostReason = lead.lost_reason;
  let lostReasonNote = lead.lost_reason_note;
  if (toStatus === "lost") {
    const reason = (input.lostReason ?? "").trim();
    if (!reason) {
      throw new LeadWorkflowError("missing_data", "A lost reason is required to mark a Lead as lost");
    }
    const catalog = await getLeadLostReasonCatalog();
    if (!catalog.includes(reason)) {
      throw new LeadWorkflowError("missing_data", `"${reason}" is not a recognized lost reason`);
    }
    lostReason = reason;
    lostReasonNote = input.lostReasonNote ?? "";
  }

  const historyReason = toStatus === "lost" ? lostReason : (input.reason ?? "");

  const updateStmt = toStatus === "lost"
    ? db.prepare(
        "UPDATE leads SET status = ?, lost_reason = ?, lost_reason_note = ?, updated_at = datetime('now') WHERE id = ? AND status = ?"
      ).bind(toStatus, lostReason, lostReasonNote, leadId, lead.status)
    : db.prepare(
        "UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?"
      ).bind(toStatus, leadId, lead.status);

  const results = await db.batch([
    updateStmt,
    db.prepare(
      "INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)"
    ).bind(leadId, lead.status, toStatus, input.actorUserId, historyReason),
  ]);

  const updateChanges = results[0]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const historyRowId = results[1]?.meta?.last_row_id;
    if (historyRowId) {
      await run("DELETE FROM lead_status_history WHERE id = ?", [historyRowId]);
    }
    throw new LeadWorkflowError(
      "conflict",
      "This lead was changed by another request since it was last read — reload and try again"
    );
  }

  return {
    lead: { id: leadId, status: toStatus, lost_reason: lostReason, lost_reason_note: lostReasonNote },
    fromStatus: lead.status as LeadStatus,
    toStatus,
  };
}
