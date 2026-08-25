-- Migration number: 0019 	 2026-08-24T00:00:00.000Z
--
-- Phase 13A hardening (Company Profile): a tenant-specific business-identity
-- record — the canonical source for the customer-facing company name,
-- contact/address, business/tax identifiers, and a default Contract footer
-- used by generated documents (currently: the Contracts/E-Sign signed PDF).
--
-- Persistence model decision: NOT a `global_settings` key. That table's
-- entire design (one effective-dated VERSION per key, never mutated in
-- place — see migrations/0002 and src/server/settings.ts) exists to answer
-- "what threshold applied to a job evaluated last month," a historical
-- point-in-time resolution problem specific to government-rebate-program
-- rules. Company identity fields (name/phone/address/etc.) are current-state
-- data with no such requirement — forcing ~14 cohesive profile fields into
-- 14 independently-versioned global_settings keys would mean 14 pointless
-- per-field history modals and either 14 sequential publish calls or a new
-- bulk-publish endpoint just to save one form. A dedicated table with plain
-- typed columns and ordinary UPDATE semantics is the right fit — see
-- src/server/company-profile.ts and docs/PLATFORM-GENERALIZATION-AUDIT.md's
-- "§22 Addendum — Phase 13A Company Profile" for the full rationale.
--
-- Tenant ownership: one profile row per organization (organization_id
-- UNIQUE). DIRECT_TENANT_COLUMN per the Phase 11.5 taxonomy — application-
-- enforced only (every read/write path derives organization_id from the
-- authenticated actor's session, never client input), consistent with
-- every other tenant-owned table this codebase already has. Unlike
-- migration 0015's ALTER-TABLE columns, this is a fresh CREATE TABLE, so a
-- real `REFERENCES organizations(id)` foreign key is used here (D1's
-- "Cannot add a REFERENCES column with non-NULL default value" restriction
-- only applies to ALTER TABLE ADD COLUMN, not CREATE TABLE — confirmed by
-- migrations/0016-0018's own CREATE TABLE statements already doing this).
--
-- Business Number vs. Tax Number: modeled as two separate, both-optional
-- fields rather than collapsed into one, since they are related but
-- distinct concepts even in this app's current BC/Canada context (a CRA
-- Business Number vs. a GST/HST registration number, which is often but not
-- always the Business Number plus a program-account suffix like "RT0001")
-- — collapsing them would either lose the distinction for tenants that do
-- track both, or silently assume a suffix convention that doesn't
-- generalize. The client UI's help text explains the relationship; the
-- schema does not encode or require it.
--
-- Logo: honestly deferred this pass — see the addendum. `logo_key` exists
-- now (nullable, an R2 object key exactly like storage.ts's existing media
-- convention) so a future upload feature is purely additive with zero
-- schema change, but no upload UI or PDF logo-rendering ships this pass.
--
-- No historical/versioning semantics of any kind: a profile edit is a
-- plain UPDATE. The immutability guarantee this feature actually needs
-- lives entirely in application code — Contract creation snapshots the
-- CURRENT profile into the already-existing, already-immutable
-- `contract_versions.company_snapshot` JSON column (Phase 13's own
-- snapshot mechanism, unchanged by this migration) at contract-creation
-- time, so a later profile edit can never alter an already-signed PDF.

CREATE TABLE IF NOT EXISTS organization_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL DEFAULT '',
  legal_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  address_line1 TEXT NOT NULL DEFAULT '',
  address_line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  business_number TEXT NOT NULL DEFAULT '',
  tax_number TEXT NOT NULL DEFAULT '',
  contract_footer TEXT NOT NULL DEFAULT '',
  logo_key TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_profiles_org ON organization_profiles(organization_id);
