import { get, query, run } from "./db.js";
import { canActorAccessJobCompliance, actorTechnicianId, type Actor as WorkflowActor } from "./workflow.js";
import { getChecklistTemplateVersionInOrganization } from "./maintenance-checklists.js";
import { getAgreement } from "./maintenance-agreements.js";
import { getMembership, getMembershipByAgreement, consumeEntitlement } from "./maintenance-memberships.js";
import { getObject, putObject, assertUploadAllowed, StorageError, type StorageEnv } from "./storage.js";
import { renderServiceReportPdf } from "./maintenance-service-report-pdf.js";

/**
 * Phase 19B — Digital Maintenance Service Reports. `job_id` is
 * `UNIQUE REFERENCES jobs(id)` — creating a DRAFT report IS the "Dispatcher
 * manually associates a maintenance Job" act (Section 19/29); there is no
 * separate association table and `jobs` itself is never touched (Core
 * boundary preserved). RBAC reuses `canActorAccessJobCompliance` /
 * `actorTechnicianId` from workflow.ts verbatim — the exact same
 * ownership rule Phase 4's compliance photos/report/signature already
 * established (admin/dispatcher always; a technician only for their own
 * assigned job).
 */

export type ServiceReportStatus = "draft" | "finalized";

export class ServiceReportError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state" | "forbidden";
  constructor(code: ServiceReportError["code"], message: string) {
    super(message);
    this.name = "ServiceReportError";
    this.code = code;
  }
}

export interface ServiceReportRow {
  id: number;
  organization_id: number;
  job_id: number;
  agreement_id: number | null;
  membership_id: number | null;
  asset_id: number | null;
  technician_id: number | null;
  checklist_template_version_id: number | null;
  checklist_snapshot: string;
  checklist_results: string;
  measurements: string;
  work_performed: string;
  findings: string;
  recommendations: string;
  notes: string;
  internal_notes: string;
  customer_acknowledgement: string;
  status: ServiceReportStatus;
  finalized_at: string | null;
  finalized_by: number | null;
  document_key: string | null;
  document_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobForServiceReport { id: number; organization_id: number; customer_id: number; technician_id: number | null }

/** The "manually associate a maintenance Job" act (Section 19/29). Admin/
 *  dispatcher only — a technician fills in an existing report, doesn't
 *  create the association itself. Idempotent: returns the existing report
 *  if one already exists for this job (one report per job, by design).
 *  `actor: null` (Phase 19C) means system-triggered automation — pre-
 *  authorized by construction (recurring occurrence generation, not a
 *  client request), so the technician RBAC gate is simply not applicable;
 *  every other validation (organization/customer ownership of every
 *  reference) still runs unconditionally regardless of actor. */
export async function createOrGetServiceReport(
  organizationId: number, actor: WorkflowActor | null, job: JobForServiceReport,
  input: { agreementId?: number | null; membershipId?: number | null; assetId?: number | null; checklistTemplateVersionId?: number | null }
): Promise<ServiceReportRow> {
  if (actor?.role === "technician") throw new ServiceReportError("forbidden", "Only admin/dispatcher can associate a job with maintenance work");
  if (job.organization_id !== organizationId) throw new ServiceReportError("not_found", "Job not found in this organization");

  const existing = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE job_id = ?", [job.id]);
  if (existing) return existing;

  // Security review finding (Phase 19B): every optional client-supplied
  // reference MUST be validated against this organization (and, where a
  // customer relationship exists, this job's customer) before being
  // persisted — none of these were previously checked, allowing a
  // cross-tenant actor to attach another organization's agreement/
  // membership/asset/checklist-template-version to their own job, reading
  // its content and (via finalize -> consumeEntitlement) draining the
  // victim organization's membership entitlement. Mirrors the discipline
  // attachCoveredEquipment() already applies to assets on Agreements.
  if (input.agreementId) {
    const agreement = await getAgreement(organizationId, input.agreementId);
    if (!agreement || agreement.customer_id !== job.customer_id) {
      throw new ServiceReportError("invalid_input", "Agreement not found for this organization/customer");
    }
  }
  // A membership explicitly picked always wins; otherwise, when an
  // Agreement was picked, auto-derive its Membership (if the Agreement has
  // been signed/activated) so a dispatcher never has to separately
  // correlate the two — one fewer thing the UI needs to ask for, and one
  // fewer way to attach the wrong membership's entitlement to a report.
  let resolvedMembershipId = input.membershipId ?? null;
  if (resolvedMembershipId) {
    const membership = await getMembership(organizationId, resolvedMembershipId);
    if (!membership || membership.customer_id !== job.customer_id) {
      throw new ServiceReportError("invalid_input", "Membership not found for this organization/customer");
    }
  } else if (input.agreementId) {
    const derived = await getMembershipByAgreement(organizationId, input.agreementId);
    resolvedMembershipId = derived?.id ?? null;
  }
  if (input.assetId) {
    const asset = await get<{ id: number; customer_id: number }>(
      "SELECT id, customer_id FROM assets WHERE id = ? AND organization_id = ?", [input.assetId, organizationId]
    );
    if (!asset || asset.customer_id !== job.customer_id) {
      throw new ServiceReportError("invalid_input", "Asset not found for this organization/customer");
    }
  }

  let checklistSnapshot: Record<string, unknown> = {};
  if (input.checklistTemplateVersionId) {
    const templateVersion = await getChecklistTemplateVersionInOrganization(organizationId, input.checklistTemplateVersionId);
    if (!templateVersion) throw new ServiceReportError("invalid_input", "Checklist template version not found for this organization");
    checklistSnapshot = JSON.parse(templateVersion.sections);
  }

  const result = await run(
    `INSERT INTO maintenance_service_reports
      (organization_id, job_id, agreement_id, membership_id, asset_id, technician_id, checklist_template_version_id, checklist_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, job.id, input.agreementId ?? null, resolvedMembershipId, input.assetId ?? null,
      job.technician_id, input.checklistTemplateVersionId ?? null, JSON.stringify(checklistSnapshot),
    ]
  );
  const report = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (!report) throw new ServiceReportError("not_found", "Failed to load newly created service report");
  return report;
}

export async function getServiceReportByJob(organizationId: number, actor: WorkflowActor, job: JobForServiceReport): Promise<ServiceReportRow | null> {
  if (!(await canActorAccessJobCompliance(actor, job))) throw new ServiceReportError("forbidden", "Not permitted to access this job's maintenance report");
  const row = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE job_id = ? AND organization_id = ?", [job.id, organizationId]);
  return row ?? null;
}

async function assertReportEditable(organizationId: number, actor: WorkflowActor, job: JobForServiceReport, reportId: number): Promise<ServiceReportRow> {
  if (!(await canActorAccessJobCompliance(actor, job))) throw new ServiceReportError("forbidden", "Not permitted to edit this job's maintenance report");
  const report = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ? AND organization_id = ?", [reportId, organizationId]);
  if (!report || report.job_id !== job.id) throw new ServiceReportError("not_found", "Service report not found");
  if (report.status !== "draft") throw new ServiceReportError("invalid_state", "A finalized service report cannot be edited");
  return report;
}

export interface UpdateServiceReportInput {
  checklistResults?: Record<string, unknown>;
  measurements?: Record<string, unknown>;
  workPerformed?: string;
  findings?: string;
  recommendations?: string;
  notes?: string;
  internalNotes?: string;
}

export async function updateServiceReportDraft(organizationId: number, actor: WorkflowActor, job: JobForServiceReport, reportId: number, input: UpdateServiceReportInput): Promise<ServiceReportRow> {
  const existing = await assertReportEditable(organizationId, actor, job, reportId);
  await run(
    `UPDATE maintenance_service_reports SET
      checklist_results = ?, measurements = ?, work_performed = ?, findings = ?, recommendations = ?, notes = ?, internal_notes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      JSON.stringify(input.checklistResults ?? JSON.parse(existing.checklist_results)),
      JSON.stringify(input.measurements ?? JSON.parse(existing.measurements)),
      input.workPerformed ?? existing.work_performed, input.findings ?? existing.findings,
      input.recommendations ?? existing.recommendations, input.notes ?? existing.notes,
      input.internalNotes ?? existing.internal_notes, reportId,
    ]
  );
  const updated = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ?", [reportId]);
  if (!updated) throw new ServiceReportError("not_found", "Failed to reload updated service report");
  return updated;
}

const ACK_IMAGE_DATA_URL_RE = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/;

export interface CustomerAcknowledgementInput { signerName: string; relationship?: string; signatureImageDataUrl?: string }

/** Optional customer sign-off on the visit — kept separate from the
 *  formal Agreement e-sign ceremony (this is a field acknowledgement of
 *  work performed, not a legal signing of new terms). */
export async function captureCustomerAcknowledgement(env: StorageEnv, organizationId: number, actor: WorkflowActor, job: JobForServiceReport, reportId: number, input: CustomerAcknowledgementInput): Promise<ServiceReportRow> {
  const existing = await assertReportEditable(organizationId, actor, job, reportId);
  if (!input.signerName?.trim()) throw new ServiceReportError("invalid_input", "Signer name is required");

  let imageKey: string | null = null;
  if (input.signatureImageDataUrl) {
    const match = input.signatureImageDataUrl.match(ACK_IMAGE_DATA_URL_RE);
    if (!match) throw new ServiceReportError("invalid_input", "signatureImageDataUrl must be a base64 PNG data URL");
    const bytes = Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0));
    try {
      assertUploadAllowed(bytes.byteLength, "image/png");
    } catch (err) {
      if (err instanceof StorageError) throw new ServiceReportError("invalid_input", err.message);
      throw err;
    }
    imageKey = `maintenance-service-reports/${organizationId}/${existing.job_id}/${reportId}/acknowledgement-${crypto.randomUUID()}.png`;
    await putObject(env, imageKey, bytes.buffer as ArrayBuffer, "image/png");
  }

  const ack = { signer_name: input.signerName, relationship: input.relationship ?? "", signature_image_key: imageKey, signed_at: new Date().toISOString() };
  await run("UPDATE maintenance_service_reports SET customer_acknowledgement = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(ack), reportId]);

  const updated = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ?", [reportId]);
  if (!updated) throw new ServiceReportError("not_found", "Failed to reload updated service report");
  return updated;
}

/** DRAFT -> FINALIZED, one-way. Renders the professional PDF exactly once
 *  (never re-rendered afterward — same snapshot-once-and-hash discipline
 *  as Contracts/Agreements), then consumes exactly one visit against the
 *  linked membership's entitlement (idempotent, keyed by this report's own
 *  id — a retry can never double-consume). */
export async function finalizeServiceReport(env: StorageEnv, organizationId: number, actorUserId: number, actor: WorkflowActor, job: JobForServiceReport, reportId: number): Promise<ServiceReportRow> {
  const report = await assertReportEditable(organizationId, actor, job, reportId);
  if (!report.work_performed.trim()) throw new ServiceReportError("invalid_input", "Work performed must be described before finalizing");

  const pdfBytes = await renderServiceReportPdf({ report, jobId: job.id });
  const digest = await crypto.subtle.digest("SHA-256", pdfBytes.slice().buffer as ArrayBuffer);
  const documentHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const documentKey = `maintenance-service-reports/${organizationId}/${job.id}/${reportId}/report-${crypto.randomUUID()}.pdf`;
  await putObject(env, documentKey, pdfBytes.slice().buffer as ArrayBuffer, "application/pdf");

  await run(
    "UPDATE maintenance_service_reports SET status = 'finalized', finalized_at = datetime('now'), finalized_by = ?, document_key = ?, document_hash = ?, updated_at = datetime('now') WHERE id = ?",
    [actorUserId, documentKey, documentHash, reportId]
  );

  await consumeEntitlement(report.membership_id, job.id, reportId, actorUserId);

  const updated = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ?", [reportId]);
  if (!updated) throw new ServiceReportError("not_found", "Failed to reload finalized service report");
  return updated;
}

export async function getServiceReportDocument(env: StorageEnv, organizationId: number, actor: WorkflowActor, job: JobForServiceReport, reportId: number): Promise<{ bytes: ArrayBuffer; hash: string }> {
  if (!(await canActorAccessJobCompliance(actor, job))) throw new ServiceReportError("forbidden", "Not permitted to access this job's maintenance report");
  const report = await get<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE id = ? AND organization_id = ?", [reportId, organizationId]);
  if (!report || report.job_id !== job.id || !report.document_key || !report.document_hash) throw new ServiceReportError("not_found", "No finalized document exists for this report");
  const obj = await getObject(env, report.document_key);
  if (!obj) throw new ServiceReportError("not_found", "Report document is missing from storage");
  const bytes = await obj.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actualHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actualHash !== report.document_hash) throw new ServiceReportError("invalid_state", "Stored document failed integrity verification");
  return { bytes, hash: actualHash };
}

export async function listServiceReportsForMembership(organizationId: number, membershipId: number): Promise<ServiceReportRow[]> {
  return query<ServiceReportRow>("SELECT * FROM maintenance_service_reports WHERE organization_id = ? AND membership_id = ? ORDER BY created_at DESC", [organizationId, membershipId]);
}

export { actorTechnicianId };
