-- Migration number: 0010 	 2026-08-18T16:51:12.000Z
--
-- Phase 8.0 — Lead Management data model. Approved business decisions (see
-- mem:backlog/p1-lead-management-pipeline for the full record) drove every
-- deviation from the earlier architecture-audit draft:
--
-- * Lead and Customer are deliberately SEPARATE tables — a Lead is a
--   pre-sale intake/qualification record, not a Customer with a status
--   flag. `leads.converted_customer_id` is the ONE link between them
--   (Lead → Customer), never the other way — a Customer can accumulate
--   many Leads over time with zero schema change on the Customer side.
-- * NO Customer financial/rebate-profile fields were copied onto `leads`
--   (house_size / primary_heating_source / number_of_adults /
--   number_of_children / household_income) — an earlier draft of this
--   design included them for pre-qualification convenience, but the
--   approved decisions explicitly rule this out ("do not copy Customer
--   financial fields into Lead unnecessarily" + "Lead program interest is
--   NOT rebate eligibility"). `program_interest` is a plain nullable
--   string (mirrors jobs.job_type's own un-enforced-at-the-DB-level
--   convention — no CHECK constraint, no FK, validated at the app layer
--   like every other status/type field in this schema) with zero coupling
--   to `src/server/rebate.ts` or any eligibility threshold.
-- * `status` has NO terminal state at the schema level — "lost" is
--   explicitly REOPENABLE per the approved decisions (unlike Jobs, where
--   only `cancelled` reopens and `completed`/`invoiced` are truly
--   terminal). The lifecycle itself (new/contacted/qualified/estimate/
--   won/lost) and its transition legality are enforced entirely in
--   application code (a future `lead-workflow.ts`, Phase 8.1+), exactly
--   how `jobs.status` has no CHECK constraint either — `workflow.ts` is
--   the sole authority there, and the same split applies here.
-- * `lost_reason` is a free string resolved against a NEW Global Settings
--   catalog (`LEAD_LOST_REASON_OPTIONS`) — the exact same mechanism as
--   the existing `REFERRAL_SOURCE_OPTIONS`/`HEATING_SOURCE_OPTIONS`
--   catalogs from migration 0004, not a hardcoded enum, not a new
--   settings mechanism. `lost_reason_note` is free text, meaningful only
--   when `lost_reason = 'Other'` (same conditional-field precedent as
--   `customers.referral_name`, migration 0008).
-- * `referral_source`/`referral_name`/`referred_by_customer_id` mirror
--   `customers`' own referral-attribution columns field-for-field (same
--   conditional validity rules: referral_name only when
--   referral_source='Referral', referred_by_customer_id only when
--   referral_source='Existing Customer') — a Lead's referral attribution
--   is independent of, and copied FORWARD to, a Customer's at conversion
--   time (a data-flow rule in the future conversion handler, not a shared
--   column or a live reference), which is what keeps historical
--   attribution correct even if the Lead's referring customer or the
--   Lead's own resulting Customer are edited later.
-- * `estimated_value_cents` is INTEGER cents (the standing monetary-
--   representation rule) and purely informational — nothing here writes
--   to `jobs.price` or any `invoices`/`invoice_lines`/`payments` table;
--   the financial architecture from Phase 5 is completely untouched.
-- * `lead_status_history` mirrors `job_status_history` (migration 0003)
--   field-for-field — a domain-specific append-only audit table, not a
--   new generic system-wide audit mechanism (this project already has 5
--   of these; this is the 6th, same shape, same reasoning re-affirmed
--   each time). It is what makes "lost" being reopenable safe: every
--   transition (including into and back out of "lost") is preserved here
--   forever, so a later reopen can never destroy why (and when, and by
--   whom) a Lead was previously marked lost — `reason` on the "→ lost"
--   row is where that point-in-time lost_reason/lost_reason_note context
--   is expected to be captured by the future transition handler, exactly
--   how `job_status_history.reason` already captures point-in-time
--   context for job transitions.
-- * No `lead_notes` table in this migration — out of the approved Phase
--   8.0 scope (which names only `leads`/`lead_status_history`); a single
--   `notes` column on `leads` itself (matching `customers.notes`/
--   `jobs.notes`'s existing plain-field precedent) is sufficient for the
--   data-model foundation. A multi-entry `lead_notes` table (mirroring
--   `job_notes`) can be added later, non-breaking, if the UI phase proves
--   it's actually wanted.
-- * No unique constraint on phone/email — duplicate Leads are a
--   legitimate business scenario (repeat inquiries, shared household
--   phones, re-referrals), not a data-integrity violation; deduplication
--   is a future UI-level warning, never a DB-level block.
-- * No soft-delete column — deletion is ADMIN-ONLY (app-layer RBAC,
--   Phase 8.2, not a DB concern) and no concrete need for preserving a
--   deleted Lead's row has been demonstrated (its own status history
--   cascades away with it, same as a deleted Job's history does — no
--   precedent in this codebase soft-deletes a primary record for an
--   audit-preservation reason; only compliance PHOTOS are soft-deleted,
--   for evidence-integrity reasons that don't apply here).
-- * Conversion idempotency/concurrency (approved decision 8) is an
--   APPLICATION-layer guarantee (a conditional `UPDATE ... WHERE status
--   != 'won'` inside one atomic db.batch(), mirroring transitionJob()'s
--   precedent) — this migration only needs to provide the `status` and
--   `converted_customer_id` columns for that future logic to operate on;
--   no schema-level uniqueness or trigger is required or added.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,                -- "LEAD-{n}", same _meta counter/prefix pattern as JOB-/INV-

  -- Identity / contact
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',

  -- Pipeline (app-enforced, see note above — no CHECK constraint, matches jobs.status)
  status TEXT NOT NULL DEFAULT 'new',

  -- Ownership — existing User model only, no new role, no Salesperson entity.
  -- Restricting this to admin/dispatcher users specifically is an
  -- application-layer check (Phase 8.2, mirrors validateTechnicianUserId()'s
  -- precedent) — deliberately not enforceable as a DB constraint, and
  -- deliberately extensible: nothing here prevents a future dedicated
  -- Salesperson concept from being layered on top without a redesign.
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Referral attribution — mirrors customers.referral_source/referral_name/
  -- referred_by_customer_id exactly (migration 0008); copied FORWARD onto
  -- the resulting Customer at conversion, never a live/shared reference.
  referral_source TEXT NOT NULL DEFAULT '',
  referral_name TEXT NOT NULL DEFAULT '',
  referred_by_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,

  -- Program interest — plain nullable string, NOT rebate eligibility, NOT
  -- coupled to src/server/rebate.ts or any Global Settings threshold.
  program_interest TEXT,

  -- Estimate — informational only, integer cents, never written to
  -- jobs.price or any invoice/payment table.
  estimated_value_cents INTEGER,
  estimate_notes TEXT NOT NULL DEFAULT '',

  -- Lost — resolved against the new LEAD_LOST_REASON_OPTIONS Global
  -- Settings catalog (see below), never hardcoded. lost_reason_note is
  -- free text, meaningful only when lost_reason = 'Other'. Reopening a
  -- lost Lead does not clear these columns retroactively for past
  -- history (lead_status_history preserves the point-in-time record);
  -- they simply describe the Lead's current/most-recent lost episode.
  lost_reason TEXT NOT NULL DEFAULT '',
  lost_reason_note TEXT NOT NULL DEFAULT '',

  -- Conversion — Lead → Customer only, never Lead → Job directly.
  -- ON DELETE SET NULL: deleting the resulting Customer must never erase
  -- the fact that this Lead existed, was won, and converted — only the
  -- now-dangling pointer clears (identical reasoning to
  -- customers.referred_by_customer_id, migration 0008).
  converted_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  converted_at TEXT,
  converted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,

  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit trail — mirrors job_status_history (migration 0003)
-- field-for-field. old_status is nullable (the initial "created" row has
-- no prior status, same as a job's creation-time history row).
CREATE TABLE IF NOT EXISTS lead_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_user ON leads(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_converted_customer ON leads(converted_customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_referred_by ON leads(referred_by_customer_id);
CREATE INDEX IF NOT EXISTS idx_lead_status_history_lead ON lead_status_history(lead_id, created_at);

-- Same _meta counter/prefix pattern as job_counter/identifier_prefix and
-- invoice_counter/invoice_prefix (migration 0001).
INSERT OR IGNORE INTO _meta (key, value) VALUES ('lead_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('lead_prefix', 'LEAD');

-- Business-configurable lost-reason catalog — same mechanism as
-- REFERRAL_SOURCE_OPTIONS/HEATING_SOURCE_OPTIONS (migration 0004): an
-- ordinary global_settings row, category='reference_data', a fixed past
-- effective_from timestamp (not datetime('now'), which uses a different
-- string format than this app's own ISO comparisons — see
-- src/server/settings.ts and mem:phase1/global-settings). Values are the
-- exact approved business list; "Other" pairs with leads.lost_reason_note.
INSERT OR IGNORE INTO global_settings (key, value, data_type, category, description, effective_from, updated_by)
VALUES (
  'LEAD_LOST_REASON_OPTIONS',
  '["Price Too High","Chose Competitor","Not Ready","Unreachable","Outside Service Area","Not Eligible","Duplicate Lead","No Longer Needed","Other"]',
  'json', 'reference_data', 'Dropdown options for why a Lead was marked lost', '2020-01-01T00:00:00.000Z', 1
);
