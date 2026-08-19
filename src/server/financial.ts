import { get, query, run } from "./db.js";
import { getSettingValue } from "./settings.js";
import type { Role } from "./auth.js";
import type { JobType } from "./workflow.js";

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

export const PAYMENT_METHODS = ["cash", "check", "credit_card", "debit_card", "e_transfer", "financing", "other"] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

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
}

export interface ComputedTotals {
  subtotalCents: number;
  taxAmountCents: number;
  totalCents: number;
}

/** Integer-cents totals — quantity may be fractional (e.g. 2.5 hours), but
 *  every money value is rounded to the nearest cent at each step so rounding
 *  error can never accumulate across many lines. */
export function computeTotals(lines: InvoiceLineInput[], taxRatePercent: number): ComputedTotals {
  let subtotalCents = 0;
  for (const line of lines) {
    subtotalCents += Math.round(line.quantity * line.unitPriceCents);
  }
  const taxAmountCents = Math.round(subtotalCents * (taxRatePercent / 100));
  return { subtotalCents, taxAmountCents, totalCents: subtotalCents + taxAmountCents };
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
async function computeRebateAmountCents(jobType: JobType, totalCents: number): Promise<number> {
  if (jobType === "STANDARD") return 0;
  const key = jobType === "CLEANBC" ? "CLEANBC_REBATE_AMOUNT_CENTS" : "BC_HYDRO_REBATE_AMOUNT_CENTS";
  const configured = await getSettingValue<number>(key);
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
  customer_id: number;
  job_id: number | null;
  status: InvoiceStatus;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  rebate_amount_cents: number;
  total_cents: number;
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

  const lines: InvoiceLineInput[] = [
    { description: (job.service_type_name as string) || "Service", quantity: 1, unitPriceCents: priceCents },
  ];
  for (const m of mats) {
    lines.push({
      description: m.material_name as string,
      quantity: m.quantity as number,
      unitPriceCents: Math.round((m.unit_cost as number) * 100),
    });
  }

  const totals = computeTotals(lines, 0);
  const rebateAmountCents = await computeRebateAmountCents(job.job_type as JobType, totals.totalCents);
  const identifier = await nextInvoiceIdentifier();

  const statements = [
    db.prepare(
      `INSERT INTO invoices (identifier, customer_id, job_id, status, subtotal_cents, tax_rate, tax_amount_cents, rebate_amount_cents, total_cents, notes, due_date)
       VALUES (?, ?, ?, 'draft', ?, 0, ?, ?, ?, '', '')`
    ).bind(identifier, job.customer_id, jobId, totals.subtotalCents, totals.taxAmountCents, rebateAmountCents, totals.totalCents),
    ...lines.map((line) =>
      db.prepare(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_cents, total_cents)
         VALUES ((SELECT id FROM invoices WHERE identifier = ?), ?, ?, ?, ?)`
      ).bind(identifier, line.description, line.quantity, line.unitPriceCents, Math.round(line.quantity * line.unitPriceCents))
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
  return { invoice: created!, created: true };
}

export interface ManualInvoiceInput {
  customerId: number;
  jobId: number | null;
  taxRatePercent: number;
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

  const totals = computeTotals(input.lines, input.taxRatePercent);
  const identifier = await nextInvoiceIdentifier();

  const statements = [
    db.prepare(
      `INSERT INTO invoices (identifier, customer_id, job_id, status, subtotal_cents, tax_rate, tax_amount_cents, rebate_amount_cents, total_cents, notes, due_date)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, 0, ?, ?, ?)`
    ).bind(identifier, input.customerId, input.jobId, totals.subtotalCents, input.taxRatePercent, totals.taxAmountCents, totals.totalCents, input.notes, input.dueDate),
    ...input.lines.map((line) =>
      db.prepare(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_cents, total_cents)
         VALUES ((SELECT id FROM invoices WHERE identifier = ?), ?, ?, ?, ?)`
      ).bind(identifier, line.description, line.quantity, line.unitPriceCents, Math.round(line.quantity * line.unitPriceCents))
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
}

/** Records a payment, then recomputes the invoice's status from the actual
 *  payment total (never trusts a client-supplied status). Overpayment is
 *  rejected outright — this app has no credit/refund model, so a payment
 *  that would push the running total past total_cents is invalid, not
 *  silently accepted as a credit balance (see FinancialError "invalid_amount"
 *  below, and the rebate-integrity requirement this satisfies: a customer's
 *  balance can shrink to exactly 0 but never go negative). */
export async function recordPayment(
  db: D1Database, invoiceId: number, input: PaymentInput, actorId: number
): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new FinancialError("not_found", "Invoice not found");
  if (invoice.status === "draft" || invoice.status === "void") {
    throw new FinancialError("invalid_state", `Cannot record a payment against a ${invoice.status} invoice — issue it first`);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new FinancialError("invalid_amount", "Payment amount must be a positive integer number of cents");
  }
  const paidRow = await get<{ total: number | null }>(
    "SELECT SUM(amount_cents) as total FROM payments WHERE invoice_id = ? AND voided_at IS NULL", [invoiceId]
  );
  const alreadyPaid = paidRow?.total ?? 0;
  if (alreadyPaid + input.amountCents > invoice.total_cents) {
    throw new FinancialError(
      "invalid_amount",
      `Payment of ${input.amountCents} cents would exceed the remaining balance (${invoice.total_cents - alreadyPaid} cents)`
    );
  }

  await db.batch([
    db.prepare(
      `INSERT INTO payments (invoice_id, amount_cents, payer_type, method, reference, notes, paid_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(invoiceId, input.amountCents, input.payerType, input.method, input.reference, input.notes, input.paidAt, actorId),
    db.prepare(
      `INSERT INTO invoice_audit (invoice_id, event_type, actor_user_id, details) VALUES (?, 'payment_recorded', ?, ?)`
    ).bind(invoiceId, actorId, JSON.stringify({
      amount_cents: input.amountCents, payer_type: input.payerType, method: input.method,
    })),
  ]);
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
