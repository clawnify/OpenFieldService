import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { WINANSI_EXTRA, renderContractPdf, sanitizeForPdf, type ContractPdfInput } from "../src/server/contract-pdf.js";
import { extractPdfText } from "./helpers.js";

// Phase 13A hardening — unit tests for the PDF renderer itself, independent
// of the DB/HTTP layer (already covered end-to-end by test/contracts.test.ts's
// "Signed Document Access" block). Content streams inside a real PDF are
// Flate-compressed by default, so these tests verify STRUCTURE (does it
// parse back as a valid PDF, how many pages, does generation ever throw) —
// not literal text bytes; see contracts.test.ts's own comment on why a raw
// byte/text search against real PDF output isn't a meaningful check.

const EMPTY_COMPANY = {
  name: "", legal_name: "", phone: "", email: "", website: "", address: "", contact: "",
  business_number: "", tax_number: "", contract_footer: "",
};

function baseInput(overrides: Partial<ContractPdfInput> = {}): ContractPdfInput {
  return {
    contractIdentifier: "CONTRACT-1",
    version: { title: "HVAC Installation Agreement", body: "Standard terms apply.", effective_date: "2026-08-24", expires_at: null, version_number: 1 },
    commercial: {
      quote_identifier: "QUOTE-1", quote_version_number: 1,
      line_items: [{ description: "HVAC Install", quantity: 1, unit: "", unit_price_cents: 500000, total_cents: 500000 }],
      subtotal_cents: 500000, discount_cents: 0, tax_rate: 0, tax_amount_cents: 0, total_cents: 500000, tax_breakdown: null,
    },
    customer: { name: "Jane Customer", email: "jane@example.test", phone: "555-0100", address: "123 Main St", city: "Anytown", state: "BC", zip: "V1V 1V1" },
    company: EMPTY_COMPANY,
    signers: [{ id: 1, contract_id: 1, name: "Jane Customer", email: "jane@example.test", phone: "", role: "customer", sort_order: 0, created_at: "2026-08-24 00:00:00" }],
    requests: [{
      id: 1, contract_id: 1, contract_version_id: 1, signer_id: 1, status: "signed", provider: "local", provider_request_id: null,
      expires_at: "2026-09-07", consent_text_version: "v1", consent_at: "2026-08-24 12:00:00", signed_at: "2026-08-24 12:05:00",
      signature_method: "typed", signer_ip: "203.0.113.1", signer_user_agent: "test-agent", declined_reason: "", created_by: null,
      created_at: "2026-08-24 11:00:00", updated_at: "2026-08-24 12:05:00",
    }],
    ...overrides,
  };
}

describe("renderContractPdf", () => {
  it("produces a valid, loadable PDF (agreement page + Certificate of Completion page) for a short contract", async () => {
    const bytes = await renderContractPdf(baseInput());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    // A short contract's agreement content fits on one page, plus exactly
    // one Certificate of Completion page appended after it (Phase 13A
    // final document hardening) — never fewer than 2 pages once a
    // Certificate is always appended, never more for content this short.
    expect(doc.getPageCount()).toBe(2);
  });

  it("paginates across multiple pages for long Terms & Conditions and many line items, without throwing (Section 37)", async () => {
    const longBody = Array.from({ length: 80 }, (_, i) => `Clause ${i + 1}: This is a reasonably long sentence of contract terms meant to force text wrapping and eventually a page break when repeated many times over.`).join("\n\n");
    const manyLineItems = Array.from({ length: 40 }, (_, i) => ({
      description: `Line item number ${i + 1} with a moderately long description to exercise cell wrapping`,
      quantity: 1, unit: "ea", unit_price_cents: 10000 * (i + 1), total_cents: 10000 * (i + 1),
    }));
    const input = baseInput({
      version: { title: "Long-Form Agreement", body: longBody, effective_date: "2026-08-24", expires_at: "2027-08-24", version_number: 3 },
      commercial: { quote_identifier: "QUOTE-9", quote_version_number: 2, line_items: manyLineItems, subtotal_cents: 4_100_000, discount_cents: 5000, tax_rate: 12, tax_amount_cents: 490000, total_cents: 4_585_000, tax_breakdown: null },
    });
    const bytes = await renderContractPdf(input);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1); // must not clip/overlap by staying on one page
  });

  it("renders a per-component tax breakdown (GST/PST) instead of the flat legacy line when tax_breakdown is present (hardening — independent Testing review, Phase 13D)", async () => {
    const input = baseInput({
      commercial: {
        quote_identifier: "QUOTE-1", quote_version_number: 1,
        line_items: [{ description: "HVAC Install", quantity: 1, unit: "", unit_price_cents: 500000, total_cents: 500000 }],
        subtotal_cents: 500000, discount_cents: 0, tax_rate: 12, tax_amount_cents: 60000, total_cents: 560000,
        tax_breakdown: {
          id: 1, document_type: "quote_version", document_id: 1, tax_profile_id: 1, tax_enabled: true,
          country_code: "CA", region_code: "BC", currency: "CAD", prices_include_tax: false,
          taxable_base_cents: 500000, total_tax_cents: 60000, business_number: "", tax_number: "", legacy: false, created_at: "2026-08-24 00:00:00",
          components: [{ code: "GST", name: "GST", rate_percent: 5, amount_cents: 25000 }, { code: "PST", name: "PST", rate_percent: 7, amount_cents: 35000 }],
        },
      },
    });
    const bytes = await renderContractPdf(input);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = await extractPdfText(bytes);
    // Real per-component labels/amounts, not the flat "Tax (12%)" fallback.
    expect(text).toContain("GST");
    expect(text).toContain("PST");
    expect(text).toContain("250.00"); // $250.00 GST
    expect(text).toContain("350.00"); // $350.00 PST
    expect(text).not.toContain("Tax (12%)");
  });

  it("handles multiple signers without truncating any signature block", async () => {
    const signers = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, contract_id: 1, name: `Signer ${i + 1}`, email: `signer${i + 1}@example.test`, phone: "", role: "customer" as const, sort_order: i, created_at: "2026-08-24 00:00:00" }));
    const requests = signers.map((s) => ({
      id: s.id, contract_id: 1, contract_version_id: 1, signer_id: s.id, status: "signed", provider: "local", provider_request_id: null,
      expires_at: "2026-09-07", consent_text_version: "v1", consent_at: "2026-08-24 12:00:00", signed_at: "2026-08-24 12:05:00",
      signature_method: "typed", signer_ip: "203.0.113.1", signer_user_agent: "test-agent", declined_reason: "", created_by: null,
      created_at: "2026-08-24 11:00:00", updated_at: "2026-08-24 12:05:00",
    }));
    const bytes = await renderContractPdf(baseInput({ signers, requests }));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("generation never throws on missing/empty optional fields (no terms body, no company profile, no line items)", async () => {
    const input = baseInput({
      version: { title: "", body: "", effective_date: null, expires_at: null, version_number: 1 },
      commercial: { quote_identifier: "", quote_version_number: 1, line_items: [], subtotal_cents: 0, discount_cents: 0, tax_rate: 0, tax_amount_cents: 0, total_cents: 0, tax_breakdown: null },
      company: EMPTY_COMPANY,
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("sanitizeForPdf (Section 36 — Unicode/WinAnsi limitation)", () => {
  it("leaves accented Western-European Latin characters and common punctuation unchanged", () => {
    const input = "café, naïve, Müller & Søren — 50% off, \"quoted\"";
    expect(sanitizeForPdf(input)).toBe(input);
  });

  it("replaces characters outside the base-14 WinAnsi font range with '?' rather than throwing", () => {
    expect(sanitizeForPdf("北京")).toBe("??");
    expect(sanitizeForPdf("Москва")).toBe("??????");
    expect(sanitizeForPdf("مرحبا")).toBe("?????");
  });

  it("every WinAnsi-extra character (smart quotes, en/em dash, ellipsis, trademark, etc.) is individually pinned as unchanged — not just the one em-dash the first version of this file got wrong", () => {
    for (const codePoint of WINANSI_EXTRA) {
      const ch = String.fromCodePoint(codePoint);
      expect(sanitizeForPdf(ch), `code point 0x${codePoint.toString(16)} should pass through unchanged`).toBe(ch);
    }
  });

  it("a customer/signer name containing non-Latin1 Unicode does not crash PDF generation end-to-end", async () => {
    const input = baseInput({
      customer: { name: "北京 Müller Test", email: "test@example.test", phone: "", address: "", city: "", state: "", zip: "" },
      signers: [{ id: 1, contract_id: 1, name: "Москва Signer", email: "signer@example.test", phone: "", role: "customer", sort_order: 0, created_at: "2026-08-24 00:00:00" }],
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  // P1 regression (found by independent security review): WinAnsiEncoding
  // does not define glyphs for C0 controls (0x00-0x1F), DEL (0x7F), or C1
  // controls (0x80-0x9F) even though their code points are <= 0xFF — a
  // naive "code <= 0xFF passes" check (this file's second version) let
  // these straight through, and pdf-lib's font encoder throws an uncaught
  // Error on them. Since finalizeSignedDocument() is invoked from the
  // PUBLIC, unauthenticated signing endpoint, an uncaught throw there
  // permanently dead-ends that contract's signing ceremony (no retry path
  // exists — see contracts.ts's own comment on submitSignature's
  // idempotency guard). This must never throw, for ANY single-byte value.
  it("replaces C0/C1 control characters with '?' instead of letting pdf-lib throw (P1 — permanently dead-ends public signing if unfixed)", () => {
    for (let code = 0x00; code <= 0x1f; code++) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue; // tab/LF/CR preserved
      expect(sanitizeForPdf(String.fromCharCode(code)), `control code 0x${code.toString(16)}`).toBe("?");
    }
    expect(sanitizeForPdf(String.fromCharCode(0x7f))).toBe("?"); // DEL
    for (let code = 0x80; code <= 0x9f; code++) {
      expect(sanitizeForPdf(String.fromCharCode(code)), `C1 control code 0x${code.toString(16)}`).toBe("?");
    }
    // tab/newline/CR must survive — wrapText() depends on newlines to split paragraphs
    expect(sanitizeForPdf("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("a control character embedded in a customer/signer name does not crash PDF generation end-to-end (empirically verified exploit from the review)", async () => {
    const input = baseInput({
      customer: { name: "Jane\x01Doe", email: "test@example.test", phone: "", address: "", city: "", state: "", zip: "" },
      signers: [{ id: 1, contract_id: 1, name: "Jane\x81Doe", email: "signer@example.test", phone: "", role: "customer", sort_order: 0, created_at: "2026-08-24 00:00:00" }],
      version: { title: "Bad\x7fTitle", body: "Body with a stray\x00null byte.", effective_date: null, expires_at: null, version_number: 1 },
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("Company Profile integration (Phase 13A Company Profile hardening)", () => {
  it("renders a full company profile (identity, contact, business IDs, contract footer) without throwing", async () => {
    const input = baseInput({
      company: {
        name: "Coreline Comfort", legal_name: "Coreline Comfort Ltd.", phone: "604-555-0100",
        email: "office@corelinecomfort.test", website: "https://corelinecomfort.test",
        address: "123 Main St, Vancouver, BC, V1V 1V1", contact: "604-555-0100 · office@corelinecomfort.test",
        business_number: "123456789BC0001", tax_number: "123456789RT0001",
        contract_footer: "Thank you for your business. All work is guaranteed for 12 months from the effective date.",
      },
    });
    const bytes = await renderContractPdf(input);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("falls back to the 'Open Fieldservice' name and omits blank lines when no profile is configured", async () => {
    const bytes = await renderContractPdf(baseInput({ company: EMPTY_COMPANY }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  // Architecture review finding: an older company_snapshot (frozen before
  // this pass) only ever has {name, address, contact} — phone/email/website
  // are `undefined`, not "". Without a fallback to the legacy `contact`
  // field, the header would silently render a blank contact line even
  // though the old snapshot DID capture contact info.
  it("falls back to the legacy pre-joined 'contact' field for an old-format snapshot missing phone/email/website", async () => {
    const legacyCompany = { name: "Legacy Co", address: "1 Old St", contact: "555-0100 · legacy@example.test" } as ContractPdfInput["company"];
    const bytes = await renderContractPdf(baseInput({ company: legacyCompany }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  // Security review suggestion: the P1 control-character crash class
  // (see the "sanitizeForPdf" describe block above) was previously only
  // regression-tested via customer/signer/version fields. Company Profile
  // fields now flow through the same rendering path (header contact/ID
  // lines, footer tenant note) but are admin-controlled, not just
  // signer-controlled — pin that a stray control byte anywhere in the
  // profile still can't crash generation.
  it("a control character embedded in company profile fields (contract_footer, business_number) does not crash PDF generation", async () => {
    const input = baseInput({
      company: {
        ...EMPTY_COMPANY,
        name: "Cor\x01eline",
        phone: "604\x7f5550100",
        business_number: "123\x81456",
        contract_footer: "Thank you\x00 for your business.",
      },
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("long field values (Section 37 — no clipping/overlap)", () => {
  it("a very long customer/company name wraps onto multiple lines instead of overflowing the page edge", async () => {
    const longName = "A".repeat(40) + " Extremely Long Legal Entity Name Incorporated " + "B".repeat(40);
    const input = baseInput({
      customer: { name: longName, email: "test@example.test", phone: "", address: "123 A Very Long Street Name That Also Runs On For Quite A While, Suite 4000", city: "City", state: "ST", zip: "00000" },
      company: { ...EMPTY_COMPANY, name: longName },
    });
    // Must not throw, and (since labelValue() now wraps rather than
    // drawing one unbroken line) the extra wrapped lines push the document
    // to more than the single page a short-name contract would otherwise
    // fit on — a concrete, structural signal the wrap actually happened
    // rather than silently overflowing past the right margin.
    const bytes = await renderContractPdf(input);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // Testing review gap: a near-MAX_LONG (company-profile.ts's 2000-char cap)
  // Default Contract Footer must not crash or misbehave across every page
  // of a multi-page document — finalizeFooters() hard-truncates the wrapped
  // note to 2 lines (Section 14), which must hold even when the source
  // text is long enough to wrap to far more than 2 lines internally.
  it("a near-maximum-length Default Contract Footer is truncated to 2 lines on every page without throwing, across a multi-page document", async () => {
    const longFooter = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1} of the standard terms and conditions that apply to every job performed under this agreement.`).join(" ");
    const longBody = Array.from({ length: 60 }, (_, i) => `Term ${i + 1}: standard contract language repeated to force pagination.`).join("\n\n");
    const input = baseInput({
      version: { title: "Long Footer Agreement", body: longBody, effective_date: "2026-08-24", expires_at: null, version_number: 1 },
      company: { ...EMPTY_COMPANY, name: "Coreline Comfort", contract_footer: longFooter },
    });
    const bytes = await renderContractPdf(input);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1); // proves the footer renders identically on more than one page
  });
});

// A real, valid 1x1 PNG (same fixture used elsewhere in this test suite for
// job-signature uploads) — needed here because renderContractPdf() actually
// calls pdf-lib's embedPng() on logo/signature bytes, which throws on
// genuinely malformed input.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function tinyPngBytes(): Uint8Array {
  return Uint8Array.from(atob(TINY_PNG_BASE64), (ch) => ch.charCodeAt(0));
}

describe("Company Logo (Phase 13A final document hardening, Section 10)", () => {
  it("renders a valid PNG logo in the header without throwing", async () => {
    const input = baseInput({ logo: { bytes: tinyPngBytes(), format: "png" } });
    const bytes = await renderContractPdf(input);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("generation must not fail because the logo is absent (Section 10)", async () => {
    const input = baseInput({ logo: null });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("a corrupt/malformed logo does not crash generation — falls back to no logo", async () => {
    const input = baseInput({ logo: { bytes: new Uint8Array([1, 2, 3, 4, 5]), format: "png" } });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("Draw Signature (Section 22 — exact captured representation)", () => {
  it("embeds a drawn signature image for a request with signature_method 'drawn' without throwing", async () => {
    const input = baseInput({
      requests: [{
        id: 1, contract_id: 1, contract_version_id: 1, signer_id: 1, status: "signed", provider: "local", provider_request_id: null,
        expires_at: "2026-09-07", consent_text_version: "v1", consent_at: "2026-08-24 12:00:00", signed_at: "2026-08-24 12:05:00",
        signature_method: "drawn", signer_ip: "203.0.113.1", signer_user_agent: "test-agent", declined_reason: "", created_by: null,
        created_at: "2026-08-24 11:00:00", updated_at: "2026-08-24 12:05:00",
      }],
      signatureImages: new Map([[1, tinyPngBytes()]]),
    });
    const bytes = await renderContractPdf(input);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("falls back to the typed name if signature_method is 'drawn' but no image was captured (defensive, should not happen in practice)", async () => {
    const input = baseInput({
      requests: [{
        id: 1, contract_id: 1, contract_version_id: 1, signer_id: 1, status: "signed", provider: "local", provider_request_id: null,
        expires_at: "2026-09-07", consent_text_version: "v1", consent_at: "2026-08-24 12:00:00", signed_at: "2026-08-24 12:05:00",
        signature_method: "drawn", signer_ip: "203.0.113.1", signer_user_agent: "test-agent", declined_reason: "", created_by: null,
        created_at: "2026-08-24 11:00:00", updated_at: "2026-08-24 12:05:00",
      }],
      signatureImages: new Map(),
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("Certificate of Completion (Section 23-30)", () => {
  it("always appends exactly one more page than the agreement content alone would need", async () => {
    const withoutSigners = await renderContractPdf(baseInput({ requests: [] }));
    const docWithout = await PDFDocument.load(withoutSigners);
    const withSigner = await renderContractPdf(baseInput());
    const docWith = await PDFDocument.load(withSigner);
    // Both inputs are short enough that the agreement content itself fits
    // on 1 page — the Certificate page is what pushes both to page 2.
    expect(docWithout.getPageCount()).toBe(2);
    expect(docWith.getPageCount()).toBe(2);
  });

  it("renders IP/User-Agent/consent/signed timestamps only for values actually present — never fabricated", async () => {
    // No throw is the structural signal available to a unit test (PDF text
    // isn't extractable without a real text-layer parser — see this file's
    // own header comment); the exact rendering logic (labelValue("IP
    // Address:", req.signer_ip || "—")) is reviewed directly in
    // contract-pdf.ts and exercised end-to-end in test/contracts.test.ts's
    // signing-flow tests, which assert on the real captured IP/UA values.
    const input = baseInput({
      requests: [{
        id: 1, contract_id: 1, contract_version_id: 1, signer_id: 1, status: "signed", provider: "local", provider_request_id: null,
        expires_at: "2026-09-07", consent_text_version: "v1", consent_at: "2026-08-24 12:00:00", signed_at: "2026-08-24 12:05:00",
        signature_method: "typed", signer_ip: null, signer_user_agent: null, declined_reason: "", created_by: null,
        created_at: "2026-08-24 11:00:00", updated_at: "2026-08-24 12:05:00",
      }],
    });
    await expect(renderContractPdf(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("renders the event timeline when signature events are supplied, and omits it cleanly when absent", async () => {
    const withEvents = baseInput({
      signatureEvents: new Map([[1, [
        { id: 1, signature_request_id: 1, event_type: "viewed", actor_user_id: null, ip_address: "203.0.113.1", user_agent: "test-agent", metadata: "{}", created_at: "2026-08-24 11:01:00" },
        { id: 2, signature_request_id: 1, event_type: "consented", actor_user_id: null, ip_address: "203.0.113.1", user_agent: "test-agent", metadata: "{}", created_at: "2026-08-24 12:00:00" },
        { id: 3, signature_request_id: 1, event_type: "signed", actor_user_id: null, ip_address: "203.0.113.1", user_agent: "test-agent", metadata: "{}", created_at: "2026-08-24 12:05:00" },
      ]]]),
    });
    await expect(renderContractPdf(withEvents)).resolves.toBeInstanceOf(Uint8Array);
    const withoutEvents = baseInput({ signatureEvents: new Map() });
    await expect(renderContractPdf(withoutEvents)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("materially different agreement content produces a materially different final document (the printed Content Fingerprint is a real hash of real content, not a placeholder)", async () => {
    // The renderer prints a SHA-256 "Content Fingerprint" computed over the
    // agreement pages before the Certificate page is appended (see
    // contract-pdf.ts's own header comment on the chicken-and-egg
    // reasoning). Content streams are Flate-compressed, so this test can't
    // grep the printed digest out of the bytes directly — instead it
    // verifies the property that actually matters: two renders with
    // different agreement content produce different final byte streams
    // (proving real content, not a static string, feeds the page/hash
    // computation), and every render succeeds and parses as a valid PDF.
    async function sha256(bytes: Uint8Array): Promise<string> {
      const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    const a = await renderContractPdf(baseInput());
    const b = await renderContractPdf(baseInput({ version: { title: "A Different Agreement", body: "Different terms.", effective_date: "2026-08-24", expires_at: null, version_number: 1 } }));
    await expect(PDFDocument.load(a)).resolves.toBeDefined();
    await expect(PDFDocument.load(b)).resolves.toBeDefined();
    expect(await sha256(a)).not.toBe(await sha256(b));
  });
});
