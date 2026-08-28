-- Migration number: 0027 	 2026-08-28T00:00:00.000Z
--
-- Phase 19B (Maintenance Plans / Memberships / Agreements / Legal Terms /
-- Checklists / Service Reports): fully additive — no existing table,
-- column, or behavior changes. Mirrors established precedent throughout:
--
--   * `legal_terms_documents`/`legal_terms_versions` mirror
--     `contract_templates`/`contract_template_versions` (migration 0018)
--     exactly — a minimal versioned structured-content system, not a
--     visual designer. DRAFT rows are editable in place; PUBLISH is a
--     one-way transition (immutable from then on) that also marks the
--     document's previously-published version SUPERSEDED (never deleted,
--     never rewritten) — enforced entirely in application code
--     (legal-terms.ts), matching this codebase's convention of app-level
--     FSM enforcement over DB CHECK constraints (jobs.status/leads.status/
--     contracts.status all do the same).
--   * `maintenance_agreements`/`maintenance_agreement_versions`/
--     `maintenance_agreement_signers`/`maintenance_agreement_signature_
--     requests`/`maintenance_agreement_signature_events`/
--     `maintenance_agreement_status_history` mirror `contracts`/
--     `contract_versions`/`contract_signers`/`contract_signature_requests`/
--     `contract_signature_events`/`contract_status_history` (migration
--     0018) field-for-field where the concept is the same (token_hash
--     bearer pattern, row_version optimistic-concurrency CAS, append-only
--     event ledger, JSON snapshot columns for historical immutability).
--     Deliberately a SEPARATE parallel domain rather than reusing the
--     `contracts` tables directly — a Maintenance Agreement is not a
--     signed Quote (no `quotes`/`quote_versions` binding), carries
--     genuinely different fields (plan snapshot, covered equipment,
--     auto-renew consent, entitlements), and Contracts is an
--     already-shipped, reviewed, historically-relied-upon module this
--     phase must not risk destabilizing (CLAUDE.md Scope Control /
--     Shared Kernel Minimalism: duplication is safer than premature
--     coupling here). The low-level signing PRIMITIVES (token generation/
--     hashing, PDF kernel, R2 storage helpers) ARE reused — see
--     maintenance-agreements.ts / maintenance-agreement-pdf.ts.
--   * `maintenance_agreements` is DIRECT_TENANT_COLUMN (Phase 11.5's
--     taxonomy) — `organization_id INTEGER NOT NULL DEFAULT 1`, no inline
--     REFERENCES, application-enforced, matching every other tenant-root
--     table (jobs/customers/leads/invoices/assets/quotes/contracts).
--     `maintenance_agreement_versions` and everything hanging off a single
--     Agreement/Plan/Template/Checklist-Template are INHERITED_THROUGH_
--     PARENT — no own organization_id, tenant safety flows from the FK
--     chain, matching quote_versions/contract_versions precedent.
--   * `maintenance_agreements.status` values: draft, sent, viewed, signed,
--     active, cancelled, expired, superseded (see maintenance-workflow.ts).
--     Unlike Contracts, there is no `partially_signed` — this phase does
--     not require multi-signer partial-completion tracking (single
--     customer-facing agreement, deliberately simpler). `signed`/`active`/
--     `expired`/`superseded` are DERIVED-only (never a bare user-chosen
--     `to_status`), exactly mirroring how Contracts' `signed`/`declined`/
--     `partially_signed`/`expired` are absent from CONTRACT_TRANSITIONS
--     but reachable via `transitionContractInternal`. `superseded` is new
--     (Contracts has no equivalent) — reached only via
--     `supersedeAgreement()` creating a fresh replacement Agreement
--     (`supersedes_agreement_id`/`superseded_by_agreement_id` cross-links),
--     never automatic (Section 5's explicit "no automatic renewal
--     execution" boundary).
--   * `maintenance_memberships` (1:1 with a signed `maintenance_agreements`
--     row via `UNIQUE(agreement_id)`) is the "active service entitlement"
--     concept per the task's own preferred model (Section 8). Created as a
--     side effect the moment an Agreement reaches `active` — same
--     idempotent-side-effect pattern as `generateInvoiceForJob()` on job
--     completion (Phase 5) — never a separate manual "create membership"
--     step. `visits_consumed` is NEVER a stored column — always summed
--     live from `maintenance_entitlement_events` on read, the same
--     ledger-over-mutable-counter discipline `getInvoiceFinancials()`
--     already established for `amount_paid_cents`/`balance_cents` (Phase
--     5) — required by Section 21's own explicit "retries/concurrency
--     must not double-consume" instruction; a plain mutable counter cannot
--     give that guarantee, an idempotency-keyed append-only ledger can.
--   * `maintenance_agreement_covered_equipment` stores an
--     `asset_snapshot` JSON blob (manufacturer/model/serial/display_name/
--     asset_type at attach time) alongside a nullable `asset_id` FK — an
--     Asset CAN be hard-deleted (assets.ts allows delete once it has zero
--     job_assets links; an Agreement-only reference doesn't block that),
--     so the snapshot is the actual historical-reproduction guarantee
--     Section 9 requires, not the live FK alone (`ON DELETE SET NULL`,
--     never CASCADE — losing the live asset must never silently corrupt
--     an Agreement Version's own historical record).
--   * `maintenance_service_reports.job_id` is
--     `INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE` —
--     the exact same "one row per job" shape `job_completion_reports`
--     (migration 0006) already established for the conceptually
--     equivalent "the completion record of this job" idea. This is
--     deliberately how a Job gets "associated" with maintenance work
--     (Section 19/29's Dispatcher "manually associate maintenance Job")
--     — creating a DRAFT service report scoped to
--     job+agreement+membership+asset IS the association record; no
--     separate join table, no `jobs` schema change, zero Core coupling.
--   * Checklist photos reuse the EXISTING `job_media` table (Phase 4) via
--     a new `kind` value — see compliance.ts's `MEDIA_KINDS` — rather than
--     a parallel photos table (Section 7 Shared Kernel Minimalism: this is
--     a genuinely generic "photo attached to a job" concept, already
--     R2-backed, already content-type-allowlisted, already soft-deletable;
--     duplicating it here would be exactly the premature-parallel-system
--     Section 6/31 explicitly warns against).
--   * Admin-configuration audit (plan/legal-terms/checklist-template
--     create/update/activate/publish/supersede) is consolidated into ONE
--     polymorphic `maintenance_admin_audit` (entity_type/entity_id
--     discriminator) rather than three near-identical single-purpose
--     tables — deliberately following `notification_outbox`'s own
--     precedent (Phase 9: "entity_type/entity_id [deliberately not 5
--     nullable FKs]") rather than the job_status_history/job_rebate_audit/
--     job_compliance_audit per-domain-table precedent, because these
--     three really do share one shape (low-volume admin config event: who
--     changed what, when) — unlike jobs/invoices/leads, which have
--     genuinely different queryable shapes. Agreement-level events
--     (signer add/remove, pre-signing covered-equipment changes) use a
--     second, separate `maintenance_agreement_audit` table since an
--     Agreement is a much higher-stakes, higher-volume, differently-
--     queried (always by agreement_id) domain — consistent with, not a
--     contradiction of, the per-domain-shape reasoning above.

CREATE TABLE IF NOT EXISTS legal_terms_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  current_published_version_id INTEGER REFERENCES legal_terms_versions(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legal_terms_documents_org_type ON legal_terms_documents(organization_id, type);

CREATE TABLE IF NOT EXISTS legal_terms_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES legal_terms_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  effective_from TEXT,
  published_at TEXT,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  superseded_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_legal_terms_versions_document ON legal_terms_versions(document_id);

CREATE TABLE IF NOT EXISTS maintenance_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_admin_audit_entity ON maintenance_admin_audit(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS maintenance_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'CUSTOM',
  active INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CAD',
  taxable INTEGER NOT NULL DEFAULT 1,
  visit_entitlement_count INTEGER,
  frequency_description TEXT NOT NULL DEFAULT '',
  priority_benefit TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_percent REAL,
  discount_fixed_cents INTEGER,
  included_services TEXT NOT NULL DEFAULT '[]',
  excluded_services TEXT NOT NULL DEFAULT '[]',
  other_benefits TEXT NOT NULL DEFAULT '[]',
  equipment_eligibility TEXT NOT NULL DEFAULT '[]',
  effective_from TEXT,
  effective_until TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_plans_org_active ON maintenance_plans(organization_id, active);

CREATE TABLE IF NOT EXISTS maintenance_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES maintenance_plans(id),
  status TEXT NOT NULL DEFAULT 'draft',
  current_version_id INTEGER REFERENCES maintenance_agreement_versions(id),
  supersedes_agreement_id INTEGER REFERENCES maintenance_agreements(id),
  superseded_by_agreement_id INTEGER REFERENCES maintenance_agreements(id),
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreements_org_status ON maintenance_agreements(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_agreements_customer ON maintenance_agreements(customer_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_agreements_plan ON maintenance_agreements(plan_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  plan_snapshot TEXT NOT NULL DEFAULT '{}',
  customer_snapshot TEXT NOT NULL DEFAULT '{}',
  company_snapshot TEXT NOT NULL DEFAULT '{}',
  terms_version_id INTEGER REFERENCES legal_terms_versions(id),
  terms_snapshot_hash TEXT,
  effective_date TEXT,
  expires_at TEXT,
  renewal_preference TEXT NOT NULL DEFAULT 'none',
  auto_renew_consent TEXT NOT NULL DEFAULT '{}',
  tax_breakdown TEXT NOT NULL DEFAULT '{}',
  total_price_cents INTEGER NOT NULL DEFAULT 0,
  document_hash TEXT,
  hash_algorithm TEXT NOT NULL DEFAULT 'SHA-256',
  signed_document_key TEXT,
  signed_document_hash TEXT,
  signed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agreement_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_versions_agreement ON maintenance_agreement_versions(agreement_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_covered_equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_version_id INTEGER NOT NULL REFERENCES maintenance_agreement_versions(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  asset_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_covered_equipment_version ON maintenance_agreement_covered_equipment(agreement_version_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'customer',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_signers_agreement ON maintenance_agreement_signers(agreement_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_signature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  agreement_version_id INTEGER NOT NULL REFERENCES maintenance_agreement_versions(id),
  signer_id INTEGER NOT NULL REFERENCES maintenance_agreement_signers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consent_text_version TEXT NOT NULL DEFAULT '',
  consent_at TEXT,
  signed_at TEXT,
  signature_method TEXT,
  signer_ip TEXT,
  signer_user_agent TEXT,
  declined_reason TEXT NOT NULL DEFAULT '',
  row_version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_signature_requests_agreement ON maintenance_agreement_signature_requests(agreement_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_signature_requests_version ON maintenance_agreement_signature_requests(agreement_version_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_signature_requests_signer ON maintenance_agreement_signature_requests(signer_id);

-- Append-only evidence ledger — no UPDATE/DELETE statement anywhere
-- touches this table, mirroring contract_signature_events verbatim.
CREATE TABLE IF NOT EXISTS maintenance_agreement_signature_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature_request_id INTEGER NOT NULL REFERENCES maintenance_agreement_signature_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_signature_events_request ON maintenance_agreement_signature_events(signature_request_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_status_history_agreement ON maintenance_agreement_status_history(agreement_id);

CREATE TABLE IF NOT EXISTS maintenance_agreement_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_agreement_audit_agreement ON maintenance_agreement_audit(agreement_id, created_at);

CREATE TABLE IF NOT EXISTS maintenance_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES maintenance_plans(id),
  status TEXT NOT NULL DEFAULT 'pending',
  effective_start TEXT,
  effective_end TEXT,
  visits_included INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agreement_id)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_memberships_org_status ON maintenance_memberships(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_memberships_customer ON maintenance_memberships(customer_id);

CREATE TABLE IF NOT EXISTS maintenance_membership_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_id INTEGER NOT NULL REFERENCES maintenance_memberships(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_membership_status_history_membership ON maintenance_membership_status_history(membership_id);

CREATE TABLE IF NOT EXISTS maintenance_checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  applicability TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  current_version_id INTEGER REFERENCES maintenance_checklist_template_versions(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_checklist_templates_org ON maintenance_checklist_templates(organization_id, active);

CREATE TABLE IF NOT EXISTS maintenance_checklist_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES maintenance_checklist_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(template_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_checklist_template_versions_template ON maintenance_checklist_template_versions(template_id);

CREATE TABLE IF NOT EXISTS maintenance_service_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  agreement_id INTEGER REFERENCES maintenance_agreements(id),
  membership_id INTEGER REFERENCES maintenance_memberships(id),
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
  checklist_template_version_id INTEGER REFERENCES maintenance_checklist_template_versions(id),
  checklist_snapshot TEXT NOT NULL DEFAULT '{}',
  checklist_results TEXT NOT NULL DEFAULT '{}',
  measurements TEXT NOT NULL DEFAULT '{}',
  work_performed TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '',
  recommendations TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  customer_acknowledgement TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  finalized_at TEXT,
  finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  document_key TEXT,
  document_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_service_reports_org_status ON maintenance_service_reports(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_service_reports_agreement ON maintenance_service_reports(agreement_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_service_reports_membership ON maintenance_service_reports(membership_id);

-- Entitlement ledger — the idempotency_key UNIQUE constraint is the actual
-- double-consumption guard (claim-first INSERT, catch-and-adopt on
-- conflict), same idiom as invoices' idx_invoices_job_active / Phase 16's
-- call_tool_invocations UNIQUE(call_id, idempotency_key). visit counts are
-- NEVER stored elsewhere — always SUM(visit_delta) from this table.
CREATE TABLE IF NOT EXISTS maintenance_entitlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_id INTEGER NOT NULL REFERENCES maintenance_memberships(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  visit_delta INTEGER NOT NULL DEFAULT 0,
  related_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  related_service_report_id INTEGER REFERENCES maintenance_service_reports(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_entitlement_events_membership ON maintenance_entitlement_events(membership_id);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('maintenance_agreement_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('maintenance_agreement_prefix', 'MAINT');
