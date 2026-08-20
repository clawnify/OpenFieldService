-- Migration number: 0013 	 2026-08-19T23:00:00.000Z
--
-- Phase 10.0 — Location Data Model + Provider Interfaces (audit-only Phase
-- 10 architecture record: mem:phase10/maps-routing-architecture-audit).
-- Adds durable Job-level coordinate storage. NO real geocoding provider is
-- wired to this yet — see src/server/geocoding.ts for the provider-
-- independent interfaces and the mock/no-op implementations this phase
-- ships instead.
--
-- Job-level, not Customer-level, and not a new Property/Location entity:
-- the audit confirmed `jobs.address` (not `customers.address`) is already
-- the authoritative, already-snapshotted service location —
-- src/server/index.ts's createJob() only derives a job's address from its
-- customer ONCE, at creation time, when the caller didn't supply one; a
-- job's own address never silently follows a later customer-address edit.
-- Coordinates belong next to that existing snapshot, not on `customers`.
--
-- Columns, deliberately the smaller of the two models this phase's own
-- task evaluated: `latitude`/`longitude`/`geocoded_at`/`geocode_status`
-- only — no `geocode_provider`/`geocode_error` columns. Provider name is
-- purely informational with no real audit value yet (exactly one
-- candidate provider — none — exists in this codebase today), and
-- detailed failure text belongs in application-level logs/service
-- results, not a persisted Job column that could accidentally retain
-- provider-response fragments over time. Revisit only once a real
-- provider (Phase 10.1) gives this column pair genuine value.
--
-- `geocode_status` is a THREE-value contract (pending|geocoded|failed) —
-- deliberately no `stale`: address-change semantics (see
-- src/server/geocoding.ts#clearJobGeocode) clear coordinates immediately
-- back to `pending` rather than preserving old, now-untrusted coordinates
-- under a "stale" label, so there is nothing for a `stale` state to mean.
-- No DB CHECK on the status vocabulary itself, matching this codebase's
-- established precedent (jobs.status, leads.status,
-- notification_outbox.status — all app-enforced, never a DB CHECK, since
-- these vocabularies can grow without a migration).
--
-- The one real structural invariant — a job's coordinates are either both
-- present or both absent, never partial — DOES get a real CHECK
-- constraint, matching this codebase's own precedent for genuine
-- structural invariants (notification_preferences' customer_id XOR
-- lead_id CHECK, payments.amount_cents CHECK > 0). Verified empirically
-- before writing this migration that SQLite/D1 correctly supports a
-- cross-column CHECK added via a second ALTER TABLE ADD COLUMN
-- referencing a column added earlier in the same migration, even against
-- an already-populated table (a real SQLite ALTER TABLE limitation this
-- codebase had not previously exercised) — confirmed both that valid
-- migrations apply cleanly and that a deliberately-malformed partial
-- UPDATE is correctly rejected with SQLITE_CONSTRAINT_CHECK.
--
-- Every existing Job gets `geocode_status = 'pending'` (the NOT NULL
-- DEFAULT backfills every pre-existing row) and NULL coordinates — no
-- provider is called by this migration; Phase 10.0 never makes an
-- external geocoding call at all (see src/server/geocoding.ts).
ALTER TABLE jobs ADD COLUMN latitude REAL;
ALTER TABLE jobs ADD COLUMN longitude REAL
  CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL));
ALTER TABLE jobs ADD COLUMN geocoded_at TEXT;
ALTER TABLE jobs ADD COLUMN geocode_status TEXT NOT NULL DEFAULT 'pending';

-- Supports a future Dispatcher Map view's "show only geocoded jobs" /
-- "how many jobs still need geocoding" queries (Phase 10.2+). Not a
-- geospatial index — plain B-tree on a low-cardinality status column,
-- consistent with this codebase's existing indexing style
-- (idx_jobs_technician_date, migration 0009) and its explicit avoidance
-- of R-tree/geospatial indexing infrastructure until real scale justifies
-- it.
CREATE INDEX IF NOT EXISTS idx_jobs_geocode_status ON jobs(geocode_status);
