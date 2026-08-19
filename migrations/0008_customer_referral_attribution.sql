-- Migration number: 0008 	 2026-08-17T22:00:00.000Z
--
-- Customer referral attribution: distinguishes a free-text "who/what
-- referred this customer" (referral_name, only meaningful when
-- referral_source = 'Referral') from an actual link to an EXISTING
-- customer record (referred_by_customer_id, only meaningful when
-- referral_source = 'Existing Customer') — a self-referencing foreign key,
-- not a second free-text name field, so "Customer B referred Customer A" is
-- a real, query-able relationship rather than a typed name that can typo or
-- drift from the actual customer record it's supposed to mean. See
-- src/server/customers.ts for the validation that enforces exactly one of
-- these two fields is populated, and only when the matching referral_source
-- is selected.
--
-- ON DELETE SET NULL (deliberately NOT CASCADE, unlike jobs.customer_id /
-- invoices.customer_id's ownership-style cascade from migrations/0001):
-- referred_by_customer_id is a loose attribution reference, not composition
-- — deleting the referring customer must never delete the customer they
-- referred. Same SET NULL precedent already used for non-ownership
-- references elsewhere in this schema: technicians.user_id (migrations/0002),
-- job_media.uploaded_by (migrations/0006), payments.recorded_by
-- (migrations/0007).
--
-- Both columns are nullable / default-empty so every existing customer row
-- survives untouched — no historical referral data is fabricated.

ALTER TABLE customers ADD COLUMN referral_name TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN referred_by_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_referred_by ON customers(referred_by_customer_id);
