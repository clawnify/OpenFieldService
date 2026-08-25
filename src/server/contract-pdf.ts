import type { CommercialSnapshot, CompanySnapshot, ContractSigner, ContractVersion, CustomerSnapshot, SignatureEvent, SignatureRequest } from "./contracts.js";
import {
  ACCENT, CONTENT_WIDTH, INK, MARGIN, MUTED, PAGE_WIDTH, PdfWriter, WINANSI_EXTRA,
  formatDateTime, formatMoney, sanitizeForPdf,
} from "./pdf-writer.js";

/**
 * Phase 13A hardening — renders the professional, customer-facing signed
 * Contract PDF. Generated exactly ONCE, at signing finalization
 * (contracts.ts#finalizeSignedDocument), from the immutable Contract
 * Version + the exact accepted Quote Version's commercial snapshot +
 * signer/signature-request evidence — never from live, mutable
 * Contract/Quote/Customer state. The resulting bytes are what gets hashed
 * and stored in R2; View/Download/Print all serve these exact bytes back,
 * never regenerating.
 *
 * Uses pdf-lib (see pdf-writer.ts's own header comment for the full
 * rationale/font-limitation disclosure — this file only adds Contract-
 * specific layout on top of that shared, document-neutral kernel).
 *
 * Does NOT embed its own SHA-256 hash of the FULL document — that would
 * require hashing the bytes before they exist (a chicken-and-egg problem
 * for any self-verifying static document). Instead the PDF prints a
 * stable, pre-known "Document ID" (`{identifier}-V{version_number}`), plus
 * a "Content Fingerprint" — a SHA-256 of the canonical underlying
 * agreement DATA (documentId + version + commercial/customer/company
 * snapshot fields), not of rendered PDF bytes (Section 28's "display
 * SHA-256 or a clearly labeled cryptographic fingerprint"). Hashing data
 * rather than bytes was a deliberate fix, not the original design: hashing
 * the PDF-so-far right before appending the Certificate page seemed like
 * it would sidestep the chicken-and-egg problem, but finalizeFooters()
 * (called once, at the very end) mutates EVERY page, including the
 * already-hashed agreement pages, by drawing footer text onto them — so
 * that byte-hash never actually matched the delivered artifact. The
 * canonical-data hash has no such problem: it's stable, real, and
 * verifiable against the exact data that produced the document. The
 * separate, authoritative hash of the ENTIRE final artifact
 * (signed_document_hash) still lives alongside it in the database, exposed
 * via the Evidence panel / signed-document route — this fingerprint is a
 * customer-facing convenience, not a replacement for that.
 */

/** One signer's drawn-signature PNG bytes, keyed by signature_request.id —
 *  only present for requests where signature_method === "drawn". Absent/
 *  undefined for "typed" (rendered as an italic name instead, unchanged
 *  behavior) or for a request with no captured image. */
export type SignatureImageMap = Map<number, Uint8Array>;
/** Append-only signature events per signature_request.id — used to render
 *  the Certificate of Completion's event timeline (Section 27). */
export type SignatureEventMap = Map<number, SignatureEvent[]>;

export interface ContractPdfInput {
  contractIdentifier: string;
  version: Pick<ContractVersion, "title" | "body" | "effective_date" | "expires_at" | "version_number">;
  commercial: CommercialSnapshot;
  customer: CustomerSnapshot;
  company: CompanySnapshot;
  signers: ContractSigner[];
  requests: SignatureRequest[];
  /** The org's logo (or null/undefined if none configured) — PNG or JPEG
   *  per the Company Profile logo upload validation (Section 8). */
  logo?: { bytes: Uint8Array; format: "png" | "jpeg" } | null;
  signatureImages?: SignatureImageMap;
  signatureEvents?: SignatureEventMap;
}

/** Human-readable label for an event_type recorded in contract_signature_events
 *  — the Certificate's timeline only ever shows events that actually exist
 *  (Section 27: "only show events that actually exist"), so this is a pure
 *  display mapping, never a source of new claims. */
const EVENT_LABELS: Record<string, string> = {
  viewed: "Document viewed",
  consented: "Consent acknowledged",
  signed: "Document signed",
  declined: "Signature declined",
  request_expired: "Signing link expired",
};

export async function renderContractPdf(input: ContractPdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const documentId = `${input.contractIdentifier}-V${input.version.version_number}`;
  const signerById = new Map(input.signers.map((s) => [s.id, s]));

  // ── Content fingerprint (Section 28) ────────────────────────────────
  // A genuine SHA-256, independently recomputable by anyone with access
  // to the same underlying agreement DATA (the exact immutable
  // contract_versions.company_snapshot/customer_snapshot/
  // commercial_snapshot + version fields this function itself renders
  // from) — deliberately NOT a hash of rendered PDF bytes. An earlier
  // version of this function hashed the PDF-so-far right before adding
  // the Certificate page, but finalizeFooters() (called once, at the very
  // end) mutates EVERY page — including the already-hashed agreement
  // pages — by drawing footer text onto them, so that hash never actually
  // matched the delivered artifact (Architecture review finding, this
  // pass). Hashing the canonical input data instead sidesteps the
  // problem entirely: this fingerprint is stable, real, and verifiable
  // against the data that produced the document, not a snapshot of
  // in-progress rendering state.
  const fingerprintDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      documentId, version: input.version, commercial: input.commercial, customer: input.customer, company: input.company,
    })).buffer as ArrayBuffer
  );
  const contentFingerprint = Array.from(new Uint8Array(fingerprintDigest)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // ── Header ──────────────────────────────────────────────────────────
  // Every field is optional and independently omitted if blank — this
  // renders correctly whether the tenant has configured a full Company
  // Profile, only a name, or nothing at all, and is equally safe reading
  // an OLDER signed version's frozen company_snapshot JSON from before the
  // Company Profile pass (which only ever had name/address/contact — the
  // newer fields are simply `undefined` on that object, treated the same
  // as "blank").
  const company = input.company;
  let logo: { width: number; height: number } | null = null;
  if (input.logo && input.logo.bytes.length > 0) {
    logo = await w.drawImage(input.logo.bytes, input.logo.format);
  }
  const textX = logo ? MARGIN + logo.width + 12 : MARGIN;
  const textStartY = w.y;
  w.page.drawText(sanitizeForPdf(company.name || "Open Fieldservice"), { x: textX, y: w.y, size: 16, font: w.fonts.bold, color: INK });
  w.y -= 20;
  if (company.legal_name && company.legal_name !== company.name) {
    w.text(company.legal_name, { size: 9, color: MUTED, italic: true, x: textX });
  }
  const addressLine = company.address || "";
  if (addressLine) w.text(addressLine, { size: 9, color: MUTED, x: textX });
  // Fall back to the pre-existing pre-joined `contact` field (phone/email
  // already combined) when the newer discrete phone/email/website fields
  // are all blank — true for every company_snapshot frozen before the
  // Company Profile pass, which only ever had {name, address, contact}.
  // Without this, an old signed version's header would silently lose
  // contact info it did have (Architecture review finding).
  const contactLine = [company.phone, company.email, company.website].filter(Boolean).join("  ·  ") || company.contact || "";
  if (contactLine) w.text(contactLine, { size: 9, color: MUTED, x: textX });
  const idLine = [
    company.business_number ? `Business #: ${company.business_number}` : "",
    company.tax_number ? `Tax #: ${company.tax_number}` : "",
  ].filter(Boolean).join("   ");
  if (idLine) w.text(idLine, { size: 8, color: MUTED, x: textX });
  if (!addressLine && !contactLine && !company.legal_name) {
    w.text("Company profile not yet configured", { size: 8, color: MUTED, italic: true, x: textX });
  }
  // If the logo is taller than the text block, don't let the next section
  // start under it.
  if (logo && textStartY - logo.height < w.y) w.y = textStartY - logo.height;
  w.hr();

  w.page.drawText("SIGNED SERVICE AGREEMENT", { x: MARGIN, y: w.y, size: 9, font: w.fonts.bold, color: MUTED });
  w.y -= 16;
  w.text(input.version.title || "Untitled Agreement", { size: 15, bold: true });
  w.spacer(6);
  w.labelValue("Contract ID:", input.contractIdentifier);
  w.labelValue("Version:", String(input.version.version_number));
  w.labelValue("Effective Date:", input.version.effective_date || "N/A");
  w.labelValue("Expires:", input.version.expires_at || "N/A");
  w.labelValue("Source Quote:", `${input.commercial.quote_identifier} (version ${input.commercial.quote_version_number})`);
  w.spacer(10);

  // ── Customer ────────────────────────────────────────────────────────
  w.heading("Customer");
  w.labelValue("Name:", input.customer.name);
  const addr = [input.customer.address, input.customer.city, input.customer.state, input.customer.zip].filter(Boolean).join(", ");
  if (addr) w.labelValue("Address:", addr);
  if (input.customer.email) w.labelValue("Email:", input.customer.email);
  if (input.customer.phone) w.labelValue("Phone:", input.customer.phone);
  w.spacer(10);

  // ── Commercial terms ────────────────────────────────────────────────
  w.heading("Commercial Terms (Accepted Quote)");
  const colWidths = [CONTENT_WIDTH - 240, 60, 90, 90];
  w.table(
    ["Description", "Qty", "Unit Price", "Total"],
    input.commercial.line_items.map((l) => [l.description, String(l.quantity), formatMoney(l.unit_price_cents), formatMoney(l.total_cents)]),
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
  totalsRow("Subtotal", formatMoney(input.commercial.subtotal_cents));
  if (input.commercial.discount_cents) totalsRow("Discount", `-${formatMoney(input.commercial.discount_cents)}`);
  if (input.commercial.tax_amount_cents) totalsRow(`Tax (${input.commercial.tax_rate}%)`, formatMoney(input.commercial.tax_amount_cents));
  totalsRow("Total", formatMoney(input.commercial.total_cents), true);
  w.spacer(14);

  // ── Terms & Conditions ──────────────────────────────────────────────
  w.heading("Terms & Conditions");
  w.text(input.version.body || "No additional terms were provided.", { size: 9.5 });
  w.spacer(14);

  // ── Signatures ──────────────────────────────────────────────────────
  w.heading("Signatures");
  if (input.requests.length === 0) {
    w.text("No signature requests were recorded for this version.", { size: 9, color: MUTED });
  }
  for (const req of input.requests) {
    const signer = signerById.get(req.signer_id);
    w.ensureSpace(90);
    // Draw Signature (Section 22): if a drawn-signature image was
    // captured for this request, embed the EXACT captured representation
    // — never substitute a typed name for it. Typed Signature (unchanged):
    // render the typed signer name in an italic "signature-style" font,
    // honestly — no drawn/wet signature exists for that method.
    const image = req.signature_method === "drawn" ? input.signatureImages?.get(req.id) : undefined;
    if (image) {
      const drawn = await w.drawImage(image, "png", 160, 50);
      if (!drawn) w.text(signer?.name || "Unknown signer", { size: 15, italic: true }); // corrupt image — fall back rather than silently omit
      else w.y -= drawn.height + 4;
    } else {
      w.text(signer?.name || "Unknown signer", { size: 15, italic: true });
    }
    w.text(`${signer?.role ?? ""}${signer?.email ? `  <${signer.email}>` : ""}`, { size: 8.5, color: MUTED });
    if (req.status === "signed") {
      const methodLabel = req.signature_method === "drawn" ? "drawn signature" : req.signature_method === "typed" ? "typed name" : req.signature_method ?? "unknown";
      w.text(`Signed electronically · ${formatDateTime(req.signed_at)} · method: ${methodLabel}`, { size: 8.5, color: MUTED });
      w.text(`Consent acknowledged · ${formatDateTime(req.consent_at)} · consent version ${req.consent_text_version}`, { size: 8.5, color: MUTED });
    } else {
      w.text(`Status: ${req.status}`, { size: 8.5, color: MUTED });
    }
    w.spacer(10);
  }

  // ── E-Sign summary ──────────────────────────────────────────────────
  w.heading("Electronic Signature Summary");
  w.text(`Document ID: ${documentId}`, { size: 9 });
  w.text("Electronically signed via Open Fieldservice.", { size: 9 });
  w.spacer(4);
  w.text(
    "This document is a technical record of electronic signature evidence. It is not a substitute for legal advice regarding enforceability in your jurisdiction.",
    { size: 8, color: MUTED, italic: true }
  );

  // ── Certificate of Completion (Section 23-30) ──────────────────────
  w.newPage();
  w.page.drawText("CERTIFICATE OF COMPLETION", { x: MARGIN, y: w.y, size: 16, font: w.fonts.bold, color: ACCENT });
  w.y -= 22;
  w.text("Electronic Signature Certificate", { size: 10, color: MUTED, italic: true });
  w.hr();

  w.heading("Document");
  w.labelValue("Document ID:", documentId);
  w.labelValue("Contract:", input.contractIdentifier);
  w.labelValue("Version:", String(input.version.version_number));
  w.labelValue("Source Quote:", `${input.commercial.quote_identifier} (version ${input.commercial.quote_version_number})`);
  w.labelValue("Content Fingerprint:", `SHA-256: ${contentFingerprint}`);
  w.text("Fingerprint computed over the agreement's underlying data (contract terms, commercial totals, customer and company details). The complete signed artifact's own byte-for-byte hash is available to authorized staff via the platform's Evidence record.", { size: 7.5, color: MUTED, italic: true });
  w.spacer(10);

  for (const req of input.requests) {
    const signer = signerById.get(req.signer_id);
    w.ensureSpace(90);
    w.heading(signer?.name || "Unknown signer");
    w.labelValue("Email:", signer?.email || "—");
    w.labelValue("Role:", signer?.role || "—");
    w.labelValue("Signature Method:", req.signature_method === "drawn" ? "Drawn signature" : req.signature_method === "typed" ? "Typed name" : req.signature_method ?? "—");
    w.labelValue("Consent Version:", req.consent_text_version || "—");
    w.labelValue("Consent Timestamp:", formatDateTime(req.consent_at));
    w.labelValue("Signed Timestamp:", formatDateTime(req.signed_at));
    // IP/User-Agent: ONLY the values actually captured during THIS signing
    // ceremony (contracts.ts records these from the real request at
    // consent/sign time, never inferred or substituted later — Section
    // 25/26). An empty value means none was captured, shown honestly as
    // "—", never fabricated.
    w.labelValue("IP Address:", req.signer_ip || "—");
    w.labelValue("User-Agent:", req.signer_user_agent || "—");

    const events = input.signatureEvents?.get(req.id) ?? [];
    if (events.length > 0) {
      w.spacer(4);
      w.text("Event Timeline:", { size: 8.5, bold: true, color: MUTED });
      for (const ev of events) {
        const label = EVENT_LABELS[ev.event_type] || ev.event_type;
        w.text(`${formatDateTime(ev.created_at)} — ${label}`, { size: 8, color: MUTED });
      }
    }
    w.spacer(12);
  }

  w.spacer(6);
  w.text(
    "This certificate is part of the same immutable signed document as the agreement pages above — it is generated once, at signing finalization, and never regenerated. It is a technical record of electronic signature evidence, not a substitute for legal advice regarding enforceability in your jurisdiction.",
    { size: 7.5, color: MUTED, italic: true }
  );

  w.finalizeFooters(
    `Contract ${input.contractIdentifier} · Version ${input.version.version_number} · Electronically signed via Open Fieldservice`,
    company.contract_footer || undefined
  );

  return w.save();
}

export { sanitizeForPdf, WINANSI_EXTRA };
