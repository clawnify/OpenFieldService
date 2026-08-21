-- Migration number: 0014 	 2026-08-21T00:00:00.000Z
--
-- Phase 11.3 (Rebate / Regional Program Extraction): moves the 5 HVAC-rebate
-- columns that have lived directly on the generic `customers` table since
-- Phase 3 (migration 0004) into a dedicated 1:1 table owned by the BC
-- program module (src/server/modules/programs/bc/customer-profile.ts).
--
-- Additive and backward-safe, per the project's standing migration-safety
-- rules:
--   * The 5 legacy `customers` columns (house_size, primary_heating_source,
--     number_of_adults, number_of_children, household_income) are NOT
--     dropped or renamed here — they remain on `customers`, frozen at
--     whatever value they held at migration time. Application code no
--     longer writes to them after this migration; they exist purely as a
--     rollback/compatibility safety net. Removing them is an explicit
--     future decision, not made in this phase.
--   * `bc_rebate_customer_profiles` becomes the sole authoritative store
--     going forward (see customer-profile.ts). It is OPTIONAL per customer
--     — matching the original Phase 3 design intent ("do not assume these
--     fields apply to every customer"): a customer with no rebate-track
--     data on file simply has no row here, exactly as it previously had
--     all-blank/all-null column values.
--   * `customer_id` is the table's own PRIMARY KEY (not a separate
--     surrogate id) — the simplest possible way to make "at most one
--     profile row per customer" a structural guarantee rather than an
--     application-level check.
--   * The backfill below is a genuine one-time, non-idempotent data
--     transform (copies existing customer rows into the new table) — per
--     this project's own established convention (see
--     mem:architecture/data-model "Test harness gotcha #2"), it uses a
--     plain `INSERT INTO ... SELECT`, never `INSERT OR IGNORE`, so the
--     test harness's per-test reseed (which replays only `INSERT OR
--     IGNORE` statements) never re-runs it. Only customers that actually
--     have non-default rebate data are backfilled, matching the
--     "optional per customer" design above — a plain STANDARD customer
--     never gets a row.

CREATE TABLE IF NOT EXISTS bc_rebate_customer_profiles (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  house_size INTEGER,
  primary_heating_source TEXT NOT NULL DEFAULT '',
  number_of_adults INTEGER,
  number_of_children INTEGER,
  household_income REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bc_rebate_customer_profiles
  (customer_id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income, created_at, updated_at)
SELECT id, house_size, primary_heating_source, number_of_adults, number_of_children, household_income, created_at, updated_at
FROM customers
WHERE house_size IS NOT NULL
   OR primary_heating_source != ''
   OR number_of_adults IS NOT NULL
   OR number_of_children IS NOT NULL
   OR household_income IS NOT NULL;
