-- Migration number: 0015 	 2026-08-21T01:00:00.000Z
--
-- Phase 11.5 (Tenant / SaaS Boundary Preparation): introduces the minimum
-- durable tenant boundary — an `organizations` table plus an
-- `organization_id` column on every directly tenant-owned root table —
-- while preserving exact current single-company behavior.
--
-- Design decisions (see docs/PLATFORM-GENERALIZATION-AUDIT.md's Phase 11.5
-- addendum for the full rationale):
--
--   * DIRECT_TENANT_COLUMN tables (this migration): users, customers,
--     technicians, service_types, materials, jobs, invoices, leads,
--     global_settings. Every other business table (job_notes,
--     job_checklist, job_materials, invoice_lines, payments, job_status_
--     history, job_rebate_audit, job_media, job_completion_reports,
--     job_signatures, job_compliance_audit, lead_status_history,
--     calendar_*, notification_*, bc_rebate_customer_profiles) is
--     INHERITED_THROUGH_PARENT — its tenant safety comes from the FK chain
--     to one of the 9 tables above, not a duplicated organization_id
--     column. `_meta` (identifier counters) deliberately remains a GLOBAL
--     system table this phase — see the addendum's "Numbering / Counters"
--     section for why that's a disclosed, deferred decision, not an
--     oversight.
--
--   * No inline `REFERENCES organizations(id)` on these ADD COLUMN
--     statements: D1/SQLite rejects `ALTER TABLE ... ADD COLUMN` that
--     combines a REFERENCES clause with a non-NULL DEFAULT ("Cannot add a
--     REFERENCES column with non-NULL default value") — confirmed live
--     against the real D1 test pool, not assumed. `organization_id` is
--     therefore a plain INTEGER column, application-enforced only (every
--     write path in src/server/index.ts sets it explicitly from the
--     authenticated actor's own organization, never from client input).
--     This is a disclosed, deliberate trade-off, not an oversight.
--
--   * `NOT NULL DEFAULT 1` (not a separate backfill UPDATE): this single
--     mechanism correctly handles all three required cases at once —
--     (a) existing rows at ALTER time are backfilled to the default
--     organization created below; (b) a fresh database's own seed rows
--     (the admin user, the 6 example service_types, the 5 example
--     materials — all inserted by migration 0001's `INSERT OR IGNORE`
--     statements, which predate this column and never mention it) also
--     land on the default organization; (c) this project's test harness
--     (test/helpers.ts's resetDatabase()) DELETEs these tables per-test
--     and replays ONLY the original `INSERT OR IGNORE` seed statements —
--     which, again, never mention organization_id — so the default is
--     what keeps every reseeded test fixture correctly assigned without
--     touching the test harness's replay mechanism. Application code
--     ALWAYS writes organization_id explicitly on every real create path
--     going forward (see src/server/index.ts) — this default is a
--     migration/reseed safety net only, never relied upon by request
--     handling logic once a second organization exists.

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO organizations (id, name, status) VALUES (1, 'Default Organization', 'active');

ALTER TABLE users ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE technicians ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_types ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE materials ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE global_settings ADD COLUMN organization_id INTEGER NOT NULL DEFAULT 1;

-- Composite indexes matching this phase's actual new query patterns
-- (every tenant-scoped list/search route now filters on organization_id
-- first) — not a blind index-everything pass.
CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_customers_organization ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_technicians_organization ON technicians(organization_id);
CREATE INDEX IF NOT EXISTS idx_service_types_organization ON service_types(organization_id);
CREATE INDEX IF NOT EXISTS idx_materials_organization ON materials(organization_id);
CREATE INDEX IF NOT EXISTS idx_jobs_organization_status ON jobs(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_organization_scheduled_date ON jobs(organization_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_invoices_organization_status ON invoices(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_organization_status ON leads(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_global_settings_organization_key ON global_settings(organization_id, key);
