-- Migration number: 0011 	 2026-08-18T20:00:00.000Z
--
-- Phase 9.0 — Notifications data model ONLY. No NotificationService, no
-- provider adapter, no Cron Trigger, no real Email/SMS delivery, no
-- provider secrets — see mem:phase9/notifications-architecture-audit for
-- the full architecture this schema implements the foundation of, and
-- mem:project/fsm-upgrade-plan for the 5 approved Phase 9 decisions this
-- migration encodes (email-on-by-default, SMS-opt-in-required, recipient
-- snapshotted at enqueue time, dedicated delivery-attempt history instead
-- of relying only on mutable outbox fields, no real provider yet).
--
-- Three new tables:
--
-- * `notification_outbox` — the 7th domain-specific audit-adjacent table
--   in this codebase (after job_status_history/job_rebate_audit/
--   job_compliance_audit/invoice_audit/job_schedule_history/
--   lead_status_history), not a new generic system-wide event bus. Unlike
--   those 6, an outbox row's own lifecycle (pending -> sending ->
--   sent/failed/cancelled) mostly *is* the write-once audit trail for that
--   one notification — deeper per-attempt detail lives in
--   notification_delivery_attempts (see below), not in this table's own
--   mutable fields.
-- * `notification_preferences` — recipient-level (Customer OR Lead, never
--   both) channel opt-in/opt-out with consent metadata. Deliberately NOT a
--   broad polymorphic "any entity" preferences table — only Customer and
--   Lead are actual notification recipients today; extending this to a
--   third recipient type later is a new migration, not a design flaw here.
-- * `notification_delivery_attempts` — append-only, one row per actual
--   provider call attempt. `notification_outbox.attempts`/`last_error`
--   remain as a cheap current-state summary (mirrors how job status
--   itself is a summary while job_status_history is the full record), but
--   "how many times, when, what failed, which attempt actually succeeded"
--   needs its own real history, not just the last error string.
--
-- entity_type/entity_id (notification_outbox), not 5 nullable FK columns:
-- notifications may eventually reference a job, a lead, an invoice, a
-- payment, or a rebate event — every OTHER audit table in this codebase
-- instead uses one direct FK to exactly one fixed parent table
-- (job_status_history.job_id, lead_status_history.lead_id,
-- invoice_audit.invoice_id), which doesn't fit here: that would mean a
-- new nullable FK column (and a new CHECK enforcing "exactly one is set")
-- every time a new triggerable entity type is added. entity_type+entity_id
-- is a deliberate, narrow exception to that precedent for exactly this
-- reason — not casually reintroducing a "generic polymorphic" pattern this
-- project has otherwise consistently avoided. The tradeoff: no DB-level
-- referential integrity between (entity_type, entity_id) and the real row
-- it names — that check is an application-layer responsibility for
-- whichever future phase actually enqueues notifications, same as how
-- `leads.program_interest`/`jobs.job_type` are already app-validated
-- strings with no DB CHECK (migration 0010's own precedent for "a status/
-- type field can be app-enforced without a DB constraint" applies again
-- here, for the same class of reason: the valid entity_type vocabulary
-- will grow over time and doesn't need a migration each time it does).
--
-- No CHECK constraint on notification_outbox.status/channel or
-- notification_delivery_attempts.status, matching the established
-- "status/type fields are app-enforced, not DB-enforced" precedent
-- (jobs.status, leads.status, invoices.status — none of them have a DB
-- CHECK either). The one CHECK in this migration
-- (notification_preferences: exactly one of customer_id/lead_id) is a
-- structural invariant, not a business-status vocabulary, matching how
-- `payments.amount_cents CHECK (amount_cents > 0)` (migration 0007) is
-- also a structural invariant, not a status field.

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,           -- e.g. 'job.scheduled', 'invoice.issued' — app-enforced vocabulary, no DB CHECK
  entity_type TEXT NOT NULL,          -- e.g. 'job' | 'lead' | 'invoice' | 'payment' — see module comment above
  entity_id INTEGER NOT NULL,
  channel TEXT NOT NULL,              -- 'email' | 'sms' — app-enforced, no DB CHECK
  recipient TEXT NOT NULL,            -- the resolved email/phone, SNAPSHOTTED at enqueue time (never re-resolved later)
  template_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', -- minimal rendered-template context only — never a dump of the full Customer/Lead/Job/Invoice row
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | cancelled — app-enforced, no DB CHECK
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,    -- the actual duplicate-send guard, see module comment above
                                       -- enqueue must be INSERT ... ON CONFLICT(dedupe_key) DO NOTHING, never SELECT-then-INSERT
  scheduled_for TEXT NOT NULL DEFAULT (datetime('now')), -- now for immediate sends, future for reminders (Phase 9.2's Cron dispatcher scans this)
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_scheduled ON notification_outbox(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_entity ON notification_outbox(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_created ON notification_outbox(created_at);

-- Append-only — one row per actual attempted provider call. Never updated
-- after insert (a "completed_at" is set once, at insert-adjacent time, not
-- edited later); the append-only-ness is what lets this answer "how many
-- times, when, what failed, which attempt succeeded" without any row ever
-- needing to be mutated after the fact, mirroring the write-once
-- philosophy every other *_history/*_audit table in this codebase already
-- follows.
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,               -- started | succeeded | failed — app-enforced, no DB CHECK
  provider_message_id TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification ON notification_delivery_attempts(notification_id, attempt_number);

-- ON DELETE CASCADE: a delivery attempt has no standalone meaning once its
-- outbox row is gone — same composition/ownership reasoning as job_notes/
-- job_checklist/invoice_lines/payments/lead_status_history all cascading
-- from their owning row. No delete API exists for notification_outbox in
-- this phase (or any phase planned so far — notifications are expected to
-- be retained, not deleted), so this only matters if that ever changes.

-- Recipient-level channel preferences. Exactly one of customer_id/lead_id
-- must be set — enforced by a real CHECK, not just an application
-- convention (same "structural invariant, not a status field" reasoning
-- as payments.amount_cents's own CHECK, migration 0007). The two partial
-- UNIQUE indexes below (not a single UNIQUE(customer_id, lead_id), which
-- wouldn't actually prevent two separate rows each having exactly one of
-- the two set to the same value) are what actually prevent a recipient
-- from ever accidentally getting two competing preference rows.
--
-- email_enabled default 1 (on by default) / sms_enabled default 0
-- (opt-in only) are the two approved Phase 9 decisions this column pair
-- encodes directly — see mem:project/fsm-upgrade-plan. Consent metadata
-- (email_consent_at/sms_consent_at/email_consent_source/sms_consent_source)
-- is plain nullable-timestamp + free-text-source, not a hardcoded source
-- catalog (no CHECK/no Global Settings catalog for "source" — the set of
-- valid sources isn't an approved business decision yet, and inventing one
-- here would be exactly the "do not implement legal/compliance logic in
-- SQL" this phase was told not to do).
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  email_consent_at TEXT,
  sms_consent_at TEXT,
  email_consent_source TEXT NOT NULL DEFAULT '',
  sms_consent_source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (customer_id IS NOT NULL AND lead_id IS NULL)
    OR
    (customer_id IS NULL AND lead_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_customer ON notification_preferences(customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_lead ON notification_preferences(lead_id) WHERE lead_id IS NOT NULL;

-- ON DELETE CASCADE on both customer_id and lead_id: a preference row has
-- no standalone meaning once its recipient is gone — same reasoning as the
-- delivery-attempts cascade above, and consistent with how this schema
-- already treats "child row describing a parent" relationships throughout
-- (never SET NULL for a genuine ownership/composition relationship, only
-- for loose attribution references like leads.referred_by_customer_id).
