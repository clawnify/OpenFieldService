import { ConflictError } from "@/lib/errors";

export type LedgerAmount = { entryType: "payment" | "reversal"; amountCents: number };
export function effectiveAmountPaid(entries: readonly LedgerAmount[]): number {
  const value = entries.reduce((sum, entry) => sum + (entry.entryType === "payment" ? entry.amountCents : -entry.amountCents), 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new ConflictError("Payment ledger does not reconcile");
  return value;
}
export function reconciledInvoiceStatus(totalCents: number, paidCents: number): "issued" | "partially_paid" | "paid" {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !Number.isSafeInteger(paidCents) || paidCents < 0 || paidCents > totalCents) throw new ConflictError("Payment ledger does not reconcile");
  if (paidCents === 0) return "issued";
  return paidCents === totalCents ? "paid" : "partially_paid";
}
export function paymentBusinessDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}
