import type { CompanyProfile } from "./company-profile.js";
import {
  ACCENT, INK, MARGIN, MUTED, PAGE_WIDTH, PdfWriter,
  formatDateTime, formatMoney, sanitizeForPdf,
} from "./pdf-writer.js";

/**
 * Phase 13B — the professional Payment Receipt (Section 21-23).
 *
 * LIFECYCLE DECISION (Section 23, explicitly required to be documented):
 * like the Invoice PDF, rendered LIVE on every View/Download/Print/email
 * request — no stored/hashed artifact, no immutable-snapshot concept.
 *
 *   - The FINANCIAL FACTS a receipt documents (amount, method, payer,
 *     reference, paid-at timestamp) are read straight off one specific
 *     `payments` row, which is itself already immutable once created
 *     (financial.ts's module doc: "payments are immutable once created —
 *     no direct edit endpoint. Correcting a mistake is void-then-
 *     re-record, not in-place mutation") — so THOSE fields can never
 *     drift between two renders of the same receipt.
 *   - "Total Paid" / "Remaining Balance" are deliberately CURRENT
 *     invoice-level figures (computed live via getInvoiceFinancials(),
 *     the exact same call the Invoice PDF itself makes), not a frozen
 *     point-in-time reconstruction of "the balance as of that payment's
 *     moment" — reconstructing that would require an ambiguous same-
 *     timestamp payment ordering the payments table doesn't guarantee,
 *     and the Invoice PDF sitting right next to this receipt already
 *     shows current totals, so a frozen number here would just as often
 *     read as confusingly stale as it would read as historically precise.
 *   - Unlike the signed Contract PDF, a receipt is not evidence of a
 *     legal agreement moment — it is a courtesy/bookkeeping document.
 *     Live rendering avoids a redundant storage/hashing mechanism for a
 *     document whose only genuinely-immutable inputs (the payment row)
 *     are already immutable at the database level.
 *
 * Reuses pdf-writer.ts and the same Company Profile + logo as the
 * Contract/Invoice PDFs (Section 36: no duplicate branding configuration).
 */

export interface ReceiptPdfInput {
  paymentId: number;
  invoiceIdentifier: string;
  invoiceTotalCents: number;
  customerName: string;
  amountCents: number;
  payerType: string;
  method: string;
  reference: string;
  paidAt: string;
  receivedBy: string;
  source: string;
  voided: boolean;
  totalPaidCents: number;
  balanceCents: number;
  company: CompanyProfile;
  logo?: { bytes: Uint8Array; format: "png" | "jpeg" } | null;
}

const PAYER_TYPE_LABELS: Record<string, string> = { customer: "Customer", government: "Government Rebate", third_party: "Third Party" };
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", check: "Check", credit_card: "Credit Card", debit_card: "Debit Card",
  e_transfer: "E-Transfer", bank_transfer: "Bank Transfer", financing: "Financing", other: "Other",
};
const SOURCE_LABELS: Record<string, string> = { manual: "Manual / On-site", online_provider: "Online Payment" };

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const company = input.company;

  // ── Header — identical branding source/logic to the Contract/Invoice PDFs ──
  let logo: { width: number; height: number } | null = null;
  if (input.logo && input.logo.bytes.length > 0) {
    logo = await w.drawImage(input.logo.bytes, input.logo.format);
  }
  const textX = logo ? MARGIN + logo.width + 12 : MARGIN;
  const textStartY = w.y;
  const companyName = company.company_name || company.legal_name || "Open Fieldservice";
  w.page.drawText(sanitizeForPdf(companyName), { x: textX, y: w.y, size: 16, font: w.fonts.bold, color: INK });
  w.y -= 20;
  if (company.legal_name && company.legal_name !== companyName) {
    w.text(company.legal_name, { size: 9, color: MUTED, italic: true, x: textX });
  }
  const address = [company.address_line1, company.address_line2, company.city, company.state, company.postal_code, company.country]
    .filter(Boolean).join(", ");
  if (address) w.text(address, { size: 9, color: MUTED, x: textX });
  const contact = [company.phone, company.email, company.website].filter(Boolean).join("  ·  ");
  if (contact) w.text(contact, { size: 9, color: MUTED, x: textX });
  if (logo && textStartY - logo.height < w.y) w.y = textStartY - logo.height;
  w.hr();

  w.page.drawText("PAYMENT RECEIPT", { x: MARGIN, y: w.y, size: 20, font: w.fonts.bold, color: ACCENT });
  if (input.voided) {
    const label = "VOIDED";
    const labelWidth = w.fonts.bold.widthOfTextAtSize(label, 10);
    w.page.drawText(label, { x: PAGE_WIDTH - MARGIN - labelWidth, y: w.y + 4, size: 10, font: w.fonts.bold, color: MUTED });
  }
  w.y -= 26;
  w.labelValue("Receipt / Payment ID:", `#${input.paymentId}`);
  w.labelValue("Invoice #:", input.invoiceIdentifier);
  w.labelValue("Customer:", input.customerName || "—");
  w.labelValue("Payment Date:", formatDateTime(input.paidAt));
  w.labelValue("Payment Method:", METHOD_LABELS[input.method] || input.method);
  w.labelValue("Payer:", PAYER_TYPE_LABELS[input.payerType] || input.payerType);
  if (input.reference) w.labelValue("Reference:", input.reference);
  w.labelValue("Source:", SOURCE_LABELS[input.source] || input.source);
  if (input.receivedBy) w.labelValue("Received By:", input.receivedBy);
  w.spacer(12);

  const totalsX = PAGE_WIDTH - MARGIN - 200;
  const totalsRow = (rawLabel: string, rawValue: string, bold = false) => {
    const label = sanitizeForPdf(rawLabel);
    const value = sanitizeForPdf(rawValue);
    w.ensureSpace(14);
    w.page.drawText(label, { x: totalsX, y: w.y, size: 9, font: bold ? w.fonts.bold : w.fonts.regular, color: bold ? INK : MUTED });
    const valW = (bold ? w.fonts.bold : w.fonts.regular).widthOfTextAtSize(value, 9);
    w.page.drawText(value, { x: PAGE_WIDTH - MARGIN - valW, y: w.y, size: 9, font: bold ? w.fonts.bold : w.fonts.regular, color: INK });
    w.y -= 14;
  };
  totalsRow("Invoice Total", formatMoney(input.invoiceTotalCents));
  totalsRow("This Payment", formatMoney(input.amountCents), true);
  w.spacer(4);
  totalsRow("Total Paid to Date", formatMoney(input.totalPaidCents));
  totalsRow("Remaining Balance", formatMoney(input.balanceCents), true);
  w.spacer(14);

  if (input.voided) {
    w.heading("Notice");
    w.text("This payment has been voided and does not count toward the invoice balance shown above.", { size: 9.5, color: MUTED });
    w.spacer(10);
  }

  w.text(
    "This receipt confirms payment as recorded by Open Fieldservice. It is a technical record for bookkeeping purposes.",
    { size: 8, italic: true, color: MUTED }
  );

  w.finalizeFooters(`Receipt for Invoice ${input.invoiceIdentifier} · Payment #${input.paymentId} · Generated via Open Fieldservice`);

  return w.save();
}
