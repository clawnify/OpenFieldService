-- Migration number: 0018 	 2026-08-24T12:00:00.000Z
--
-- Phase 13 (Contracts / E-Sign Foundation): introduces a tenant-safe,
-- legally-traceable, historically-immutable Contract domain that binds to
-- the EXACT accepted Quote commercial version (Phase 12's
-- `quotes.accepted_version_id`), never the Quote's current/latest state.
-- Fully additive — no existing table/column changed.
--
-- Central principle (see docs addendum for full rationale): the customer
-- signs the exact commercial terms that were accepted. Everything below is
-- structured so that principle is a structural guarantee, not a policy
-- promise: `contracts.accepted_quote_version_id` is captured once at
-- Contract-creation time and never re-read from `quotes` afterward, and a
-- `contract_versions` row is an immutable, self-contained snapshot (of the
-- rendered legal body AND the commercial terms it describes) exactly like
-- `quote_versions` is for Quotes.
--
-- Design decisions:
--
--   * `contracts` is DIRECT_TENANT_COLUMN (Phase 11.5's taxonomy, reused
--     verbatim) — `organization_id INTEGER NOT NULL DEFAULT 1`, no inline
--     REFERENCES, application-enforced, consistent with every other
--     tenant-root table (jobs/customers/leads/invoices/assets/quotes).
--   * `contract_versions`/`contract_status_history`/`contract_signers`/
--     `contract_signature_requests`/`contract_signature_events`/
--     `contract_template_versions` are INHERITED_THROUGH_PARENT — no own
--     organization_id, tenant safety flows entirely from the FK chain up
--     to `contracts`/`contract_templates`, matching quote_versions/
--     quote_line_items/job_assets's established precedent.
--   * Versioning mirrors quote_versions exactly: `contracts` holds durable
--     identity + current lifecycle status + a `current_version_id`
--     pointer (forward-references `contract_versions`, legal in SQLite —
--     see migrations/0017's header for why); each `contract_versions` row
--     is immutable once created. "Editing a draft" means updating THAT
--     version's own row; a genuinely new legal/commercial position only
--     exists once a new version is explicitly created (mirrors Quote's
--     "Create Revision" operation) — never after the version has been
--     sent for signature. `row_version` (optimistic-concurrency CAS
--     counter, same hardening already applied to quote_versions) guards
--     against a lost-update race if a draft version's snapshot fields are
--     ever recomputed by a concurrent request.
--   * `contracts.accepted_quote_version_id` is captured from
--     `quotes.accepted_version_id` at the moment a Contract is created
--     from an accepted Quote, then NEVER re-read — a later Quote revision
--     (which resets the Quote to draft and can eventually produce a new
--     `accepted_version_id`) cannot alter an already-created Contract.
--     `quote_id` is also stored (informational parent reference) but
--     `accepted_quote_version_id` is the binding that actually matters.
--   * `contract_versions.commercial_snapshot`/`customer_snapshot`/
--     `company_snapshot` are JSON TEXT columns capturing exactly what
--     Section 32/33 require (quote identifier/line items/totals; customer
--     name/address at contract-creation time; company name/contact at
--     contract-creation time) so a signed Contract's displayed terms can
--     never drift if the source Quote, Customer profile, or company
--     settings change later. `company_snapshot` is captured as an empty
--     JSON object today — no company-profile Global Setting exists yet in
--     this codebase to source it from (confirmed by audit); the column
--     exists and is populated at write time so a future company-profile
--     Global Setting addition can populate it without a schema change,
--     but it is honestly empty until that exists. Not a silent gap:
--     documented in the Phase 13 docs addendum.
--   * `contract_versions.document_hash` (SHA-256 of the exact rendered
--     `body` + `commercial_snapshot`, computed once a version is sent for
--     signature) provides tamper-evidence that what was displayed to a
--     signer is what's on record. `signed_document_key`/
--     `signed_document_hash`/`signed_at` are populated once ALL required
--     signers on the current version have completed — no separate
--     "signed documents" table: a Contract Version has at most one final
--     signed artifact, and folding it onto the version row (rather than a
--     child table) mirrors `quotes.accepted_by`/`accepted_at` living on
--     the parent rather than a side table for a single well-defined event.
--   * `contract_templates`/`contract_template_versions` are a minimal,
--     versioned, structured template system (Section 15) — NOT a visual
--     designer. A `contract_versions` row optionally references the
--     `contract_template_versions` row it was rendered from
--     (`template_version_id`, nullable — a Contract can also be created
--     freeform with no template), but `contract_versions.body` always
--     holds the fully-rendered, already-merge-field-resolved text — the
--     template itself can be edited/versioned later with zero effect on
--     any Contract Version already created from an earlier template
--     version, matching the "historical Contracts point to or snapshot
--     the exact template version used" requirement structurally.
--   * `contract_signers`: no FK to `customers`/`leads` — a signer (co-owner,
--     guarantor, company rep) may not correspond to any existing Customer/
--     Lead contact row, so this table stores signer identity fields
--     directly (name/email/phone/role). Cross-customer signer assignment
--     is prevented structurally, not via an extra FK: every signer row is
--     created through `POST /api/contracts/{id}/signers`, which is already
--     scoped by `contract_id` (and therefore that Contract's own
--     `customer_id`) — there is no route that can attach a signer to any
--     Contract other than the one in the URL path.
--   * `contract_signature_requests.token_hash` — the same "generate 256
--     bits of randomness, store only its SHA-256 hash, never the raw
--     token" pattern `sessions.token_hash` already uses (`src/server/
--     auth.ts`) — a signing link's token is bound to exactly ONE
--     `contract_version_id` and ONE `signer_id` (both NOT NULL, both set
--     at creation, never reassigned), so a signer can never be redirected
--     to sign a different/newer version or another signer's request even
--     if a raw token were somehow guessed. `UNIQUE(token_hash)` — a
--     structural guarantee against token collision, not just a convention.
--   * `contract_signature_events` is an append-only ledger (Section 28) —
--     no UPDATE/DELETE statement anywhere touches it, mirroring
--     `notification_delivery_attempts`' proven append-only-by-construction
--     pattern (verified in Phase 9 by exhaustive grep, same discipline
--     applied here from the start).
--   * `contracts.identifier` (`CONTRACT-{n}`) reuses the existing GLOBAL
--     (not tenant-scoped) `_meta` counter pattern — same mechanism as
--     job_counter/invoice_counter/lead_counter/quote_counter, via the same
--     atomic `UPDATE _meta ... RETURNING value` statement. DELIBERATE,
--     disclosed inheritance of the existing G15 risk register entry — not
--     silently fixed, no existing counter touched, only a new
--     `contract_counter`/`contract_prefix` pair added.

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  -- Captured once at creation time from quotes.accepted_version_id — see
  -- header comment. Never updated after INSERT.
  accepted_quote_version_id INTEGER NOT NULL REFERENCES quote_versions(id),
  status TEXT NOT NULL DEFAULT 'draft',
  current_version_id INTEGER REFERENCES contract_versions(id),
  voided_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contracts_organization_status ON contracts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_customer ON contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_quote ON contracts(quote_id);

CREATE TABLE IF NOT EXISTS contract_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  current_version_id INTEGER REFERENCES contract_template_versions(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contract_templates_organization ON contract_templates(organization_id);

CREATE TABLE IF NOT EXISTS contract_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES contract_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Whitelisted {{merge_field}} placeholders only — see contracts.ts's
  -- ALLOWED_MERGE_FIELDS. Never executed as code; a plain string-replace
  -- against a fixed whitelist, unknown placeholders left literally in
  -- place (fail-safe, never silently dropped or code-evaluated).
  body TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(template_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_contract_template_versions_template ON contract_template_versions(template_id);

CREATE TABLE IF NOT EXISTS contract_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Fully rendered (merge fields already resolved) — the immutable legal
  -- text a signer actually sees, never re-rendered from the template later.
  body TEXT NOT NULL DEFAULT '',
  template_version_id INTEGER REFERENCES contract_template_versions(id),
  commercial_snapshot TEXT NOT NULL DEFAULT '{}',
  customer_snapshot TEXT NOT NULL DEFAULT '{}',
  company_snapshot TEXT NOT NULL DEFAULT '{}',
  effective_date TEXT,
  expires_at TEXT,
  document_hash TEXT,
  hash_algorithm TEXT NOT NULL DEFAULT 'SHA-256',
  signed_document_key TEXT,
  signed_document_hash TEXT,
  signed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contract_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_contract_versions_contract ON contract_versions(contract_id);

CREATE TABLE IF NOT EXISTS contract_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contract_status_history_contract ON contract_status_history(contract_id);

CREATE TABLE IF NOT EXISTS contract_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'customer',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contract_signers_contract ON contract_signers(contract_id);

CREATE TABLE IF NOT EXISTS contract_signature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  -- Bound to ONE exact version and ONE exact signer at creation time, both
  -- immutable for the life of the request — see header comment.
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  signer_id INTEGER NOT NULL REFERENCES contract_signers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  token_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'local',
  provider_request_id TEXT,
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

CREATE INDEX IF NOT EXISTS idx_contract_signature_requests_contract ON contract_signature_requests(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_signature_requests_version ON contract_signature_requests(contract_version_id);
CREATE INDEX IF NOT EXISTS idx_contract_signature_requests_signer ON contract_signature_requests(signer_id);

-- Append-only evidence ledger — see header comment. No UPDATE/DELETE
-- statement against this table exists anywhere in application code.
CREATE TABLE IF NOT EXISTS contract_signature_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature_request_id INTEGER NOT NULL REFERENCES contract_signature_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contract_signature_events_request ON contract_signature_events(signature_request_id);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('contract_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('contract_prefix', 'CONTRACT');
