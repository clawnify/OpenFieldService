import "server-only";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { customers, invoices, invoiceStatusHistory, payments } from "@/db/schema";

export type PaymentFilter = { invoiceId?: string; customerId?: string; method?: typeof payments.$inferSelect.method; source?: typeof payments.$inferSelect.source; from?: Date; to?: Date; search?: string; limit: number };

export class PaymentRepository {
  constructor(readonly db: DatabaseExecutor = getDb()) {}
  async invoice(organizationId: string, invoiceId: string, lock = false) {
    const query = this.db.select().from(invoices).where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId), sql`${invoices.archivedAt} is null`));
    return lock ? (await query.for("update"))[0] : (await query)[0];
  }
  async find(organizationId: string, id: string, lock = false) {
    const query = this.db.select().from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.id, id)));
    return lock ? (await query.for("update"))[0] : (await query)[0];
  }
  async findIdempotent(organizationId: string, source: typeof payments.$inferSelect.source, key: string) {
    return this.db.query.payments.findFirst({ where: and(eq(payments.organizationId, organizationId), eq(payments.source, source), eq(payments.idempotencyKey, key)) });
  }
  async reversalFor(organizationId: string, paymentId: string) {
    return this.db.query.payments.findFirst({ where: and(eq(payments.organizationId, organizationId), eq(payments.entryType, "reversal"), eq(payments.reversesPaymentId, paymentId)) });
  }
  async create(value: typeof payments.$inferInsert) { return (await this.db.insert(payments).values(value).returning())[0]!; }
  async amountPaidCents(organizationId: string, invoiceId: string) {
    const [row] = await this.db.select({ value: sql<number>`coalesce(sum(case when ${payments.entryType}='payment' then ${payments.amountCents} else -${payments.amountCents} end),0)` }).from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.invoiceId, invoiceId)));
    return Number(row?.value ?? 0);
  }
  async listForInvoice(organizationId: string, invoiceId: string) { return this.db.select().from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.invoiceId, invoiceId))).orderBy(desc(payments.postedAt), desc(payments.createdAt), desc(payments.id)); }
  async list(organizationId: string, input: PaymentFilter) {
    const filters = [eq(payments.organizationId, organizationId)];
    if (input.invoiceId) filters.push(eq(payments.invoiceId, input.invoiceId));
    if (input.customerId) filters.push(eq(invoices.customerId, input.customerId));
    if (input.method) filters.push(eq(payments.method, input.method));
    if (input.source) filters.push(eq(payments.source, input.source));
    if (input.from) filters.push(gte(payments.postedAt, input.from));
    if (input.to) filters.push(lte(payments.postedAt, input.to));
    if (input.search) filters.push(or(ilike(invoices.identifier, `%${input.search}%`), ilike(payments.externalReference, `%${input.search}%`), ilike(customers.name, `%${input.search}%`))!);
    return this.db.select({ payment: payments, invoiceIdentifier: invoices.identifier, customerName: customers.name }).from(payments)
      .innerJoin(invoices, and(eq(invoices.organizationId, payments.organizationId), eq(invoices.id, payments.invoiceId)))
      .innerJoin(customers, and(eq(customers.organizationId, invoices.organizationId), eq(customers.id, invoices.customerId)))
      .where(and(...filters)).orderBy(desc(payments.postedAt), desc(payments.id)).limit(input.limit);
  }
  async setInvoiceStatus(organizationId: string, invoiceId: string, status: "issued" | "partially_paid" | "paid") {
    return (await this.db.update(invoices).set({ status, rowVersion: sql`${invoices.rowVersion}+1`, updatedAt: new Date() }).where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId), sql`${invoices.status} in ('issued','partially_paid','paid')`)).returning())[0];
  }
  async history(value: typeof invoiceStatusHistory.$inferInsert) { return (await this.db.insert(invoiceStatusHistory).values(value).returning())[0]!; }
}
