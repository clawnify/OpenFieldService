import { get, query, run } from "./db.js";
import { getBusinessTimezone } from "./business-timezone.js";
import { businessDateOffset } from "./notification-dispatcher.js";
import { enqueueMaintenanceRenewalReminder, getCustomerContact, safeEnqueue } from "./notifications.js";
import {
  initiateRenewal, autoRenewAgreement, getRenewalStatus,
  RenewalError, type MaintenanceAgreement,
} from "./maintenance-agreements.js";
import { getMembership, getMembershipByAgreement, getEntitlement, type MembershipRow } from "./maintenance-memberships.js";
import { createOrGetServiceReport } from "./maintenance-service-reports.js";
import { getChecklistTemplate } from "./maintenance-checklists.js";
import { recordAdminAudit } from "./legal-terms.js";

/**
 * Phase 19C — Recurring Maintenance / Renewal / Reminder automation.
 * Reuses Phase 19B's Agreement/Membership/Service-Report domain and Phase
 * 9's notification pipeline directly (see migration 0028's header comment
 * for the full "what's genuinely new vs. reused" rationale) — this module
 * is the orchestration layer that ties them together on a schedule,
 * nothing more.
 *
 * Job creation is reached via dependency injection (`AutomationDeps`,
 * matching phone-operations-crm.ts's own established
 * `deps.createJobRecord` pattern for the identical "a Core module needs
 * the composition root's canonical Job-creation logic without inverting
 * the import direction" problem) — index.ts (the composition root) passes
 * the real `createJobRecord` in; this module never imports from index.ts.
 */

export interface AutomationJobResult {
  ok: boolean;
  job?: { id: number; identifier: string; organization_id: number; customer_id: number; technician_id: number | null };
  error?: string;
}

export interface AutomationDeps {
  createJobRecord: (
    organizationId: number, actorUserId: number | null,
    data: { customer_id: number; job_type?: string; scheduled_date: string; notes?: string }
  ) => Promise<AutomationJobResult>;
}

export type SystemActor = { id: number; role: "admin" | "dispatcher" } | null;

// ── Schedules ────────────────────────────────────────────────────────

export const RECURRENCE_TYPES = ["ANNUAL", "SEMI_ANNUAL", "QUARTERLY", "CUSTOM_DAYS"] as const;
export type RecurrenceType = typeof RECURRENCE_TYPES[number];

export interface Actor { id: number; role: "admin" | "dispatcher" | "technician" }

export function canManageSchedules(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class AutomationError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state" | "conflict";
  constructor(code: AutomationError["code"], message: string) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
  }
}

export interface MaintenanceScheduleRow {
  id: number;
  organization_id: number;
  membership_id: number;
  recurrence_type: RecurrenceType;
  custom_interval_days: number | null;
  checklist_template_id: number | null;
  status: "active" | "paused" | "cancelled";
  next_due_date: string;
  cycles_generated: number;
  automation_enabled: number;
  paused_at: string | null;
  pause_reason: string;
  created_at: string;
  updated_at: string;
}

async function recordScheduleAudit(organizationId: number, entityType: "schedule" | "occurrence", entityId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await recordAdminAudit(organizationId, entityType, entityId, eventType, actorUserId, details);
}

function nextIntervalDate(fromDate: string, recurrenceType: RecurrenceType, customIntervalDays: number | null): string {
  const [y, m, d] = fromDate.slice(0, 10).split("-").map(Number);
  if (recurrenceType === "CUSTOM_DAYS") {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Math.max(1, customIntervalDays ?? 365));
    return isoDate(dt);
  }
  const monthsToAdd = recurrenceType === "ANNUAL" ? 12 : recurrenceType === "SEMI_ANNUAL" ? 6 : 3; // QUARTERLY
  // Calendar-month addition (not fixed-day-count) — correctly handles
  // variable month lengths and leap years without any UTC-timestamp/DST
  // arithmetic (this is pure calendar-date math, per migration 0028's own
  // DST-safety note).
  const dt = new Date(Date.UTC(y, m - 1 + monthsToAdd, d));
  return isoDate(dt);
}

function isoDate(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export interface CreateScheduleInput {
  recurrenceType: RecurrenceType;
  customIntervalDays?: number | null;
  checklistTemplateId?: number | null;
  startDate?: string;
}

export async function createSchedule(organizationId: number, actorUserId: number, membershipId: number, input: CreateScheduleInput): Promise<MaintenanceScheduleRow> {
  const membership = await getMembership(organizationId, membershipId);
  if (!membership) throw new AutomationError("not_found", "Membership not found");
  if (membership.status !== "active") throw new AutomationError("invalid_state", "Only an active membership can have a maintenance schedule");
  const existing = await get<{ id: number }>("SELECT id FROM maintenance_schedules WHERE membership_id = ?", [membershipId]);
  if (existing) throw new AutomationError("conflict", "This membership already has a maintenance schedule");
  if (!RECURRENCE_TYPES.includes(input.recurrenceType)) throw new AutomationError("invalid_input", "Invalid recurrence_type");
  if (input.recurrenceType === "CUSTOM_DAYS" && (!input.customIntervalDays || input.customIntervalDays < 1)) {
    throw new AutomationError("invalid_input", "custom_interval_days must be a positive integer when recurrence_type is CUSTOM_DAYS");
  }
  if (input.checklistTemplateId) {
    const template = await getChecklistTemplate(organizationId, input.checklistTemplateId);
    if (!template) throw new AutomationError("invalid_input", "Checklist template not found for this organization");
  }

  // membership.effective_start may carry a full ISO timestamp (activateMembership
  // falls back to `new Date().toISOString()` when the agreement version has no
  // explicit effective_date) — normalize to plain YYYY-MM-DD so this schedule's
  // stored next_due_date matches the date-only contract every other date helper
  // in this module assumes (nextIntervalDate/daysBetween slice defensively too).
  const nextDueDate = (input.startDate || membership.effective_start || isoDate(new Date())).slice(0, 10);
  const result = await run(
    `INSERT INTO maintenance_schedules (organization_id, membership_id, recurrence_type, custom_interval_days, checklist_template_id, next_due_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, membershipId, input.recurrenceType, input.customIntervalDays ?? null, input.checklistTemplateId ?? null, nextDueDate, actorUserId]
  );
  const scheduleId = Number(result.lastInsertRowid);
  await recordScheduleAudit(organizationId, "schedule", scheduleId, "schedule_created", actorUserId, { membership_id: membershipId, recurrence_type: input.recurrenceType });

  const created = await getSchedule(organizationId, scheduleId);
  if (!created) throw new AutomationError("not_found", "Failed to load newly created schedule");
  return created;
}

export async function getSchedule(organizationId: number, scheduleId: number): Promise<MaintenanceScheduleRow | null> {
  const row = await get<MaintenanceScheduleRow>("SELECT * FROM maintenance_schedules WHERE id = ? AND organization_id = ?", [scheduleId, organizationId]);
  return row ?? null;
}

export async function getScheduleByMembership(organizationId: number, membershipId: number): Promise<MaintenanceScheduleRow | null> {
  const row = await get<MaintenanceScheduleRow>("SELECT * FROM maintenance_schedules WHERE membership_id = ? AND organization_id = ?", [membershipId, organizationId]);
  return row ?? null;
}

export async function listSchedules(organizationId: number, filters: { status?: string } = {}): Promise<MaintenanceScheduleRow[]> {
  if (filters.status) return query<MaintenanceScheduleRow>("SELECT * FROM maintenance_schedules WHERE organization_id = ? AND status = ? ORDER BY next_due_date ASC", [organizationId, filters.status]);
  return query<MaintenanceScheduleRow>("SELECT * FROM maintenance_schedules WHERE organization_id = ? ORDER BY next_due_date ASC", [organizationId]);
}

export async function pauseSchedule(organizationId: number, actorUserId: number, scheduleId: number, reason: string): Promise<MaintenanceScheduleRow> {
  const schedule = await getSchedule(organizationId, scheduleId);
  if (!schedule) throw new AutomationError("not_found", "Schedule not found");
  if (schedule.status !== "active") throw new AutomationError("invalid_state", "Only an active schedule can be paused");
  await run("UPDATE maintenance_schedules SET status = 'paused', paused_at = datetime('now'), paused_by = ?, pause_reason = ?, updated_at = datetime('now') WHERE id = ?", [actorUserId, reason, scheduleId]);
  await recordScheduleAudit(organizationId, "schedule", scheduleId, "schedule_paused", actorUserId, { reason });
  return (await getSchedule(organizationId, scheduleId))!;
}

export async function resumeSchedule(organizationId: number, actorUserId: number, scheduleId: number): Promise<MaintenanceScheduleRow> {
  const schedule = await getSchedule(organizationId, scheduleId);
  if (!schedule) throw new AutomationError("not_found", "Schedule not found");
  if (schedule.status !== "paused") throw new AutomationError("invalid_state", "Only a paused schedule can be resumed");
  await run("UPDATE maintenance_schedules SET status = 'active', paused_at = NULL, paused_by = NULL, pause_reason = '', updated_at = datetime('now') WHERE id = ?", [scheduleId]);
  await recordScheduleAudit(organizationId, "schedule", scheduleId, "schedule_resumed", actorUserId, {});
  return (await getSchedule(organizationId, scheduleId))!;
}

export async function cancelSchedule(organizationId: number, actorUserId: number, scheduleId: number, reason: string): Promise<MaintenanceScheduleRow> {
  const schedule = await getSchedule(organizationId, scheduleId);
  if (!schedule) throw new AutomationError("not_found", "Schedule not found");
  if (schedule.status === "cancelled") throw new AutomationError("invalid_state", "Schedule is already cancelled");
  await run("UPDATE maintenance_schedules SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", [scheduleId]);
  await recordScheduleAudit(organizationId, "schedule", scheduleId, "schedule_cancelled", actorUserId, { reason });
  // Cancel any not-yet-generated future occurrences — historical
  // (job_generated) occurrences are never touched (Section 29: "preserve
  // historical Jobs/Reports/occurrences").
  await run("UPDATE maintenance_occurrences SET status = 'cancelled' WHERE schedule_id = ? AND status = 'scheduled'", [scheduleId]);
  return (await getSchedule(organizationId, scheduleId))!;
}

// ── Due calculation ──────────────────────────────────────────────────

export type DueState = "not_due" | "upcoming" | "due" | "overdue";
const UPCOMING_WINDOW_DAYS = 14;

/** Pure function — server-authoritative, derives only from persisted
 *  schedule state and the provided "today" (business-timezone-resolved by
 *  the caller, never the raw server clock — Section 31). */
export function computeDueState(nextDueDate: string, today: string): DueState {
  const daysUntil = daysBetween(today, nextDueDate);
  if (daysUntil > UPCOMING_WINDOW_DAYS) return "not_due";
  if (daysUntil > 0) return "upcoming";
  if (daysUntil === 0) return "due";
  return "overdue";
}

function daysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = toDate.slice(0, 10).split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

// ── Occurrence generation (the core recurring-maintenance automation) ──

export interface OccurrenceRow {
  id: number;
  organization_id: number;
  schedule_id: number;
  membership_id: number;
  cycle_number: number;
  due_date: string;
  status: "scheduled" | "job_generated" | "skipped" | "cancelled";
  job_id: number | null;
  service_report_id: number | null;
  skip_reason: string;
  generated_at: string | null;
  created_at: string;
}

export async function listOccurrences(organizationId: number, filters: { scheduleId?: number; membershipId?: number } = {}): Promise<OccurrenceRow[]> {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (filters.scheduleId) { conditions.push("schedule_id = ?"); params.push(filters.scheduleId); }
  if (filters.membershipId) { conditions.push("membership_id = ?"); params.push(filters.membershipId); }
  return query<OccurrenceRow>(`SELECT * FROM maintenance_occurrences WHERE ${conditions.join(" AND ")} ORDER BY due_date DESC`, params);
}

/** Generates (at most) one Job + one Service Report for a single due
 *  schedule cycle, idempotently: the `UNIQUE(schedule_id, cycle_number)`
 *  claim-first INSERT is the real duplicate-prevention guard (Section 11)
 *  — a concurrent or repeated call for the exact same cycle can insert at
 *  most once; the loser adopts the winner's row and does nothing further
 *  (mirrors generateInvoiceForJob()'s own idempotent pattern, Phase 5). */
async function generateOneOccurrence(deps: AutomationDeps, schedule: MaintenanceScheduleRow, membership: MembershipRow, dueDate: string): Promise<{ created: boolean; occurrence: OccurrenceRow | null; skipped: boolean; reason?: string }> {
  const cycleNumber = schedule.cycles_generated + 1;

  let occurrenceId: number;
  try {
    const result = await run(
      "INSERT INTO maintenance_occurrences (organization_id, schedule_id, membership_id, cycle_number, due_date) VALUES (?, ?, ?, ?, ?)",
      [schedule.organization_id, schedule.id, membership.id, cycleNumber, dueDate]
    );
    occurrenceId = Number(result.lastInsertRowid);
  } catch {
    // Lost the race (or this cycle was already claimed by an earlier run)
    // — the existing row is authoritative, nothing more to do here.
    const existing = await get<OccurrenceRow>("SELECT * FROM maintenance_occurrences WHERE schedule_id = ? AND cycle_number = ?", [schedule.id, cycleNumber]);
    return { created: false, occurrence: existing ?? null, skipped: false };
  }

  // Section 12 — entitlement-aware scheduling: never generate a Job the
  // Membership can't actually cover. Checked AFTER claiming the occurrence
  // row (so the cycle itself is never re-attempted every tick) but BEFORE
  // any Job/Report is created.
  const entitlement = await getEntitlement(schedule.organization_id, membership.id);
  if (entitlement.visitsRemaining !== null && entitlement.visitsRemaining <= 0) {
    await run("UPDATE maintenance_occurrences SET status = 'skipped', skip_reason = ? WHERE id = ?", ["No remaining visit entitlement", occurrenceId]);
    await recordScheduleAudit(schedule.organization_id, "occurrence", occurrenceId, "occurrence_skipped", null, { reason: "no_entitlement_remaining" });
    return { created: true, occurrence: await getOccurrence(occurrenceId), skipped: true, reason: "no_entitlement_remaining" };
  }

  // job_type is intentionally omitted (defaults to the Core "STANDARD"
  // workflow, workflow.ts's JOB_TYPE_REGISTRY) — a residential recurring
  // maintenance visit is an ordinary job lifecycle, not a rebate-program
  // job type (CLEANBC/BC_HYDRO), and no HVAC-only job type is invented
  // here (CLAUDE.md's "Industry and Regional Logic Must Not Leak Back
  // Into Core").
  const jobResult = await deps.createJobRecord(schedule.organization_id, null, {
    customer_id: membership.customer_id, scheduled_date: dueDate,
    notes: `Automatically generated recurring maintenance visit (cycle ${cycleNumber}).`,
  });
  if (!jobResult.ok || !jobResult.job) {
    await run("UPDATE maintenance_occurrences SET status = 'skipped', skip_reason = ? WHERE id = ?", [jobResult.error || "Job creation failed", occurrenceId]);
    await recordScheduleAudit(schedule.organization_id, "occurrence", occurrenceId, "occurrence_job_generation_failed", null, { error: jobResult.error });
    return { created: true, occurrence: await getOccurrence(occurrenceId), skipped: true, reason: jobResult.error };
  }

  const report = await createOrGetServiceReport(schedule.organization_id, null, jobResult.job, {
    agreementId: membership.agreement_id, membershipId: membership.id,
    checklistTemplateVersionId: schedule.checklist_template_id ? (await resolveChecklistCurrentVersion(schedule.organization_id, schedule.checklist_template_id)) : null,
  });

  await run(
    "UPDATE maintenance_occurrences SET status = 'job_generated', job_id = ?, service_report_id = ?, generated_at = datetime('now') WHERE id = ?",
    [jobResult.job.id, report.id, occurrenceId]
  );
  await run("UPDATE maintenance_schedules SET cycles_generated = ?, next_due_date = ?, updated_at = datetime('now') WHERE id = ?", [cycleNumber, nextIntervalDate(dueDate, schedule.recurrence_type, schedule.custom_interval_days), schedule.id]);
  await recordScheduleAudit(schedule.organization_id, "occurrence", occurrenceId, "occurrence_job_generated", null, { job_id: jobResult.job.id, service_report_id: report.id });

  const occurrence = await getOccurrence(occurrenceId);
  return { created: true, occurrence, skipped: false };
}

async function getOccurrence(occurrenceId: number): Promise<OccurrenceRow | null> {
  const row = await get<OccurrenceRow>("SELECT * FROM maintenance_occurrences WHERE id = ?", [occurrenceId]);
  return row ?? null;
}

async function resolveChecklistCurrentVersion(organizationId: number, templateId: number): Promise<number | null> {
  const template = await getChecklistTemplate(organizationId, templateId);
  return template?.current_version_id ?? null;
}

export interface AutomationRunSummary {
  organizationsScanned: number;
  occurrencesProcessed: number;
  jobsGenerated: number;
  renewalsProcessed: number;
  remindersSent: number;
  erroredCount: number;
  errorSummary: string;
}

async function activeOrganizations(organizationIdFilter: number | null): Promise<{ id: number }[]> {
  if (organizationIdFilter !== null) return [{ id: organizationIdFilter }];
  return query<{ id: number }>("SELECT id FROM organizations WHERE status = 'active'");
}

/** The occurrence-generation scan — one active schedule at a time, org by
 *  org. Safe to call repeatedly/concurrently: every side effect it
 *  performs is idempotent (see generateOneOccurrence's own doc comment). */
export async function scanDueOccurrences(deps: AutomationDeps, organizationIdFilter: number | null): Promise<{ occurrencesProcessed: number; jobsGenerated: number; erroredCount: number; errors: string[] }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let occurrencesProcessed = 0, jobsGenerated = 0, erroredCount = 0;
  const errors: string[] = [];

  for (const org of orgs) {
    const tz = await getBusinessTimezone(org.id);
    const today = businessDateOffset(tz, 0);
    const dueSchedules = await query<MaintenanceScheduleRow>(
      "SELECT * FROM maintenance_schedules WHERE organization_id = ? AND status = 'active' AND automation_enabled = 1 AND next_due_date <= ?",
      [org.id, today]
    );
    for (const schedule of dueSchedules) {
      try {
        const membership = await get<MembershipRow>("SELECT * FROM maintenance_memberships WHERE id = ? AND organization_id = ?", [schedule.membership_id, org.id]);
        // Section 13 — Membership/Agreement eligibility: a paused/
        // cancelled/expired/superseded Membership must never keep
        // generating work, even if its schedule row is still nominally
        // "active" (pausing the SCHEDULE is the normal path — this is a
        // defense-in-depth check for when the Membership itself changed
        // state without an explicit schedule pause).
        if (!membership || membership.status !== "active") continue;
        const result = await generateOneOccurrence(deps, schedule, membership, schedule.next_due_date);
        if (result.created) occurrencesProcessed++;
        if (result.created && !result.skipped) jobsGenerated++;
      } catch (err) {
        erroredCount++;
        errors.push(`schedule ${schedule.id}: ${(err as Error).message}`);
      }
    }
  }
  return { occurrencesProcessed, jobsGenerated, erroredCount, errors };
}

// ── Renewal reminders (60/30/14) ────────────────────────────────────

export const REMINDER_MILESTONES = [60, 30, 14] as const;

export async function scanRenewalReminders(organizationIdFilter: number | null): Promise<{ scanned: number; sent: number }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let scanned = 0, sent = 0;

  for (const org of orgs) {
    const tz = await getBusinessTimezone(org.id);
    const today = businessDateOffset(tz, 0);
    const activeAgreements = await query<MaintenanceAgreement & { expires_at: string | null; plan_name: string }>(
      `SELECT a.*, v.expires_at, p.name as plan_name FROM maintenance_agreements a
       JOIN maintenance_agreement_versions v ON a.current_version_id = v.id
       JOIN maintenance_plans p ON a.plan_id = p.id
       WHERE a.organization_id = ? AND a.status = 'active' AND v.expires_at IS NOT NULL`,
      [org.id]
    );
    for (const agreement of activeAgreements) {
      if (!agreement.expires_at) continue;
      scanned++;
      const daysUntilExpiry = daysBetween(today, agreement.expires_at);
      const milestone = REMINDER_MILESTONES.find((m) => m === daysUntilExpiry);
      if (milestone === undefined) continue;

      const contact = await getCustomerContact(agreement.customer_id);
      if (!contact) continue;
      let didSend = false;
      await safeEnqueue(async () => {
        const result = await enqueueMaintenanceRenewalReminder({
          agreementId: agreement.id, customerId: agreement.customer_id, customerName: contact.name,
          customerEmail: contact.email, customerPhone: contact.phone, planName: agreement.plan_name,
          agreementIdentifier: agreement.identifier, expiresDate: agreement.expires_at!, milestoneDays: milestone,
        });
        didSend = result.email.enqueued || result.sms.enqueued;
      });
      if (didSend) sent++;
    }
  }
  return { scanned, sent };
}

// ── Renewal scan (auto-renew where eligible, initiate fresh-acceptance otherwise) ──

const RENEWAL_INITIATION_WINDOW_DAYS = 14; // matches the closest reminder milestone

export async function scanRenewals(db: D1Database, organizationIdFilter: number | null): Promise<{ processed: number; autoRenewed: number; initiated: number; errored: number; errors: string[] }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let processed = 0, autoRenewed = 0, initiated = 0, errored = 0;
  const errors: string[] = [];

  for (const org of orgs) {
    const tz = await getBusinessTimezone(org.id);
    const today = businessDateOffset(tz, 0);
    const candidates = await query<MaintenanceAgreement & { expires_at: string | null }>(
      `SELECT a.*, v.expires_at FROM maintenance_agreements a
       JOIN maintenance_agreement_versions v ON a.current_version_id = v.id
       WHERE a.organization_id = ? AND a.status = 'active' AND a.superseded_by_agreement_id IS NULL AND v.expires_at IS NOT NULL`,
      [org.id]
    );
    for (const agreement of candidates) {
      if (!agreement.expires_at) continue;
      const daysUntilExpiry = daysBetween(today, agreement.expires_at);
      if (daysUntilExpiry > RENEWAL_INITIATION_WINDOW_DAYS || daysUntilExpiry < 0) continue;
      processed++;
      try {
        try {
          await autoRenewAgreement(db, org.id, agreement.id);
          autoRenewed++;
        } catch (err) {
          if (err instanceof RenewalError && (err.code === "not_eligible" || err.code === "material_change")) {
            await initiateRenewal(db, org.id, null, agreement.id);
            initiated++;
          } else if (err instanceof RenewalError && err.code === "already_in_progress") {
            // A renewal already exists for this agreement (e.g. staff
            // manually initiated one) — nothing to do, not an error.
          } else {
            throw err;
          }
        }
      } catch (err) {
        errored++;
        errors.push(`agreement ${agreement.id}: ${(err as Error).message}`);
      }
    }
  }
  return { processed, autoRenewed, initiated, errored, errors };
}

// ── Execution ledger ─────────────────────────────────────────────────

export interface AutomationRunRow {
  id: number;
  organization_id: number | null;
  run_type: string;
  triggered_by: "cron" | "manual";
  actor_user_id: number | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  organizations_scanned: number;
  occurrences_processed: number;
  jobs_generated: number;
  renewals_processed: number;
  reminders_sent: number;
  errored_count: number;
  error_summary: string;
  created_at: string;
}

/** Only ever called when a run actually did something (or errored) — see
 *  migration 0028's header comment on why an empty tick is never
 *  persisted. */
async function recordAutomationRun(organizationId: number | null, runType: string, triggeredBy: "cron" | "manual", actorUserId: number | null, summary: AutomationRunSummary): Promise<void> {
  await run(
    `INSERT INTO maintenance_automation_runs
      (organization_id, run_type, triggered_by, actor_user_id, finished_at, status, organizations_scanned, occurrences_processed, jobs_generated, renewals_processed, reminders_sent, errored_count, error_summary)
     VALUES (?, ?, ?, ?, datetime('now'), 'completed', ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, runType, triggeredBy, actorUserId, summary.organizationsScanned, summary.occurrencesProcessed,
      summary.jobsGenerated, summary.renewalsProcessed, summary.remindersSent, summary.erroredCount, summary.errorSummary,
    ]
  );
}

// Deliberately scoped to organization_id = ? only — a global cron row
// (organization_id IS NULL, aggregating every org scanned that tick) can
// carry another organization's schedule/agreement ids inside its
// error_summary text, so it must never be returned through a tenant-scoped
// admin's view (Security review finding, Phase 19C).
export async function listAutomationRuns(organizationId: number, limit = 50): Promise<AutomationRunRow[]> {
  return query<AutomationRunRow>(
    "SELECT * FROM maintenance_automation_runs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?",
    [organizationId, limit]
  );
}

/** The single entry point both the Cloudflare cron tick and the Admin-only
 *  manual runner call — same idempotent production logic either way
 *  (Section 33: "use same idempotent production logic"). `organizationIdFilter`
 *  is null for a global cron run (spans every organization, matching
 *  Notifications' own enqueueDayBeforeReminders precedent) or a real org
 *  id for a manual Admin-triggered run (scoped to their own organization
 *  only). */
export async function runMaintenanceAutomationCycle(
  db: D1Database, deps: AutomationDeps, organizationIdFilter: number | null, triggeredBy: "cron" | "manual", actorUserId: number | null
): Promise<AutomationRunSummary> {
  const orgs = await activeOrganizations(organizationIdFilter);
  const occurrenceResult = await scanDueOccurrences(deps, organizationIdFilter);
  const renewalResult = await scanRenewals(db, organizationIdFilter);
  const reminderResult = await scanRenewalReminders(organizationIdFilter);

  const erroredCount = occurrenceResult.erroredCount + renewalResult.errored;
  const summary: AutomationRunSummary = {
    organizationsScanned: orgs.length,
    occurrencesProcessed: occurrenceResult.occurrencesProcessed,
    jobsGenerated: occurrenceResult.jobsGenerated,
    renewalsProcessed: renewalResult.processed,
    remindersSent: reminderResult.sent,
    erroredCount,
    errorSummary: [...occurrenceResult.errors, ...renewalResult.errors].slice(0, 20).join("; "),
  };

  const didSomething = summary.occurrencesProcessed > 0 || summary.renewalsProcessed > 0 || summary.remindersSent > 0 || summary.erroredCount > 0;
  if (didSomething) {
    await recordAutomationRun(organizationIdFilter, "cycle", triggeredBy, actorUserId, summary);
  }
  return summary;
}

// ── Dry-run / preview ────────────────────────────────────────────────

export interface OccurrencePreviewItem { scheduleId: number; membershipId: number; dueDate: string; dueState: DueState }
export interface RenewalPreviewItem { agreementId: number; identifier: string; expiresAt: string; daysUntilExpiry: number; autoRenewEligible: boolean; materialChangeReasons: string[] }

export async function previewDueOccurrences(organizationId: number): Promise<OccurrencePreviewItem[]> {
  const tz = await getBusinessTimezone(organizationId);
  const today = businessDateOffset(tz, 0);
  const schedules = await query<MaintenanceScheduleRow>("SELECT * FROM maintenance_schedules WHERE organization_id = ? AND status = 'active'", [organizationId]);
  return schedules.map((s) => ({ scheduleId: s.id, membershipId: s.membership_id, dueDate: s.next_due_date, dueState: computeDueState(s.next_due_date, today) }))
    .filter((item) => item.dueState === "due" || item.dueState === "overdue" || item.dueState === "upcoming");
}

export async function previewRenewals(organizationId: number): Promise<RenewalPreviewItem[]> {
  const tz = await getBusinessTimezone(organizationId);
  const today = businessDateOffset(tz, 0);
  const candidates = await query<MaintenanceAgreement & { expires_at: string | null }>(
    `SELECT a.*, v.expires_at FROM maintenance_agreements a
     JOIN maintenance_agreement_versions v ON a.current_version_id = v.id
     WHERE a.organization_id = ? AND a.status = 'active' AND a.superseded_by_agreement_id IS NULL AND v.expires_at IS NOT NULL`,
    [organizationId]
  );
  const items: RenewalPreviewItem[] = [];
  for (const agreement of candidates) {
    if (!agreement.expires_at) continue;
    const daysUntilExpiry = daysBetween(today, agreement.expires_at);
    if (daysUntilExpiry > 60) continue;
    const status = await getRenewalStatus(organizationId, agreement.id);
    items.push({ agreementId: agreement.id, identifier: agreement.identifier, expiresAt: agreement.expires_at, daysUntilExpiry, autoRenewEligible: status.status === "eligible", materialChangeReasons: [] });
  }
  return items;
}

export { getMembershipByAgreement };
