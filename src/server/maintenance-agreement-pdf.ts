import { PdfWriter, sanitizeForPdf, formatMoney, formatDateTime, MARGIN, INK, MUTED, ACCENT } from "./pdf-writer.js";
import type { MaintenanceAgreementVersion, AgreementSigner, SignatureRequest, CoveredEquipmentRow } from "./maintenance-agreements.js";

/**
 * Phase 19B — Maintenance Agreement PDF. Built on the SAME shared
 * `pdf-writer.ts` kernel contract-pdf.ts uses (Section 16/24) — one new
 * per-document renderer, not a new PDF engine. Rendered exactly once at
 * signing finalization (see maintenance-agreements.ts's
 * finalizeSignedDocument) and never re-rendered — the same
 * snapshot-once-and-hash discipline as Contracts.
 */

const EVENT_LABELS: Record<string, string> = {
  viewed: "Signing link viewed",
  consent_given: "Consent given",
  signed: "Signature submitted",
  auto_renew_consent_recorded: "Auto-renew preference recorded",
  request_expired: "Signing link expired",
};

export interface MaintenanceAgreementPdfInput {
  agreementIdentifier: string;
  version: MaintenanceAgreementVersion;
  signers: AgreementSigner[];
  requests: SignatureRequest[];
  coveredEquipment: CoveredEquipmentRow[];
  events: { signature_request_id: number; event_type: string; created_at: string }[];
  taxComponents: unknown[];
}

export async function renderMaintenanceAgreementPdf(input: MaintenanceAgreementPdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const documentId = `${input.agreementIdentifier}-V${input.version.version_number}`;
  const signerById = new Map(input.signers.map((s) => [s.id, s]));
  const plan = JSON.parse(input.version.plan_snapshot) as Record<string, unknown>;
  const customer = JSON.parse(input.version.customer_snapshot) as Record<string, unknown>;
  const company = JSON.parse(input.version.company_snapshot) as Record<string, unknown>;
  const autoRenew = JSON.parse(input.version.auto_renew_consent || "{}") as Record<string, unknown>;

  const fingerprintDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ documentId, version: input.version, plan, customer, company })).buffer as ArrayBuffer
  );
  const contentFingerprint = Array.from(new Uint8Array(fingerprintDigest)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // ── Header ──────────────────────────────────────────────────────────
  w.page.drawText(sanitizeForPdf((company.name as string) || "Open Fieldservice"), { x: MARGIN, y: w.y, size: 16, font: w.fonts.bold, color: INK });
  w.y -= 20;
  const addressLine = (company.address as string) || "";
  if (addressLine) w.text(addressLine, { size: 9, color: MUTED });
  const contactLine = (company.contact as string) || "";
  if (contactLine) w.text(contactLine, { size: 9, color: MUTED });
  if (!addressLine && !contactLine) w.text("Company profile not yet configured", { size: 8, color: MUTED, italic: true });
  w.hr();

  w.page.drawText("MAINTENANCE AGREEMENT", { x: MARGIN, y: w.y, size: 9, font: w.fonts.bold, color: MUTED });
  w.y -= 16;
  w.text(`${plan.name || "Maintenance Plan"} Agreement`, { size: 15, bold: true });
  w.spacer(6);
  w.labelValue("Agreement ID:", input.agreementIdentifier);
  w.labelValue("Version:", String(input.version.version_number));
  w.labelValue("Effective Date:", input.version.effective_date || "N/A");
  w.labelValue("Expires:", input.version.expires_at || "Ongoing");
  w.spacer(10);

  // ── Customer ────────────────────────────────────────────────────────
  w.heading("Customer");
  w.labelValue("Name:", (customer.name as string) || "");
  if (customer.address) w.labelValue("Address:", customer.address as string);
  if (customer.email) w.labelValue("Email:", customer.email as string);
  if (customer.phone) w.labelValue("Phone:", customer.phone as string);
  w.spacer(10);

  // ── Plan ────────────────────────────────────────────────────────────
  w.heading("Plan");
  w.labelValue("Plan:", `${plan.name} (${plan.tier})`);
  if (plan.description) w.labelValue("Description:", plan.description as string);
  if (plan.frequency_description) w.labelValue("Visit Frequency:", plan.frequency_description as string);
  w.labelValue("Included Visits:", plan.visit_entitlement_count == null ? "Unlimited" : String(plan.visit_entitlement_count));
  if (plan.priority_benefit) w.labelValue("Priority Benefit:", plan.priority_benefit as string);
  const included = (plan.included_services as string[]) || [];
  if (included.length) w.labelValue("Included Services:", included.join(", "));
  const otherBenefits = (plan.other_benefits as string[]) || [];
  if (otherBenefits.length) w.labelValue("Other Benefits:", otherBenefits.join(", "));
  w.spacer(10);

  // ── Covered equipment ───────────────────────────────────────────────
  w.heading("Covered Equipment");
  if (input.coveredEquipment.length === 0) {
    w.text("No specific equipment listed — coverage applies as described in the plan above.", { size: 9, color: MUTED });
  } else {
    w.table(
      ["Type", "Manufacturer", "Model", "Serial #"],
      input.coveredEquipment.map((ce) => {
        const snap = JSON.parse(ce.asset_snapshot) as Record<string, string>;
        return [snap.display_name || snap.asset_type || "", snap.manufacturer || "", snap.model || "", snap.serial_number || ""];
      }),
      [140, 140, 140, 140],
      [false, false, false, false]
    );
  }
  w.spacer(10);

  // ── Pricing ─────────────────────────────────────────────────────────
  w.heading("Pricing");
  w.labelValue("Plan Price:", formatMoney(plan.price_cents as number));
  const taxComponents = input.taxComponents as { name: string; rate_percent: number; amount_cents: number }[];
  for (const comp of taxComponents) {
    if (comp.amount_cents) w.labelValue(`${comp.name} (${comp.rate_percent}%):`, formatMoney(comp.amount_cents));
  }
  w.labelValue("Total:", formatMoney(input.version.total_price_cents));
  w.spacer(10);

  // ── Renewal ─────────────────────────────────────────────────────────
  w.heading("Renewal");
  w.labelValue("Renewal Preference:", input.version.renewal_preference);
  w.labelValue("Auto-Renew:", autoRenew.enabled ? "Enabled" : "Declined / not enabled");
  if (autoRenew.consent_timestamp) {
    w.text(`Auto-renew choice recorded electronically · ${formatDateTime(autoRenew.consent_timestamp as string)} · consent version ${autoRenew.consent_text_version}`, { size: 8.5, color: MUTED });
  }
  w.spacer(14);

  // ── Terms body (bound Legal Terms version, if any) ────────────────
  w.heading("Terms & Conditions");
  w.text("This agreement is subject to the organization's published Maintenance Terms in effect at signing (see Terms Version below), plus the plan details above.", { size: 9.5 });
  w.labelValue("Terms Version ID:", input.version.terms_version_id ? String(input.version.terms_version_id) : "—");
  if (input.version.terms_snapshot_hash) w.labelValue("Terms Content Hash:", input.version.terms_snapshot_hash);
  w.spacer(14);

  // ── Signatures ──────────────────────────────────────────────────────
  w.heading("Signatures");
  if (input.requests.length === 0) {
    w.text("No signature requests were recorded for this version.", { size: 9, color: MUTED });
  }
  for (const req of input.requests) {
    const signer = signerById.get(req.signer_id);
    w.ensureSpace(70);
    w.text(signer?.name || "Unknown signer", { size: 15, italic: true });
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

  w.heading("Electronic Signature Summary");
  w.text(`Document ID: ${documentId}`, { size: 9 });
  w.text("Electronically signed via Open Fieldservice.", { size: 9 });
  w.spacer(4);
  w.text(
    "This document is a technical record of electronic signature evidence. It is not a substitute for legal advice regarding enforceability in your jurisdiction.",
    { size: 8, color: MUTED, italic: true }
  );

  // ── Certificate of Completion ───────────────────────────────────────
  w.newPage();
  w.page.drawText("CERTIFICATE OF COMPLETION", { x: MARGIN, y: w.y, size: 16, font: w.fonts.bold, color: ACCENT });
  w.y -= 22;
  w.text("Electronic Signature Certificate", { size: 10, color: MUTED, italic: true });
  w.hr();

  w.heading("Document");
  w.labelValue("Document ID:", documentId);
  w.labelValue("Agreement:", input.agreementIdentifier);
  w.labelValue("Version:", String(input.version.version_number));
  w.labelValue("Content Fingerprint:", `SHA-256: ${contentFingerprint}`);
  w.text("Fingerprint computed over the agreement's underlying data (plan terms, pricing, customer and company details). The complete signed artifact's own byte-for-byte hash is available to authorized staff via the platform's Evidence record.", { size: 7.5, color: MUTED, italic: true });
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
    w.labelValue("IP Address:", req.signer_ip || "—");
    w.labelValue("User-Agent:", req.signer_user_agent || "—");

    const events = input.events.filter((e) => e.signature_request_id === req.id);
    if (events.length > 0) {
      w.spacer(4);
      w.text("Event Timeline:", { size: 8.5, bold: true, color: MUTED });
      for (const ev of events) {
        w.text(`${formatDateTime(ev.created_at)} — ${EVENT_LABELS[ev.event_type] || ev.event_type}`, { size: 8, color: MUTED });
      }
    }
    w.spacer(12);
  }

  w.spacer(6);
  w.text(
    "This certificate is part of the same immutable signed document as the agreement pages above — it is generated once, at signing finalization, and never regenerated. It is a technical record of electronic signature evidence, not a substitute for legal advice regarding enforceability in your jurisdiction.",
    { size: 7.5, color: MUTED, italic: true }
  );

  w.finalizeFooters(`Agreement ${input.agreementIdentifier} · Version ${input.version.version_number} · Electronically signed via Open Fieldservice`);

  return w.save();
}
