-- Migration number: 0004 	 2026-08-17T19:00:00.000Z
--
-- FSM upgrade, Phase 3 (Leads / Rebate Customer Data / Eligibility):
--   * customers gain a referral source and an optional rebate profile (house
--     size, primary heating source, household composition, income). All
--     nullable/blank by default — "do not assume these fields apply to every
--     customer" (only rebate-track customers fill them in).
--   * job_rebate_audit: append-only record of eligibility checks and manual
--     eligibility code/expiry edits, distinct from job_status_history (Phase 2)
--     which only tracks the job's own workflow status. Never updated/deleted by
--     application code.
--   * REFERRAL_SOURCE_OPTIONS / HEATING_SOURCE_OPTIONS: seeded as ordinary
--     global_settings rows (category=reference_data) — this is the "configurable
--     dropdown, not hardcoded in components" mechanism, reusing Phase 1's
--     versioned settings store rather than inventing a second one. Effective
--     from a fixed past ISO timestamp (not `datetime('now')`, which uses a
--     different string format than the app's own ISO comparisons — see
--     src/server/settings.ts).
--
-- Deliberately NOT seeded here: any CleanBC/BC Hydro dollar, square-footage, or
-- day-count threshold. Those are real government-program numbers this migration
-- has no authority to invent; an admin sets them via the existing Global
-- Settings UI. src/server/rebate.ts documents the exact keys it looks for
-- (CLEANBC_MAX_HOUSE_SIZE, CLEANBC_MAX_HOUSEHOLD_INCOME,
-- BC_HYDRO_MAX_HOUSEHOLD_INCOME, CLEANBC_ELIGIBILITY_WARNING_DAYS) and treats an
-- unconfigured key as "cannot evaluate," never as a silent default.

ALTER TABLE customers ADD COLUMN referral_source TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN house_size INTEGER;
ALTER TABLE customers ADD COLUMN primary_heating_source TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN number_of_adults INTEGER;
ALTER TABLE customers ADD COLUMN number_of_children INTEGER;
ALTER TABLE customers ADD COLUMN household_income REAL;

CREATE TABLE IF NOT EXISTS job_rebate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_rebate_audit_job ON job_rebate_audit(job_id, created_at);

INSERT OR IGNORE INTO global_settings (key, value, data_type, category, description, effective_from, updated_by)
VALUES (
  'REFERRAL_SOURCE_OPTIONS',
  '["Google","Google Ads","Word of Mouth","Advertisement","Facebook","Instagram","Website","Referral","Existing Customer","Home Show","Other"]',
  'json', 'reference_data', 'Dropdown options for customer referral source', '2020-01-01T00:00:00.000Z', 1
);

INSERT OR IGNORE INTO global_settings (key, value, data_type, category, description, effective_from, updated_by)
VALUES (
  'HEATING_SOURCE_OPTIONS',
  '["Electric","Natural Gas","Oil","Propane","Wood","Heat Pump","Other"]',
  'json', 'reference_data', 'Dropdown options for a customer''s primary heating source', '2020-01-01T00:00:00.000Z', 1
);
