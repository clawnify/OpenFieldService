-- Migration number: 0029 	 2026-08-28T18:00:00.000Z
--
-- Phase 19D (Retention / Referral / Loyalty / Follow-up / Seasonal
-- Campaigns): fully additive — no existing table dropped, no existing
-- column removed/retyped. Reuses Phase 9's notification pipeline
-- (notification_outbox/notification_preferences) directly for every
-- outbound send rather than building a parallel delivery system, and
-- reuses Phase 19B's Maintenance Plans for the maintenance-plan offer
-- (no second Plan catalog). See docs/PHASE19D-RETENTION-REFERRAL-
-- LOYALTY-CAMPAIGNS.md for the full architecture rationale.
--
-- What's genuinely new vs. reused:
--   * Consent: EXTENDS the existing notification_preferences table
--     (Phase 9.0) with a separate, default-OFF marketing opt-in per
--     channel — never conflated with the existing transactional
--     email_enabled/sms_enabled toggle. Post-job follow-up/review-
--     request/maintenance-offer sends are treated as service-adjacent
--     (gated by the EXISTING transactional toggle, same precedent as
--     Phase 9's day-before reminder / on-the-way), so no new consent is
--     invented for something already covered. Only genuinely promotional
--     sends (seasonal campaigns, referral-promo content) require the new
--     marketing opt-in.
--   * Sends: every actual outbound message (follow-up, review request,
--     campaign) is enqueued through the EXISTING notification_outbox
--     dedupe_key mechanism — no new delivery/retry/evidence system.
--   * Background execution: reuses the ONE existing Cloudflare cron
--     trigger (Phase 9/19C precedent) — scheduled() gains one more
--     best-effort, non-blocking call, never a second scheduler.
--   * Referral reward AND admin-issued loyalty credit share ONE ledger
--     table (customer_credit_ledger) rather than two near-identical
--     tables — both are "issue an auditable, voidable, non-cash-or-cash
--     credit to a customer" in the same shape; consolidated per
--     CLAUDE.md's Shared Kernel Minimalism (these two concepts are
--     genuinely the same shape, not premature coupling).
--   * Financial posting/redemption against an actual Invoice is
--     explicitly DEFERRED to Phase 21 — this migration only creates the
--     ledger and a manual "mark redeemed" bookkeeping state, never wires
--     into the invoice/payment engine (Section 19's explicit boundary).

-- ── Consent: marketing opt-in extension (additive columns only) ────────

ALTER TABLE notification_preferences ADD COLUMN marketing_email_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_preferences ADD COLUMN marketing_sms_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_preferences ADD COLUMN marketing_email_consent_at TEXT;
ALTER TABLE notification_preferences ADD COLUMN marketing_sms_consent_at TEXT;
ALTER TABLE notification_preferences ADD COLUMN marketing_email_consent_source TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_preferences ADD COLUMN marketing_sms_consent_source TEXT NOT NULL DEFAULT '';
-- Persistent, per-recipient token for the public "unsubscribe from
-- marketing" link embedded in every campaign send (Security/Code review
-- finding: opt-in existed with no reachable opt-out). Deliberately a plain
-- stored token, not a hash — this is a low-stakes convenience action (stop
-- promotional mail), not a financial or consent-granting one, so the same
-- "hash bearer tokens at rest" discipline used for e-sign/follow-up links
-- (which DO gate a financial/legal action) is not warranted here; lazily
-- generated on first campaign send, reused thereafter for a stable link.
ALTER TABLE notification_preferences ADD COLUMN marketing_unsubscribe_token TEXT;
-- Set when a customer uses the public "unsubscribe from marketing" link —
-- a convenience audit signal distinct from opt_in=0 (which doesn't record
-- WHETHER they were ever opted in and explicitly opted out vs. never
-- opted in at all).
ALTER TABLE notification_preferences ADD COLUMN marketing_unsubscribed_at TEXT;

-- ── Post-job follow-up / satisfaction / review-request ──────────────────
-- One row per qualifying Job (UNIQUE(job_id) is the real duplicate-
-- follow-up-prevention guard, same claim-first-INSERT idiom as Phase 19C's
-- maintenance_occurrences). Review-request state lives on the SAME row
-- (1:1 with one follow-up, one customer, one action) rather than a
-- separate table — avoids an unrequested extra abstraction.

CREATE TABLE IF NOT EXISTS customer_follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|responded|satisfied|needs_attention|closed|failed|suppressed
  due_date TEXT NOT NULL,
  sent_at TEXT,
  response TEXT NOT NULL DEFAULT '', -- ''|satisfied|needs_attention
  response_notes TEXT NOT NULL DEFAULT '',
  responded_at TEXT,
  review_status TEXT NOT NULL DEFAULT 'not_eligible', -- not_eligible|eligible|sent|clicked|suppressed|failed
  review_sent_at TEXT,
  review_clicked_at TEXT,
  maintenance_offer_shown INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  token_hash TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_follow_ups_org_status ON customer_follow_ups(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_follow_ups_due ON customer_follow_ups(status, due_date);
CREATE INDEX IF NOT EXISTS idx_customer_follow_ups_customer ON customer_follow_ups(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_follow_ups_token ON customer_follow_ups(token_hash) WHERE token_hash IS NOT NULL;

-- ── Referral program ─────────────────────────────────────────────────
-- One config row per organization — reward TERMS are current-state (not
-- historically versioned like tax_profiles; what actually gets awarded is
-- captured immutably in customer_credit_ledger below, which is what
-- matters for audit).

CREATE TABLE IF NOT EXISTS referral_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  reward_type TEXT NOT NULL DEFAULT 'account_credit', -- account_credit|fixed_reward|service_credit|future_discount|non_cash
  reward_value_cents INTEGER, -- null for non-monetary reward_type
  reward_description TEXT NOT NULL DEFAULT '',
  qualification_rule TEXT NOT NULL DEFAULT 'first_completed_job', -- first_completed_job|first_paid_invoice
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id)
);

-- referrer -> referred attribution. referred_customer_id/referred_lead_id
-- are both nullable but never both-null in application code — a referral
-- row is only created once the referred party is known (at referral-link
-- signup time). Partial unique indexes below are the real self-referral/
-- duplicate-attribution DB-level guard: a given Lead or Customer can only
-- ever be the REFERRED party of exactly one referral, ever.
CREATE TABLE IF NOT EXISTS customer_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  referrer_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  referred_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  referred_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  referral_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|qualified|rewarded|expired|rejected
  qualifying_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  qualifying_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  qualified_at TEXT,
  rejected_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_referrals_org_status ON customer_referrals(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_referrals_referrer ON customer_referrals(referrer_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_referrals_referred_customer ON customer_referrals(referred_customer_id) WHERE referred_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_referrals_referred_lead ON customer_referrals(referred_lead_id) WHERE referred_lead_id IS NOT NULL;

-- ── Unified reward / loyalty credit ledger ──────────────────────────────
-- Serves BOTH referral rewards and admin-issued loyalty credit — same
-- shape (issue/void/redeem, auditable, idempotent). UNIQUE(source_type,
-- source_id) WHERE source_id IS NOT NULL is the REAL idempotency guard
-- for "one qualifying referral must not create the same reward twice"
-- (Section 17) — a claim-first INSERT, same idiom as every other
-- idempotency guard in this codebase (maintenance_occurrences,
-- maintenance_entitlement_events, call_tool_invocations).
CREATE TABLE IF NOT EXISTS customer_credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL, -- referral_reward|loyalty_grant
  source_id INTEGER, -- customer_referrals.id when source_type=referral_reward, NULL for a manual loyalty_grant
  amount_cents INTEGER, -- integer cents, NULL for a non-monetary reward (see value_description)
  value_description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'issued', -- issued|voided|redeemed
  reason TEXT NOT NULL DEFAULT '',
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  redeemed_at TEXT,
  redeemed_reason TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_credit_ledger_org_customer ON customer_credit_ledger(organization_id, customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_credit_ledger_source ON customer_credit_ledger(source_type, source_id) WHERE source_id IS NOT NULL;

-- ── Seasonal / retention campaigns ──────────────────────────────────────
-- Each campaign IS its own content unit (no separate reusable-template
-- library — an unrequested extra abstraction for this phase's scope).
-- Content/audience_filter become immutable at the API layer once status
-- leaves 'draft' — this alone satisfies "later template edits must not
-- rewrite historical send evidence" (Section 28) without a separate
-- snapshot table, since the campaign row itself is the frozen record.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL DEFAULT 'seasonal', -- seasonal|referral_promo|general — informational only
  status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|running|paused|completed|cancelled|failed
  channel TEXT NOT NULL DEFAULT 'email', -- email|sms|both
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  cta_link TEXT NOT NULL DEFAULT '',
  audience_filter TEXT NOT NULL DEFAULT '{}', -- JSON, deterministic filter — never raw SQL
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_org_status ON campaigns(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_due ON campaigns(status, scheduled_for);

-- Audience-membership + eligibility-decision ledger, built once per
-- campaign run. UNIQUE(campaign_id, customer_id) is the audience-
-- processing idempotency guard (re-running the worker for the same
-- campaign can't double-process a recipient). The actual send/delivery
-- lifecycle lives in notification_outbox (notification_outbox_id links
-- back) — reused, not duplicated; that table's own dedupe_key is what
-- prevents the same customer/channel being sent to twice (Section 32).
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed|suppressed
  notification_outbox_id INTEGER REFERENCES notification_outbox(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  failed_at TEXT,
  suppressed_at TEXT,
  UNIQUE(campaign_id, customer_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id, status);

-- ── Automation execution ledger ──────────────────────────────────────────
-- Mirrors maintenance_automation_runs (Phase 19C) exactly — only written
-- when a run did something meaningful, same anti-noise-floor rationale.
CREATE TABLE IF NOT EXISTS retention_automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  run_type TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'cron',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  organizations_scanned INTEGER NOT NULL DEFAULT 0,
  follow_ups_created INTEGER NOT NULL DEFAULT 0,
  review_requests_sent INTEGER NOT NULL DEFAULT 0,
  referrals_qualified INTEGER NOT NULL DEFAULT 0,
  rewards_issued INTEGER NOT NULL DEFAULT 0,
  campaign_recipients_queued INTEGER NOT NULL DEFAULT 0,
  campaign_sends INTEGER NOT NULL DEFAULT 0,
  errored_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retention_automation_runs_org ON retention_automation_runs(organization_id, created_at);

-- ── Audit trail ──────────────────────────────────────────────────────────
-- Polymorphic entity_type/entity_id, same established shape as
-- maintenance_admin_audit/phone_operations_audit — a new table because
-- this is a genuinely new domain, not a forced reuse of an unrelated one.
CREATE TABLE IF NOT EXISTS retention_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL DEFAULT 1,
  entity_type TEXT NOT NULL, -- preference|follow_up|referral|reward|loyalty_credit|campaign
  entity_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retention_audit_entity ON retention_audit(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_retention_audit_org ON retention_audit(organization_id, created_at);
