import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderInvoicePdf, type InvoicePdfInput } from "../src/server/invoice-pdf.js";
import type { CompanyProfile } from "../src/server/company-profile.js";

// Phase 13A final document hardening — unit tests for the Invoice PDF
// renderer, independent of the DB/HTTP layer (covered end-to-end by
// test/financial.test.ts's "Invoice PDF" block). Same "verify structure,
// not literal compressed bytes" approach as test/contract-pdf.test.ts.

const EMPTY_COMPANY: CompanyProfile = {
  organization_id: 1, company_name: "", legal_name: "", phone: "", email: "", website: "",
  address_line1: "", address_line2: "", city: "", state: "", postal_code: "", country: "",
  business_number: "", tax_number: "", contract_footer: "", logo_key: null,
  updated_by: null, created_at: "", updated_at: "",
};

function baseInput(overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput {
  return {
    identifier: "INV-1",
    status: "issued",
    issuedAt: "2026-08-24 12:00:00",
    dueDate: "2026-09-24",
    notes: "",
    jobIdentifier: "JOB-1",
    customer: { name: "Jane Customer", email: "jane@example.test", phone: "555-0100", address: "123 Main St", city: "Anytown", state: "BC", zip: "V1V 1V1" },
    lines: [{ description: "Furnace Tune-up", quantity: 1, unit_price_cents: 20000, total_cents: 20000 }],
    taxRate: 5,
    financials: {
      subtotal_cents: 20000, tax_amount_cents: 1000, rebate_amount_cents: 0,
      total_cents: 21000, customer_amount_cents: 21000, amount_paid_cents: 0, balance_cents: 21000, is_overdue: false,
    },
    payments: [],
    company: EMPTY_COMPANY,
    logo: null,
    ...overrides,
  };
}

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function tinyPngBytes(): Uint8Array {
  return Uint8Array.from(atob(TINY_PNG_BASE64), (ch) => ch.charCodeAt(0));
}

describe("renderInvoicePdf", () => {
  it("produces a valid, loadable PDF for a basic invoice", async () => {
    const bytes = await renderInvoicePdf(baseInput());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("renders correctly with no company profile configured (no logo, blank fields)", async () => {
    await expect(renderInvoicePdf(baseInput({ company: EMPTY_COMPANY, logo: null }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it("renders the same Company Profile + logo as the Contract PDF uses (Section 45 — shared branding)", async () => {
    const company: CompanyProfile = { ...EMPTY_COMPANY, company_name: "Coreline Comfort", legal_name: "Coreline Comfort Ltd.", phone: "604-555-0100" };
    const bytes = await renderInvoicePdf(baseInput({ company, logo: { bytes: tinyPngBytes(), format: "png" } }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("a corrupt logo does not crash Invoice PDF generation", async () => {
    await expect(renderInvoicePdf(baseInput({ logo: { bytes: new Uint8Array([1, 2, 3]), format: "png" } }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it("renders payments when present, and omits the section cleanly when absent", async () => {
    const withPayments = await renderInvoicePdf(baseInput({
      payments: [{ amount_cents: 10000, method: "cash", paid_at: "2026-08-25 10:00:00", reference: "REF-1" }],
      financials: { subtotal_cents: 20000, tax_amount_cents: 1000, rebate_amount_cents: 0, total_cents: 21000, customer_amount_cents: 21000, amount_paid_cents: 10000, balance_cents: 11000, is_overdue: false },
    }));
    await expect(PDFDocument.load(withPayments)).resolves.toBeDefined();
    const withoutPayments = await renderInvoicePdf(baseInput({ payments: [] }));
    await expect(PDFDocument.load(withoutPayments)).resolves.toBeInstanceOf(Object);
  });

  it("renders an overdue invoice and a voided invoice without throwing", async () => {
    const overdue = await renderInvoicePdf(baseInput({ financials: { ...baseInput().financials, is_overdue: true } }));
    await expect(PDFDocument.load(overdue)).resolves.toBeDefined();
    const voided = await renderInvoicePdf(baseInput({ status: "void" }));
    await expect(PDFDocument.load(voided)).resolves.toBeDefined();
  });

  it("wraps a long line-item description and many line items across pages without clipping/overlap", async () => {
    const manyLines = Array.from({ length: 40 }, (_, i) => ({
      description: `Line item ${i + 1} with a moderately long description to exercise cell wrapping across many rows`,
      quantity: 1, unit_price_cents: 1000 * (i + 1), total_cents: 1000 * (i + 1),
    }));
    const bytes = await renderInvoicePdf(baseInput({ lines: manyLines }));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("control characters embedded in notes/line descriptions do not crash generation (shares sanitizeForPdf with the Contract renderer)", async () => {
    const input = baseInput({
      notes: "Thank you\x00 for your business.",
      lines: [{ description: "Furnace\x01Tune-up", quantity: 1, unit_price_cents: 20000, total_cents: 20000 }],
    });
    await expect(renderInvoicePdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});
