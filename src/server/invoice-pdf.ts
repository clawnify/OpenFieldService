import type { CompanyProfile } from "./company-profile.js";
import type { TaxSnapshot } from "./tax-jurisdiction.js";
import {
  ACCENT, CONTENT_WIDTH, INK, MARGIN, MUTED, PAGE_WIDTH, PdfWriter,
  formatDateOnly, formatDateTime, formatMoney, sanitizeForPdf,
} from "./pdf-writer.js";

/**
 * Phase 13A final document hardening — the professional Invoice PDF.
 *
 * LIFECYCLE DECISION (Section 43, explicitly required to be documented):
 * rendered LIVE, from current invoice/line/payment state, on every
 * View/Download/Print request — never stored, never hashed, no
 * "immutable snapshot" concept. This is a deliberate departure from the
 * signed Contract PDF's model, not an oversight:
 *
 *   - Invoices remain genuinely mutable after creation/issuance in this
 *     codebase's existing design — `rebate_amount_cents` is editable post-
 *     issue, and `financial.ts#getInvoiceFinancials()` computes
 *     amount_paid/balance FRESH from the payments table on every read,
 *     by explicit design (see that module's own docstring: "never cached
 *     on the invoice row... so balance_cents can never silently disagree
 *     with the actual payment history"). A snapshot-at-issue PDF would
 *     immediately go stale the moment a payment is recorded, and there is
 *     no precedent anywhere in this codebase for a "reissue a new
 *     snapshot" flow for invoices the way Contract Revisions exist for
 *     contracts.
 *   - A Contract's signature is a one-time legal event with a real
 *     "moment it became final" — an Invoice's balance is an ongoing
 *     financial fact that customers legitimately need to see reflect
 *     partial payments over time. Live rendering is MORE correct here,
 *     not less.
 *
 * Reuses pdf-writer.ts (the same document-neutral kernel contract-pdf.ts
 * uses) and the same Company Profile + logo as the Contract PDF (Section
 * 45: "Invoice must use the same Company Profile and Logo. Do not create
 * separate branding settings").
 */

export interface InvoicePdfLine { description: string; quantity: number; unit_price_cents: number; total_cents: number }
export interface InvoicePdfPayment { amount_cents: number; method: string; paid_at: string; reference: string }

export interface InvoicePdfInput {
  identifier: string;
  status: string;
  issuedAt: string | null;
  dueDate: string;
  notes: string;
  jobIdentifier: string | null;
  customer: { name: string; email: string; phone: string; address: string; city: string; state: string; zip: string };
  lines: InvoicePdfLine[];
  taxRate: number;
  // Phase 13D — the persisted per-component breakdown for THIS invoice
  // (never re-derived from today's Tax Profile). null for a pre-Phase-13D
  // invoice, in which case `taxRate` above is the only tax detail that was
  // ever actually recorded.
  taxBreakdown: TaxSnapshot | null;
  financials: {
    subtotal_cents: number; tax_amount_cents: number; rebate_amount_cents: number;
    total_cents: number; customer_amount_cents: number; amount_paid_cents: number; balance_cents: number; is_overdue: boolean;
  };
  payments: InvoicePdfPayment[];
  company: CompanyProfile;
  logo?: { bytes: Uint8Array; format: "png" | "jpeg" } | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", issued: "Issued", partially_paid: "Partially Paid", paid: "Paid", void: "Void",
};

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const company = input.company;

  // ── Header — identical branding source/logic to the Contract PDF ────
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
  const idLine = [
    company.business_number ? `Business #: ${company.business_number}` : "",
    company.tax_number ? `Tax #: ${company.tax_number}` : "",
  ].filter(Boolean).join("   ");
  if (idLine) w.text(idLine, { size: 8, color: MUTED, x: textX });
  if (logo && textStartY - logo.height < w.y) w.y = textStartY - logo.height;
  w.hr();

  w.page.drawText("INVOICE", { x: MARGIN, y: w.y, size: 20, font: w.fonts.bold, color: ACCENT });
  const statusLabel = STATUS_LABELS[input.status] || input.status;
  const statusWidth = w.fonts.bold.widthOfTextAtSize(statusLabel.toUpperCase(), 10);
  w.page.drawText(statusLabel.toUpperCase(), { x: PAGE_WIDTH - MARGIN - statusWidth, y: w.y + 4, size: 10, font: w.fonts.bold, color: input.status === "void" ? MUTED : ACCENT });
  w.y -= 26;
  w.labelValue("Invoice #:", input.identifier);
  w.labelValue("Invoice Date:", input.issuedAt ? formatDateTime(input.issuedAt) : "Not yet issued");
  w.labelValue("Due Date:", input.dueDate ? formatDateOnly(input.dueDate) : "N/A");
  if (input.jobIdentifier) w.labelValue("Job:", input.jobIdentifier);
  w.spacer(10);

  // ── Bill To ─────────────────────────────────────────────────────────
  w.heading("Bill To");
  w.labelValue("Name:", input.customer.name);
  const custAddr = [input.customer.address, input.customer.city, input.customer.state, input.customer.zip].filter(Boolean).join(", ");
  if (custAddr) w.labelValue("Address:", custAddr);
  if (input.customer.email) w.labelValue("Email:", input.customer.email);
  if (input.customer.phone) w.labelValue("Phone:", input.customer.phone);
  w.spacer(10);

  // ── Line items ──────────────────────────────────────────────────────
  w.heading("Line Items");
  const colWidths = [CONTENT_WIDTH - 240, 60, 90, 90];
  w.table(
    ["Description", "Qty", "Unit Price", "Total"],
    input.lines.map((l) => [l.description, String(l.quantity), formatMoney(l.unit_price_cents), formatMoney(l.total_cents)]),
    colWidths,
    [false, true, true, true]
  );
  w.spacer(6);

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
  const f = input.financials;
  totalsRow("Subtotal", formatMoney(f.subtotal_cents));
  if (input.taxBreakdown && input.taxBreakdown.components.length > 0) {
    for (const comp of input.taxBreakdown.components) {
      if (comp.amount_cents) totalsRow(`${comp.name} (${comp.rate_percent}%)`, formatMoney(comp.amount_cents));
    }
  } else if (f.tax_amount_cents) {
    totalsRow(`Tax (${input.taxRate}%)`, formatMoney(f.tax_amount_cents));
  }
  if (f.rebate_amount_cents) totalsRow("Rebate", `-${formatMoney(f.rebate_amount_cents)}`);
  totalsRow("Invoice Total", formatMoney(f.total_cents), true);
  totalsRow("Amount Paid", formatMoney(f.amount_paid_cents));
  totalsRow("Balance Due", formatMoney(f.balance_cents), true);
  if (f.is_overdue) totalsRow("", "OVERDUE");
  w.spacer(14);

  // ── Payments ────────────────────────────────────────────────────────
  if (input.payments.length > 0) {
    w.heading("Payments");
    w.table(
      ["Date", "Method", "Reference", "Amount"],
      input.payments.map((p) => [formatDateTime(p.paid_at), p.method, p.reference || "—", formatMoney(p.amount_cents)]),
      [CONTENT_WIDTH - 300, 100, 100, 100],
      [false, false, false, true]
    );
    w.spacer(14);
  }

  // ── Notes ───────────────────────────────────────────────────────────
  if (input.notes) {
    w.heading("Notes");
    w.text(input.notes, { size: 9.5 });
    w.spacer(10);
  }

  w.finalizeFooters(`Invoice ${input.identifier} · Generated via Open Fieldservice`);

  return w.save();
}
