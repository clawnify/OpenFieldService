import { ConflictError, ValidationError } from "@/lib/errors";
import { calculateTax, type TaxComponentInput } from "@/modules/estimates/tax.rules";

export type InvoiceLineValue = { quantityMilli: number; unitPriceCents: number; taxable: boolean };
export function lineTotalCents(quantityMilli: number, unitPriceCents: number): number { return Number((BigInt(quantityMilli) * BigInt(unitPriceCents) + 500n) / 1000n); }
export function calculateInvoice(lines: InvoiceLineValue[], profile: { enabled: boolean; pricesIncludeTax: boolean; components: TaxComponentInput[] }) {
  const priced = lines.map(line => ({ amountCents: lineTotalCents(line.quantityMilli, line.unitPriceCents), taxable: line.taxable }));
  const tax = calculateTax(priced, profile);
  return { subtotalCents: tax.subtotalCents, discountCents: 0, taxCents: tax.totalTaxCents, totalCents: tax.totalCents, tax };
}
export function dueDateFor(issueDate: string, paymentTerms: "due_on_receipt" | "net_15" | "net_30" | "net_60" | "custom", explicit?: string | null): string {
  if (paymentTerms === "custom") { if (!explicit) throw new ValidationError("A custom due date is required"); if(explicit<issueDate)throw new ValidationError("Due date cannot precede the issue date"); return explicit; }
  const days = paymentTerms === "net_15" ? 15 : paymentTerms === "net_30" ? 30 : paymentTerms === "net_60" ? 60 : 0;
  const value = new Date(`${issueDate}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function invoiceBalance(totalCents: number, amountPaidCents: number): number { if (!Number.isInteger(amountPaidCents) || amountPaidCents < 0 || amountPaidCents > totalCents) throw new ConflictError("Posted payments do not reconcile with this Invoice"); return totalCents - amountPaidCents; }
export function isInvoiceOverdue(status: string, dueDate: string | null, balanceCents: number, today: string): boolean { return ["issued", "partially_paid"].includes(status) && balanceCents > 0 && !!dueDate && dueDate < today; }
export function assertDraft(status: string): void { if (status !== "draft") throw new ConflictError("Issued Invoice commercial content is immutable"); }
