import { get } from "./db.js";
import type { Role } from "./auth.js";
import { BC_PROGRAM_JOB_TYPES, BC_PROGRAM_STATUS_LABELS } from "./modules/programs/bc/workflow-definitions.js";

/**
 * Central job-workflow engine. This is the ONLY place status-transition rules
 * live — API routes and the client must call into this module rather than
 * re-implement any part of the state machine. See `transitionJob()` for the
 * single authoritative entry point that actually changes a job's status.
 *
 * Phase 11.2 — this file is also the single authoritative job-type/workflow
 * REGISTRY: JobType, JOB_TYPES, isJobType, and WORKFLOWS below are all
 * derived from one JOB_TYPE_REGISTRY object rather than separately
 * hardcoded. STANDARD is Core's own default job type (every industry needs a
 * plain, non-program job); CLEANBC and BC_HYDRO are contributed as pure
 * shape DATA by the BC regional-program module (see
 * modules/programs/bc/workflow-definitions.ts — no business logic there,
 * only status sequences/labels). This file is a narrowly-scoped, documented
 * exception to Phase 11.1's "Core never imports modules/**" rule (see
 * scripts/check-architecture-boundaries.mjs's COMPOSITION_ROOTS): the
 * registry and the engine functions that close over it (forwardTransitions,
 * transitionJob, etc.) must live in the same module scope, so composing the
 * registry from Core's own default plus each module's contribution has to
 * happen here rather than in a separate file. This does NOT mean Core is
 * fully decoupled from BC — it still names "CLEANBC"/"BC_HYDRO" as registry
 * keys (there is no dynamic/database-driven job-type system in this phase,
 * see the Phase 11.2 addendum in docs/PLATFORM-GENERALIZATION-AUDIT.md for
 * why) — but the actual workflow SHAPE (status order, status labels) no
 * longer lives here as an inline literal.
 */

export interface JobTypeDefinition {
  /** Ordered status sequence — index order IS the forward-progression rule.
   *  "cancelled" is deliberately not listed: it's a universal transition
   *  available from any non-terminal status (see forwardTransitions). */
  statusSequence: readonly string[];
}

const JOB_TYPE_REGISTRY = Object.freeze({
  STANDARD: { statusSequence: ["scheduled", "in_progress", "completed", "invoiced"] },
  ...BC_PROGRAM_JOB_TYPES,
}) satisfies Readonly<Record<string, JobTypeDefinition>>;

export type JobType = keyof typeof JOB_TYPE_REGISTRY;

export const JOB_TYPES: JobType[] = Object.keys(JOB_TYPE_REGISTRY) as JobType[];

export function isJobType(value: string): value is JobType {
  return Object.prototype.hasOwnProperty.call(JOB_TYPE_REGISTRY, value);
}

/** Small explicit accessor API (Phase 11.2) — prefer these over indexing
 *  JOB_TYPE_REGISTRY/WORKFLOWS directly in new code. Both fail safely on an
 *  unregistered id: getJobTypeDefinition's parameter type only accepts a
 *  narrowed JobType (use isJobType() first to narrow an arbitrary string),
 *  so there is no silent default — an unrecognized value simply cannot be
 *  passed in at all. */
export function getJobTypeDefinition(id: JobType): JobTypeDefinition {
  return JOB_TYPE_REGISTRY[id];
}

export function listJobTypeDefinitions(): ReadonlyArray<{ id: JobType; definition: JobTypeDefinition }> {
  return JOB_TYPES.map((id) => ({ id, definition: JOB_TYPE_REGISTRY[id] }));
}

export const WORKFLOWS: Record<JobType, readonly string[]> = Object.freeze(Object.fromEntries(
  JOB_TYPES.map((id) => [id, JOB_TYPE_REGISTRY[id].statusSequence])
)) as unknown as Record<JobType, readonly string[]>;

export const STATUS_LABELS: Record<string, string> = Object.freeze({
  scheduled: "Scheduled",
  in_progress: "In Progress",
  completed: "Completed",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
  ...BC_PROGRAM_STATUS_LABELS,
});

/** Derived from WORKFLOWS rather than hardcoded: "terminal" means "the last
 *  status in some job type's sequence" — for STANDARD that's "invoiced", for
 *  CLEANBC/BC_HYDRO that's "gov_portal_submitted". This removes Core's only
 *  remaining hardcoded literal reference to a BC-specific status name. */
const TERMINAL_STATUSES = new Set(
  JOB_TYPES.map((id) => {
    const seq = WORKFLOWS[id];
    return seq[seq.length - 1];
  })
);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Every status, across every job type, that isn't finished or cancelled — "this
 *  job still has open work" in any workflow. Used for dashboard/technician-load
 *  counts so they don't hardcode a stale status list (see index.ts getStats /
 *  listTechnicians) that drifts every time a job type's workflow changes. */
export const ACTIVE_STATUSES: string[] = Array.from(
  new Set(Object.values(WORKFLOWS).flatMap((seq) => seq.filter((s) => !TERMINAL_STATUSES.has(s))))
);

/** Every status that comes before "in_progress" in any workflow — "scheduled but
 *  not yet started," regardless of job type. */
export const PRE_WORK_STATUSES: string[] = Array.from(
  new Set(
    Object.values(WORKFLOWS).flatMap((seq) => {
      const idx = seq.indexOf("in_progress");
      return idx === -1 ? [] : seq.slice(0, idx);
    })
  )
);

export function entryStatus(jobType: JobType): string {
  return WORKFLOWS[jobType][0];
}

/** Forward-progression + universal cancel for a job type/status pair. Pure and
 *  synchronous — does not know about "reopen" (cancelled -> X), which depends on
 *  job_status_history and is resolved by resolveAllowedTransitions() below. */
export function forwardTransitions(jobType: JobType, currentStatus: string): string[] {
  const seq = WORKFLOWS[jobType];
  const idx = seq.indexOf(currentStatus);
  if (idx === -1) return [];
  const next: string[] = [];
  if (idx < seq.length - 1) next.push(seq[idx + 1]);
  if (!isTerminalStatus(currentStatus)) next.push("cancelled");
  return next;
}

export interface WorkflowJobRow {
  id: number;
  status: string;
  job_type: string;
  technician_id: number | null;
  eligibility_code: string;
  eligibility_code_expiry: string;
}

/** The status a cancelled job reopens into: whatever it was transitioning FROM the
 *  moment it was cancelled, per the audit trail. Returns null if the job was never
 *  cancelled through the engine (shouldn't happen, but fails closed rather than
 *  guessing). This is also why job_status_history is functionally load-bearing,
 *  not just an audit log. */
async function reopenTarget(jobId: number): Promise<string | null> {
  const row = await get<{ from_status: string | null }>(
    `SELECT from_status FROM job_status_history
     WHERE job_id = ? AND to_status = 'cancelled'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [jobId]
  );
  return row?.from_status ?? null;
}

/** Every status this job could legally move to next, independent of who's asking —
 *  RBAC narrows this further via allowedTransitionsForActor(). This is the
 *  server-side truth the client renders buttons from; it must never be
 *  reimplemented in React. */
export async function resolveAllowedTransitions(job: WorkflowJobRow): Promise<string[]> {
  if (!isJobType(job.job_type)) return [];
  if (job.status === "cancelled") {
    const target = await reopenTarget(job.id);
    return target ? [target] : [];
  }
  return forwardTransitions(job.job_type, job.status);
}

const TECHNICIAN_ALLOWED_TARGETS = new Set(["in_progress", "completed"]);

export interface Actor {
  id: number;
  role: Role;
}

/** Resolves the technician row linked to `actor` via `technicians.user_id`,
 *  or null if the actor isn't a technician at all OR is a technician-role
 *  user with no linked technician row (both cases mean "no ownership scope
 *  — deny/empty," exactly how every existing caller below already treats
 *  it). Exported so read-scoping fixes elsewhere (index.ts's job/customer/
 *  schedule list and detail routes) can resolve "which technician is this,
 *  really" the same way transitions and compliance already do, instead of
 *  re-querying `technicians` inline and risking a second, subtly different
 *  ownership mechanism. */
export async function actorTechnicianId(actor: Actor): Promise<number | null> {
  if (actor.role !== "technician") return null;
  const row = await get<{ id: number }>("SELECT id FROM technicians WHERE user_id = ?", [actor.id]);
  return row?.id ?? null;
}

/** RBAC for a specific transition: admin/dispatcher may make any valid transition
 *  on any job. A technician may only move a job assigned to them (via their linked
 *  technicians row) into "in_progress" or "completed" — never reassign, reschedule,
 *  cancel, reopen, or touch any rebate/gov-portal status. */
export async function canActorTransition(actor: Actor, job: WorkflowJobRow, toStatus: string): Promise<boolean> {
  if (actor.role === "admin" || actor.role === "dispatcher") return true;
  if (actor.role === "technician") {
    const techId = await actorTechnicianId(actor);
    if (techId === null || job.technician_id !== techId) return false;
    return TECHNICIAN_ALLOWED_TARGETS.has(toStatus);
  }
  return false;
}

/** Allowed transitions narrowed to what THIS actor may actually perform — what the
 *  UI should render as available actions. */
export async function allowedTransitionsForActor(actor: Actor, job: WorkflowJobRow): Promise<string[]> {
  const candidates = await resolveAllowedTransitions(job);
  const checks = await Promise.all(candidates.map((target) => canActorTransition(actor, job, target)));
  return candidates.filter((_, i) => checks[i]);
}

export interface CompletionRequirement {
  key: string;
  label: string;
  satisfied: boolean;
}

export interface CompletionCheck {
  allowed: boolean;
  requirements: CompletionRequirement[];
}

/** Server-side capability check for whether a job may move to "completed".
 *  Phase 2 shipped this synchronous with a single requirement
 *  (technician-assignment); Phase 4 extends it with the mandatory compliance
 *  artifacts (pre/post-work photos, a *submitted* technician report, a customer
 *  signature) — the ONLY structural change needed was making this function
 *  async/DB-aware, since "does this job have a photo on file" can't be answered
 *  from the job row alone. The {allowed, requirements[]} CONTRACT is unchanged;
 *  every caller (transitionJob, the /can-complete route, the future UI) reads
 *  this same shape regardless of how many requirements it grows to. */
export async function canCompleteJob(job: { id: number; technician_id: number | null }): Promise<CompletionCheck> {
  const requirements: CompletionRequirement[] = [
    {
      key: "technician_assigned",
      label: "A technician must be assigned before the job can be completed",
      satisfied: job.technician_id !== null,
    },
  ];

  const preWork = await get<{ c: number }>(
    "SELECT COUNT(*) as c FROM job_media WHERE job_id = ? AND kind = 'pre_work_photo' AND deleted_at IS NULL", [job.id]
  );
  requirements.push({
    key: "pre_work_photos",
    label: "At least one pre-work photo is required",
    satisfied: (preWork?.c ?? 0) > 0,
  });

  const postWork = await get<{ c: number }>(
    "SELECT COUNT(*) as c FROM job_media WHERE job_id = ? AND kind = 'post_work_photo' AND deleted_at IS NULL", [job.id]
  );
  requirements.push({
    key: "post_work_photos",
    label: "At least one post-work photo is required",
    satisfied: (postWork?.c ?? 0) > 0,
  });

  const report = await get<{ status: string }>(
    "SELECT status FROM job_completion_reports WHERE job_id = ?", [job.id]
  );
  requirements.push({
    key: "technician_report",
    label: "A submitted technician report is required",
    satisfied: report?.status === "submitted",
  });

  const signature = await get<{ c: number }>(
    "SELECT COUNT(*) as c FROM job_signatures WHERE job_id = ?", [job.id]
  );
  requirements.push({
    key: "customer_signature",
    label: "A customer signature is required",
    satisfied: (signature?.c ?? 0) > 0,
  });

  return { allowed: requirements.every((r) => r.satisfied), requirements };
}

/** Whether `actor` may view/manage compliance data (photos, report, signature)
 *  for `job` — the same ownership rule as canActorTransition's technician
 *  branch (assigned technician only), but without the transition-target
 *  restriction, since uploading a photo isn't a status transition. Centralizes
 *  the ownership check so compliance routes in index.ts don't reimplement it. */
export async function canActorAccessJobCompliance(actor: Actor, job: { technician_id: number | null }): Promise<boolean> {
  if (actor.role === "admin" || actor.role === "dispatcher") return true;
  if (actor.role === "technician") {
    const techId = await actorTechnicianId(actor);
    return techId !== null && job.technician_id === techId;
  }
  return false;
}

export type WorkflowErrorCode = "not_found" | "invalid_transition" | "forbidden" | "missing_data";

export class WorkflowError extends Error {
  code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export interface TransitionInput {
  toStatus: string;
  reason?: string;
  eligibilityCode?: string;
  eligibilityCodeExpiry?: string;
}

export interface TransitionOutcome {
  job: WorkflowJobRow;
  fromStatus: string;
  toStatus: string;
}

/**
 * THE authoritative way to change a job's status. Validates current status, job
 * type, the requested transition, actor permissions, and any transition-specific
 * required data, then persists the status change and its history row atomically
 * (single D1 batch — both succeed or both fail, so the audit trail can never
 * silently drift from the job's actual status). Throws WorkflowError for every
 * rejection case; callers map `.code` to the appropriate HTTP status.
 */
export async function transitionJob(
  db: D1Database,
  jobId: number,
  actor: Actor,
  input: TransitionInput
): Promise<TransitionOutcome> {
  const job = await get<WorkflowJobRow>(
    "SELECT id, status, job_type, technician_id, eligibility_code, eligibility_code_expiry FROM jobs WHERE id = ?",
    [jobId]
  );
  if (!job) throw new WorkflowError("not_found", "Job not found");

  const allowed = await resolveAllowedTransitions(job);
  if (!allowed.includes(input.toStatus)) {
    throw new WorkflowError(
      "invalid_transition",
      `Cannot transition job from "${job.status}" to "${input.toStatus}"`
    );
  }

  if (!(await canActorTransition(actor, job, input.toStatus))) {
    throw new WorkflowError("forbidden", "You are not permitted to make this transition");
  }

  let eligibilityCode = job.eligibility_code;
  let eligibilityCodeExpiry = job.eligibility_code_expiry;
  if (input.toStatus === "eligibility_approved") {
    eligibilityCode = input.eligibilityCode ?? job.eligibility_code;
    eligibilityCodeExpiry = input.eligibilityCodeExpiry ?? job.eligibility_code_expiry;
    if (!eligibilityCode.trim() || !eligibilityCodeExpiry.trim()) {
      throw new WorkflowError(
        "missing_data",
        "Eligibility code and eligibility code expiry date are required to approve eligibility"
      );
    }
  }

  if (input.toStatus === "completed") {
    const check = await canCompleteJob(job);
    if (!check.allowed) {
      const missing = check.requirements.filter((r) => !r.satisfied).map((r) => r.label).join("; ");
      throw new WorkflowError("missing_data", `Cannot complete job: ${missing}`);
    }
  }

  await db.batch([
    db.prepare(
      "UPDATE jobs SET status = ?, eligibility_code = ?, eligibility_code_expiry = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(input.toStatus, eligibilityCode, eligibilityCodeExpiry, jobId),
    db.prepare(
      "INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)"
    ).bind(jobId, job.status, input.toStatus, actor.id, input.reason ?? ""),
  ]);

  return {
    job: { ...job, status: input.toStatus, eligibility_code: eligibilityCode, eligibility_code_expiry: eligibilityCodeExpiry },
    fromStatus: job.status,
    toStatus: input.toStatus,
  };
}
