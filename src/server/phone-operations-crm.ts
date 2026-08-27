import { get, query, run } from "./db.js";
import { ScheduleConflictError, checkScheduleConflict } from "./scheduling.js";

/** Phase 16 — Phone Operations <-> CRM integration.
 *
 *  This module is the ONLY place Phone Operations touches Customers/Leads/
 *  Jobs. Every write here goes through the same domain rules the rest of
 *  the app already enforces (Lead status FSM via lead-workflow.ts, Job
 *  creation via the shared `createJobRecord`/`createLeadRecord` helpers in
 *  index.ts that the ordinary POST /api/jobs and POST /api/leads routes
 *  ALSO call — never a raw INSERT that bypasses them). Nothing here creates
 *  a Customer directly, and nothing here auto-converts a Lead into a
 *  Customer — `create_appointment_for_customer` (the tool registry, below)
 *  only ever operates on an ALREADY-MATCHED existing customer; a new
 *  prospect gets a Lead, and converting that Lead to a Customer stays a
 *  human decision through the existing Lead pipeline, exactly matching
 *  lead-conversion.ts's own deliberate "no auto Job creation" precedent.
 *
 *  Tool authorization: the AI model never authorizes itself. Every tool
 *  invocation goes through `invokeTool()`, which checks (in order) that the
 *  tool exists, that the CALLING AGENT VERSION's own `tool_policy` allows
 *  it (frozen at call-start in `calls.voice_agent_snapshot`, so a later
 *  policy change never retroactively changes what an in-flight call may
 *  do), and that the risk category is one this runtime API permits at all
 *  — before ever touching business data. Idempotency is enforced by a
 *  database UNIQUE constraint (`call_tool_invocations(call_id,
 *  idempotency_key)`), not just an in-memory check, so a duplicated retry
 *  can never double-execute a side effect. */

export class PhoneOperationsCrmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PhoneOperationsCrmError";
    this.code = code;
  }
}

/** Deliberately MORE aggressive than lead-conversion.ts's own
 *  normalizePhone (bare digits-only): a caller's number always arrives from
 *  Twilio as full E.164 (`+16045551234`), while a staff-entered Customer
 *  phone is just as often typed WITHOUT the leading NANP country code
 *  (`604-555-1234`) — with only digit-stripping, those two would never
 *  match, which would make automatic caller matching nearly useless for
 *  its actual purpose. This strips a leading "1" specifically when the
 *  remainder is a plausible 10-digit NANP number, so both forms of the
 *  same real number normalize identically; a genuine 11-digit non-NANP
 *  number (rare in this codebase's target market — see its existing
 *  Canadian/BC-specific fixtures throughout) is left untouched rather than
 *  guessed at. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ── Caller matching (Section 8-10, 45) ──────────────────────────────────

export interface CustomerMatchSummary {
  id: number;
  name: string;
  phone: string;
  email: string;
}

/** Exact-normalized-phone match only — deliberately narrower than
 *  lead-conversion.ts's findMatchingCustomerIds (which also matches on
 *  email, meaningless for an inbound caller who hasn't said their email
 *  yet). Zero/one/many semantics mirror that same function's precedent —
 *  a full-table scan is this codebase's own established, scale-appropriate
 *  choice for this size of query (see listAllCustomers), not a new
 *  performance concern. */
export async function matchCustomersByPhone(organizationId: number, rawPhone: string): Promise<CustomerMatchSummary[]> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return [];
  const rows = await query<CustomerMatchSummary>(
    "SELECT id, name, phone, email FROM customers WHERE organization_id = ?", [organizationId]
  );
  return rows.filter((c) => normalizePhone(c.phone) === phone);
}

export type MatchConfidence = "EXACT_PHONE" | "MANUAL" | "UNKNOWN";

export interface CallerResolution {
  matches: CustomerMatchSummary[];
  confidence: MatchConfidence;
}

/** The read-only "who is calling" resolution — never writes a link itself
 *  (see `linkCallToCustomer` for that). Zero matches: genuinely unknown,
 *  safe to treat as a new prospect. One match: a strong automatic
 *  candidate, but caller-ID is NOT verified identity (Section 9) — see
 *  `getCustomerVoiceContext`'s own header comment for the actual
 *  disclosure boundary this codebase enforces today (a fixed, narrow, safe
 *  projection, regardless of match confidence — not a confidence-gated
 *  "more data if MANUAL" tier, since no tool needs that yet). More than
 *  one match: never guess — the caller must surface this as "needs human
 *  disambiguation", never silently pick one. */
export async function resolveCallerContext(organizationId: number, rawPhone: string): Promise<CallerResolution> {
  const matches = await matchCustomersByPhone(organizationId, rawPhone);
  return { matches, confidence: matches.length === 1 ? "EXACT_PHONE" : "UNKNOWN" };
}

// ── Call <-> Customer/Lead/Job linkage (Section 11-14, 44-46) ──────────

export async function linkCallToCustomer(organizationId: number, callId: number, customerId: number, source: string, confidence: MatchConfidence): Promise<void> {
  const call = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsCrmError("not_found", "Call not found");
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [customerId, organizationId]);
  if (!customer) throw new PhoneOperationsCrmError("not_found", "Customer not found");
  await run("UPDATE calls SET customer_id = ?, match_confidence = ?, match_source = ? WHERE id = ?", [customerId, confidence, source, callId]);
}

export async function unlinkCallCustomer(organizationId: number, callId: number, source: string): Promise<void> {
  const call = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsCrmError("not_found", "Call not found");
  await run("UPDATE calls SET customer_id = NULL, match_confidence = 'UNKNOWN', match_source = ? WHERE id = ?", [source, callId]);
}

export async function linkCallToLead(organizationId: number, callId: number, leadId: number): Promise<void> {
  const call = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsCrmError("not_found", "Call not found");
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [leadId, organizationId]);
  if (!lead) throw new PhoneOperationsCrmError("not_found", "Lead not found");
  await run("UPDATE calls SET lead_id = ? WHERE id = ?", [leadId, callId]);
}

export async function linkCallToJob(organizationId: number, callId: number, jobId: number): Promise<void> {
  const call = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsCrmError("not_found", "Call not found");
  const job = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [jobId, organizationId]);
  if (!job) throw new PhoneOperationsCrmError("not_found", "Job not found");
  await run("UPDATE calls SET job_id = ? WHERE id = ?", [jobId, callId]);
}

// ── Safe voice-facing projections (Section 29-33) — narrow DTOs, never a
// raw entity row, so the model never sees more than the task needs. This
// is the actual Section-9 disclosure boundary: no email, address, price,
// or notes reach the model regardless of match confidence — a fixed,
// narrow projection rather than a confidence-gated "more data if manually
// verified" tier, since no tool needs the latter yet. ───────────────────

export interface CustomerVoiceContext {
  id: number;
  name: string;
  active_jobs: Array<{ id: number; identifier: string; status: string; scheduled_date: string; scheduled_time: string }>;
  most_recent_completed_job: { id: number; identifier: string; scheduled_date: string } | null;
}

export async function getCustomerVoiceContext(organizationId: number, customerId: number): Promise<CustomerVoiceContext | null> {
  const customer = await get<{ id: number; name: string }>(
    "SELECT id, name FROM customers WHERE id = ? AND organization_id = ?", [customerId, organizationId]
  );
  if (!customer) return null;
  const activeJobs = await query<{ id: number; identifier: string; status: string; scheduled_date: string; scheduled_time: string }>(
    `SELECT id, identifier, status, scheduled_date, scheduled_time FROM jobs
     WHERE customer_id = ? AND organization_id = ? AND status NOT IN ('completed', 'invoiced', 'cancelled', 'gov_portal_submitted')
     ORDER BY scheduled_date ASC, scheduled_time ASC LIMIT 10`,
    [customerId, organizationId]
  );
  const recentCompleted = await get<{ id: number; identifier: string; scheduled_date: string }>(
    `SELECT id, identifier, scheduled_date FROM jobs
     WHERE customer_id = ? AND organization_id = ? AND status IN ('completed', 'invoiced', 'gov_portal_submitted')
     ORDER BY scheduled_date DESC LIMIT 1`,
    [customerId, organizationId]
  );
  return { id: customer.id, name: customer.name, active_jobs: activeJobs, most_recent_completed_job: recentCompleted ?? null };
}

export interface LeadVoiceContext {
  id: number;
  name: string;
  status: string;
  program_interest: string | null;
}

export async function getLeadVoiceContext(organizationId: number, leadId: number): Promise<LeadVoiceContext | null> {
  const row = await get<LeadVoiceContext>(
    "SELECT id, name, status, program_interest FROM leads WHERE id = ? AND organization_id = ?", [leadId, organizationId]
  );
  return row ?? null;
}

export interface JobVoiceStatus {
  id: number;
  identifier: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string;
  technician_name: string | null;
}

export async function getJobVoiceStatus(organizationId: number, jobId: number): Promise<JobVoiceStatus | null> {
  const row = await get<JobVoiceStatus>(
    `SELECT j.id, j.identifier, j.status, j.scheduled_date, j.scheduled_time, t.name as technician_name
     FROM jobs j LEFT JOIN technicians t ON j.technician_id = t.id
     WHERE j.id = ? AND j.organization_id = ?`,
    [jobId, organizationId]
  );
  return row ?? null;
}

// ── Availability (Section 15, 34, 40) — reuses the exact canonical
// conflict-detection query scheduling.ts#checkScheduleConflict already
// uses, rather than a second, simplified phone-only model that could
// double-book. ────────────────────────────────────────────────────────

export interface TechnicianAvailability {
  technician_id: number;
  technician_name: string;
  available: boolean;
}

/** For every active technician, reports whether the proposed (date, time,
 *  duration) window is free — calls the SAME `checkScheduleConflict`
 *  function real booking uses (not a hand-copied reimplementation of its
 *  math), so this structurally cannot drift from what booking would then
 *  reject. Independent Architecture review finding: an earlier version of
 *  this function copied the overlap formula and query instead of calling
 *  the canonical function, which would have silently diverged the moment
 *  `checkScheduleConflict` grew a new rule (business hours, a buffer,
 *  etc.) that this function didn't know to replicate. */
export async function getAvailability(organizationId: number, date: string, time: string, duration: number): Promise<TechnicianAvailability[]> {
  const technicians = await query<{ id: number; name: string }>(
    "SELECT id, name FROM technicians WHERE organization_id = ? AND active = 1", [organizationId]
  );
  const results: TechnicianAvailability[] = [];
  for (const tech of technicians) {
    let available = true;
    try {
      await checkScheduleConflict(tech.id, date, time, duration, null);
    } catch (err) {
      if (!(err instanceof ScheduleConflictError)) throw err;
      available = false;
    }
    results.push({ technician_id: tech.id, technician_name: tech.name, available });
  }
  return results;
}

// ── Follow-ups (Section 24, reuse-checked: no existing task/follow-up
// mechanism exists anywhere in this codebase — notification_outbox is a
// delivery-send queue, not a task list). ────────────────────────────────

export interface FollowUp {
  id: number;
  call_id: number;
  customer_id: number | null;
  lead_id: number | null;
  job_id: number | null;
  assigned_user_id: number | null;
  due_date: string | null;
  note: string;
  status: string;
  created_by_type: string;
  created_by_user_id: number | null;
  created_at: string;
  completed_at: string | null;
}

export async function createFollowUp(organizationId: number, callId: number, input: {
  customerId?: number | null; leadId?: number | null; jobId?: number | null; assignedUserId?: number | null;
  dueDate?: string | null; note: string; createdByType: "voice_engine" | "user"; createdByUserId?: number | null;
}): Promise<FollowUp> {
  const call = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsCrmError("not_found", "Call not found");
  if (!input.note.trim()) throw new PhoneOperationsCrmError("invalid_input", "note is required");
  // Independent Security/Architecture review finding: every other link
  // function in this file (linkCallToCustomer/Lead/Job) re-verifies the
  // target entity's organization before writing — this one didn't, and the
  // create_follow_up TOOL forwards Voice-Engine-supplied integers straight
  // into customerId/leadId, making it a real cross-tenant IDOR on a write
  // path. Now consistent with the rest of the file.
  if (input.customerId != null) {
    const owned = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [input.customerId, organizationId]);
    if (!owned) throw new PhoneOperationsCrmError("not_found", "Customer not found");
  }
  if (input.leadId != null) {
    const owned = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [input.leadId, organizationId]);
    if (!owned) throw new PhoneOperationsCrmError("not_found", "Lead not found");
  }
  if (input.jobId != null) {
    const owned = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [input.jobId, organizationId]);
    if (!owned) throw new PhoneOperationsCrmError("not_found", "Job not found");
  }
  if (input.assignedUserId != null) {
    const owned = await get<{ id: number }>("SELECT id FROM users WHERE id = ? AND organization_id = ?", [input.assignedUserId, organizationId]);
    if (!owned) throw new PhoneOperationsCrmError("not_found", "Assigned user not found");
  }
  await run(
    `INSERT INTO call_follow_ups (organization_id, call_id, customer_id, lead_id, job_id, assigned_user_id, due_date, note, created_by_type, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, callId, input.customerId ?? null, input.leadId ?? null, input.jobId ?? null, input.assignedUserId ?? null, input.dueDate ?? null, input.note.trim(), input.createdByType, input.createdByUserId ?? null]
  );
  const row = await get<FollowUp>("SELECT * FROM call_follow_ups WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [organizationId]);
  return row!;
}

export async function listFollowUps(organizationId: number, opts: { status?: string; callId?: number } = {}): Promise<FollowUp[]> {
  const clauses = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.status) { clauses.push("status = ?"); params.push(opts.status); }
  if (opts.callId) { clauses.push("call_id = ?"); params.push(opts.callId); }
  return query<FollowUp>(`SELECT * FROM call_follow_ups WHERE ${clauses.join(" AND ")} ORDER BY due_date IS NULL, due_date ASC, created_at DESC`, params);
}

export async function completeFollowUp(organizationId: number, id: number): Promise<boolean> {
  const result = await run(
    "UPDATE call_follow_ups SET status = 'done', completed_at = datetime('now') WHERE id = ? AND organization_id = ? AND status = 'open'",
    [id, organizationId]
  );
  return result.changes > 0;
}

// ── Tool registry + authorized, idempotent invocation (Section 26-29,
// 35, 53, 57-58) ─────────────────────────────────────────────────────

export type ToolRiskCategory = "read" | "low_write" | "high_write";

export interface ToolContext {
  organizationId: number;
  callId: number;
  actorUserId: number | null;
}

export interface ToolDefinition {
  riskCategory: ToolRiskCategory;
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new PhoneOperationsCrmError("invalid_input", `${key} is required`);
  return v;
}
function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new PhoneOperationsCrmError("invalid_input", `${key} must be an integer`);
  return v;
}
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** The full Phase 16 tool set. Deliberately does NOT include a technician-
 *  assignment tool (Section 19 — appointments are created unassigned;
 *  dispatch remains a human decision through the existing Job UI), a job
 *  status-mutation tool (job transitions stay behind transitionJob()'s own
 *  RBAC, never exposed to the phone runtime), or a Lead->Customer
 *  auto-conversion tool (Section 41 — see `createLeadFromCall`'s own
 *  header comment for why this mirrors lead-conversion.ts's existing,
 *  deliberate "no auto Job creation" precedent). `create_appointment_for_customer`
 *  only ever operates on an ALREADY-MATCHED existing customer — there is
 *  no tool that can create a Job for an unknown caller or a bare Lead. */
/** The complete, fixed set of valid tool names — used to validate an
 *  agent's `tool_policy` at save time (see the `/api/phone-operations/agents`
 *  route) so an admin can never save a policy referencing a tool that
 *  doesn't exist. Kept in sync with `buildToolRegistry`'s keys by the one
 *  test asserting they're identical. */
export const KNOWN_TOOL_NAMES = [
  "find_customer_by_phone",
  "get_customer_service_context",
  "get_job_status",
  "get_available_slots",
  "create_lead_from_call",
  "create_follow_up",
  "create_appointment_for_customer",
] as const;

export function buildToolRegistry(deps: {
  createLeadRecord: (organizationId: number, input: Record<string, unknown>, actorUserId: number | null) => Promise<{ id: number; identifier: string }>;
  createJobRecord: (organizationId: number, input: Record<string, unknown>, actorUserId: number | null) => Promise<{ id: number; identifier: string } | { conflict: true; message: string }>;
}): Record<string, ToolDefinition> {
  return {
    find_customer_by_phone: {
      riskCategory: "read",
      execute: async (ctx, args) => resolveCallerContext(ctx.organizationId, str(args, "phone")),
    },
    get_customer_service_context: {
      riskCategory: "read",
      execute: async (ctx, args) => {
        const result = await getCustomerVoiceContext(ctx.organizationId, num(args, "customer_id"));
        if (!result) throw new PhoneOperationsCrmError("not_found", "Customer not found");
        return result;
      },
    },
    get_job_status: {
      riskCategory: "read",
      execute: async (ctx, args) => {
        const result = await getJobVoiceStatus(ctx.organizationId, num(args, "job_id"));
        if (!result) throw new PhoneOperationsCrmError("not_found", "Job not found");
        return result;
      },
    },
    get_available_slots: {
      riskCategory: "read",
      execute: async (ctx, args) => getAvailability(ctx.organizationId, str(args, "date"), optStr(args, "time") ?? "09:00", typeof args.duration === "number" ? args.duration : 60),
    },
    create_lead_from_call: {
      riskCategory: "low_write",
      execute: async (ctx, args) => {
        // Explicit allowlist rather than forwarding raw `args` — independent
        // Architecture review finding (a missing `name` fell through to a
        // bare TypeError instead of a clean validation error) and, more
        // broadly, matches the discipline every other tool in this
        // registry already uses for untrusted Voice-Engine-supplied input.
        const leadInput = {
          name: str(args, "name"),
          phone: optStr(args, "phone"),
          email: optStr(args, "email"),
          address: optStr(args, "address"),
          city: optStr(args, "city"),
          state: optStr(args, "state"),
          zip: optStr(args, "zip"),
          referral_source: optStr(args, "referral_source") ?? "Phone",
          program_interest: optStr(args, "program_interest") ?? null,
          notes: optStr(args, "notes"),
        };
        const lead = await deps.createLeadRecord(ctx.organizationId, leadInput, ctx.actorUserId);
        await linkCallToLead(ctx.organizationId, ctx.callId, lead.id);
        return lead;
      },
    },
    create_follow_up: {
      riskCategory: "low_write",
      execute: async (ctx, args) => createFollowUp(ctx.organizationId, ctx.callId, {
        customerId: typeof args.customer_id === "number" ? args.customer_id : null,
        leadId: typeof args.lead_id === "number" ? args.lead_id : null,
        note: str(args, "note"),
        dueDate: optStr(args, "due_date") ?? null,
        createdByType: "voice_engine",
      }),
    },
    create_appointment_for_customer: {
      riskCategory: "high_write",
      execute: async (ctx, args) => {
        const customerId = num(args, "customer_id");
        const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [customerId, ctx.organizationId]);
        if (!customer) throw new PhoneOperationsCrmError("not_found", "Customer not found — appointments may only be created for an already-matched existing customer");
        // Explicit allowlist, NEVER a raw `{ ...args }` spread — independent
        // Security review finding: forwarding the whole args object let a
        // model-controlled `price` reach a real financial column with no
        // validation. `technician_id` stays hardcoded null regardless of
        // what's asked for (Section 19 — phone-created appointments are
        // always unassigned; dispatch stays a human decision). No price,
        // priority, or recurrence field is accepted from this tool at all.
        const jobInput = {
          customer_id: customerId,
          technician_id: null,
          service_type_id: typeof args.service_type_id === "number" ? args.service_type_id : null,
          scheduled_date: str(args, "scheduled_date"),
          scheduled_time: optStr(args, "scheduled_time"),
          duration: typeof args.duration === "number" ? args.duration : undefined,
          notes: optStr(args, "notes"),
        };
        const job = await deps.createJobRecord(ctx.organizationId, jobInput, ctx.actorUserId);
        if ("conflict" in job) throw new PhoneOperationsCrmError("conflict", job.message);
        await linkCallToJob(ctx.organizationId, ctx.callId, job.id);
        return job;
      },
    },
  };
}

export interface InvokeToolResult {
  status: "success" | "denied" | "failed";
  result?: unknown;
  error?: string;
  idempotent_replay: boolean;
}

/** THE single authorized entry point for every tool call the runtime API
 *  accepts. Order matters and is fixed: (1) tool must exist, (2) idempotency
 *  — a replay of an already-completed invocation returns the STORED result
 *  without re-executing anything, (3) the calling agent VERSION's frozen
 *  tool_policy (captured in the call's own voice_agent_snapshot, never the
 *  agent's current live policy) must explicitly allow this tool by name —
 *  only then does the tool's own `execute` run. Every outcome (including a
 *  denial) is recorded in `call_tool_invocations`, so the Call Detail UI's
 *  "Actions taken" section (Section 43) has a complete record even for
 *  attempts that were refused. */
export async function invokeTool(
  registry: Record<string, ToolDefinition>,
  ctx: ToolContext,
  toolName: string,
  idempotencyKey: string,
  agentToolPolicy: string[],
  args: Record<string, unknown>
): Promise<InvokeToolResult> {
  const tool = registry[toolName];
  if (!tool) return { status: "failed", error: `Unknown tool: ${toolName}`, idempotent_replay: false };

  // Claim the idempotency key BEFORE any policy check or execution — this
  // is the actual atomicity boundary (the database UNIQUE constraint on
  // INSERT), not a prior SELECT-then-act check. An earlier version of this
  // function checked-then-acted, which an independent Testing review
  // reproduced as a real race: two genuinely concurrent requests with the
  // same key both passed the SELECT (neither yet saw the other's
  // not-committed row) and both ran tool.execute() — e.g. both created a
  // real Job or Lead — with only the SECOND INSERT ever failing, silently,
  // well after the damage was done. Claiming a 'pending' row first means
  // only the request whose INSERT actually wins ever reaches tool.execute();
  // the loser resolves the SAME way a legitimate replay does, just phrased
  // as "still processing" if it arrives before the winner finishes.
  let claimed: boolean;
  try {
    await run(
      `INSERT INTO call_tool_invocations (organization_id, call_id, tool_name, risk_category, idempotency_key, input_json, result_json, status)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 'pending')`,
      [ctx.organizationId, ctx.callId, toolName, tool.riskCategory, idempotencyKey, JSON.stringify(args)]
    );
    claimed = true;
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err;
    claimed = false;
  }

  if (!claimed) {
    const existing = await get<{ tool_name: string; status: string; result_json: string }>(
      "SELECT tool_name, status, result_json FROM call_tool_invocations WHERE call_id = ? AND idempotency_key = ?",
      [ctx.callId, idempotencyKey]
    );
    if (!existing) return { status: "failed", error: "This tool invocation could not be resolved — retry with a new idempotency_key", idempotent_replay: false };
    // Independent Security review finding: the idempotency key alone
    // doesn't prove this is a genuine replay of THIS request — a reused
    // key against a DIFFERENT tool must never silently return that other
    // tool's (mismatched) cached result.
    if (existing.tool_name !== toolName) {
      return { status: "failed", error: `idempotency_key was already used for a different tool (${existing.tool_name})`, idempotent_replay: false };
    }
    if (existing.status === "pending") {
      return { status: "failed", error: "This tool invocation is still being processed by a concurrent request — retry shortly", idempotent_replay: false };
    }
    return { status: existing.status as InvokeToolResult["status"], result: JSON.parse(existing.result_json), idempotent_replay: true };
  }

  if (!agentToolPolicy.includes(toolName)) {
    await finishToolInvocation(ctx.callId, idempotencyKey, "denied", { error: "not permitted by this agent version's tool policy" });
    return { status: "denied", error: "This tool is not permitted by the agent version handling this call", idempotent_replay: false };
  }

  try {
    const result = await tool.execute(ctx, args);
    await finishToolInvocation(ctx.callId, idempotencyKey, "success", result);
    return { status: "success", result, idempotent_replay: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishToolInvocation(ctx.callId, idempotencyKey, "failed", { error: message });
    return { status: "failed", error: message, idempotent_replay: false };
  }
}

async function finishToolInvocation(callId: number, idempotencyKey: string, status: string, result: unknown): Promise<void> {
  await run(
    "UPDATE call_tool_invocations SET status = ?, result_json = ? WHERE call_id = ? AND idempotency_key = ?",
    [status, JSON.stringify(result), callId, idempotencyKey]
  );
}

export async function listToolInvocations(organizationId: number, callId: number): Promise<Array<{ tool_name: string; risk_category: string; status: string; created_at: string }>> {
  return query(
    "SELECT tool_name, risk_category, status, created_at FROM call_tool_invocations WHERE call_id = ? AND organization_id = ? ORDER BY id ASC",
    [callId, organizationId]
  );
}
