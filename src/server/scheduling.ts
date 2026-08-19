import { get, query, run } from "./db.js";

/** Field-format/range problems (bad date, bad time, non-positive duration,
 *  nonexistent/inactive technician) — mapped to 400 by the route handler,
 *  same pattern as CustomerValidationError/WorkflowError/FinancialError. */
export class ScheduleValidationError extends Error {}

/** A same-technician overlapping-interval conflict — mapped to 409 by the
 *  route handler (distinct from ScheduleValidationError's 400: this isn't a
 *  malformed request, it's a well-formed request that collides with another
 *  already-scheduled job). */
export class ScheduleConflictError extends Error {
  conflict: { job_id: number; scheduled_date: string; scheduled_time: string; duration: number };
  constructor(message: string, conflict: { job_id: number; scheduled_date: string; scheduled_time: string; duration: number }) {
    super(message);
    this.conflict = conflict;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Rejects not just malformed strings but calendar-invalid ones (e.g.
 *  "2026-02-30") — Date's UTC constructor silently rolls invalid
 *  day-of-month values into the next month, so the round-trip check below is
 *  required, not just the regex. */
export function isValidCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s: string): boolean {
  return TIME_RE.test(s);
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export interface ScheduleFieldsInput {
  scheduled_date?: string;
  scheduled_time?: string;
  duration?: number;
}

/** Validates only the scheduling fields actually present in `input` —
 *  partial-update aware, matching PUT /api/jobs/{id}'s existing "only
 *  touched fields are validated/applied" semantics. Never coerces or
 *  silently normalizes an invalid value; always throws instead. */
export function validateScheduleFields(input: ScheduleFieldsInput): void {
  if (input.scheduled_date !== undefined && !isValidCalendarDate(input.scheduled_date)) {
    throw new ScheduleValidationError("scheduled_date must be a valid calendar date (YYYY-MM-DD)");
  }
  if (input.scheduled_time !== undefined && !isValidTime(input.scheduled_time)) {
    throw new ScheduleValidationError("scheduled_time must be a valid 24-hour time (HH:MM)");
  }
  if (input.duration !== undefined && (!Number.isInteger(input.duration) || input.duration <= 0)) {
    throw new ScheduleValidationError("duration must be a positive integer number of minutes");
  }
}

/** Only called when technician_id is actually being SET/changed to a new
 *  value in the current request — never re-validated on an unrelated update
 *  to a job whose already-assigned technician later went inactive (that
 *  existing assignment must remain readable/history-safe, never silently
 *  reassigned — see mem:phase7/advanced-scheduler). */
export async function assertTechnicianAssignable(technicianId: number): Promise<void> {
  const tech = await get<{ id: number; active: number }>("SELECT id, active FROM technicians WHERE id = ?", [technicianId]);
  if (!tech) throw new ScheduleValidationError("The selected technician does not exist");
  if (!tech.active) throw new ScheduleValidationError("Cannot assign an inactive technician");
}

interface ConflictCandidate { id: number; scheduled_time: string; duration: number; }

/** Half-open-interval [start, start+duration) overlap check against every
 *  OTHER non-cancelled job already on this technician's books for this
 *  date. `excludeJobId` lets a job being edited ignore its own pre-edit
 *  slot. Hard-blocks (throws ScheduleConflictError) rather than warning —
 *  approved policy, see mem:phase7/advanced-scheduler. */
export async function checkScheduleConflict(
  technicianId: number, date: string, time: string, duration: number, excludeJobId: number | null
): Promise<void> {
  const candidates = await query<ConflictCandidate>(
    `SELECT id, scheduled_time, duration FROM jobs
     WHERE technician_id = ? AND scheduled_date = ? AND status != 'cancelled'${excludeJobId !== null ? " AND id != ?" : ""}`,
    excludeJobId !== null ? [technicianId, date, excludeJobId] : [technicianId, date]
  );
  const startA = timeToMinutes(time);
  const endA = startA + duration;
  for (const c of candidates) {
    const startB = timeToMinutes(c.scheduled_time);
    const endB = startB + c.duration;
    if (startA < endB && startB < endA) {
      throw new ScheduleConflictError(
        "This technician is already booked during an overlapping time range",
        { job_id: c.id, scheduled_date: date, scheduled_time: c.scheduled_time, duration: c.duration }
      );
    }
  }
}

export interface ScheduleSnapshot {
  technician_id: number | null;
  scheduled_date: string;
  scheduled_time: string;
  duration: number;
}

/** Records one job_schedule_history row (migration 0009) — only ever called
 *  by the route handler when at least one of technician/date/time/duration
 *  actually changed value; an update that only touches unrelated fields
 *  (notes, price, priority, ...) must never create a row here. `actorUserId`
 *  always comes from the authenticated session (currentUser(c).id in the
 *  route handler) — never client-supplied. */
export async function recordScheduleHistory(
  jobId: number, before: ScheduleSnapshot, after: ScheduleSnapshot, actorUserId: number, reason: string
): Promise<void> {
  await run(
    `INSERT INTO job_schedule_history
       (job_id, old_technician_id, new_technician_id, old_scheduled_date, new_scheduled_date,
        old_scheduled_time, new_scheduled_time, old_duration, new_duration, actor_user_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId, before.technician_id, after.technician_id, before.scheduled_date, after.scheduled_date,
      before.scheduled_time, after.scheduled_time, before.duration, after.duration, actorUserId, reason,
    ]
  );
}

/** True iff any of the 4 scheduling-relevant fields actually differ between
 *  before/after — the exact "did this update change scheduling data"
 *  predicate `updateJob` uses to decide whether to write a history row. */
export function scheduleChanged(before: ScheduleSnapshot, after: ScheduleSnapshot): boolean {
  return before.technician_id !== after.technician_id
    || before.scheduled_date !== after.scheduled_date
    || before.scheduled_time !== after.scheduled_time
    || before.duration !== after.duration;
}
