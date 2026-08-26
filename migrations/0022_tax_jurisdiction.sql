-- Migration number: 0022 	 2026-08-25T00:00:00.000Z
--
-- FSM upgrade, Phase 13D (Tax & Jurisdiction Settings):
--
--   * Replaces the Phase 5/12 single-flat-`tax_rate`-percent model (still
--     present on `invoices`/`quote_versions`, both untouched here — see
--     below) with an organization-scoped, versioned, component-based Tax
--     Profile. Nothing is destructive: `invoices.tax_rate`/`tax_amount_cents`
--     and `quote_versions.tax_rate`/`tax_amount_cents` keep meaning exactly
--     what they already mean (a blended effective rate / the already-stored
--     total tax amount) for every pre-Phase-13D row and for every UI/PDF
--     code path that has not been updated to read the richer snapshot below
--     — this is purely additive.
--
--   * `tax_profiles` — one row per *version* of an organization's tax
--     configuration, effective-dated exactly like `global_settings`
--     (effective_from/effective_until). A new Save NEVER edits an existing
--     row in place: it closes the current row's effective_until and inserts
--     a new one (src/server/tax-jurisdiction.ts#saveTaxProfile), the same
--     non-destructive-versioning discipline `quote_versions`/Contract
--     revisions already use elsewhere in this codebase. `tax_enabled=0` is
--     the default for every organization (including the existing default
--     org, id=1) — a fresh install or an org that never visits the new
--     Tax & Jurisdiction screen sees ZERO behavior change: new documents
--     keep computing $0 tax, exactly like every document before this phase.
--     No Canadian rates are seeded into any organization's real profile —
--     province presets are offered client-side as editable starting points
--     only (Section 5 of the phase spec: "editable presets, not permanent
--     legal truth"), never silently applied.
--
--   * `tax_profile_components` — 0..N rows per profile (GST/PST/HST/QST/
--     anything else an admin names) instead of one combined rate, so BC's
--     GST+PST, Ontario's single HST, and Quebec's GST+QST are all just
--     different component sets under the same schema — no per-province
--     code branching anywhere in the calculation engine.
--
--   * `tax_snapshots` — one row per taxed *document* (a Quote Version or an
--     Invoice; `document_type`/`document_id` is a small deliberate
--     polymorphic pair rather than two near-identical tables, since the
--     snapshot shape and every reader of it — src/server/tax-jurisdiction.ts
--     — is genuinely identical for both). Written exactly once, at the
--     moment tax is computed for that specific document (Quote: every
--     recompute while still in `draft`, matching the existing
--     recomputeAndStoreVersionTotals cadence — see quotes.ts; Invoice: at
--     creation). Never updated afterward, and never re-derived from today's
--     Global/Tax Settings when rendering a historical document — this is
--     the actual historical-immutability mechanism the phase spec requires:
--     a later Tax Profile change can only affect documents created after
--     the change, because every existing tax_snapshots row keeps pointing
--     at the (still-intact, never-edited) tax_profiles row that produced it.
--     `legacy` is a reserved flag for a POSSIBLE future backfill of
--     pre-Phase-13D documents from their already-stored subtotal/tax/total
--     (never a fabricated jurisdiction/rate) — no backfill has been written
--     or run as part of this phase. Today, a pre-Phase-13D document simply
--     has no tax_snapshots row at all, and every reader (invoice-pdf.ts,
--     contract-pdf.ts, quote-detail.tsx, invoice-detail.tsx) already
--     falls back to that document's original flat tax_rate/tax_amount_cents
--     columns when no snapshot exists — see each file's own null-check.
--
--   * `tax_snapshot_components` — the actual GST/PST/HST/QST breakdown for
--     one snapshot (name, rate, computed amount) — what the UI/PDF loop
--     over to render "GST 5% / PST 7% / Total Tax" instead of one flat
--     "Tax (12%)" line, for every document created after this phase.
--
--   * `taxable` (additive column, default 1 = taxable) on `quote_line_items`
--     and `invoice_lines` — explicit per-line taxability (Section 8),
--     defaulting to the organization's `default_taxable` at the point of
--     calculation, but always overridable per line. Every existing row
--     defaults to taxable=1, which is a no-op for every organization
--     currently running with tax_enabled=0 and preserves the closest
--     reasonable assumption (a normal billable line) for the one existing
--     organization that might later enable tax.

CREATE TABLE IF NOT EXISTS tax_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_enabled INTEGER NOT NULL DEFAULT 0,
  country_code TEXT NOT NULL DEFAULT '',
  region_code TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CAD',
  prices_include_tax INTEGER NOT NULL DEFAULT 0,
  default_taxable INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_until TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tax_profiles_org_effective ON tax_profiles(organization_id, effective_from);

CREATE TABLE IF NOT EXISTS tax_profile_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_profile_id INTEGER NOT NULL REFERENCES tax_profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_percent REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tax_profile_components_profile ON tax_profile_components(tax_profile_id);

CREATE TABLE IF NOT EXISTS tax_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_type TEXT NOT NULL,
  document_id INTEGER NOT NULL,
  tax_profile_id INTEGER REFERENCES tax_profiles(id) ON DELETE SET NULL,
  tax_enabled INTEGER NOT NULL DEFAULT 0,
  country_code TEXT NOT NULL DEFAULT '',
  region_code TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CAD',
  prices_include_tax INTEGER NOT NULL DEFAULT 0,
  taxable_base_cents INTEGER NOT NULL DEFAULT 0,
  total_tax_cents INTEGER NOT NULL DEFAULT 0,
  business_number TEXT NOT NULL DEFAULT '',
  tax_number TEXT NOT NULL DEFAULT '',
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_snapshots_document ON tax_snapshots(document_type, document_id);

CREATE TABLE IF NOT EXISTS tax_snapshot_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_snapshot_id INTEGER NOT NULL REFERENCES tax_snapshots(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_percent REAL NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tax_snapshot_components_snapshot ON tax_snapshot_components(tax_snapshot_id);

ALTER TABLE quote_line_items ADD COLUMN taxable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invoice_lines ADD COLUMN taxable INTEGER NOT NULL DEFAULT 1;
