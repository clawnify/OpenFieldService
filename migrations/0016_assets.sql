-- Migration number: 0016 	 2026-08-22T00:00:00.000Z
--
-- Phase 11.4 (Assets / Equipment Generalization): introduces a generic,
-- tenant-safe Asset (Core term; UI may label it "Equipment" for HVAC users)
-- concept. Fully additive — no existing table, column, or behavior changes.
--
-- Design decisions (see docs/PLATFORM-GENERALIZATION-AUDIT.md's Phase 11.4
-- addendum for the full rationale):
--
--   * `assets` is a DIRECT_TENANT_COLUMN table (Phase 11.5's own
--     classification — see migrations/0015), matching jobs/customers/leads/
--     invoices: it needs its own independently listable/searchable/
--     paginated endpoint, not just parent-JOIN access. `organization_id`
--     is a plain `INTEGER NOT NULL DEFAULT 1` column with NO inline
--     `REFERENCES organizations(id)` — this IS a brand-new table (a real
--     CREATE TABLE, not an ALTER TABLE ADD COLUMN, so the D1/SQLite
--     REFERENCES+non-NULL-DEFAULT restriction documented in migration 0015
--     does not technically apply here) but the column is kept
--     application-enforced-only anyway, for consistency with all 9
--     existing DIRECT_TENANT_COLUMN tables rather than introducing a
--     first-of-its-kind inconsistent exception. Every write path in
--     src/server/assets.ts sets it explicitly from the authenticated
--     actor's own organization, never from client input.
--   * `customer_id` uses the SAME `REFERENCES customers(id) ON DELETE
--     CASCADE` shape jobs.customer_id and invoices.customer_id already
--     use (see migrations/0001) — an Asset cannot outlive the Customer
--     that owns it. Every create/update path additionally verifies the
--     referenced customer belongs to the actor's own organization before
--     trusting it (defense in depth beyond the DB-level FK, matching the
--     "verify every cross-entity FK reference is same-org" convention
--     already established for e.g. resolveReferralAttribution).
--   * `asset_type` is a plain TEXT column, NOT a DB CHECK/enum — validated
--     at the API boundary (src/server/index.ts) against a registry
--     composed from Core plus the HVAC module's own contributed type list
--     (src/server/modules/hvac/asset-types.ts), mirroring Phase 11.2's
--     JOB_TYPE_REGISTRY pattern for "avoid an HVAC-only Core union." Unlike
--     JOB_TYPE_REGISTRY, this composition needs no architecture-guard
--     composition-root exception: there is no per-type engine behavior to
--     close over (just a flat label lookup for validation + a listing
--     endpoint), so index.ts — already an allowed composition root — owns
--     the composition and validation directly; src/server/assets.ts (Core)
--     never imports modules/** at all.
--   * `serial_number` is UNCONSTRAINED (no UNIQUE index) — deliberately.
--     Real-world HVAC serial data is frequently missing, mistyped, or
--     legitimately duplicated (a manufacturer's own numbering can collide
--     across models/eras; a company may have two units with blank serials
--     entered as placeholders). A hard uniqueness constraint would produce
--     false rejections on real, messy field data. Indexed for search
--     performance only, not enforced as unique at any scope (global,
--     tenant, or customer).
--   * `status` is a plain TEXT column, minimal by design (no DB CHECK,
--     matching jobs.status/leads.status precedent): 'active' | 'inactive'
--     | 'retired'. No maintenance lifecycle in this phase.
--   * No snapshot/history table for Asset field changes: Job <-> Asset is a
--     LIVE reference via job_assets (below), not a point-in-time copy.
--     Unlike money (which this codebase deliberately snapshots, e.g.
--     invoice_lines), equipment identity fields (manufacturer/model/serial)
--     essentially never change after install — an edit is a data
--     correction, not a new fact needing history. Documented tradeoff, not
--     an oversight: if a future phase needs point-in-time Job/Asset
--     snapshots, that is new, additive work, not a retrofit of this table.
--   * Delete/retire: DELETE is only permitted (src/server/assets.ts) when
--     the Asset has zero job_assets links — a referenced Asset must be
--     retired (`status='retired'` via ordinary PUT) instead, never
--     hard-deleted out from under historical Job data. This reuses the
--     existing `status` column as the soft-delete mechanism (same
--     precedent as jobs.status='cancelled'), rather than adding a second
--     `deleted_at` column.
--
--   * `job_assets` is INHERITED_THROUGH_PARENT (Phase 11.5's other
--     classification), matching job_notes/job_checklist/job_materials: NO
--     organization_id column of its own — tenant safety comes from both
--     `job_id` and `asset_id` already being org-scoped via their own FK
--     chains, and every route additionally verifies both belong to the
--     SAME organization before linking (cross-org linking is impossible by
--     construction, not just by convention). `UNIQUE(job_id, asset_id)`
--     prevents a duplicate link. Many-to-many (not a single nullable
--     jobs.asset_id column): real HVAC jobs commonly involve multiple
--     units (e.g. servicing both a furnace and an AC on one visit), and a
--     junction table is barely more complex than a single FK while being
--     materially more correct.
--   * Cross-customer safety: every link-creation path (src/server/assets.ts)
--     verifies asset.customer_id === job.customer_id before inserting —
--     default DENY, no shared-asset-across-customers concept exists in
--     this phase.

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  installation_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_organization ON assets(organization_id);
CREATE INDEX IF NOT EXISTS idx_assets_customer ON assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_assets_org_type ON assets(organization_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_org_status ON assets(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_serial ON assets(serial_number);

CREATE TABLE IF NOT EXISTS job_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_job_assets_job ON job_assets(job_id);
CREATE INDEX IF NOT EXISTS idx_job_assets_asset ON job_assets(asset_id);
