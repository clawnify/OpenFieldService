import type { CompanyProfile } from "./company-profile.js";
import type { QuoteOption, QuoteOptionLineItem } from "./quote-options.js";
import {
  ACCENT, INK, MARGIN, MUTED, PdfWriter,
  formatDateOnly, formatMoney,
} from "./pdf-writer.js";

/**
 * Phase 18 — professional, customer-facing Good/Better/Best Estimate PDF.
 * Uses the same document-neutral pdf-writer.ts kernel as Contract/Invoice
 * PDFs (Section 39: "Use shared PDF kernel where possible").
 *
 * Snapshot policy (Section 40 — "document exactly, don't imply
 * immutability if not implemented"): rendered LIVE on every request from
 * the CURRENT quote/option data, the SAME lifecycle decision already made
 * for the Invoice PDF (invoice-pdf.ts's own header comment) — there is no
 * "frozen at send" artifact/R2 storage for this document, unlike the
 * signed Contract PDF. This is safe precisely BECAUSE of the real
 * historical-integrity mechanism elsewhere in this phase: an Estimate's
 * OWN option/line-item data never changes after being shown to a customer
 * except through the ordinary draft-only edit routes (which are
 * unavailable once the quote is sent) — the PDF simply reflects whatever
 * that already-immutable-once-sent data currently says, the same relationship
 * Invoice already has to its own line items.
 *
 * Never renders cost/margin/internal notes — the caller (quote-options.ts's
 * `getEstimatePdfBytes`) only ever passes this function the SAME
 * public-safe option shape the customer's own comparison page receives.
 */

export interface EstimatePdfInput {
  quoteIdentifier: string;
  status: string;
  expiresAt: string | null;
  customer: { name: string; email: string; phone: string; address: string; city: string; state: string; zip: string };
  company: CompanyProfile;
  options: (Omit<QuoteOption, "internal_notes"> & { line_items: Omit<QuoteOptionLineItem, "cost_cents">[] })[];
  logo?: { bytes: Uint8Array; format: "png" | "jpeg" } | null;
}

const TIER_LABELS: Record<string, string> = { GOOD: "Good", BETTER: "Better", BEST: "Best", CUSTOM: "Option" };

export async function renderEstimatePdf(input: EstimatePdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const company = input.company;

  let logo: { width: number; height: number } | null = null;
  if (input.logo && input.logo.bytes.length > 0) {
    logo = await w.drawImage(input.logo.bytes, input.logo.format);
  }
  const textX = logo ? MARGIN + logo.width + 12 : MARGIN;
  const textStartY = w.y;
  w.page.drawText(company.company_name || company.legal_name || "Estimate", { x: textX, y: w.y, size: 16, font: w.fonts.bold, color: ACCENT });
  w.y -= 18;
  const contactLine = [company.phone, company.email].filter(Boolean).join("  ·  ");
  if (contactLine) { w.page.drawText(contactLine, { x: textX, y: w.y, size: 9, font: w.fonts.regular, color: MUTED }); w.y -= 14; }
  if (logo && textStartY - logo.height < w.y) w.y = textStartY - logo.height;
  w.spacer(10);
  w.hr();

  w.text(`Estimate ${input.quoteIdentifier}`, { size: 18, bold: true });
  w.spacer(4);
  w.labelValue("Prepared For:", input.customer.name);
  const addressLine = [input.customer.address, input.customer.city, input.customer.state, input.customer.zip].filter(Boolean).join(", ");
  if (addressLine) w.labelValue("Address:", addressLine);
  w.labelValue("Status:", input.status.charAt(0).toUpperCase() + input.status.slice(1));
  if (input.expiresAt) w.labelValue("Valid Until:", formatDateOnly(input.expiresAt));
  w.spacer(10);

  for (const option of input.options) {
    w.hr();
    const tierLabel = `${TIER_LABELS[option.tier] || option.tier}${option.name ? ` — ${option.name}` : ""}${option.recommended ? "  (Recommended)" : ""}`;
    w.heading(tierLabel);
    if (option.headline) w.text(option.headline, { italic: true, size: 10, color: MUTED });
    if (option.description) { w.spacer(2); w.text(option.description, { size: 10 }); }

    if (option.highlights.length > 0) {
      w.spacer(4);
      w.text(option.highlights.map((h) => `• ${h}`).join("   "), { size: 9, color: MUTED });
    }

    w.spacer(8);
    const rows = option.line_items.map((line) => [
      line.description || "Item",
      line.quantity !== 1 ? String(line.quantity) : "",
      formatMoney(line.unit_price_cents),
      formatMoney(line.total_cents),
    ]);
    if (rows.length > 0) {
      w.table(["Description", "Qty", "Unit Price", "Total"], rows, [260, 60, 90, 94], [false, true, true, true]);
    }

    w.spacer(6);
    if (option.discount_cents > 0) {
      w.page.drawText(`Subtotal: ${formatMoney(option.subtotal_cents + option.discount_cents)}`, { x: MARGIN, y: w.y, size: 9, font: w.fonts.regular, color: MUTED });
      w.y -= 12;
      w.page.drawText(`Discount: -${formatMoney(option.discount_cents)}`, { x: MARGIN, y: w.y, size: 9, font: w.fonts.regular, color: MUTED });
      w.y -= 12;
    }
    if (option.tax_amount_cents > 0) {
      w.page.drawText(`Subtotal: ${formatMoney(option.subtotal_cents)}`, { x: MARGIN, y: w.y, size: 9, font: w.fonts.regular, color: MUTED });
      w.y -= 12;
      w.page.drawText(`Tax: ${formatMoney(option.tax_amount_cents)}`, { x: MARGIN, y: w.y, size: 9, font: w.fonts.regular, color: MUTED });
      w.y -= 12;
    }
    w.page.drawText(`Total: ${formatMoney(option.total_cents)}`, { x: MARGIN, y: w.y, size: 12, font: w.fonts.bold, color: INK });
    w.y -= 20;
  }

  w.hr();
  w.text("This is an estimate, not an invoice. Prices are valid until the date shown above. Selecting an option and confirming acceptance moves this estimate forward to a service agreement.", { size: 8, color: MUTED });

  w.finalizeFooters(`Estimate ${input.quoteIdentifier}`, company.contract_footer);
  return w.save();
}
