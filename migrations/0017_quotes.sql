-- Migration number: 0017 	 2026-08-23T00:00:00.000Z
--
-- Phase 12 (Quotes / Estimates Foundation): introduces a generic, tenant-safe,
-- historically-traceable Quote domain — a commercial proposal to a Customer,
-- optionally originating from a Lead, structured as a durable Quote identity
-- (`quotes`) with immutable, versioned commercial content (`quote_versions` +
-- `quote_line_items`) and an append-only lifecycle audit trail
-- (`quote_status_history`). Fully additive — no existing table/column changed.
--
-- Design decisions (see docs/PLATFORM-GENERALIZATION-AUDIT.md's Phase 12
-- addendum for the full rationale):
--
--   * `quotes` is DIRECT_TENANT_COLUMN (Phase 11.5's taxonomy, reused
--     verbatim): `organization_id INTEGER NOT NULL DEFAULT 1`, no inline
--     REFERENCES, application-enforced only — consistent with every other
--     tenant-root table in this codebase (jobs/customers/leads/invoices/
--     assets), not a first-of-its-kind exception.
--   * `quote_versions`/`quote_line_items`/`quote_status_history` are
--     INHERITED_THROUGH_PARENT (no own organization_id) — tenant safety
--     flows entirely from the `quote_id` FK chain, matching job_notes/
--     job_checklist/job_assets's established precedent.
--   * Versioning: `quotes` holds durable identity + CURRENT lifecycle status
--     + a `current_version_id` pointer; each `quote_versions` row is an
--     IMMUTABLE, self-contained commercial snapshot (subtotal/discount/tax/
--     total all STORED, never recomputed from later Global Settings changes
--     — matching invoices' own precedent of storing computed money at
--     write time, not deriving it from mutable state). A version is never
--     UPDATEd after creation; "editing a draft" means updating the row's
--     own line items and re-storing that SAME version's totals (still
--     version 1) — a genuinely NEW commercial position only exists once
--     `POST /api/quotes/{id}/revisions` (Section 8's explicit "Create
--     Revision" operation) inserts version 2, 3, etc. `UNIQUE(quote_id,
--     version_number)` backstops the atomic `INSERT ... SELECT
--     COALESCE(MAX(version_number),0)+1 ...` version-number generation
--     (same "single-statement atomicity, backstopped by a UNIQUE
--     constraint" reasoning as job_assets' UNIQUE(job_id,asset_id) and
--     invoices' idx_invoices_job_active) — a genuine concurrent-revision
--     race fails the losing INSERT's UNIQUE constraint rather than silently
--     duplicating a version number.
--   * `quotes.current_version_id` forward-references `quote_versions(id)`
--     even though `quote_versions` is declared later in this same file —
--     legal in SQLite (FK target table need not exist yet at parse time,
--     only at constraint-check time) and avoids a circular-declaration
--     workaround. No `ON DELETE` action: a version is never independently
--     deleted while its quote exists (versions cascade away only when the
--     whole quote is deleted), so this pointer never needs to self-heal.
--   * Line items belong to `quote_version_id`, NOT `quote_id` directly —
--     this is what makes "prior versions immutable" and "no overwrite of
--     accepted/sent commercial history" structural rather than a policy
--     promise: creating a revision INSERTs a fresh set of
--     `quote_line_items` rows under the NEW version_id, the old version's
--     rows are never touched again.
--   * Money: every Quote financial value is integer cents
--     (`unit_price_cents`/`total_cents`/`subtotal_cents`/`discount_cents`/
--     `tax_amount_cents`), matching this codebase's standing "money is
--     always integer cents, never a bare-dollar REAL" rule (see
--     mem:architecture/data-model). `quantity` stays REAL (fractional labor
--     hours are a real use case, same precedent as invoice_lines.quantity).
--     `discount_type`('none'|'fixed'|'percent') + `discount_percent` are
--     retained alongside the resolved `discount_cents` purely for display/
--     audit ("why was this the discount") — `discount_cents` is always the
--     authoritative value actually used in the total calculation, computed
--     and capped server-side (never negative-total-producing) at version-
--     write time. `tax_rate` (REAL, a flat percentage — same shape as
--     invoices.tax_rate) is snapshotted per version so a later change to
--     the org's configured default tax rate never rewrites a past quote's
--     numbers.
--   * `quotes.identifier` (`QUOTE-{n}`) reuses the existing GLOBAL
--     (not tenant-scoped) `_meta` counter pattern — same mechanism as
--     job_counter/invoice_counter/lead_counter, via the same atomic
--     `UPDATE _meta ... RETURNING value` statement `nextInvoiceIdentifier()`
--     already uses. This is a DELIBERATE, disclosed inheritance of the
--     existing G15 risk (mem:phase11/platform-generalization-audit's §17
--     risk register — global identifier counters/uniqueness, not yet
--     tenant-scoped) — not a new problem, and not silently refactored:
--     no existing counter (`job_counter`/`invoice_counter`/`lead_counter`)
--     is touched by this migration, only a new `quote_counter`/
--     `quote_prefix` pair is added alongside them.
--   * `lead_id` (nullable, `ON DELETE SET NULL`) preserves Lead source
--     traceability without requiring one — a Quote may be created directly
--     from a Customer with no Lead involved. `customer_id` is required and
--     NOT NULL CASCADE, matching jobs.customer_id/invoices.customer_id's
--     existing "cannot outlive its Customer" precedent. Deliberately no
--     `job_id` column here: per this phase's own scope, the future
--     accepted-Quote -> Job boundary is Job-side ("Job should reference
--     source Quote/version"), so a future Phase adds `jobs.source_quote_id`/
--     `source_quote_version_id` (nullable, additive) rather than this
--     migration guessing that shape now.
--   * `accepted_by`/`accepted_at`/`rejected_reason` live on `quotes` (not a
--     version) since acceptance/rejection is a LIFECYCLE event about the
--     Quote as a whole, not a property of one version's commercial content
--     — mirrors `job_completion_reports`-style "who/when" metadata living
--     next to the entity it describes. Explicitly informal: "Quote
--     accepted" here means internal/manual acceptance metadata recorded by
--     staff, NEVER a legally-binding signed contract — Phase 13 (Contracts/
--     E-Sign) owns that distinction and will layer its own audit trail on
--     top, not replace this one.
--
--   * (Phase 12 hardening addendum, pre-Safe-Commit, 2026-08-24 — this
--     migration was still uncommitted/unapplied-beyond-local-dev at the
--     time, so it was amended in place rather than fragmented across a
--     second migration file for the same unshipped phase):
--     `accepted_version_id INTEGER REFERENCES quote_versions(id)` — an
--     EXPLICIT, permanent snapshot of which version was current at the
--     exact moment of acceptance, set once by transitionQuote() and never
--     touched again. Before this, "the accepted version" was only
--     correctly inferable as "whatever current_version_id happens to be,
--     since createQuoteRevision() is structurally blocked from an
--     'accepted' quote" — true, but implicit; Phase 13 (Contracts/E-Sign)
--     needs an exact, self-evident `accepted_quote_version_id` to reference
--     without relying on that inference holding forever. `quote_versions`
--     gains `row_version INTEGER NOT NULL DEFAULT 0` — a plain optimistic-
--     concurrency token (compare-and-swap counter), closing a disclosed P2
--     from Phase 12's security review: recomputeAndStoreVersionTotals()
--     used to SELECT line items then UPDATE stored totals as two separate
--     round-trips, so two genuinely concurrent line-item mutations on the
--     same draft version's totals could race and leave a stale total
--     stored until the next mutation happened to correct it. Now every
--     totals write is a `WHERE id = ? AND row_version = ?` compare-and-swap
--     (same idiom already used by `leads.converted_customer_id IS NULL` in
--     lead-conversion.ts), retried (bounded, 3 attempts) on a lost race
--     rather than surfacing a spurious conflict to the caller for what is,
--     from the client's perspective, an ordinary single-user edit.

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version_id INTEGER REFERENCES quote_versions(id),
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  accepted_version_id INTEGER REFERENCES quote_versions(id),
  rejected_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quotes_organization_status ON quotes(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_lead ON quotes(lead_id);

CREATE TABLE IF NOT EXISTS quote_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_percent REAL NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_quote_versions_quote ON quote_versions(quote_id);

CREATE TABLE IF NOT EXISTS quote_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_version_id INTEGER NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Optional reference to an existing Customer Asset being serviced/
  -- replaced (Phase 11.4) — never required (Section 14: "Do not force
  -- Asset linkage"). Proposed NEW equipment stays a plain line-item
  -- description; this is only for referencing something that already
  -- exists on file.
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_quote_line_items_version ON quote_line_items(quote_version_id);

CREATE TABLE IF NOT EXISTS quote_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_status_history_quote ON quote_status_history(quote_id);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('quote_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('quote_prefix', 'QUOTE');
