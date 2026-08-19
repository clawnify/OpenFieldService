import { get, query, run } from "./db.js";

/**
 * Technician job-completion compliance: pre/post-work photos, the technician's
 * report, and the customer signature. Pure data-layer module — RBAC/ownership
 * lives in workflow.ts's canActorAccessJobCompliance() (reused, not
 * duplicated), and the actual completion GATE lives in workflow.ts's
 * canCompleteJob(), which queries these same tables directly. This module is
 * what the API routes in index.ts call to read/write that data and record the
 * audit trail.
 */

export type MediaKind = "pre_work_photo" | "post_work_photo";
export const MEDIA_KINDS: MediaKind[] = ["pre_work_photo", "post_work_photo"];

export interface JobMediaRow {
  id: number;
  job_id: number;
  kind: MediaKind;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: number | null;
  deleted_at: string | null;
  created_at: string;
}

export async function listJobMedia(jobId: number): Promise<JobMediaRow[]> {
  return query<JobMediaRow>(
    "SELECT * FROM job_media WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at ASC", [jobId]
  );
}

export async function getJobMedia(id: number): Promise<JobMediaRow | null> {
  const row = await get<JobMediaRow>("SELECT * FROM job_media WHERE id = ?", [id]);
  return row ?? null;
}

export async function insertJobMedia(input: {
  jobId: number; kind: MediaKind; storageKey: string; contentType: string; sizeBytes: number; uploadedBy: number;
}): Promise<JobMediaRow> {
  const result = await run(
    "INSERT INTO job_media (job_id, kind, storage_key, content_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
    [input.jobId, input.kind, input.storageKey, input.contentType, input.sizeBytes, input.uploadedBy]
  );
  const row = await get<JobMediaRow>("SELECT * FROM job_media WHERE id = ?", [result.lastInsertRowid]);
  return row!;
}

/** Soft-delete only — a photo is compliance evidence, never hard-removed, so the
 *  audit trail and the state of the record at completion time stay reconstructable. */
export async function softDeleteJobMedia(id: number): Promise<boolean> {
  const result = await run("UPDATE job_media SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [new Date().toISOString(), id]);
  return result.changes > 0;
}

export type ReportStatus = "draft" | "submitted";

export interface CompletionReportRow {
  job_id: number;
  work_performed: string;
  findings: string;
  notes: string;
  materials_used: string;
  status: ReportStatus;
  submitted_by: number | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getCompletionReport(jobId: number): Promise<CompletionReportRow | null> {
  const row = await get<CompletionReportRow>("SELECT * FROM job_completion_reports WHERE job_id = ?", [jobId]);
  return row ?? null;
}

/** Creates the report row on first save, or updates it on subsequent saves.
 *  Editing an already-SUBMITTED report reverts it to draft — the content just
 *  changed, so it is no longer confirmed final until resubmitted. This is what
 *  keeps "a draft must never satisfy the completion requirement" true without
 *  any special-casing at the call site. */
export async function upsertCompletionReport(jobId: number, fields: {
  workPerformed?: string; findings?: string; notes?: string; materialsUsed?: string;
}): Promise<CompletionReportRow> {
  const existing = await getCompletionReport(jobId);
  if (!existing) {
    await run(
      "INSERT INTO job_completion_reports (job_id, work_performed, findings, notes, materials_used, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [jobId, fields.workPerformed ?? "", fields.findings ?? "", fields.notes ?? "", fields.materialsUsed ?? ""]
    );
  } else {
    await run(
      `UPDATE job_completion_reports SET
         work_performed = ?, findings = ?, notes = ?, materials_used = ?,
         status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = datetime('now')
       WHERE job_id = ?`,
      [
        fields.workPerformed ?? existing.work_performed,
        fields.findings ?? existing.findings,
        fields.notes ?? existing.notes,
        fields.materialsUsed ?? existing.materials_used,
        jobId,
      ]
    );
  }
  return (await getCompletionReport(jobId))!;
}

export class ComplianceError extends Error {
  code: "not_found" | "invalid";
  constructor(code: ComplianceError["code"], message: string) {
    super(message);
    this.name = "ComplianceError";
    this.code = code;
  }
}

export async function submitCompletionReport(jobId: number, actorId: number): Promise<CompletionReportRow> {
  const existing = await getCompletionReport(jobId);
  if (!existing || !existing.work_performed.trim()) {
    throw new ComplianceError("invalid", "Describe the work performed before submitting the report");
  }
  await run(
    "UPDATE job_completion_reports SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE job_id = ?",
    [actorId, jobId]
  );
  return (await getCompletionReport(jobId))!;
}

export interface JobSignatureRow {
  id: number;
  job_id: number;
  storage_key: string;
  signer_name: string;
  signer_relationship: string;
  captured_by: number | null;
  captured_at: string;
}

export async function listJobSignatures(jobId: number): Promise<JobSignatureRow[]> {
  return query<JobSignatureRow>("SELECT * FROM job_signatures WHERE job_id = ? ORDER BY captured_at DESC", [jobId]);
}

export async function insertJobSignature(input: {
  jobId: number; storageKey: string; signerName: string; signerRelationship: string; capturedBy: number;
}): Promise<JobSignatureRow> {
  const result = await run(
    "INSERT INTO job_signatures (job_id, storage_key, signer_name, signer_relationship, captured_by) VALUES (?, ?, ?, ?, ?)",
    [input.jobId, input.storageKey, input.signerName, input.signerRelationship, input.capturedBy]
  );
  const row = await get<JobSignatureRow>("SELECT * FROM job_signatures WHERE id = ?", [result.lastInsertRowid]);
  return row!;
}

export type ComplianceEventType =
  | "photo_uploaded" | "photo_deleted" | "report_saved" | "report_submitted"
  | "signature_captured" | "completion_attempted" | "completion_rejected" | "completion_succeeded";

export interface ComplianceAuditRow {
  id: number;
  job_id: number;
  event_type: ComplianceEventType;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

export async function recordComplianceEvent(
  jobId: number, eventType: ComplianceEventType, actorId: number | null, details: unknown = {}
): Promise<void> {
  await run(
    "INSERT INTO job_compliance_audit (job_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?)",
    [jobId, eventType, actorId, JSON.stringify(details)]
  );
}

export async function getComplianceAudit(jobId: number): Promise<ComplianceAuditRow[]> {
  return query<ComplianceAuditRow>(
    "SELECT * FROM job_compliance_audit WHERE job_id = ? ORDER BY created_at DESC, id DESC", [jobId]
  );
}
