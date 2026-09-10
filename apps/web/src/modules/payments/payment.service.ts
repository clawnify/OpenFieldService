import "server-only";
import { authorize } from "@/auth/authorization";
import { getDb } from "@/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { AuditRepository } from "@/modules/audit/audit.repository";
import type { RequestActor } from "@/modules/customers/customer.service";
import { parseEntityId } from "@/modules/crm/crm.helpers";
import { PaymentRepository } from "./payment.repository";
import { paymentFilterSchema, postPaymentSchema, reversePaymentSchema } from "./payment.schema";
import { paymentBusinessDate, reconciledInvoiceStatus } from "./payment.rules";

const samePosting = (existing: Awaited<ReturnType<PaymentRepository["findIdempotent"]>>, invoiceId: string, input: ReturnType<typeof postPaymentSchema.parse>) => !!existing && existing.entryType === "payment" && existing.invoiceId === invoiceId && existing.amountCents === input.amountCents && existing.payerType === input.payerType && existing.method === input.method && existing.source === input.source && (existing.externalReference ?? undefined) === input.externalReference;

export class PaymentService {
  private async reconcile(repository: PaymentRepository, invoice: NonNullable<Awaited<ReturnType<PaymentRepository["invoice"]>>>, actorUserId: string) {
    const paid = await repository.amountPaidCents(invoice.organizationId, invoice.id);
    const next = reconciledInvoiceStatus(invoice.totalCents, paid);
    if (invoice.status !== "void" && invoice.status !== next) {
      const changed = await repository.setInvoiceStatus(invoice.organizationId, invoice.id, next);
      if (!changed) throw new ConflictError("Invoice changed concurrently");
      await repository.history({ organizationId: invoice.organizationId, invoiceId: invoice.id, fromStatus: invoice.status, toStatus: next, actorUserId, reason: "Payment ledger reconciliation" });
    }
    return { amountPaidCents: paid, balanceCents: invoice.totalCents - paid, invoiceStatus: invoice.status === "void" ? "void" as const : next };
  }

  async post(actor: RequestActor, invoiceId: string, raw: unknown) {
    await authorize(actor, "payment.create");
    invoiceId = parseEntityId(invoiceId);
    const input = parseInput(postPaymentSchema, raw);
    try {
      return await getDb().transaction(async tx => {
        const repository = new PaymentRepository(tx);
        const invoice = await repository.invoice(actor.organizationId, invoiceId, true);
        if (!invoice) throw new NotFoundError("Invoice not found");
        if (input.idempotencyKey) {
          const existing = await repository.findIdempotent(actor.organizationId, input.source, input.idempotencyKey);
          if (existing) {
            if (!samePosting(existing, invoiceId, input)) throw new ConflictError("Idempotency key was already used for different payment facts");
            return { payment: existing, financials: await this.reconcile(repository, invoice, actor.userId), idempotent: true };
          }
        }
        if (!["issued", "partially_paid"].includes(invoice.status)) throw new ConflictError(`Payments cannot be posted against a ${invoice.status} Invoice`);
        if (input.source !== "manual") throw new ConflictError("Provider posting requires a configured server-side provider adapter");
        const alreadyPaid = await repository.amountPaidCents(actor.organizationId, invoiceId);
        if (input.amountCents > invoice.totalCents - alreadyPaid) throw new ConflictError("Payment exceeds the remaining Invoice balance");
        const postedAt = input.postedAt ?? new Date();
        const customer = JSON.parse(invoice.billingSnapshot) as { customerId?: string; name?: string };
        const payment = await repository.create({ organizationId: actor.organizationId, invoiceId, entryType: "payment", amountCents: input.amountCents, currency: invoice.currency, payerType: input.payerType, payerSnapshot: JSON.stringify({ payerType: input.payerType, customerId: customer.customerId, customerName: input.payerType === "customer" ? customer.name : undefined }), method: input.method, source: input.source, externalReference: input.externalReference, idempotencyKey: input.idempotencyKey, receivedBy: input.receivedBy, notes: input.notes, postedAt, businessDate: paymentBusinessDate(postedAt), recordedBy: actor.userId });
        const financials = await this.reconcile(repository, invoice, actor.userId);
        await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "payment.posted", entityType: "payment", entityId: payment.id, metadata: { invoiceId, amountCents: payment.amountCents, currency: payment.currency, payerType: payment.payerType, method: payment.method, source: payment.source } });
        return { payment, financials, idempotent: false };
      });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) throw error;
      if (error instanceof Error && /payments_idempotency_unique/.test(error.message) && input.idempotencyKey) {
        const existing = await new PaymentRepository().findIdempotent(actor.organizationId, input.source, input.idempotencyKey);
        if (samePosting(existing, invoiceId, input)) return { payment: existing!, financials: await this.financials(actor, invoiceId), idempotent: true };
        throw new ConflictError("Idempotency key was already used");
      }
      throw error;
    }
  }

  async reverse(actor: RequestActor, paymentId: string, raw: unknown) {
    await authorize(actor, "payment.reverse");
    paymentId = parseEntityId(paymentId);
    const input = parseInput(reversePaymentSchema, raw);
    try {
      return await getDb().transaction(async tx => {
        const repository = new PaymentRepository(tx);
        const initial = await repository.find(actor.organizationId, paymentId);
        if (!initial) throw new NotFoundError("Payment not found");
        const invoice = await repository.invoice(actor.organizationId, initial.invoiceId, true);
        if (!invoice) throw new NotFoundError("Invoice not found");
        const payment = await repository.find(actor.organizationId, paymentId, true);
        if (!payment || payment.entryType !== "payment") throw new ConflictError("Only an original payment can be reversed");
        if (await repository.reversalFor(actor.organizationId, paymentId)) throw new ConflictError("Payment is already reversed");
        const reversal = await repository.create({ organizationId: actor.organizationId, invoiceId: payment.invoiceId, entryType: "reversal", amountCents: payment.amountCents, currency: payment.currency, payerType: payment.payerType, payerSnapshot: payment.payerSnapshot, method: payment.method, source: payment.source, externalReference: payment.externalReference, receivedBy: payment.receivedBy, notes: "", postedAt: new Date(), businessDate: paymentBusinessDate(new Date()), recordedBy: actor.userId, reversesPaymentId: payment.id, reversalReason: input.reason });
        const financials = await this.reconcile(repository, invoice, actor.userId);
        await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "payment.reversed", entityType: "payment", entityId: payment.id, metadata: { invoiceId: payment.invoiceId, reversalId: reversal.id, amountCents: payment.amountCents, reason: input.reason } });
        return { payment, reversal, financials };
      });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) throw error;
      if (error instanceof Error && /payments_reversal_unique/.test(error.message)) throw new ConflictError("Payment is already reversed");
      throw error;
    }
  }

  async get(actor: RequestActor, id: string) { await authorize(actor, "payment.read"); id=parseEntityId(id); const repository = new PaymentRepository(), payment = await repository.find(actor.organizationId, id); if (!payment) throw new NotFoundError("Payment not found"); return { payment, reversal: payment.entryType === "payment" ? await repository.reversalFor(actor.organizationId, payment.id) : null, financials: await this.financials(actor, payment.invoiceId) }; }
  async listForInvoice(actor: RequestActor, invoiceId: string) { await authorize(actor, "payment.read"); invoiceId=parseEntityId(invoiceId); const repository = new PaymentRepository(); if (!await repository.invoice(actor.organizationId, invoiceId)) throw new NotFoundError("Invoice not found"); return repository.listForInvoice(actor.organizationId, invoiceId); }
  async list(actor: RequestActor, raw: unknown = {}) { await authorize(actor, "payment.read"); return new PaymentRepository().list(actor.organizationId, parseInput(paymentFilterSchema, raw)); }
  async financials(actor: RequestActor, invoiceId: string) { await authorize(actor, "payment.read"); invoiceId=parseEntityId(invoiceId); const repository = new PaymentRepository(), invoice = await repository.invoice(actor.organizationId, invoiceId); if (!invoice) throw new NotFoundError("Invoice not found"); const paid = await repository.amountPaidCents(actor.organizationId, invoiceId); return { amountPaidCents: paid, balanceCents: invoice.totalCents - paid, invoiceStatus: invoice.status }; }
  async receiptModel(actor: RequestActor, paymentId: string) {
    await authorize(actor, "payment.receipt.read");
    paymentId=parseEntityId(paymentId); const repository = new PaymentRepository(), payment = await repository.find(actor.organizationId, paymentId);
    if (!payment || payment.entryType !== "payment") throw new NotFoundError("Payment receipt not found");
    const invoice = await repository.invoice(actor.organizationId, payment.invoiceId);
    if (!invoice) throw new NotFoundError("Invoice not found");
    const customer = JSON.parse(invoice.billingSnapshot) as { name?: string };
    const reversal = await repository.reversalFor(actor.organizationId, payment.id), amountPaidCents = await repository.amountPaidCents(actor.organizationId, payment.invoiceId);
    return { paymentId: payment.id, invoiceIdentifier: invoice.identifier, customerName: customer.name ?? "Customer", amountCents: payment.amountCents, currency: payment.currency, payerType: payment.payerType, method: payment.method, source: payment.source, externalReference: payment.externalReference, receivedBy: payment.receivedBy, postedAt: payment.postedAt, reversed: !!reversal, reversalReason: reversal?.reversalReason ?? null, invoiceTotalCents: invoice.totalCents, amountPaidCents, balanceCents: invoice.totalCents - amountPaidCents };
  }
}
