-- Migration number: 0003 	 2026-08-17T18:10:00.000Z
--
-- FSM upgrade, Phase 2 (Workflow Engine):
--   * job_type distinguishes STANDARD / CLEANBC / BC_HYDRO jobs, each with its own
--     status sequence (see src/server/workflow.ts) — the workflow engine reads this
--     column to know which transition table applies to a given job.
--   * eligibility_code / eligibility_code_expiry: required on a CleanBC job before
--     it can transition into "eligibility_approved" (src/server/workflow.ts
--     validateRequiredData()). Only CleanBC jobs use these; left blank otherwise.
--   * "confirmed" is retired as a distinct status (folded into "scheduled" — see the
--     UPDATE below) now that job_type-specific workflows are the source of truth for
--     what statuses exist. cancelled/reopen remain universal across all job types.
--   * job_status_history: append-only audit trail of every status transition. Rows
--     are never updated or deleted by application code.

ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE jobs ADD COLUMN eligibility_code TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN eligibility_code_expiry TEXT NOT NULL DEFAULT '';

UPDATE jobs SET status = 'scheduled' WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);

CREATE TABLE IF NOT EXISTS job_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_status_history_job ON job_status_history(job_id, created_at);
