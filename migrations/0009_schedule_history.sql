-- Migration number: 0009 	 2026-08-17T23:48:11.000Z
--
-- Phase 7 — Advanced Scheduler: job_schedule_history, a 5th domain-specific
-- audit table (after job_status_history / job_rebate_audit /
-- job_compliance_audit / invoice_audit) recording WHO changed a job's
-- SCHEDULING data (technician/date/time/duration) and to what — distinct
-- from job_status_history, which records WORKFLOW STATUS transitions only.
-- A scheduling mutation (reschedule/reassign, via PUT /api/jobs/{id}) never
-- touches jobs.status, so this is a genuinely separate concern, not a
-- duplicate of the existing table — extends the established per-domain
-- audit pattern rather than consolidating (same reasoning re-affirmed by
-- every prior phase that added one of these tables).
--
-- Shape mirrors job_status_history (migrations/0003_workflow_engine.sql):
-- job_id FK ON DELETE CASCADE (history is meaningless once the job itself
-- is gone — same ownership-cascade precedent as job_notes/job_checklist/
-- job_materials from migrations/0001_baseline.sql). old/new_technician_id
-- and actor_user_id all use ON DELETE SET NULL (a technician or user
-- account can be deleted later without destroying the historical record,
-- and without blocking that deletion — same precedent as
-- job_compliance_audit.actor_user_id, payments.recorded_by,
-- customers.referred_by_customer_id from migration 0008).
--
-- No stored end_time — end time stays a derived value (scheduled_time +
-- duration) everywhere in this schema, never duplicated into a column.

CREATE TABLE IF NOT EXISTS job_schedule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  old_technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
  new_technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
  old_scheduled_date TEXT NOT NULL,
  new_scheduled_date TEXT NOT NULL,
  old_scheduled_time TEXT NOT NULL,
  new_scheduled_time TEXT NOT NULL,
  old_duration INTEGER NOT NULL,
  new_duration INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_schedule_history_job ON job_schedule_history(job_id);

-- Speeds up the new conflict-detection query (technician_id + scheduled_date
-- lookup on every scheduling mutation). Previously only single-column
-- indexes existed on jobs(technician_id) and jobs(scheduled_date)
-- separately (migrations/0001_baseline.sql) — additive only, does not
-- replace either.
CREATE INDEX IF NOT EXISTS idx_jobs_technician_date ON jobs(technician_id, scheduled_date);
