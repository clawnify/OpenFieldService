-- Migration number: 0025 	 2026-08-27T00:00:00.000Z
--
-- Phase 17 (Pricebook): introduces a reusable, organization-scoped product/
-- service catalog — the future authoritative source for Quote line-item
-- selection, Contract equipment metadata, Invoice line items, and Phase 18's
-- Good/Better/Best packages. Fully additive — no existing table, column, or
-- row is altered destructively.
--
-- Pre-implementation catalog audit (see docs/PHASE17-PRICEBOOK.md for the
-- full write-up) found two existing, narrower, tenant-scoped tables this
-- migration deliberately does NOT touch or unify with:
--   * `service_types` (0001, tenant-scoped since 0015) — a minimal job-
--     scheduling default helper (name/duration/REAL-dollar price/color),
--     no SKU/cost-split/taxability/category/manufacturer.
--   * `materials`/`job_materials` (0001, tenant-scoped since 0015) — a
--     minimal job-material-usage/inventory tracker, REAL-dollar cost only,
--     no sell price/SKU/taxability/category.
-- Neither has the cost/sell-price split, SKU, taxability, category, or
-- cents-money convention Pricebook requires, and destructively reshaping
-- either (tenant-column semantics already exist; money would need a
-- REAL->cents rebuild like invoices' own Phase 5 migration) is exactly the
-- kind of large, risky, out-of-scope change this phase's own instructions
-- warn against. Both remain separate and unmodified; a future phase may
-- choose to unify them into Pricebook, documented as a known coexistence,
-- not an oversight.
--
-- Design decisions:
--
--   * `pricebook_items`/`pricebook_categories` are DIRECT_TENANT_COLUMN
--     (Phase 11.5's taxonomy) — `organization_id INTEGER NOT NULL DEFAULT 1`,
--     no inline REFERENCES, application-enforced only, matching every other
--     genuinely new tenant-root table (jobs/customers/quotes/assets), not
--     tax_profiles' inline-REFERENCES exception (that table predates this
--     precedent settling). `pricebook_item_audit` is also given its own
--     organization_id (rather than INHERITED_THROUGH_PARENT) since audit
--     rows must remain independently queryable/listable per-org even if a
--     referenced item is later deleted in some future cleanup — matching
--     invoice_audit's own precedent of carrying its own scoping rather than
--     relying solely on a parent FK chain.
--   * `type` is a plain TEXT column (EQUIPMENT|PART|MATERIAL|SERVICE|LABOR|
--     OTHER), not a DB CHECK — validated at the API boundary in
--     src/server/pricebook.ts, same "app-validated enum, no DB CHECK"
--     precedent as jobs.status/leads.status/calls.status throughout this
--     codebase.
--   * `equipment_metadata`/`warranty_metadata` are JSON TEXT blobs, not a
--     dozen top-level columns — deliberate per this phase's own instruction
--     ("do not hard-code every possible HVAC attribute into top-level
--     columns"). Structured HVAC-ish keys (capacity, fuel_type, efficiency_
--     rating, voltage, phase, refrigerant_type, serial_number_required;
--     warranty duration/unit/terms/registration_required per warranty type)
--     live in application code (src/server/pricebook.ts), never as SQL
--     columns — keeps Core industry-neutral (CLAUDE.md law: industry logic
--     must not leak back into Core schema), same reasoning `voice_agent_
--     snapshot`/`call.details` JSON columns already use elsewhere in this
--     codebase for extensible, non-relationally-queried structured data.
--   * `cost_cents`/`sell_price_cents` are separate integer-cents columns
--     (this codebase's standing money rule) — cost is never customer-facing
--     (enforced at the RBAC/route layer, not the schema layer).
--   * `sku` uniqueness is per-organization, only when non-empty (Section 22)
--     — a partial unique index (`WHERE sku != ''`), not a plain UNIQUE
--     column, so multiple items may legitimately share a blank SKU without
--     a collision, matching `assets.serial_number`'s own "real-world data is
--     often blank/messy" reasoning (though here duplicates ARE rejected once
--     a SKU is actually entered, since SKU — unlike a manufacturer's serial
--     number — is meant to be a real per-org identifier when present).
--   * No effective-dating (`effective_from`/`effective_until`) on
--     `pricebook_items` in this phase — deliberately deferred per this
--     phase's own instruction ("do not make Phase 17 unnecessarily complex
--     if immediate active pricing is enough"). The extension point is
--     documented, not built: a future phase needing scheduled price changes
--     can add those two columns plus a resolution query filtering by date,
--     mirroring `tax_profiles`' own effective-dated versioning pattern,
--     without touching this migration.
--   * No separate price-version/history table — `pricebook_item_audit` (an
--     append-only log, same shape as `invoice_audit`/`phone_operations_
--     audit`) is the auditability mechanism (Section 47: "who changed, what
--     item, old price, new price, timestamp"), not a full versioned-row
--     model like `quote_versions`. The REAL historical-integrity guarantee
--     (Section 11) comes from Quote/Invoice line items copying a SNAPSHOT
--     at selection time, never dereferencing the live Pricebook item —
--     exactly the same discipline `quote_line_items.asset_id` already
--     established for Customer Assets. A full version/history table would
--     be overbuilding what this phase's own instructions ask for.
--   * `pricebook_categories.parent_category_id` (nullable self-FK) exists
--     per Section 14's explicit list, but is deliberately unenforced beyond
--     a plain FK — no depth limit, no cycle-prevention trigger — since
--     nothing in this phase's UI yet builds a multi-level tree; a shallow,
--     single-level "Category" picker is the actual UI delivered, and the
--     column is a documented extension point, not a load-bearing feature
--     (avoids overbuilding hierarchy UI/validation nothing uses yet).
--
--   * Snapshot linkage (Section 36/39/40, all additive, all nullable, all
--     `ON DELETE SET NULL` — losing the catalog-origin pointer never
--     invalidates the historical document/asset it's attached to):
--     `quote_line_items.pricebook_item_id` — set at line-item creation time
--     when a line originates from a catalog pick; the line's own
--     description/unit/unit_price_cents/taxable remain the authoritative,
--     independently-stored snapshot (unchanged existing columns) — a later
--     Pricebook price change never retroactively touches this row.
--     `invoice_lines.pricebook_item_id` — same reasoning; invoices in this
--     codebase are generated from Job/Quote data, not composed directly
--     from a Pricebook picker in this phase, so this column is the
--     forward-compatible foundation Section 39 asks for, not a new
--     invoice-composition UI.
--     `assets.pricebook_item_id` — links an installed-equipment Asset
--     instance back to the catalog Equipment definition it was
--     sold/installed from (Section 40's explicit "asset.pricebook_item_id
--     (optional)"). An Asset's own manufacturer/model/serial fields remain
--     its own independently-editable identity (unchanged) — this is
--     provenance, not a live dependency.

CREATE TABLE IF NOT EXISTS pricebook_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_category_id INTEGER REFERENCES pricebook_categories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pricebook_categories_org ON pricebook_categories(organization_id);
CREATE INDEX IF NOT EXISTS idx_pricebook_categories_org_active ON pricebook_categories(organization_id, active);

CREATE TABLE IF NOT EXISTS pricebook_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES pricebook_categories(id) ON DELETE SET NULL,
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'each',
  default_quantity REAL NOT NULL DEFAULT 1,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  sell_price_cents INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  preferred_vendor TEXT NOT NULL DEFAULT '',
  vendor_sku TEXT NOT NULL DEFAULT '',
  equipment_metadata TEXT NOT NULL DEFAULT '{}',
  warranty_metadata TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pricebook_items_org ON pricebook_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_pricebook_items_org_type ON pricebook_items(organization_id, type);
CREATE INDEX IF NOT EXISTS idx_pricebook_items_org_status ON pricebook_items(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_pricebook_items_org_category ON pricebook_items(organization_id, category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricebook_items_org_sku ON pricebook_items(organization_id, sku) WHERE sku != '';

CREATE TABLE IF NOT EXISTS pricebook_item_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  item_id INTEGER NOT NULL REFERENCES pricebook_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pricebook_item_audit_item ON pricebook_item_audit(item_id);
CREATE INDEX IF NOT EXISTS idx_pricebook_item_audit_org ON pricebook_item_audit(organization_id);

ALTER TABLE quote_line_items ADD COLUMN pricebook_item_id INTEGER REFERENCES pricebook_items(id) ON DELETE SET NULL;
ALTER TABLE invoice_lines ADD COLUMN pricebook_item_id INTEGER REFERENCES pricebook_items(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN pricebook_item_id INTEGER REFERENCES pricebook_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quote_line_items_pricebook_item ON quote_line_items(pricebook_item_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_pricebook_item ON invoice_lines(pricebook_item_id);
CREATE INDEX IF NOT EXISTS idx_assets_pricebook_item ON assets(pricebook_item_id);
