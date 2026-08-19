-- Migration number: 0007 	 2026-08-17T21:00:00.000Z
--
-- FSM upgrade, Phase 5 (Financials & Invoicing):
--
--   * invoices/invoice_lines are REBUILT (SQLite has no ALTER COLUMN TYPE) to
--     replace every REAL dollar column with an INTEGER *_cents column —
--     floating-point dollars invite silent rounding drift on money, integer
--     minor units don't. Existing dollar values are rescaled losslessly
--     (existing data is always at most 2 decimal places, so *100 is exact).
--     `status` is remapped from the old freeform vocabulary to the new
--     server-authoritative lifecycle: sent/overdue -> issued ("overdue" is now
--     a computed display property — due_date in the past with a balance still
--     owing — not a stored status, so it can never silently go stale),
--     cancelled -> void, paid/draft unchanged. `paid_date` is dropped: "paid"
--     is now derived from the payments table (SUM(amount_cents) >= total_cents),
--     never a separately-settable field that could drift from actual payments.
--   * rebate_amount_cents is new (0 for every existing invoice — none of them
--     were CleanBC/BC Hydro rebate invoices before this phase). customer_amount
--     and balance are deliberately NOT stored columns — see src/server/financial.ts,
--     they're computed from total_cents/rebate_amount_cents/payments on every
--     read, per the standing rule against independently-mutable derived money.
--   * A partial UNIQUE index (job_id, excluding void invoices) is the actual
--     concurrency guard for "one invoice per job" — a database constraint, not
--     just an application check — while still allowing a fresh invoice to be
--     issued after a previous one for the same job was voided.
--   * New `payments` table: multiple payments per invoice, multiple payer
--     types (customer/government/third_party, plain TEXT so a new payer type
--     never needs a schema change), multiple payment methods. amount_cents has
--     a CHECK > 0 — no zero/negative payments at the database level, not just
--     in application code. Payments are soft-voided (voided_at), never hard
--     deleted, so a voided payment still fully explains a balance's history.
--   * New `invoice_audit`: one domain-specific audit table covering both
--     invoice-level and payment-level events (event_type discriminator) —
--     extends the existing per-domain pattern (job_status_history,
--     job_rebate_audit, job_compliance_audit) rather than introducing a
--     generic audit system; this domain's financial events are cohesive
--     enough to share one table exactly like Phase 4's compliance events did.

CREATE TABLE invoices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount_cents INTEGER NOT NULL DEFAULT 0,
  rebate_amount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  issued_at TEXT,
  voided_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO invoices_new (
  id, identifier, customer_id, job_id, status,
  subtotal_cents, tax_rate, tax_amount_cents, rebate_amount_cents, total_cents,
  notes, due_date, issued_at, voided_at, void_reason, created_at, updated_at
)
SELECT
  id, identifier, customer_id, job_id,
  CASE status
    WHEN 'sent' THEN 'issued'
    WHEN 'overdue' THEN 'issued'
    WHEN 'cancelled' THEN 'void'
    WHEN 'paid' THEN 'paid'
    ELSE 'draft'
  END,
  CAST(ROUND(COALESCE(subtotal, 0) * 100) AS INTEGER),
  COALESCE(tax_rate, 0),
  CAST(ROUND(COALESCE(tax_amount, 0) * 100) AS INTEGER),
  0,
  CAST(ROUND(COALESCE(total, 0) * 100) AS INTEGER),
  COALESCE(notes, ''),
  COALESCE(due_date, ''),
  CASE WHEN status IN ('sent', 'paid', 'overdue') THEN COALESCE(created_at, datetime('now')) ELSE NULL END,
  CASE WHEN status = 'cancelled' THEN COALESCE(updated_at, datetime('now')) ELSE NULL END,
  CASE WHEN status = 'cancelled' THEN 'Migrated from legacy cancelled status' ELSE '' END,
  COALESCE(created_at, datetime('now')),
  COALESCE(updated_at, datetime('now'))
FROM invoices;

CREATE TABLE invoice_lines_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices_new(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0
);

INSERT INTO invoice_lines_new (id, invoice_id, description, quantity, unit_price_cents, total_cents)
SELECT
  id, invoice_id, description, COALESCE(quantity, 1),
  CAST(ROUND(COALESCE(unit_price, 0) * 100) AS INTEGER),
  CAST(ROUND(COALESCE(total, 0) * 100) AS INTEGER)
FROM invoice_lines;

DROP TABLE invoice_lines;
DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;
ALTER TABLE invoice_lines_new RENAME TO invoice_lines;

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_job_active ON invoices(job_id) WHERE job_id IS NOT NULL AND status != 'void';
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payer_type TEXT NOT NULL DEFAULT 'customer',
  method TEXT NOT NULL DEFAULT 'other',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoice_audit_invoice ON invoice_audit(invoice_id, created_at);
