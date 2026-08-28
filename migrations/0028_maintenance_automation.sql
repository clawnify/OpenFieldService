-- Migration number: 0028 	 2026-08-28T12:00:00.000Z
--
-- Phase 19C (Recurring Maintenance / Renewal / Reminders / Automation):
-- fully additive — no existing table, column, or behavior changes. Only 3
-- genuinely new tables — everything else this phase needs is reused
-- directly from Phase 19B and Phase 9 infrastructure, not duplicated:
--
--   * Renewal state is NOT a new table/FSM. It is entirely derived from
--     Phase 19B's own `maintenance_agreements.supersedes_agreement_id`/
--     `superseded_by_agreement_id` (already present, migration 0027) plus
--     the existing `maintenance_agreement_audit` table (new event_types:
--     `renewal_initiated`/`renewal_auto_executed`/
--     `renewal_material_change_blocked`/`renewal_completed`). A renewal
--     "in progress" IS simply: an active Agreement whose
--     `superseded_by_agreement_id` points at a not-yet-active Agreement;
--     "renewed" IS that pointed-at Agreement reaching `active` (which
--     — see maintenance-agreements.ts's `recalculateAgreementStatus` —
--     now also completes the old Agreement's supersession and the old
--     Membership's supersession at that exact moment, never before,
--     never leaving the customer without active coverage mid-ceremony).
--     This satisfies Section 19's explicit FSM requirement without
--     inventing a second status vocabulary alongside the one Phase 19B
--     already reviewed and shipped.
--   * 60/30/14-day reminders are NOT a new delivery/evidence system. They
--     are enqueued through the existing Phase 9 `notification_outbox`
--     pipeline (`enqueueEvent`/`enqueueChannel` in notifications.ts) with
--     a new `eventType` ("maintenance.renewal_reminder") and
--     `discriminator` (the milestone, "60"/"30"/"14") — the EXACT same
--     `dedupe_key` UNIQUE-constraint mechanism that already guarantees
--     idempotent enqueue-per-milestone, the same channel/consent
--     resolution (`resolvePreferences`), and the same retry/delivery-
--     attempt evidence (`notification_delivery_attempts`) Phase 9 already
--     built, reviewed, and shipped. No new reminder table.
--   * Admin-config/system-actor audit reuses the existing polymorphic
--     `maintenance_admin_audit` table (Phase 19B) with new entity_type
--     values (`schedule`/`occurrence`), consistent with that table's own
--     "low-volume config event, one shared shape" rationale.
--
-- What IS genuinely new:
--
--   * `maintenance_schedules` — one recurring cadence per Membership
--     (`UNIQUE(membership_id)` — the simplest model that satisfies
--     Section 6/7: a Membership has one maintenance cadence covering all
--     its covered equipment in one visit, matching how residential HVAC
--     maintenance plans actually work; a future phase could relax this to
--     one-schedule-per-covered-asset if a real multi-cadence need
--     emerges, additive, not a redesign). `recurrence_type` is a plain
--     string (`ANNUAL`/`SEMI_ANNUAL`/`QUARTERLY`/`CUSTOM_DAYS`), never a
--     DB CHECK, matching jobs.status/assets.status precedent — no
--     HVAC-only cadence is hardcoded into reusable Core architecture, a
--     CUSTOM_DAYS org can define anything. `next_due_date` is a plain
--     `YYYY-MM-DD` string (same convention as `jobs.scheduled_date`) —
--     all recurrence-advancement arithmetic is calendar-date math, never
--     UTC-timestamp math, which is what makes it DST-safe by
--     construction (see maintenance-automation.ts's `advanceDueDate()`).
--   * `maintenance_occurrences` — the durable occurrence ledger (Section
--     9). `UNIQUE(schedule_id, cycle_number)` is the REAL duplicate-Job-
--     prevention guard (Section 11) — a claim-first INSERT with
--     `ON CONFLICT DO NOTHING`, the exact same idiom Phase 19B's
--     `maintenance_entitlement_events.idempotency_key` and Phase 15's
--     `call_tool_invocations.UNIQUE(call_id, idempotency_key)` already
--     established for "re-running the same trigger must not double the
--     side effect." `job_id`/`service_report_id` are nullable —
--     populated only once a Job is actually generated for that cycle;
--     `ON DELETE SET NULL` on both (an occurrence's own historical record
--     must outlive the Job/Report it produced, same loose-attribution-
--     reference precedent as `customers.referred_by_customer_id`).
--   * `maintenance_automation_runs` — the durable execution ledger
--     (Section 24/32). A cron-triggered run spans every organization (no
--     single actor to scope by, matching `enqueueDayBeforeReminders`'
--     own existing multi-org loop), so `organization_id` is nullable
--     (NULL = a global cron run's aggregate summary; a real org id = an
--     Admin-triggered manual run scoped to their own organization only).
--     Application code only ever persists a row when the run actually did
--     something (occurrences/renewals/reminders processed, or an error) —
--     a genuinely empty minute-by-minute tick is not durably logged, to
--     avoid an unbounded 1,440-rows-per-day floor of pure noise; this is
--     an application-level filter, not a schema constraint.

CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  membership_id INTEGER NOT NULL REFERENCES maintenance_memberships(id) ON DELETE CASCADE,
  recurrence_type TEXT NOT NULL DEFAULT 'ANNUAL',
  custom_interval_days INTEGER,
  checklist_template_id INTEGER REFERENCES maintenance_checklist_templates(id),
  status TEXT NOT NULL DEFAULT 'active',
  next_due_date TEXT NOT NULL,
  cycles_generated INTEGER NOT NULL DEFAULT 0,
  automation_enabled INTEGER NOT NULL DEFAULT 1,
  paused_at TEXT,
  paused_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pause_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_org_status ON maintenance_schedules(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_due ON maintenance_schedules(status, next_due_date);

CREATE TABLE IF NOT EXISTS maintenance_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  schedule_id INTEGER NOT NULL REFERENCES maintenance_schedules(id) ON DELETE CASCADE,
  membership_id INTEGER NOT NULL REFERENCES maintenance_memberships(id),
  cycle_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  service_report_id INTEGER REFERENCES maintenance_service_reports(id) ON DELETE SET NULL,
  skip_reason TEXT NOT NULL DEFAULT '',
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_occurrences_org_status ON maintenance_occurrences(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_occurrences_schedule ON maintenance_occurrences(schedule_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_occurrences_membership ON maintenance_occurrences(membership_id);

CREATE TABLE IF NOT EXISTS maintenance_automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  run_type TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'cron',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  organizations_scanned INTEGER NOT NULL DEFAULT 0,
  occurrences_processed INTEGER NOT NULL DEFAULT 0,
  jobs_generated INTEGER NOT NULL DEFAULT 0,
  renewals_processed INTEGER NOT NULL DEFAULT 0,
  reminders_sent INTEGER NOT NULL DEFAULT 0,
  errored_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_automation_runs_org ON maintenance_automation_runs(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_automation_runs_type ON maintenance_automation_runs(run_type, created_at);
