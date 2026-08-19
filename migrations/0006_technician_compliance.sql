-- Migration number: 0006 	 2026-08-17T20:15:00.000Z
--
-- FSM upgrade, Phase 4 (Technician Compliance):
--   * job_media: pre/post-work photos. Soft-delete only (deleted_at) — a photo
--     is evidence, and completion integrity depends on being able to show what
--     was on file at the moment a job was actually completed, even if a photo
--     was later removed for being wrong/duplicate/etc.
--   * job_completion_reports: one row per job (PK = job_id, same "one row per
--     entity" shape as calendar_integrations). status starts 'draft' and only
--     becomes 'submitted' explicitly — a draft must never satisfy the
--     completion gate.
--   * job_signatures: customer signature capture. Multiple rows allowed per
--     job (not unique on job_id) in case a signature needs to be recaptured;
--     canCompleteJob() only requires that at least one exists.
--   * job_compliance_audit: domain-specific audit trail (kept separate from
--     job_status_history and job_rebate_audit rather than a generic table —
--     see Serena backlog/p1-technician-completion-compliance for the reasoning:
--     each domain's events have a genuinely different queryable shape, and nothing
--     has shown a generic table would pay for the abstraction cost it adds).
--
-- Storage: R2-backed (see src/server/storage.ts and the new [[r2_buckets]]
-- binding in wrangler.toml) — job_media.storage_key and
-- job_signatures.storage_key are R2 object keys, never raw bytes in D1.

CREATE TABLE IF NOT EXISTS job_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_media_job ON job_media(job_id, kind);

CREATE TABLE IF NOT EXISTS job_completion_reports (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  work_performed TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  materials_used TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  signer_name TEXT NOT NULL DEFAULT '',
  signer_relationship TEXT NOT NULL DEFAULT '',
  captured_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_signatures_job ON job_signatures(job_id);

CREATE TABLE IF NOT EXISTS job_compliance_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_compliance_audit_job ON job_compliance_audit(job_id, created_at);
