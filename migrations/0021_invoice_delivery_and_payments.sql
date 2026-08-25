-- Migration number: 0021 	 2026-08-25T00:00:00.000Z
--
-- Phase 13B — Invoice Delivery + Online Payment + Manual Payment + Receipts.
--
-- Two changes, both additive:
--
-- 1. `payment_sessions` (new table) — a pre-payment intent for the online
--    payment flow (Section 11/12/13 of the spec): created when an office
--    user generates a "Pay Online" link, or when the public link is first
--    opened. Deliberately SEPARATE from `payments` — a session can expire/
--    fail/be cancelled and never produce a payment at all, so conflating
--    the two would mean either fabricating a payment row for money that
--    was never received, or adding a bunch of session-only nullable columns
--    onto the payments table for a concept (intent) that isn't a payment.
--    `token_hash` follows the exact same discipline as
--    `contract_signature_requests.token_hash` (contracts.ts's
--    generateSigningToken/hashSigningToken) — 256 bits of randomness,
--    returned to the caller exactly once, only the SHA-256 hash is ever
--    persisted. `provider_session_id` is the id the provider (real or
--    mock) returns from creating the session; `provider_transaction_id`
--    is set separately, only once a payment actually succeeds — a real
--    provider's own charge/transaction id isn't known until confirmation,
--    and a session can fail/expire/cancel with no transaction ever
--    existing. `amount_cents` is captured at session-creation time from
--    the server-authoritative invoice balance (Section 13) — never trusts
--    a client-supplied amount at confirmation time. The actual webhook
--    replay guard is the atomic pending->succeeded UPDATE...RETURNING
--    claim on `provider_session_id` in financial.ts#processPaymentWebhookEvent
--    (sufficient on its own). `idempotency_key` (UNIQUE-constrained) is
--    reserved for a future real provider that requires one be supplied to
--    its own idempotent-request API — not currently read back anywhere.
--
-- 2. `payments` gains three nullable/defaulted columns (Section 16):
--    `source` (manual|online_provider — plain TEXT, no DB CHECK, same
--    "a new value never needs a schema change" precedent as
--    payer_type/method), `received_by` (free-text — who physically took
--    the payment; distinct from the existing `recorded_by` FK, which is
--    who is logged into OFS entering it, and may be a different person
--    for an on-site cash/cheque payment relayed to the office later),
--    and `payment_session_id` (nullable FK -> payment_sessions, SET NULL,
--    populated only for source='online_provider' rows — traces a recorded
--    payment back to the session that produced it). All three are
--    additive `ALTER TABLE ADD COLUMN`s with nullable/default values, no
--    `NOT NULL` + non-default combination, so none of migration 0015's
--    documented D1 ALTER-TABLE restrictions apply — the same pattern
--    migration 0020's `signature_image_key` already used successfully.
--
-- No `receipts` table. A Receipt is a live-rendered view of one immutable
-- `payments` row (see src/server/receipt-pdf.ts's own header comment for
-- the full rationale) — the same "no snapshot needed" decision this
-- codebase already made for the Invoice PDF, not a new concept requiring
-- new storage.

CREATE TABLE IF NOT EXISTS payment_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  provider_transaction_id TEXT,
  idempotency_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_invoice ON payment_sessions(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_token_hash ON payment_sessions(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_idempotency_key ON payment_sessions(idempotency_key);

ALTER TABLE payments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE payments ADD COLUMN received_by TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN payment_session_id INTEGER REFERENCES payment_sessions(id) ON DELETE SET NULL;
