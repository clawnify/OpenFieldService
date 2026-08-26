import { get, query, run } from "./db.js";
import { getSettingValue } from "./settings.js";
import type { Role } from "./auth.js";
import type { JobType } from "./workflow.js";
import { getCompanyProfile, getCompanyLogo } from "./company-profile.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import { renderReceiptPdf } from "./receipt-pdf.js";
import type { StorageEnv } from "./storage.js";
import type { PaymentProvider } from "./payment-provider.js";
import { signMockWebhookPayload } from "./payment-provider.js";
import { resolveTaxProfile, calculateTaxes, createTaxSnapshot, getTaxSnapshot, type TaxProfile, type TaxComponentResult } from "./tax-jurisdiction.js";

/**
 * Phase 5 — Financials & Invoicing. All money is integer cents (never a REAL/
 * float dollar value) — see migrations/0007_financial_invoicing.sql for the
 * rationale and the one-time rescale of pre-existing invoice data.
 *
 * Derived money (customer_amount_cents, amount_paid_cents, balance_cents) is
 * NEVER a stored column — it's computed from total_cents/rebate_amount_cents/
 * payments on every read (getInvoiceFinancials), so it can never drift out of
 * sync with its inputs. The one exception is `invoices.status`, which IS
 * stored — but it's only ever written by this module's own functions
 * (issueInvoice/voidInvoice/recordPayment/voidPayment), recomputed from the
 * payment totals, never independently settable by a raw field edit (see
 * index.ts's updateInvoice route, which excludes status entirely).
 */

export interface Actor {
  id: number;
  role: Role;
}

export const PAYER_TYPES = ["customer", "government", "third_party"] as const;
export type PayerType = typeof PAYER_TYPES[number];

// Phase 13B (Section 15): "bank_transfer" added — a genuinely distinct
// concept in Canadian usage from "e_transfer" (Interac email transfer,
// already supported) — a wire/EFT bank transfer. Every pre-existing value
// is left exactly as-is (stable IDs — see CLAUDE.md's "Stable IDs and
// Compatibility"): "Card Terminal/POS" from the task's suggested list is
// already covered, with finer granularity, by the existing credit_card/
// debit_card values, so no new value was needed for that one.
export const PAYMENT_METHODS = ["cash", "check", "credit_card", "debit_card", "e_transfer", "bank_transfer", "financing", "other"] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

// Phase 13B (Section 16): distinguishes how a payment reached OFS. A new
// value never needs a schema change (see payer_type's own precedent
// above) — plain TEXT, no DB CHECK.
export const PAYMENT_SOURCES = ["manual", "online_provider"] as const;
export type PaymentSource = typeof PAYMENT_SOURCES[number];

export const PAYMENT_SESSION_STATUSES = ["pending", "succeeded", "failed", "cancelled", "expired"] as const;
export type PaymentSessionStatus = typeof PAYMENT_SESSION_STATUSES[number];

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void";

export class FinancialError extends Error {
  code: "not_found" | "invalid_state" | "invalid_amount" | "forbidden";
  constructor(code: FinancialError["code"], message: string) {
    super(message);
    this.name = "FinancialError";
    this.code = code;
  }
}

/** Every financial route/action in Phase 5 is admin/dispatcher only —
 *  technicians have no financial surface at all (list, detail, create, edit,
 *  void, payments), per the explicit RBAC requirement. There is currently no
 *  operational reason for a technician to see pricing/rebate/payment data
 *  through the invoicing system specifically (they already see job.price on
 *  the job itself, which is a separate, pre-existing, unrelated field). */
export function canManageFinancials(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable?: boolean; // defaults to true — Phase 13D per-line taxability (Section 8)
}

export interface ComputedTotals {
  subtotalCents: number;
  taxAmountCents: number;
  totalCents: number;
  effectiveTaxRatePercent: number; // blended rate, backward-compatible with the legacy `tax_rate` column
  taxComponents: TaxComponentResult[];
  taxableBaseCents: number;
}

/** Integer-cents totals — quantity may be fractional (e.g. 2.5 hours), but
 *  every money value is rounded to the nearest cent at each step so rounding
 *  error can never accumulate across many lines. */
export function computeTotals(lines: InvoiceLineInput[], profile: TaxProfile | null): ComputedTotals {
  const calc = calculateTaxes(profile, lines.map((l) => ({ amountCents: Math.round(l.quantity * l.unitPriceCents), taxable: l.taxable ?? true })));
  const effectiveTaxRatePercent = calc.taxableBaseCents > 0 ? Math.round((calc.totalTaxCents / calc.taxableBaseCents) * 10000) / 100 : 0;
  return {
    subtotalCents: calc.subtotalCents,
    taxAmountCents: calc.totalTaxCents,
    totalCents: calc.totalCents,
    effectiveTaxRatePercent,
    taxComponents: calc.components,
    taxableBaseCents: calc.taxableBaseCents,
  };
}

async function nextInvoiceIdentifier(): Promise<string> {
  const prefixRow = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'invoice_prefix'");
  // Atomic: a single UPDATE...RETURNING is one indivisible SQLite statement —
  // no other statement can interleave between the read and the write, unlike
  // the old SELECT-then-UPDATE pattern this replaces, which raced under
  // concurrent invoice creation (two callers could read the same counter
  // value and mint the same identifier).
  const counterRow = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'invoice_counter' RETURNING value"
  );
  return `${prefixRow?.value || "INV"}-${counterRow!.value}`;
}

/** Government/third-party rebate amount for a job type, read from Global
 *  Settings — never hardcoded. Unconfigured means $0 (never a fabricated
 *  number), which is always safe: it can never push customer_amount below 0.
 *  Capped at the invoice total for the same reason if the configured amount
 *  ever exceeds a particular job's price. This is a deliberately simple,
 *  admin-configurable flat-amount model, not a simulation of actual CleanBC/
 *  BC Hydro program tiers/eligibility caps — this app has no authority to
 *  invent those rules, and none are hardcoded here. */
async function computeRebateAmountCents(organizationId: number, jobType: JobType, totalCents: number): Promise<number> {
  if (jobType === "STANDARD") return 0;
  const key = jobType === "CLEANBC" ? "CLEANBC_REBATE_AMOUNT_CENTS" : "BC_HYDRO_REBATE_AMOUNT_CENTS";
  const configured = await getSettingValue<number>(organizationId, key);
  if (configured === null || configured <= 0) return 0;
  return Math.min(Math.round(configured), totalCents);
}

export async function recordInvoiceEvent(
  invoiceId: number, eventType: string, actorId: number | null, details: Record<string, unknown>
): Promise<void> {
  await run(
    "INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?)",
    [invoiceId, eventType, actorId, JSON.stringify(details)]
  );
}

export async function getInvoiceAudit(invoiceId: number) {
  return query(
    "SELECT * FROM invoice_audit WHERE invoice_id = ? ORDER BY created_at DESC, id DESC", [invoiceId]
  );
}

interface InvoiceRow {
  id: number;
  identifier: string;
  organization_id: number;
  customer_id: number;
  job_id: number | null;
  status: InvoiceStatus;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  rebate_amount_cents: number;
  total_cents: number;
  due_date: string;
}

async function getActiveInvoiceForJob(jobId: number): Promise<InvoiceRow | null> {
  const row = await get<InvoiceRow>(
    "SELECT * FROM invoices WHERE job_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1", [jobId]
  );
  return row ?? null;
}

/** Idempotent job -> invoice generation. Called both automatically (from the
 *  job-transition route, right after a job legitimately reaches "completed")
 *  and manually (the existing "Create Invoice" button, POST
 *  /api/jobs/{id}/invoice) — both paths funnel through here so both get the
 *  same idempotency guarantee. Returns the existing invoice (created: false)
 *  if one already exists for this job, rather than ever creating a second
 *  one — the real guard is the database's partial UNIQUE index
 *  (idx_invoices_job_active), not just this function's up-front check: the
 *  up-front check is a fast path that avoids unnecessary work in the common
 *  case, the try/catch around the actual INSERT is what closes the race
 *  under genuine concurrent callers (mirrors the exact pattern
 *  calendar-sync.ts's tryClaimSync() already uses for the same class of
 *  problem — catch the constraint violation, re-fetch, treat it as success). */
export async function generateInvoiceForJob(
  db: D1Database, jobId: number, actorId: number | null
): Promise<{ invoice: InvoiceRow; created: boolean }> {
  const existing = await getActiveInvoiceForJob(jobId);
  if (existing) return { invoice: existing, created: false };

  const job = await get<Record<string, unknown>>(
    `SELECT j.*, st.name as service_type_name FROM jobs j
     LEFT JOIN service_types st ON j.service_type_id = st.id WHERE j.id = ?`, [jobId]
  );
  if (!job) throw new FinancialError("not_found", "Job not found");

  const priceCents = Math.round((job.price as number) * 100);
  const mats = await query<Record<string, unknown>>(
    `SELECT jm.*, m.name as material_name FROM job_materials jm
     LEFT JOIN materials m ON jm.material_id = m.id WHERE jm.job_id = ?`, [jobId]
  );

  const organizationId = job.organization_id as number;
  const profile = await resolveTaxProfile(organizationId);
  const defaultTaxable = profile?.default_taxable ?? true;
  const lines: InvoiceLineInput[] = [
    { description: (job.service_type_name as string) || "Service", quantity: 1, unitPriceCents: priceCents, taxable: defaultTaxable },
  ];
  for (const m of mats) {
    lines.push({
      description: m.material_name as string,
      quantity: m.quantity as number,
      unitPriceCents: Math.round((m.unit_cost as number) * 100),
      taxable: defaultTaxable,
    });
  }

  const totals = computeTotals(lines, profile);
  const rebateAmountCents = await computeRebateAmountCents(organizationId, job.job_type as JobType, totals.totalCents);
  const identifier = await nextInvoiceIdentifier();

  const statements = [
    db.prepare(
      `INSERT INTO invoices (identifier, organization_id, customer_id, job_id, status, subtotal_cents, tax_rate, tax_amount_cents, rebate_amount_cents, total_cents, notes, due_date)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '', '')`
    ).bind(identifier, organizationId, job.customer_id, jobId, totals.subtotalCents, totals.effectiveTaxRatePercent, totals.taxAmountCents, rebateAmountCents, totals.totalCents),
    ...lines.map((line) =>
      db.prepare(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_cents, total_cents, taxable)
         VALUES ((SELECT id FROM invoices WHERE identifier = ?), ?, ?, ?, ?, ?)`
      ).bind(identifier, line.description, line.quantity, line.unitPriceCents, Math.round(line.quantity * line.unitPriceCents), line.taxable ? 1 : 0)
    ),
    db.prepare(
      `INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details)
       VALUES ((SELECT id FROM invoices WHERE identifier = ?), 'invoice_created', ?, ?)`
    ).bind(identifier, actorId, JSON.stringify({
      source: "job_completion", job_id: jobId, rebate_amount_cents: rebateAmountCents,
      rebate_configured: rebateAmountCents > 0 || job.job_type === "STANDARD",
    })),
  ];

  try {
    await db.batch(statements);
  } catch {
    // Lost the race: a concurrent caller's INSERT committed first and the
    // partial unique index on (job_id) rejected ours. Not a failure — that
    // caller's invoice is the real one; adopt it, exactly like the
    // Google Calendar sync's claim/409 reconciliation does for the same
    // class of "someone else already created this" race.
    const winner = await getActiveInvoiceForJob(jobId);
    if (!winner) throw new FinancialError("invalid_state", "Failed to generate invoice and no concurrent invoice was found");
    return { invoice: winner, created: false };
  }

  const created = await getActiveInvoiceForJob(jobId);
  // Tax Snapshot (Section 10) — written once, right after the invoice row
  // it describes actually exists. A concurrent caller that lost the race
  // above already returned above (before reaching this line), so this
  // write always corresponds to the invoice this exact call created — it
  // is never re-run against another caller's winning row.
  const company = await getCompanyProfile(organizationId);
  await createTaxSnapshot({
    documentType: "invoice", documentId: created!.id, profile,
    calc: { taxableBaseCents: totals.taxableBaseCents, totalTaxCents: totals.taxAmountCents, components: totals.taxComponents },
    businessNumber: company.business_number, taxNumber: company.tax_number,
  });
  return { invoice: created!, created: true };
}

export interface ManualInvoiceInput {
  organizationId: number;
  customerId: number;
  jobId: number | null;
  // Phase 13D (Section 18): tax rate is no longer client-suppliable — the
  // caller may only mark individual lines taxable/non-taxable
  // (InvoiceLineInput#taxable); the server resolves the organization's
  // current Tax Profile and calculates the actual rate/amount/total.
  notes: string;
  dueDate: string;
  lines: InvoiceLineInput[];
}

/** Manual invoice creation (admin/dispatcher, POST /api/invoices) — same
 *  atomic-batch shape as generateInvoiceForJob, and subject to the exact same
 *  database-level idempotency guard if `jobId` is set (a manual invoice for a
 *  job that already has an active one is rejected the same way a duplicate
 *  auto-generation attempt would be, not silently allowed to create a
 *  second one just because a human triggered it instead of the workflow
 *  engine). */
export async function createManualInvoice(
  db: D1Database, input: ManualInvoiceInput, actorId: number
): Promise<InvoiceRow> {
  if (input.lines.length === 0) throw new FinancialError("invalid_amount", "At least one line item is required");
  if (input.jobId !== null) {
    const existing = await getActiveInvoiceForJob(input.jobId);
    if (existing) throw new FinancialError("invalid_state", "This job already has an active invoice");
  }

  const profile = await resolveTaxProfile(input.organizationId);
  const defaultTaxable = profile?.default_taxable ?? true;
  const lines = input.lines.map((l) => ({ ...l, taxable: l.taxable ?? defaultTaxable }));
  const totals = computeTotals(lines, profile);
  const identifier = await nextInvoiceIdentifier();

  const statements = [
    db.prepare(
      `INSERT INTO invoices (identifier, organization_id, customer_id, job_id, status, subtotal_cents, tax_rate, tax_amount_cents, rebate_amount_cents, total_cents, notes, due_date)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 0, ?, ?, ?)`
    ).bind(identifier, input.organizationId, input.customerId, input.jobId, totals.subtotalCents, totals.effectiveTaxRatePercent, totals.taxAmountCents, totals.totalCents, input.notes, input.dueDate),
    ...lines.map((line) =>
      db.prepare(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_cents, total_cents, taxable)
         VALUES ((SELECT id FROM invoices WHERE identifier = ?), ?, ?, ?, ?, ?)`
      ).bind(identifier, line.description, line.quantity, line.unitPriceCents, Math.round(line.quantity * line.unitPriceCents), line.taxable ? 1 : 0)
    ),
    db.prepare(
      `INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details)
       VALUES ((SELECT id FROM invoices WHERE identifier = ?), 'invoice_created', ?, ?)`
    ).bind(identifier, actorId, JSON.stringify({ source: "manual" })),
  ];

  try {
    await db.batch(statements);
  } catch {
    if (input.jobId !== null) {
      const winner = await getActiveInvoiceForJob(input.jobId);
      if (winner) return winner;
    }
    throw new FinancialError("invalid_state", "Failed to create invoice");
  }

  const row = await get<InvoiceRow>("SELECT * FROM invoices WHERE identifier = ?", [identifier]);
  const company = await getCompanyProfile(input.organizationId);
  await createTaxSnapshot({
    documentType: "invoice", documentId: row!.id, profile,
    calc: { taxableBaseCents: totals.taxableBaseCents, totalTaxCents: totals.taxAmountCents, components: totals.taxComponents },
    businessNumber: company.business_number, taxNumber: company.tax_number,
  });
  return row!;
}

export async function getInvoiceById(invoiceId: number): Promise<InvoiceRow | null> {
  const row = await get<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  return row ?? null;
}

/** Draft -> Issued. The only forward manual transition — "partially_paid" and
 *  "paid" are never set directly, they're always computed from actual
 *  payments (see recalculateStatus below), so there's no way for a status to
 *  claim money was received that wasn't actually recorded as a payment. */
export async function issueInvoice(invoiceId: number, actorId: number): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status !== "draft") {
    throw new FinancialError("invalid_state", `Cannot issue an invoice with status "${invoice.status}" — only a draft can be issued`);
  }
  await run("UPDATE invoices SET status = 'issued', issued_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [invoiceId]);
  await recordInvoiceEvent(invoiceId, "invoice_issued", actorId, {});
  return (await getInvoiceById(invoiceId))!;
}

/** Any non-void status -> Void, with a mandatory reason (business purpose:
 *  correcting an error, a cancelled job, a duplicate — the "cancelled" state
 *  jobs.status already has a rough analogue for). Financial records are
 *  never hard-deleted once issued (see deleteDraftInvoice for the one
 *  exception) — voiding preserves the full history rather than erasing it,
 *  which is what "auditability" for financial data actually requires. Voiding
 *  does NOT retroactively refund/reverse any payments already recorded
 *  against it — this app has no refund/credit model (deliberately out of
 *  Phase 5's scope); those payments remain on record as what was actually
 *  paid, the invoice is just marked as no longer active/billable. */
export async function voidInvoice(invoiceId: number, actorId: number, reason: string): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status === "void") throw new FinancialError("invalid_state", "Invoice is already void");
  if (!reason.trim()) throw new FinancialError("invalid_amount", "A reason is required to void an invoice");
  await run(
    "UPDATE invoices SET status = 'void', voided_at = datetime('now'), void_reason = ?, updated_at = datetime('now') WHERE id = ?",
    [reason, invoiceId]
  );
  await recordInvoiceEvent(invoiceId, "invoice_voided", actorId, { reason, previous_status: invoice.status });
  return (await getInvoiceById(invoiceId))!;
}

/** Only a draft (never issued, never had a payment, never seen by a
 *  customer) may be hard-deleted — anything past draft must be voided
 *  instead (see voidInvoice), consistent with standard accounting practice
 *  of never erasing a financial record that ever had legal/customer-facing
 *  effect. Cascades to its lines and its own (pre-issuance) audit trail,
 *  which is fine precisely because it never had real effect. */
export async function deleteDraftInvoice(invoiceId: number): Promise<void> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status !== "draft") {
    throw new FinancialError("invalid_state", "Only a draft invoice can be deleted — void it instead");
  }
  await run("DELETE FROM invoices WHERE id = ?", [invoiceId]);
}

/** rebate_amount_cents is the one financial field on an invoice that's
 *  editable after creation (e.g. correcting an auto-computed amount, or
 *  filling it in when Global Settings wasn't configured yet at generation
 *  time) — always clamped to [0, total_cents] so a rebate can never push
 *  customer_amount_cents below 0 (see getInvoiceFinancials). */
export async function setRebateAmount(invoiceId: number, actorId: number, rebateAmountCents: number): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status === "void") throw new FinancialError("invalid_state", "Cannot edit a void invoice");
  if (!Number.isInteger(rebateAmountCents) || rebateAmountCents < 0 || rebateAmountCents > invoice.total_cents) {
    throw new FinancialError("invalid_amount", `Rebate amount must be an integer between 0 and the invoice total (${invoice.total_cents} cents)`);
  }
  await run("UPDATE invoices SET rebate_amount_cents = ?, updated_at = datetime('now') WHERE id = ?", [rebateAmountCents, invoiceId]);
  await recordInvoiceEvent(invoiceId, "rebate_amount_changed", actorId, {
    old_rebate_amount_cents: invoice.rebate_amount_cents, new_rebate_amount_cents: rebateAmountCents,
  });
  return (await getInvoiceById(invoiceId))!;
}

export interface InvoiceFinancials {
  subtotal_cents: number;
  tax_amount_cents: number;
  rebate_amount_cents: number;
  total_cents: number;
  customer_amount_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  is_overdue: boolean;
}

/** Every derived money figure, computed fresh from stored inputs + the
 *  payments table — never cached on the invoice row (see the module
 *  docstring). Cheap at this app's scale (one aggregate query per invoice
 *  view), and it's the only way to guarantee balance_cents can never
 *  silently disagree with the actual payment history. */
export async function getInvoiceFinancials(invoice: InvoiceRow, dueDate: string): Promise<InvoiceFinancials> {
  const paidRow = await get<{ total: number | null }>(
    "SELECT SUM(amount_cents) as total FROM payments WHERE invoice_id = ? AND voided_at IS NULL", [invoice.id]
  );
  const amountPaidCents = paidRow?.total ?? 0;
  const balanceCents = invoice.total_cents - amountPaidCents;
  const today = new Date().toISOString().split("T")[0];
  const isOverdue = balanceCents > 0 && dueDate !== "" && dueDate < today &&
    (invoice.status === "issued" || invoice.status === "partially_paid");
  return {
    subtotal_cents: invoice.subtotal_cents,
    tax_amount_cents: invoice.tax_amount_cents,
    rebate_amount_cents: invoice.rebate_amount_cents,
    total_cents: invoice.total_cents,
    customer_amount_cents: invoice.total_cents - invoice.rebate_amount_cents,
    amount_paid_cents: amountPaidCents,
    balance_cents: balanceCents,
    is_overdue: isOverdue,
  };
}

async function recalculateStatus(db: D1Database, invoiceId: number): Promise<void> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice || invoice.status === "draft" || invoice.status === "void") return;
  const paidRow = await get<{ total: number | null }>(
    "SELECT SUM(amount_cents) as total FROM payments WHERE invoice_id = ? AND voided_at IS NULL", [invoiceId]
  );
  const paid = paidRow?.total ?? 0;
  const newStatus: InvoiceStatus = paid >= invoice.total_cents && invoice.total_cents > 0
    ? "paid"
    : paid > 0 ? "partially_paid" : "issued";
  if (newStatus !== invoice.status) {
    await run("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, invoiceId]);
  }
}

export interface PaymentInput {
  amountCents: number;
  payerType: PayerType;
  method: PaymentMethod;
  reference: string;
  notes: string;
  paidAt: string;
  /** Phase 13B — defaults to "manual" (the existing office Record Payment
   *  action). "online_provider" is set only by confirmPaymentSession()
   *  below, never accepted directly from a client-supplied field on the
   *  manual-payment route (mass-assignment guard — see index.ts). */
  source?: PaymentSource;
  /** Free text — who physically took the payment (may differ from the
   *  logged-in actor recording it). Optional; never required (Section 16:
   *  "Do not require reference for Cash unless business policy explicitly
   *  requires it" — same non-mandatory spirit extended to this field). */
  receivedBy?: string;
  /** Only set for source="online_provider" — traces back to the
   *  payment_sessions row that produced this payment. */
  paymentSessionId?: number | null;
}

/** Records a payment, then recomputes the invoice's status from the actual
 *  payment total (never trusts a client-supplied status). Overpayment is
 *  rejected outright — this app has no credit/refund model, so a payment
 *  that would push the running total past total_cents is invalid, not
 *  silently accepted as a credit balance (see FinancialError "invalid_amount"
 *  below, and the rebate-integrity requirement this satisfies: a customer's
 *  balance can shrink to exactly 0 but never go negative).
 *
 *  Phase 13B security/testing review fix: the overpayment guard used to be
 *  a plain SELECT-the-sum, then-INSERT — a classic read-then-write race
 *  (two concurrent payments, e.g. a manual one racing an online webhook
 *  confirmation, could each read the same pre-payment sum, both pass the
 *  check, and both insert, pushing amount_paid_cents past total_cents).
 *  This is the exact race class `nextInvoiceIdentifier()` and
 *  `generateInvoiceForJob()` were already hardened against elsewhere in
 *  this file — recordPayment() had NOT been. Fixed by folding the guard
 *  into the INSERT itself: an `INSERT ... SELECT ... WHERE <aggregate
 *  check>` is one indivisible SQLite statement (D1 serializes writes to a
 *  single database), so a second concurrent caller's statement can only
 *  ever run after the first one's has fully committed, and will correctly
 *  see the updated sum — there is no gap for two callers to both pass a
 *  stale check. A 0-row insert means the guard rejected it. */
export async function recordPayment(
  // actorId is nullable — an online-provider payment confirmed by a
  // webhook has no human actor to attribute it to (see
  // processPaymentWebhookEvent below); recorded_by/actor_user_id are both
  // nullable FK columns (ON DELETE SET NULL) precisely so this has always
  // been a safe, representable state.
  db: D1Database, invoiceId: number, input: PaymentInput, actorId: number | null
): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status === "draft" || invoice.status === "void") {
    throw new FinancialError("invalid_state", `Cannot record a payment against a ${invoice.status} invoice — issue it first`);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new FinancialError("invalid_amount", "Payment amount must be a positive integer number of cents");
  }

  const source = input.source ?? "manual";
  const insertResult = await db.prepare(
    `INSERT INTO payments (invoice_id, amount_cents, payer_type, method, reference, notes, paid_at, recorded_by, source, received_by, payment_session_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE invoice_id = ? AND voided_at IS NULL) + ? <= (SELECT total_cents FROM invoices WHERE id = ?)`
  ).bind(
    invoiceId, input.amountCents, input.payerType, input.method, input.reference, input.notes, input.paidAt, actorId,
    source, input.receivedBy ?? "", input.paymentSessionId ?? null,
    invoiceId, input.amountCents, invoiceId
  ).run();

  if (!insertResult.meta.changes) {
    const paidRow = await get<{ total: number | null }>(
      "SELECT SUM(amount_cents) as total FROM payments WHERE invoice_id = ? AND voided_at IS NULL", [invoiceId]
    );
    const alreadyPaid = paidRow?.total ?? 0;
    throw new FinancialError(
      "invalid_amount",
      `Payment of ${input.amountCents} cents would exceed the remaining balance (${invoice.total_cents - alreadyPaid} cents)`
    );
  }

  await run(
    `INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details) VALUES (?, 'payment_recorded', ?, ?)`,
    [invoiceId, actorId, JSON.stringify({ amount_cents: input.amountCents, payer_type: input.payerType, method: input.method, source })]
  );
  await recalculateStatus(db, invoiceId);
  return (await getInvoiceById(invoiceId))!;
}

export async function listPayments(invoiceId: number) {
  return query(
    "SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at DESC, id DESC", [invoiceId]
  );
}

export async function getPaymentById(paymentId: number) {
  return get<{ id: number; invoice_id: number; voided_at: string | null }>(
    "SELECT * FROM payments WHERE id = ?", [paymentId]
  );
}

/** Soft-void, never a hard delete — same reasoning as job_media's soft
 *  delete in Phase 4: a voided payment is itself part of the invoice's
 *  financial history ("a payment WAS recorded, then reversed on <date>
 *  because <reason>"), which a hard DELETE would erase entirely. */
export async function voidPayment(db: D1Database, paymentId: number, actorId: number, reason: string): Promise<void> {
  const payment = await getPaymentById(paymentId);
  if (!payment) throw new FinancialError("not_found", "Payment not found");
  if (payment.voided_at) throw new FinancialError("invalid_state", "Payment is already voided");
  if (!reason.trim()) throw new FinancialError("invalid_amount", "A reason is required to void a payment");

  await db.batch([
    db.prepare("UPDATE payments SET voided_at = datetime('now'), void_reason = ? WHERE id = ?").bind(reason, paymentId),
    db.prepare(
      `INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details) VALUES (?, 'payment_voided', ?, ?)`
    ).bind(payment.invoice_id, actorId, JSON.stringify({ payment_id: paymentId, reason })),
  ]);
  await recalculateStatus(db, payment.invoice_id);
}

// ── Phase 13B — Invoice PDF / Receipt PDF bytes, for delivery ──────────
// Both resolve the exact same rendering logic the /pdf routes use (see
// invoice-pdf.ts / receipt-pdf.ts's own header comments for the "live-
// rendered, no snapshot" lifecycle decision), so a delivered email
// attachment is always byte-identical to what View/Download/Print would
// produce for the same invoice/payment at that moment — one rendering
// code path, never a duplicated "email version."

export interface DeliveryDocument {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}

async function loadInvoicePdfInput(invoiceId: number) {
  const invoice = await get<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
            c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip,
            j.identifier as job_identifier
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN jobs j ON i.job_id = j.id
     WHERE i.id = ?`, [invoiceId]
  );
  if (!invoice) return null;
  const lines = await query<{ description: string; quantity: number; unit_price_cents: number; total_cents: number }>(
    "SELECT description, quantity, unit_price_cents, total_cents FROM invoice_lines WHERE invoice_id = ? ORDER BY id ASC", [invoiceId]
  );
  const payments = await query<{ amount_cents: number; method: string; paid_at: string; reference: string; voided_at: string | null }>(
    "SELECT amount_cents, method, paid_at, reference, voided_at FROM payments WHERE invoice_id = ? ORDER BY paid_at ASC, id ASC", [invoiceId]
  );
  const financials = await getInvoiceFinancials(invoice as unknown as InvoiceRow, invoice.due_date as string);
  return { invoice, lines, payments, financials };
}

export async function getInvoicePdfBytesForDelivery(env: StorageEnv, invoiceId: number): Promise<DeliveryDocument | null> {
  const loaded = await loadInvoicePdfInput(invoiceId);
  if (!loaded) return null;
  const { invoice, lines, payments, financials } = loaded;
  const organizationId = invoice.organization_id as number;
  const company = await getCompanyProfile(organizationId);
  const logo = await getCompanyLogo(env, organizationId);
  const bytes = await renderInvoicePdf({
    identifier: invoice.identifier as string,
    status: invoice.status as string,
    issuedAt: invoice.issued_at as string | null,
    dueDate: invoice.due_date as string,
    notes: invoice.notes as string,
    jobIdentifier: invoice.job_identifier as string | null,
    customer: {
      name: (invoice.customer_name as string) || "", email: (invoice.customer_email as string) || "",
      phone: (invoice.customer_phone as string) || "", address: (invoice.customer_address as string) || "",
      city: (invoice.customer_city as string) || "", state: (invoice.customer_state as string) || "", zip: (invoice.customer_zip as string) || "",
    },
    lines,
    taxRate: invoice.tax_rate as number,
    taxBreakdown: await getTaxSnapshot("invoice", invoice.id as number),
    financials,
    payments: payments.filter((p) => !p.voided_at),
    company,
    logo: logo ? { bytes: logo.bytes, format: logo.contentType === "image/jpeg" ? "jpeg" : "png" } : null,
  });
  return { filename: `Invoice-${invoice.identifier}.pdf`, contentType: "application/pdf", bytes: bytes.slice().buffer as ArrayBuffer };
}

interface PaymentDetailRow {
  id: number; invoice_id: number; amount_cents: number; payer_type: PayerType; method: PaymentMethod;
  reference: string; notes: string; paid_at: string; received_by: string; source: PaymentSource; voided_at: string | null;
}

export async function getPaymentDetail(paymentId: number): Promise<PaymentDetailRow | null> {
  const row = await get<PaymentDetailRow>("SELECT * FROM payments WHERE id = ?", [paymentId]);
  return row ?? null;
}

/** Receipt content — see receipt-pdf.ts's own header comment for the
 *  immutable-facts-vs-live-context distinction this function embodies:
 *  the payment fields themselves are read straight off the immutable
 *  `payments` row, while "Total Paid"/"Remaining Balance" are computed
 *  live from getInvoiceFinancials() (current, not a frozen point-in-time
 *  snapshot) — deliberately consistent with how the Invoice PDF itself
 *  always shows current totals. */
export async function getReceiptPdfBytesForDelivery(env: StorageEnv, paymentId: number): Promise<DeliveryDocument | null> {
  const payment = await getPaymentDetail(paymentId);
  if (!payment) return null;
  const invoice = await getInvoiceById(payment.invoice_id);
  if (!invoice) return null;
  const customer = await get<{ name: string; email: string }>(
    "SELECT name, email FROM customers WHERE id = ?", [invoice.customer_id]
  );
  const financials = await getInvoiceFinancials(invoice, "");
  const organizationId = invoice.organization_id;
  const company = await getCompanyProfile(organizationId);
  const logo = await getCompanyLogo(env, organizationId);
  const bytes = await renderReceiptPdf({
    paymentId: payment.id,
    invoiceIdentifier: invoice.identifier,
    invoiceTotalCents: invoice.total_cents,
    customerName: customer?.name || "",
    amountCents: payment.amount_cents,
    payerType: payment.payer_type,
    method: payment.method,
    reference: payment.reference,
    paidAt: payment.paid_at,
    receivedBy: payment.received_by,
    source: payment.source,
    voided: !!payment.voided_at,
    totalPaidCents: financials.amount_paid_cents,
    balanceCents: financials.balance_cents,
    company,
    logo: logo ? { bytes: logo.bytes, format: logo.contentType === "image/jpeg" ? "jpeg" : "png" } : null,
  });
  return { filename: `Receipt-${invoice.identifier}-${payment.id}.pdf`, contentType: "application/pdf", bytes: bytes.slice().buffer as ArrayBuffer };
}

// ── Phase 13B — Online Payment: sessions + provider webhook processing ──
// See payment-provider.ts's own header comment for the PaymentProvider
// abstraction this section is built on, and the FINAL Safe Commit report
// for the production-provider recommendation. Section 11-13/29-32's
// requirements: never trust a client-supplied amount, never mark an
// invoice paid from a pending session, and duplicate provider
// confirmations must never create duplicate payments.

function toBase64UrlLocal(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function hashPaymentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64UrlLocal(new Uint8Array(digest));
}

const PAYMENT_SESSION_TTL_MINUTES = 30;

export interface PaymentSessionRow {
  id: number; invoice_id: number; organization_id: number; provider: string; status: PaymentSessionStatus;
  amount_cents: number; token_hash: string; provider_session_id: string; provider_transaction_id: string | null;
  idempotency_key: string; expires_at: string; confirmed_at: string | null; cancelled_at: string | null;
  created_by: number | null; created_at: string;
}

/** Creates (or reuses an existing, still-pending, non-expired) payment
 *  session for an invoice — reuse means repeatedly clicking "Generate
 *  Payment Link" doesn't spawn N live sessions for the same invoice, the
 *  same duplicate-click discipline as everywhere else in this codebase.
 *  The amount is captured HERE, from the server-authoritative current
 *  balance (Section 13) — never supplied by, or re-derived from, the
 *  client at any later step. Rejects a $0-or-less balance (nothing to
 *  pay) and a draft/void invoice (not yet billable / no longer active). */
export async function createPaymentSession(
  provider: PaymentProvider, organizationId: number, invoiceId: number, actorId: number | null
): Promise<{ rawToken: string; session: PaymentSessionRow }> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status === "draft" || invoice.status === "void") {
    throw new FinancialError("invalid_state", `Cannot create a payment link for a ${invoice.status} invoice`);
  }
  const financials = await getInvoiceFinancials(invoice, "");
  if (financials.balance_cents <= 0) {
    throw new FinancialError("invalid_amount", "This invoice has no remaining balance");
  }

  const existing = await get<PaymentSessionRow>(
    `SELECT * FROM payment_sessions WHERE invoice_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
    [invoiceId]
  );
  if (existing) {
    // The raw token isn't recoverable from a hash — a reused session can't
    // return the ORIGINAL link. This is the correct, safe behavior (same
    // "shown once" discipline as the Contract signing link): the caller
    // gets a fresh token bound to the SAME underlying session row instead
    // of a second live session, by re-hashing a newly generated token onto
    // the existing row.
    const rawToken = toBase64UrlLocal(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashPaymentToken(rawToken);
    await run("UPDATE payment_sessions SET token_hash = ?, updated_at = datetime('now') WHERE id = ?", [tokenHash, existing.id]);
    return { rawToken, session: { ...existing, token_hash: tokenHash } };
  }

  const rawToken = toBase64UrlLocal(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashPaymentToken(rawToken);
  // Architecture review correction: this is NOT the active replay guard —
  // that's the atomic `UPDATE ... WHERE status='pending' RETURNING id`
  // claim on `provider_session_id` in processPaymentWebhookEvent below,
  // which is sufficient on its own and is what the replay/duplicate-event
  // tests actually exercise. `idempotency_key` is stored (UNIQUE-
  // constrained) as a forward-compatible value a REAL provider integration
  // could be asked to echo back on its own idempotent-request API (the
  // same convention this codebase's Resend adapter already uses via
  // `EmailSendInput.idempotencyKey`) — reserved for that future use, not
  // currently read back by any code path in this mock-only pass.
  const idempotencyKey = toBase64UrlLocal(crypto.getRandomValues(new Uint8Array(16)));
  const providerResult = await provider.createPaymentSession({
    amountCents: financials.balance_cents, currency: "CAD", invoiceIdentifier: invoice.identifier,
    metadata: { invoiceId: String(invoiceId) },
  });

  const inserted = await get<{ id: number }>(
    `INSERT INTO payment_sessions
       (invoice_id, organization_id, provider, status, amount_cents, token_hash, provider_session_id, idempotency_key, expires_at, created_by)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, datetime('now', ?), ?)
     RETURNING id`,
    [invoiceId, organizationId, provider.name, financials.balance_cents, tokenHash, providerResult.providerSessionId,
      idempotencyKey, `+${PAYMENT_SESSION_TTL_MINUTES} minutes`, actorId]
  );
  const session = await get<PaymentSessionRow>("SELECT * FROM payment_sessions WHERE id = ?", [inserted!.id]);
  return { rawToken, session: session! };
}

export interface PublicPaymentView {
  session: PaymentSessionRow;
  invoiceIdentifier: string;
  companyName: string;
  balanceDueCents: number;
}

const GENERIC_PAYMENT_LINK_ERROR = "This payment link is invalid or has expired";

/** Same generic-404-for-every-failure discipline as
 *  contracts.ts#getSignatureRequestByToken — a wrong token, an expired
 *  one, and an already-used one are all indistinguishable to the caller,
 *  so a link can never be used to enumerate/probe invoice state. */
export async function getPaymentSessionByToken(rawToken: string): Promise<PublicPaymentView | null> {
  if (!rawToken || rawToken.length > 200) return null;
  const tokenHash = await hashPaymentToken(rawToken);
  const session = await get<PaymentSessionRow>("SELECT * FROM payment_sessions WHERE token_hash = ?", [tokenHash]);
  if (!session) return null;
  if (session.status !== "pending") return null;
  // Compare entirely in SQL — SQLite stores expires_at as its own
  // datetime('now', ...) bare format ("YYYY-MM-DD HH:MM:SS", UTC, no "Z").
  // `new Date(session.expires_at) < new Date()` (contracts.ts's own
  // getSignatureRequestByToken uses this exact pattern too — an adjacent,
  // not-fixed-here latent risk, see this phase's final report) parses that
  // bare string as LOCAL time in most JS engines, silently shifting it by
  // the runtime's UTC offset — on a real deployment in this app's own
  // America/Vancouver business timezone, that misreads an
  // already-expired session as hours in the future. A same-format SQL
  // string comparison has no such ambiguity.
  const expiryCheck = await get<{ expired: number }>(
    "SELECT (expires_at < datetime('now')) as expired FROM payment_sessions WHERE id = ?", [session.id]
  );
  if (expiryCheck?.expired) {
    await run("UPDATE payment_sessions SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'pending'", [session.id]);
    return null;
  }
  const invoice = await getInvoiceById(session.invoice_id);
  if (!invoice) return null;
  const company = await getCompanyProfile(session.organization_id);
  const financials = await getInvoiceFinancials(invoice, "");
  return {
    session, invoiceIdentifier: invoice.identifier,
    companyName: company.company_name || company.legal_name || "",
    balanceDueCents: financials.balance_cents,
  };
}

/** Security review fix (P3): `getPaymentSessionByToken`'s read and this
 *  UPDATE aren't one atomic step — a webhook can confirm the same session
 *  in between, in which case the `WHERE status = 'pending'` guard below
 *  correctly changes 0 rows. Report that honestly (a real 400, not a
 *  false `{ok:true}`) rather than silently no-op-ing a cancel that never
 *  actually happened — the caller (index.ts) surfaces this distinctly so
 *  the customer sees "this was already paid," not a misleading success. */
export async function cancelPaymentSessionByToken(rawToken: string): Promise<{ alreadyResolved: boolean }> {
  const view = await getPaymentSessionByToken(rawToken);
  if (!view) throw new FinancialError("not_found", GENERIC_PAYMENT_LINK_ERROR);
  const result = await run(
    "UPDATE payment_sessions SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    [view.session.id]
  );
  return { alreadyResolved: result.changes === 0 };
}

/** The public "Pay Now" button's server-side handler (Section 11: customer
 *  clicks pay -> provider confirms -> OFS independently verifies). For the
 *  mock provider there is no separate external process to call back from,
 *  so this constructs a same-shape signed event server-side and feeds it
 *  through the EXACT SAME processPaymentWebhookEvent() the real public
 *  webhook route runs — the "independent verification" step is genuinely
 *  exercised (signature check, amount/session binding, idempotent claim),
 *  not bypassed for convenience. */
export async function confirmMockPayment(
  db: D1Database, provider: PaymentProvider, secret: string, rawToken: string
): Promise<WebhookProcessResult> {
  const view = await getPaymentSessionByToken(rawToken);
  if (!view) throw new FinancialError("not_found", GENERIC_PAYMENT_LINK_ERROR);
  const { rawBody, signature } = await signMockWebhookPayload(secret, {
    providerSessionId: view.session.provider_session_id,
    status: "succeeded",
    providerTransactionId: `mock_txn_${toBase64UrlLocal(crypto.getRandomValues(new Uint8Array(12)))}`,
    amountCents: view.session.amount_cents,
  });
  return processPaymentWebhookEvent(db, provider, secret, rawBody, signature);
}

export type WebhookProcessOutcome = "payment_recorded" | "already_processed" | "session_terminal" | "session_not_found" | "invalid_signature";

export interface WebhookProcessResult {
  outcome: WebhookProcessOutcome;
  /** Present only when outcome === "payment_recorded" — the caller (the
   *  webhook route / mock-confirm route in index.ts) needs this to
   *  resolve the customer contact and enqueue the receipt email itself;
   *  financial.ts deliberately never calls into notifications.ts (see
   *  this module's existing invoice/payment functions, none of which
   *  enqueue anything — that responsibility has always lived in the
   *  route handler, not here). */
  invoiceId?: number;
}

/** The ONE place a payment_sessions row ever turns into a real `payments`
 *  row. Independently re-verifies everything the event claims against our
 *  own durable session record before trusting any of it (Section 11:
 *  "Never trust browser redirect/query-string success alone" — this
 *  applies equally to a webhook payload, which is just as untrusted until
 *  its signature verifies): signature (via the provider abstraction —
 *  Section 30), session existence, amount binding (the event's amount
 *  must match what WE recorded at session-creation time, never the
 *  event's own claim alone), and idempotency (a session that's already
 *  'succeeded' is a safe no-op, never a second payment — Section 29). */
export async function processPaymentWebhookEvent(
  db: D1Database, provider: PaymentProvider, secret: string, rawBody: string, signature: string | null
): Promise<WebhookProcessResult> {
  const event = await provider.verifyWebhook(rawBody, signature, secret);
  if (!event) return { outcome: "invalid_signature" };

  const session = await get<PaymentSessionRow>(
    "SELECT * FROM payment_sessions WHERE provider_session_id = ?", [event.providerSessionId]
  );
  if (!session) return { outcome: "session_not_found" };
  if (session.status === "succeeded") return { outcome: "already_processed", invoiceId: session.invoice_id };
  if (session.status !== "pending") return { outcome: "session_terminal" };
  if (event.amountCents !== session.amount_cents) return { outcome: "session_terminal" }; // amount tampering / mismatch — never adjusted, never trusted

  if (event.status !== "succeeded") {
    await run(
      "UPDATE payment_sessions SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
      [event.status, session.id]
    );
    return { outcome: "session_terminal" };
  }

  // Atomic claim: only the caller that actually flips pending -> succeeded
  // gets to record the payment — a second concurrent/replayed webhook for
  // the same session sees 0 rows changed and stops here (Section 29/40).
  const claimed = await get<{ id: number }>(
    `UPDATE payment_sessions SET status = 'succeeded', provider_transaction_id = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'pending' RETURNING id`,
    [event.providerTransactionId, session.id]
  );
  if (!claimed) return { outcome: "already_processed", invoiceId: session.invoice_id }; // lost the race — someone else's call already recorded it

  // Security/testing review fix: the session's amount_cents was pinned at
  // creation time and could be stale by the time the provider confirms
  // (e.g. a manual payment landed on the same invoice in between) —
  // recordPayment()'s own (now race-safe, see its doc comment) overpayment
  // guard can still legitimately reject this. That must NEVER leave the
  // session stuck at 'succeeded' with no actual payment recorded — a
  // permanently-false ledger entry and a dead link the customer can never
  // recover (getPaymentSessionByToken only ever returns 'pending'
  // sessions). Revert to 'failed' (an already-recognized terminal state)
  // so office staff can see it happened and generate a fresh payment link
  // for the invoice's real, current balance.
  try {
    await recordPayment(db, session.invoice_id, {
      amountCents: session.amount_cents,
      payerType: "customer",
      method: "credit_card", // best generic representation for an online-provider charge; see PAYMENT_METHODS' own doc comment
      reference: event.providerTransactionId || "",
      notes: "Paid online",
      paidAt: new Date().toISOString(),
      source: "online_provider",
      paymentSessionId: session.id,
    }, /* actorId */ session.created_by);
  } catch (err) {
    await run("UPDATE payment_sessions SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [session.id]);
    if (err instanceof FinancialError) return { outcome: "session_terminal" };
    throw err;
  }

  return { outcome: "payment_recorded", invoiceId: session.invoice_id };
}

// ── Phase 13B — Invoice / Receipt email delivery status + retry ────────
// Same shape and reuse discipline as contracts.ts's
// getContractDeliveryStatus/resendSignedCopy (Section 8's "delivery
// status, retry, idempotency" requirement, extended to Invoices/Receipts).

export interface DeliveryStatus {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
  last_sent_at: string | null;
  last_error: string | null;
}

async function aggregateDeliveryStatus(entityType: string, entityId: number, eventType: string): Promise<DeliveryStatus> {
  const rows = await query<{ status: string; sent_at: string | null; last_error: string }>(
    "SELECT status, sent_at, last_error FROM notification_outbox WHERE entity_type = ? AND entity_id = ? AND event_type = ?",
    [entityType, entityId, eventType]
  );
  const sent = rows.filter((r) => r.status === "sent");
  const failed = rows.filter((r) => r.status === "failed");
  return {
    total: rows.length,
    sent: sent.length,
    failed: failed.length,
    pending: rows.filter((r) => r.status === "pending" || r.status === "sending").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    last_sent_at: sent.map((r) => r.sent_at).filter(Boolean).sort().pop() ?? null,
    last_error: failed.map((r) => r.last_error).filter(Boolean).pop() ?? null,
  };
}

export async function getInvoiceDeliveryStatus(invoiceId: number): Promise<DeliveryStatus> {
  return aggregateDeliveryStatus("invoice", invoiceId, "invoice.sent");
}

export async function getPaymentReceiptDeliveryStatus(paymentId: number): Promise<DeliveryStatus> {
  return aggregateDeliveryStatus("payment", paymentId, "payment.receipt");
}

/** Section 6/8/41 — "Send Invoice to Customer." Idempotent per invoice:
 *  a genuinely NEW outbox row is only ever created the first time
 *  (`created: true`); every subsequent call — whether an accidental
 *  duplicate click while the first send is still in flight, or a
 *  deliberate resend after a failure or even after a prior success (a
 *  real, named business need per Section 41, distinct from mere failure
 *  recovery) — reuses the SAME row rather than ever creating a second
 *  one. A rapid double-click while still `pending`/`sending` is a safe
 *  no-op (protects against duplicate-click sends); any terminal state
 *  (`sent`/`failed`/`cancelled`) is reset back to `pending` with a fresh
 *  attempt budget on a deliberate call. The caller (index.ts's route)
 *  passes an already-built enqueue callback rather than this function
 *  calling notifications.ts directly — same separation-of-concerns as
 *  every other financial.ts function (see processPaymentWebhookEvent's
 *  own comment on this). */
export async function prepareInvoiceSend(
  invoiceId: number, enqueue: () => Promise<{ enqueued: boolean }>
): Promise<{ action: "enqueued" | "already_in_flight" | "reset_for_resend" }> {
  const existing = await get<{ id: number; status: string }>(
    "SELECT id, status FROM notification_outbox WHERE entity_type = 'invoice' AND entity_id = ? AND event_type = 'invoice.sent'",
    [invoiceId]
  );
  if (!existing) {
    await enqueue();
    return { action: "enqueued" };
  }
  if (existing.status === "pending" || existing.status === "sending") {
    return { action: "already_in_flight" };
  }
  await run(
    `UPDATE notification_outbox SET status = 'pending', attempts = 0, last_error = '', scheduled_for = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [existing.id]
  );
  return { action: "reset_for_resend" };
}

/** Same reuse-the-row semantics as prepareInvoiceSend, for the optional
 *  Receipt email (Section 24). */
export async function preparePaymentReceiptEmail(
  paymentId: number, enqueue: () => Promise<{ enqueued: boolean }>
): Promise<{ action: "enqueued" | "already_in_flight" | "reset_for_resend" }> {
  const existing = await get<{ id: number; status: string }>(
    "SELECT id, status FROM notification_outbox WHERE entity_type = 'payment' AND entity_id = ? AND event_type = 'payment.receipt'",
    [paymentId]
  );
  if (!existing) {
    await enqueue();
    return { action: "enqueued" };
  }
  if (existing.status === "pending" || existing.status === "sending") {
    return { action: "already_in_flight" };
  }
  await run(
    `UPDATE notification_outbox SET status = 'pending', attempts = 0, last_error = '', scheduled_for = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [existing.id]
  );
  return { action: "reset_for_resend" };
}
