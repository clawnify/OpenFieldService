import { get, query, run } from "./db.js";
import { getCompanyProfile } from "./company-profile.js";
import { assertPlanInOrganization, buildPlanSnapshot } from "./maintenance-plans.js";
import { getCurrentPublishedVersion } from "./legal-terms.js";
import { resolveTaxProfile, calculateTaxes, createTaxSnapshot, getTaxSnapshot, type TaxableLine } from "./tax-jurisdiction.js";
import { transitionAgreementInternal } from "./maintenance-workflow.js";
import { activateMembership } from "./maintenance-memberships.js";
import { getObject, putObject, assertUploadAllowed, StorageError, type StorageEnv } from "./storage.js";
import { renderMaintenanceAgreementPdf } from "./maintenance-agreement-pdf.js";

/**
 * Phase 19B — Maintenance Agreements. Deliberately a SEPARATE parallel
 * domain from Contracts (see migration 0027's header comment for the full
 * rationale) that reuses Contracts' proven MECHANISMS: the token_hash
 * bearer-signing-link pattern, the append-only signature-event ledger, the
 * snapshot-once-at-finalization PDF/hash/R2 discipline, and the derived-
 * status-from-signature-aggregate pattern — each re-implemented here at the
 * same small scale contracts.ts/auth.ts already duplicate these primitives
 * at (no shared "e-sign engine" module was introduced — see CLAUDE.md
 * Shared Kernel Minimalism).
 */

export interface Actor {
  id: number;
  role: "admin" | "dispatcher" | "technician";
}

export function canManageAgreements(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class AgreementError extends Error {
  code: "not_found" | "invalid_input" | "not_draft" | "conflict" | "invalid_token" | "not_signed" | "hash_mismatch";
  constructor(code: AgreementError["code"], message: string) {
    super(message);
    this.name = "AgreementError";
    this.code = code;
  }
}

export interface MaintenanceAgreement {
  id: number;
  organization_id: number;
  identifier: string;
  customer_id: number;
  plan_id: number;
  status: string;
  current_version_id: number | null;
  supersedes_agreement_id: number | null;
  superseded_by_agreement_id: number | null;
  cancelled_at: string | null;
  cancel_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceAgreementVersion {
  id: number;
  agreement_id: number;
  version_number: number;
  plan_snapshot: string;
  customer_snapshot: string;
  company_snapshot: string;
  terms_version_id: number | null;
  terms_snapshot_hash: string | null;
  effective_date: string | null;
  expires_at: string | null;
  renewal_preference: string;
  auto_renew_consent: string;
  tax_breakdown: string;
  total_price_cents: number;
  document_hash: string | null;
  hash_algorithm: string;
  signed_document_key: string | null;
  signed_document_hash: string | null;
  signed_at: string | null;
  row_version: number;
  created_by: number | null;
  created_at: string;
}

export interface CoveredEquipmentRow {
  id: number;
  agreement_version_id: number;
  asset_id: number | null;
  asset_snapshot: string;
  created_at: string;
}

export interface AgreementSigner {
  id: number;
  agreement_id: number;
  name: string;
  email: string;
  phone: string;
  role: string;
  sort_order: number;
  created_at: string;
}

export interface SignatureRequest {
  id: number;
  agreement_id: number;
  agreement_version_id: number;
  signer_id: number;
  status: string;
  token_hash: string;
  expires_at: string;
  consent_text_version: string;
  consent_at: string | null;
  signed_at: string | null;
  signature_method: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  declined_reason: string;
  row_version: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

async function recordAgreementAudit(agreementId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO maintenance_agreement_audit (agreement_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?)",
    [agreementId, eventType, actorUserId, JSON.stringify(details)]
  );
}

export interface AgreementAuditRow {
  id: number;
  agreement_id: number;
  event_type: string;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

/** Architecture review finding (Phase 19B): the audit trail was write-only
 *  — every admin/dispatcher action was recorded but no route ever read it
 *  back. This is the read path (mirrors getContractStatusHistory's own
 *  shape). */
export async function listAgreementAudit(agreementId: number): Promise<AgreementAuditRow[]> {
  return query<AgreementAuditRow>(
    "SELECT * FROM maintenance_agreement_audit WHERE agreement_id = ? ORDER BY created_at DESC, id DESC", [agreementId]
  );
}

async function nextAgreementIdentifier(): Promise<string> {
  const prefixRow = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'maintenance_agreement_prefix'");
  const counterRow = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'maintenance_agreement_counter' RETURNING value"
  );
  return `${prefixRow?.value || "MAINT"}-${counterRow!.value}`;
}

// ── Crypto helpers (mirror auth.ts / contracts.ts's own token discipline —
// each module keeps its own small copy rather than a shared primitive) ──

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateSigningToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashSigningToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildCompanySnapshot(organizationId: number): Promise<Record<string, unknown>> {
  const profile = await getCompanyProfile(organizationId);
  const address = [profile.address_line1, profile.address_line2, profile.city, profile.state, profile.postal_code, profile.country].filter(Boolean).join(", ");
  const contact = [profile.phone, profile.email].filter(Boolean).join(" · ");
  return {
    name: profile.company_name || profile.legal_name || "",
    legal_name: profile.legal_name, phone: profile.phone, email: profile.email, website: profile.website,
    address, contact, business_number: profile.business_number, tax_number: profile.tax_number,
  };
}

// ── Agreement CRUD ───────────────────────────────────────────────────

export async function listAgreements(organizationId: number, filters: { customerId?: number; status?: string } = {}): Promise<(MaintenanceAgreement & { customer_name: string | null; plan_name: string | null })[]> {
  const conditions = ["a.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (filters.customerId) { conditions.push("a.customer_id = ?"); params.push(filters.customerId); }
  if (filters.status) { conditions.push("a.status = ?"); params.push(filters.status); }
  return query(
    `SELECT a.*, cu.name as customer_name, p.name as plan_name
     FROM maintenance_agreements a LEFT JOIN customers cu ON a.customer_id = cu.id LEFT JOIN maintenance_plans p ON a.plan_id = p.id
     WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC`, params
  );
}

export async function getAgreement(organizationId: number, agreementId: number): Promise<MaintenanceAgreement | null> {
  const row = await get<MaintenanceAgreement>("SELECT * FROM maintenance_agreements WHERE id = ? AND organization_id = ?", [agreementId, organizationId]);
  return row ?? null;
}

async function assertAgreement(organizationId: number, agreementId: number): Promise<MaintenanceAgreement> {
  const agreement = await getAgreement(organizationId, agreementId);
  if (!agreement) throw new AgreementError("not_found", "Maintenance agreement not found");
  return agreement;
}

export async function getAgreementVersion(versionId: number): Promise<MaintenanceAgreementVersion | null> {
  const row = await get<MaintenanceAgreementVersion>("SELECT * FROM maintenance_agreement_versions WHERE id = ?", [versionId]);
  return row ?? null;
}

export async function listCoveredEquipment(agreementVersionId: number): Promise<CoveredEquipmentRow[]> {
  return query<CoveredEquipmentRow>("SELECT * FROM maintenance_agreement_covered_equipment WHERE agreement_version_id = ? ORDER BY id ASC", [agreementVersionId]);
}

export async function listAgreementSigners(agreementId: number): Promise<AgreementSigner[]> {
  return query<AgreementSigner>("SELECT * FROM maintenance_agreement_signers WHERE agreement_id = ? ORDER BY sort_order ASC, id ASC", [agreementId]);
}

export async function listSignatureRequests(agreementId: number): Promise<SignatureRequest[]> {
  return query<SignatureRequest>("SELECT * FROM maintenance_agreement_signature_requests WHERE agreement_id = ? ORDER BY created_at ASC", [agreementId]);
}

export interface CreateAgreementInput {
  customerId: number;
  planId: number;
  effectiveDate?: string | null;
  expiresAt?: string | null;
  renewalPreference?: "auto" | "manual" | "none";
  coveredAssetIds?: number[];
  legalTermsDocumentId?: number | null;
}

/** Creates a DRAFT Agreement with its first Version, freezing the Plan's
 *  terms, the Company Profile, the customer identity, the current
 *  published MAINTENANCE Legal Terms (if any), tax (if the plan is
 *  taxable), and the requested covered equipment — all at creation time
 *  (Section 7/9/19/25). Nothing here is re-derived later. */
export async function createAgreement(organizationId: number, actorUserId: number, input: CreateAgreementInput): Promise<{ agreement: MaintenanceAgreement; version: MaintenanceAgreementVersion }> {
  const customer = await get<{ id: number; name: string; address: string; phone: string; email: string }>(
    "SELECT id, name, address, phone, email FROM customers WHERE id = ? AND organization_id = ?", [input.customerId, organizationId]
  );
  if (!customer) throw new AgreementError("invalid_input", "Customer not found in this organization");

  const plan = await assertPlanInOrganization(organizationId, input.planId);
  const planSnapshot = buildPlanSnapshot(plan);
  const companySnapshot = await buildCompanySnapshot(organizationId);
  const customerSnapshot = { id: customer.id, name: customer.name, address: customer.address, phone: customer.phone, email: customer.email };

  let termsVersionId: number | null = null;
  let termsSnapshotHash: string | null = null;
  if (input.legalTermsDocumentId) {
    const termsVersion = await getCurrentPublishedVersion(organizationId, "MAINTENANCE", input.legalTermsDocumentId);
    if (termsVersion) { termsVersionId = termsVersion.id; termsSnapshotHash = termsVersion.content_hash; }
  }

  let taxBreakdown: Record<string, unknown> = {};
  let totalPriceCents = plan.price_cents;
  let taxProfile: Awaited<ReturnType<typeof resolveTaxProfile>> = null;
  let taxCalc: ReturnType<typeof calculateTaxes> | null = null;
  if (plan.taxable) {
    taxProfile = await resolveTaxProfile(organizationId);
    const lines: TaxableLine[] = [{ amountCents: plan.price_cents, taxable: true }];
    taxCalc = calculateTaxes(taxProfile, lines);
    totalPriceCents = taxCalc.totalCents;
    taxBreakdown = { totalTaxCents: taxCalc.totalTaxCents, components: taxCalc.components, subtotalCents: taxCalc.subtotalCents };
  }

  const identifier = await nextAgreementIdentifier();
  const agreementResult = await run(
    "INSERT INTO maintenance_agreements (organization_id, identifier, customer_id, plan_id, status, created_by) VALUES (?, ?, ?, ?, 'draft', ?)",
    [organizationId, identifier, input.customerId, input.planId, actorUserId]
  );
  const agreementId = Number(agreementResult.lastInsertRowid);

  const versionResult = await run(
    `INSERT INTO maintenance_agreement_versions
      (agreement_id, version_number, plan_snapshot, customer_snapshot, company_snapshot, terms_version_id, terms_snapshot_hash,
       effective_date, expires_at, renewal_preference, tax_breakdown, total_price_cents, created_by)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agreementId, JSON.stringify(planSnapshot), JSON.stringify(customerSnapshot), JSON.stringify(companySnapshot),
      termsVersionId, termsSnapshotHash, input.effectiveDate ?? null, input.expiresAt ?? null,
      input.renewalPreference ?? "none", JSON.stringify(taxBreakdown), totalPriceCents, actorUserId,
    ]
  );
  const versionId = Number(versionResult.lastInsertRowid);
  await run("UPDATE maintenance_agreements SET current_version_id = ? WHERE id = ?", [versionId, agreementId]);

  if (taxCalc) {
    const profileRow = await getCompanyProfile(organizationId);
    await createTaxSnapshot({
      documentType: "maintenance_agreement", documentId: versionId, profile: taxProfile,
      calc: { taxableBaseCents: taxCalc.taxableBaseCents, totalTaxCents: taxCalc.totalTaxCents, components: taxCalc.components },
      businessNumber: profileRow.business_number, taxNumber: profileRow.tax_number,
    });
  }

  if (input.coveredAssetIds?.length) {
    await attachCoveredEquipment(organizationId, agreementId, versionId, input.coveredAssetIds);
  }

  await recordAgreementAudit(agreementId, "agreement_created", actorUserId, { plan_id: input.planId, customer_id: input.customerId });

  const agreement = await assertAgreement(organizationId, agreementId);
  const version = await getAgreementVersion(versionId);
  if (!version) throw new AgreementError("not_found", "Failed to load newly created version");
  return { agreement, version };
}

/** Draft-only (Section 9's "before signing" boundary — mirrors Contracts'
 *  own draft-only signer/covered-item guards). Verifies each asset belongs
 *  to the SAME customer as the agreement before attaching (cross-customer
 *  attachment is denied by construction, not just convention — same
 *  discipline job_assets already established). */
export async function attachCoveredEquipment(organizationId: number, agreementId: number, agreementVersionId: number, assetIds: number[]): Promise<void> {
  const agreement = await assertAgreement(organizationId, agreementId);
  if (agreement.status !== "draft") throw new AgreementError("not_draft", "Covered equipment can only be changed while the agreement is a draft");

  for (const assetId of assetIds) {
    const asset = await get<{ id: number; customer_id: number; organization_id: number; asset_type: string; display_name: string; manufacturer: string; model: string; serial_number: string }>(
      "SELECT id, customer_id, organization_id, asset_type, display_name, manufacturer, model, serial_number FROM assets WHERE id = ? AND organization_id = ?",
      [assetId, organizationId]
    );
    if (!asset) throw new AgreementError("invalid_input", `Asset ${assetId} not found in this organization`);
    if (asset.customer_id !== agreement.customer_id) throw new AgreementError("invalid_input", `Asset ${assetId} does not belong to this agreement's customer`);

    const snapshot = {
      asset_type: asset.asset_type, display_name: asset.display_name, manufacturer: asset.manufacturer,
      model: asset.model, serial_number: asset.serial_number,
    };
    await run(
      "INSERT INTO maintenance_agreement_covered_equipment (agreement_version_id, asset_id, asset_snapshot) VALUES (?, ?, ?)",
      [agreementVersionId, assetId, JSON.stringify(snapshot)]
    );
  }
  await recordAgreementAudit(agreementId, "covered_equipment_added", null, { asset_ids: assetIds });
}

export async function removeCoveredEquipment(organizationId: number, agreementId: number, coveredEquipmentId: number): Promise<void> {
  const agreement = await assertAgreement(organizationId, agreementId);
  if (agreement.status !== "draft") throw new AgreementError("not_draft", "Covered equipment can only be changed while the agreement is a draft");
  const result = await run(
    "DELETE FROM maintenance_agreement_covered_equipment WHERE id = ? AND agreement_version_id = ?",
    [coveredEquipmentId, agreement.current_version_id]
  );
  if (result.changes === 0) throw new AgreementError("not_found", "Covered equipment entry not found");
  await recordAgreementAudit(agreementId, "covered_equipment_removed", null, { covered_equipment_id: coveredEquipmentId });
}

export interface AddSignerInput { name: string; email?: string; phone?: string; role?: string; sortOrder?: number }

export async function addAgreementSigner(organizationId: number, actorUserId: number, agreementId: number, input: AddSignerInput): Promise<AgreementSigner> {
  const agreement = await assertAgreement(organizationId, agreementId);
  if (agreement.status !== "draft") throw new AgreementError("not_draft", "Signers can only be added while the agreement is a draft");
  if (!input.name?.trim()) throw new AgreementError("invalid_input", "Signer name is required");

  const result = await run(
    "INSERT INTO maintenance_agreement_signers (agreement_id, name, email, phone, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    [agreementId, input.name.trim(), input.email ?? "", input.phone ?? "", input.role ?? "customer", input.sortOrder ?? 0]
  );
  await recordAgreementAudit(agreementId, "signer_added", actorUserId, { name: input.name });
  const signer = await get<AgreementSigner>("SELECT * FROM maintenance_agreement_signers WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (!signer) throw new AgreementError("not_found", "Failed to load newly created signer");
  return signer;
}

export async function removeAgreementSigner(organizationId: number, actorUserId: number, agreementId: number, signerId: number): Promise<void> {
  const agreement = await assertAgreement(organizationId, agreementId);
  if (agreement.status !== "draft") throw new AgreementError("not_draft", "Signers can only be removed while the agreement is a draft");
  const result = await run("DELETE FROM maintenance_agreement_signers WHERE id = ? AND agreement_id = ?", [signerId, agreementId]);
  if (result.changes === 0) throw new AgreementError("not_found", "Signer not found");
  await recordAgreementAudit(agreementId, "signer_removed", actorUserId, { signer_id: signerId });
}

/** Draft -> Sent: creates one signing request per signer, transitions the
 *  Agreement's bare status. Requires at least one signer. */
export async function sendAgreementForSignature(db: D1Database, organizationId: number, actorUserId: number, agreementId: number, consentTextVersion: string, expiresInDays = 30): Promise<{ signerId: number; signerName: string; token: string }[]> {
  const agreement = await assertAgreement(organizationId, agreementId);
  if (agreement.status !== "draft") throw new AgreementError("not_draft", "Only a draft agreement can be sent for signature");
  if (!agreement.current_version_id) throw new AgreementError("invalid_input", "Agreement has no version to send");
  const signers = await listAgreementSigners(agreementId);
  if (signers.length === 0) throw new AgreementError("invalid_input", "At least one signer is required before sending");

  const results: { signerId: number; signerName: string; token: string }[] = [];
  for (const signer of signers) {
    const token = generateSigningToken();
    const tokenHash = await hashSigningToken(token);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    await run(
      `INSERT INTO maintenance_agreement_signature_requests
        (agreement_id, agreement_version_id, signer_id, status, token_hash, expires_at, consent_text_version, created_by)
       VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)`,
      [agreementId, agreement.current_version_id, signer.id, tokenHash, expiresAt, consentTextVersion, actorUserId]
    );
    results.push({ signerId: signer.id, signerName: signer.name, token });
  }

  await transitionAgreementInternal(
    db,
    { id: agreement.id, status: agreement.status, organization_id: agreement.organization_id },
    "sent", actorUserId, ""
  );
  await recordAgreementAudit(agreementId, "sent_for_signature", actorUserId, { signer_count: signers.length });
  return results;
}

// ── Public signing ceremony (mirrors contracts.ts's token flow exactly) ──

export interface PublicSigningView {
  request: SignatureRequest;
  agreement: { identifier: string; status: string; organization_id: number };
  version: MaintenanceAgreementVersion;
  signer: { name: string; email: string; role: string };
}

export async function getAgreementSignatureRequestByToken(rawToken: string): Promise<PublicSigningView | null> {
  if (!rawToken || rawToken.length > 200) return null;
  const tokenHash = await hashSigningToken(rawToken);
  const reqRow = await get<SignatureRequest>("SELECT * FROM maintenance_agreement_signature_requests WHERE token_hash = ?", [tokenHash]);
  if (!reqRow) return null;
  if (!["pending", "sent", "viewed"].includes(reqRow.status)) return null;

  if (new Date(reqRow.expires_at) < new Date()) {
    await run("UPDATE maintenance_agreement_signature_requests SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = ?", [reqRow.id, reqRow.status]);
    await run("INSERT INTO maintenance_agreement_signature_events (signature_request_id, event_type, metadata) VALUES (?, 'request_expired', '{}')", [reqRow.id]);
    return null;
  }

  if (reqRow.status === "sent") {
    await run("UPDATE maintenance_agreement_signature_requests SET status = 'viewed', updated_at = datetime('now') WHERE id = ? AND status = 'sent'", [reqRow.id]);
    await run("INSERT INTO maintenance_agreement_signature_events (signature_request_id, event_type, metadata) VALUES (?, 'viewed', '{}')", [reqRow.id]);
    reqRow.status = "viewed";
  }

  const agreement = await get<{ identifier: string; status: string; organization_id: number }>(
    "SELECT identifier, status, organization_id FROM maintenance_agreements WHERE id = ?", [reqRow.agreement_id]
  );
  const version = await getAgreementVersion(reqRow.agreement_version_id);
  const signer = await get<{ name: string; email: string; role: string }>("SELECT name, email, role FROM maintenance_agreement_signers WHERE id = ?", [reqRow.signer_id]);
  if (!agreement || !version || !signer) return null;

  return { request: reqRow, agreement, version, signer };
}

export async function recordAgreementConsent(rawToken: string, consentTextVersion: string, ip: string, userAgent: string): Promise<void> {
  const view = await getAgreementSignatureRequestByToken(rawToken);
  if (!view) throw new AgreementError("invalid_token", "This signing link is invalid or has expired");
  await run(
    "UPDATE maintenance_agreement_signature_requests SET consent_at = datetime('now'), consent_text_version = ? WHERE id = ?",
    [consentTextVersion, view.request.id]
  );
  await run(
    "INSERT INTO maintenance_agreement_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'consent_given', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ consent_text_version: consentTextVersion })]
  );
}

export const AGREEMENT_SIGNATURE_METHODS = ["typed", "drawn"] as const;
export type AgreementSignatureMethod = typeof AGREEMENT_SIGNATURE_METHODS[number];

const SIGNATURE_IMAGE_DATA_URL_RE = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/;

function decodeSignatureImage(dataUrl: string): Uint8Array {
  const match = dataUrl.match(SIGNATURE_IMAGE_DATA_URL_RE);
  if (!match) throw new AgreementError("invalid_input", "signatureImageDataUrl must be a base64 PNG data URL");
  const bytes = Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0));
  try {
    assertUploadAllowed(bytes.byteLength, "image/png");
  } catch (err) {
    if (err instanceof StorageError) throw new AgreementError("invalid_input", err.message);
    throw err;
  }
  return bytes;
}

export interface SubmitAgreementSignatureInput {
  signerName: string;
  signatureMethod: string;
  signatureImageDataUrl?: string;
  /** Section 14 — captured as SEPARATE explicit evidence, never inferred
   *  from the general signature. Must be an explicit true/false choice
   *  from the signer, never defaulted/preselected. */
  autoRenewEnabled: boolean;
  autoRenewConsentTextVersion: string;
}

/** Submits a signature AND, in the same request, the separate explicit
 *  auto-renew consent evidence (Section 14) — both stamped with the exact
 *  same real ip/userAgent/timestamp, since they are given by the signer in
 *  the same act. Idempotent (mirrors Contracts). */
export async function submitAgreementSignature(db: D1Database, env: StorageEnv, rawToken: string, input: SubmitAgreementSignatureInput, ip: string, userAgent: string): Promise<void> {
  const tokenHash = await hashSigningToken(rawToken);
  const existing = await get<{ id: number; status: string; agreement_id: number }>(
    "SELECT id, status, agreement_id FROM maintenance_agreement_signature_requests WHERE token_hash = ?", [tokenHash]
  );
  if (existing?.status === "signed") return; // idempotent

  const view = await getAgreementSignatureRequestByToken(rawToken);
  if (!view) throw new AgreementError("invalid_token", "This signing link is invalid or has expired");
  if (!view.request.consent_at) throw new AgreementError("invalid_input", "Consent is required before signing");
  if (!AGREEMENT_SIGNATURE_METHODS.includes(input.signatureMethod as AgreementSignatureMethod)) throw new AgreementError("invalid_input", "Unsupported signature method");
  if (!input.signerName?.trim()) throw new AgreementError("invalid_input", "A typed legal name is required");
  if (typeof input.autoRenewEnabled !== "boolean") throw new AgreementError("invalid_input", "An explicit auto-renew choice is required");

  let signatureImageKey: string | null = null;
  if (input.signatureMethod === "drawn") {
    if (!input.signatureImageDataUrl) throw new AgreementError("invalid_input", "A drawn signature is required for this method");
    const bytes = decodeSignatureImage(input.signatureImageDataUrl);
    signatureImageKey = `maintenance-agreements/${view.agreement.organization_id}/${view.request.agreement_id}/${view.request.id}/signature-${crypto.randomUUID()}.png`;
    await putObject(env, signatureImageKey, bytes.buffer as ArrayBuffer, "image/png");
  }

  const result = await run(
    `UPDATE maintenance_agreement_signature_requests SET status = 'signed', signed_at = datetime('now'), signature_method = ?, signer_ip = ?, signer_user_agent = ?, updated_at = datetime('now')
     WHERE token_hash = ? AND status IN ('pending','sent','viewed')`,
    [input.signatureMethod, ip, userAgent, tokenHash]
  );
  if (result.changes === 0) throw new AgreementError("conflict", "This signing link was already used or is no longer valid");

  await run(
    "INSERT INTO maintenance_agreement_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'signed', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ signer_name: input.signerName, signature_method: input.signatureMethod, signature_image_key: signatureImageKey })]
  );

  // Separate explicit auto-renew consent evidence — its own event row
  // (distinct event_type) in the same append-only ledger, so a future
  // audit can see it was captured as its own act, not folded into the
  // general "signed" event.
  const autoRenewConsent = {
    enabled: input.autoRenewEnabled,
    consent_timestamp: new Date().toISOString(),
    consent_text_version: input.autoRenewConsentTextVersion,
    signer: input.signerName,
    ip, user_agent: userAgent,
  };
  await run("UPDATE maintenance_agreement_versions SET auto_renew_consent = ? WHERE id = ?", [JSON.stringify(autoRenewConsent), view.version.id]);
  await run(
    "INSERT INTO maintenance_agreement_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'auto_renew_consent_recorded', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ enabled: input.autoRenewEnabled, consent_text_version: input.autoRenewConsentTextVersion })]
  );

  await recalculateAgreementStatus(db, env, view.request.agreement_id);
}

async function recalculateAgreementStatus(db: D1Database, env: StorageEnv, agreementId: number): Promise<void> {
  const agreement = await get<MaintenanceAgreement>("SELECT * FROM maintenance_agreements WHERE id = ?", [agreementId]);
  if (!agreement || agreement.current_version_id === null) return;
  const requests = await query<{ status: string }>("SELECT status FROM maintenance_agreement_signature_requests WHERE agreement_version_id = ?", [agreement.current_version_id]);
  if (requests.length === 0) return;

  let nextStatus: "signed" | "expired" | null = null;
  if (requests.every((r) => r.status === "signed")) {
    nextStatus = "signed";
  } else if (requests.every((r) => r.status === "expired" || r.status === "cancelled")) {
    nextStatus = "expired";
  }
  if (!nextStatus || nextStatus === agreement.status) return;

  if (nextStatus === "signed") {
    // Finalize the immutable signed artifact BEFORE flipping status — a
    // PDF/R2 failure here must leave the agreement at its prior, honest
    // status rather than falsely "signed" with no document (mirrors
    // Contracts' Phase 13A hardening fix exactly).
    await finalizeSignedDocument(env, agreement.organization_id, agreementId, agreement.current_version_id);
    await transitionAgreementInternal(db, { id: agreement.id, status: agreement.status, organization_id: agreement.organization_id }, "signed", null, "Derived from signature completion");
    // Signed collapses straight to Active in the same call — this phase
    // deliberately does not defer activation to a future effective_date
    // (Section 22: "do not implement automatic expiry/renewal scheduling
    // except safe deterministic display if needed" — collapsing
    // signed->active synchronously is exactly that safe, deterministic
    // rule, not a cron). Two distinct history rows are still written so
    // the FSM's own explicit SIGNED/ACTIVE states remain individually
    // auditable.
    const signedAgreement = { id: agreement.id, status: "signed" as const, organization_id: agreement.organization_id };
    await transitionAgreementInternal(db, signedAgreement, "active", null, "Signed agreement activated");
    await activateMembership(agreement.organization_id, agreement.id, agreement.customer_id, agreement.plan_id, agreement.current_version_id);
  } else {
    await transitionAgreementInternal(db, { id: agreement.id, status: agreement.status, organization_id: agreement.organization_id }, "expired", null, "All signature requests expired without completion");
  }
}

/** Rendered exactly once, at the moment every signer completes — never
 *  re-rendered. Hash is the tamper-evidence mechanism (mirrors Contracts'
 *  finalizeSignedDocument precisely). */
async function finalizeSignedDocument(env: StorageEnv, organizationId: number, agreementId: number, versionId: number): Promise<void> {
  const agreement = await get<MaintenanceAgreement>("SELECT * FROM maintenance_agreements WHERE id = ?", [agreementId]);
  const version = await getAgreementVersion(versionId);
  if (!agreement || !version) throw new AgreementError("not_found", "Agreement or version not found during finalization");

  const signers = await listAgreementSigners(agreementId);
  const requests = await listSignatureRequests(agreementId);
  const coveredEquipment = await listCoveredEquipment(versionId);
  const events = await query<{ signature_request_id: number; event_type: string; created_at: string }>(
    "SELECT signature_request_id, event_type, created_at FROM maintenance_agreement_signature_events WHERE signature_request_id IN (SELECT id FROM maintenance_agreement_signature_requests WHERE agreement_version_id = ?) ORDER BY created_at ASC",
    [versionId]
  );

  let taxSnapshotComponents: unknown[] = [];
  try {
    const snapshot = await getTaxSnapshot("maintenance_agreement", versionId);
    if (snapshot) taxSnapshotComponents = snapshot.components;
  } catch { /* tax snapshot is optional — a non-taxable plan has none */ }

  const pdfBytes = await renderMaintenanceAgreementPdf({
    agreementIdentifier: agreement.identifier,
    version, signers, requests, coveredEquipment, events, taxComponents: taxSnapshotComponents,
  });

  const documentHash = await sha256HexBytes(pdfBytes.slice().buffer);
  const key = `maintenance-agreements/${organizationId}/${agreementId}/${versionId}/signed-${crypto.randomUUID()}.pdf`;
  await putObject(env, key, pdfBytes.slice().buffer as ArrayBuffer, "application/pdf");

  await run(
    "UPDATE maintenance_agreement_versions SET signed_document_key = ?, signed_document_hash = ?, signed_at = datetime('now') WHERE id = ?",
    [key, documentHash, versionId]
  );
}

/** Re-hashes the retrieved bytes before returning — a mismatch throws,
 *  never silently serves (mirrors Contracts' getSignedDocumentArtifact). */
export async function getSignedAgreementArtifact(env: StorageEnv, organizationId: number, agreementId: number): Promise<{ bytes: ArrayBuffer; hash: string }> {
  const agreement = await getAgreement(organizationId, agreementId);
  if (!agreement || !agreement.current_version_id) throw new AgreementError("not_found", "Agreement not found");
  const version = await getAgreementVersion(agreement.current_version_id);
  if (!version || !version.signed_document_key || !version.signed_document_hash) throw new AgreementError("not_signed", "This agreement has no signed document yet");

  const obj = await getObject(env, version.signed_document_key);
  if (!obj) throw new AgreementError("not_found", "Signed document is missing from storage");
  const bytes = await obj.arrayBuffer();
  const actualHash = await sha256HexBytes(bytes);
  if (actualHash !== version.signed_document_hash) throw new AgreementError("hash_mismatch", "Stored document failed integrity verification");
  return { bytes, hash: actualHash };
}

/** Section 10/22 — an explicit, staff-triggered replacement: marks the
 *  current Agreement SUPERSEDED and returns a fresh DRAFT Agreement
 *  cross-linked both ways. Never automatic (no cron, no renewal-date
 *  trigger) — Section 5's explicit "no automatic renewal execution"
 *  boundary. */
export async function supersedeAgreement(db: D1Database, organizationId: number, actorUserId: number, agreementId: number, input: CreateAgreementInput): Promise<{ oldAgreement: MaintenanceAgreement; newAgreement: MaintenanceAgreement; newVersion: MaintenanceAgreementVersion }> {
  const oldAgreement = await assertAgreement(organizationId, agreementId);
  if (!["signed", "active"].includes(oldAgreement.status)) {
    throw new AgreementError("invalid_input", "Only a signed or active agreement can be superseded");
  }

  const { agreement: createdAgreement, version: newVersion } = await createAgreement(organizationId, actorUserId, input);
  await run("UPDATE maintenance_agreements SET supersedes_agreement_id = ? WHERE id = ?", [agreementId, createdAgreement.id]);

  await transitionAgreementInternal(db, { id: oldAgreement.id, status: oldAgreement.status, organization_id: oldAgreement.organization_id }, "superseded", actorUserId, "Superseded by a replacement agreement");
  await run("UPDATE maintenance_agreements SET superseded_by_agreement_id = ? WHERE id = ?", [createdAgreement.id, agreementId]);
  await recordAgreementAudit(agreementId, "superseded", actorUserId, { new_agreement_id: createdAgreement.id });

  // Bug fix (Testing review, Phase 19B): the object returned by
  // createAgreement() above was captured BEFORE the supersedes_agreement_id
  // UPDATE ran, so the API response was silently stale (always null) even
  // though the DB row was correct — both agreement objects must be
  // re-fetched after all writes complete.
  const [refreshedOld, refreshedNew] = await Promise.all([
    assertAgreement(organizationId, agreementId),
    assertAgreement(organizationId, createdAgreement.id),
  ]);
  return { oldAgreement: refreshedOld, newAgreement: refreshedNew, newVersion };
}
