import "server-only";
import type { DatabaseExecutor } from "@/db";
import type { InvoicePaymentLedger } from "@/modules/invoices/invoice.service";
import { PaymentRepository } from "./payment.repository";

export class PostgresInvoicePaymentLedger implements InvoicePaymentLedger {
  async amountPaidCents(organizationId: string, invoiceId: string, executor?: DatabaseExecutor): Promise<number> {
    return new PaymentRepository(executor).amountPaidCents(organizationId, invoiceId);
  }
}
