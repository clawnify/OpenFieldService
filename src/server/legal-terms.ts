import { get, query, run } from "./db.js";

/**
 * Phase 19B — generic, org-scoped Versioned Legal Terms Library. Mirrors
 * contract_templates/contract_template_versions (Phase 13, migration 0018)
 * field-for-field: a minimal versioned structured-content system, NOT a
 * visual designer. A DRAFT version is freely editable in place; PUBLISH is
 * a one-way transition (immutable from then on) that also marks the
 * document's previous PUBLISHED version SUPERSEDED — never deleted, never
 * rewritten, so any historical reference (a signed Agreement's
 * terms_version_id) always resolves to exact, unchanged content.
 *
 * Only "MAINTENANCE" is actually wired into a workflow this phase (Section
 * 20 — Maintenance Agreements). The other types (EQUIPMENT_SALE,
 * INSTALLATION, QUOTE, CONTRACT, PAYMENT, WARRANTY) exist as usable
 * infrastructure for a future phase to wire in, per the task's explicit
 * "not every type must be wired into every existing workflow" instruction
 * — Section 21's Equipment Sale/Installation Terms guidance is satisfied
 * by this same generic `type` column, no separate schema needed.
 */

export const LEGAL_TERMS_TYPES = ["MAINTENANCE", "EQUIPMENT_SALE", "INSTALLATION", "QUOTE", "CONTRACT", "PAYMENT", "WARRANTY"] as const;
export type LegalTermsType = typeof LEGAL_TERMS_TYPES[number];

export function isLegalTermsType(value: string): value is LegalTermsType {
  return (LEGAL_TERMS_TYPES as readonly string[]).includes(value);
}

export type LegalTermsVersionStatus = "draft" | "published" | "superseded";

export interface Actor {
  id: number;
  role: "admin" | "dispatcher" | "technician";
}

/** Publishing binding legal content is Admin-only — matches Company
 *  Profile's own admin-only-both-directions precedent (Phase 13A/13C) and
 *  Section 25's explicit "No org-level Legal Terms publishing unless
 *  current policy explicitly allows" for dispatcher (no such allowance is
 *  given anywhere in this task). */
export function canManageLegalTerms(actor: Actor): boolean {
  return actor.role === "admin";
}

/** Any authenticated staff role may READ published terms (needed to
 *  prepare/send a Maintenance Agreement) — dispatcher included, mirrors
 *  Contracts' own read-vs-manage split. Technician has no legitimate need
 *  (no Agreement-authoring UI reaches them per Section 25) and is blocked. */
export function canViewLegalTerms(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class LegalTermsError extends Error {
  code: "not_found" | "invalid_state" | "validation" | "forbidden";
  constructor(code: LegalTermsError["code"], message: string) {
    super(message);
    this.name = "LegalTermsError";
    this.code = code;
  }
}

export interface LegalTermsDocumentRow {
  id: number;
  organization_id: number;
  type: string;
  title: string;
  current_published_version_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface LegalTermsVersionRow {
  id: number;
  document_id: number;
  version_number: number;
  status: LegalTermsVersionStatus;
  content: string;
  content_hash: string | null;
  effective_from: string | null;
  published_at: string | null;
  published_by: number | null;
  superseded_at: string | null;
  created_by: number | null;
  created_at: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Genuinely shared write helper for maintenance_admin_audit (Architecture
 *  review finding, Phase 19B: maintenance-plans.ts/maintenance-checklists.ts
 *  originally each hand-rolled an identical INSERT instead of reusing this
 *  export, undercutting the migration's own "these three share one shape"
 *  rationale for the consolidated table — fixed by parameterizing
 *  entity_type here and having every caller use it). */
export async function recordAdminAudit(organizationId: number, entityType: string, entityId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO maintenance_admin_audit (organization_id, entity_type, entity_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [organizationId, entityType, entityId, eventType, actorUserId, JSON.stringify(details)]
  );
}

const recordLegalTermsAudit = (organizationId: number, entityId: number, eventType: string, actorUserId: number, details: Record<string, unknown>) =>
  recordAdminAudit(organizationId, "legal_terms", entityId, eventType, actorUserId, details);

export async function listLegalTermsDocuments(organizationId: number, type?: string): Promise<LegalTermsDocumentRow[]> {
  if (type) {
    return query<LegalTermsDocumentRow>(
      "SELECT * FROM legal_terms_documents WHERE organization_id = ? AND type = ? ORDER BY title ASC", [organizationId, type]
    );
  }
  return query<LegalTermsDocumentRow>(
    "SELECT * FROM legal_terms_documents WHERE organization_id = ? ORDER BY type ASC, title ASC", [organizationId]
  );
}

export async function getLegalTermsDocument(organizationId: number, documentId: number): Promise<LegalTermsDocumentRow | null> {
  const row = await get<LegalTermsDocumentRow>(
    "SELECT * FROM legal_terms_documents WHERE id = ? AND organization_id = ?", [documentId, organizationId]
  );
  return row ?? null;
}

export async function listLegalTermsVersions(documentId: number): Promise<LegalTermsVersionRow[]> {
  return query<LegalTermsVersionRow>(
    "SELECT * FROM legal_terms_versions WHERE document_id = ? ORDER BY version_number DESC", [documentId]
  );
}

export async function getLegalTermsVersion(versionId: number): Promise<LegalTermsVersionRow | null> {
  const row = await get<LegalTermsVersionRow>("SELECT * FROM legal_terms_versions WHERE id = ?", [versionId]);
  return row ?? null;
}

/** The current published version for a document, or null if none has ever
 *  been published — used by Maintenance Agreement preparation to bind
 *  the exact terms in effect right now. */
export async function getCurrentPublishedVersion(organizationId: number, type: string, documentId: number): Promise<LegalTermsVersionRow | null> {
  const doc = await getLegalTermsDocument(organizationId, documentId);
  if (!doc || doc.type !== type || !doc.current_published_version_id) return null;
  return getLegalTermsVersion(doc.current_published_version_id);
}

export async function createLegalTermsDocument(
  organizationId: number, actorUserId: number, type: string, title: string
): Promise<{ document: LegalTermsDocumentRow; version: LegalTermsVersionRow }> {
  if (!isLegalTermsType(type)) throw new LegalTermsError("validation", `Unknown terms type "${type}"`);
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new LegalTermsError("validation", "Title is required");

  const docResult = await run(
    "INSERT INTO legal_terms_documents (organization_id, type, title, created_by) VALUES (?, ?, ?, ?)",
    [organizationId, type, trimmedTitle, actorUserId]
  );
  const documentId = Number(docResult.lastInsertRowid);

  const versionResult = await run(
    "INSERT INTO legal_terms_versions (document_id, version_number, status, content, created_by) VALUES (?, 1, 'draft', '', ?)",
    [documentId, actorUserId]
  );
  const versionId = Number(versionResult.lastInsertRowid);

  await recordLegalTermsAudit(organizationId, documentId, "document_created", actorUserId, { type, title: trimmedTitle });

  const document = await getLegalTermsDocument(organizationId, documentId);
  const version = await getLegalTermsVersion(versionId);
  if (!document || !version) throw new LegalTermsError("not_found", "Failed to load newly created document");
  return { document, version };
}

/** A DRAFT version's content may be freely edited. Once published, a
 *  version is immutable — editing requires creating a new draft version. */
export async function updateDraftVersionContent(
  organizationId: number, actorUserId: number, documentId: number, versionId: number, content: string, effectiveFrom?: string | null
): Promise<LegalTermsVersionRow> {
  const document = await getLegalTermsDocument(organizationId, documentId);
  if (!document) throw new LegalTermsError("not_found", "Terms document not found");
  const version = await getLegalTermsVersion(versionId);
  if (!version || version.document_id !== documentId) throw new LegalTermsError("not_found", "Terms version not found");
  if (version.status !== "draft") throw new LegalTermsError("invalid_state", "Only a draft version can be edited");

  if (effectiveFrom !== undefined && effectiveFrom !== null) {
    const parsed = new Date(effectiveFrom);
    if (Number.isNaN(parsed.getTime())) throw new LegalTermsError("validation", "Invalid effective_from date");
  }

  await run(
    "UPDATE legal_terms_versions SET content = ?, effective_from = ? WHERE id = ?",
    [content, effectiveFrom ?? version.effective_from, versionId]
  );
  await recordLegalTermsAudit(organizationId, documentId, "draft_updated", actorUserId, { version_id: versionId });

  const updated = await getLegalTermsVersion(versionId);
  if (!updated) throw new LegalTermsError("not_found", "Failed to reload updated version");
  return updated;
}

/** Creates a new DRAFT version for a document, starting from the current
 *  published version's content (or the prior draft's, if the document has
 *  never been published) — a convenience starting point, not a
 *  requirement. Refuses if a draft already exists (one draft at a time). */
export async function createNextDraftVersion(organizationId: number, actorUserId: number, documentId: number): Promise<LegalTermsVersionRow> {
  const document = await getLegalTermsDocument(organizationId, documentId);
  if (!document) throw new LegalTermsError("not_found", "Terms document not found");

  const versions = await listLegalTermsVersions(documentId);
  const existingDraft = versions.find((v) => v.status === "draft");
  if (existingDraft) throw new LegalTermsError("invalid_state", "A draft version already exists — edit or publish it first");

  const nextVersionNumber = versions.length > 0 ? Math.max(...versions.map((v) => v.version_number)) + 1 : 1;
  const startingContent = versions.find((v) => v.id === document.current_published_version_id)?.content ?? "";

  const result = await run(
    "INSERT INTO legal_terms_versions (document_id, version_number, status, content, created_by) VALUES (?, ?, 'draft', ?, ?)",
    [documentId, nextVersionNumber, startingContent, actorUserId]
  );
  await recordLegalTermsAudit(organizationId, documentId, "draft_created", actorUserId, { version_number: nextVersionNumber });

  const created = await getLegalTermsVersion(Number(result.lastInsertRowid));
  if (!created) throw new LegalTermsError("not_found", "Failed to load newly created draft version");
  return created;
}

/** One-way: draft -> published. Computes content_hash, stamps published_at/
 *  published_by, supersedes the document's previously-published version
 *  (if any — never deleted, never rewritten), and repoints
 *  current_published_version_id. */
export async function publishLegalTermsVersion(organizationId: number, actorUserId: number, documentId: number, versionId: number): Promise<LegalTermsVersionRow> {
  const document = await getLegalTermsDocument(organizationId, documentId);
  if (!document) throw new LegalTermsError("not_found", "Terms document not found");
  const version = await getLegalTermsVersion(versionId);
  if (!version || version.document_id !== documentId) throw new LegalTermsError("not_found", "Terms version not found");
  if (version.status !== "draft") throw new LegalTermsError("invalid_state", "Only a draft version can be published");
  if (!version.content.trim()) throw new LegalTermsError("validation", "Cannot publish empty content");

  const contentHash = await sha256Hex(version.content);
  const previousPublishedId = document.current_published_version_id;

  await run(
    "UPDATE legal_terms_versions SET status = 'published', content_hash = ?, published_at = datetime('now'), published_by = ? WHERE id = ?",
    [contentHash, actorUserId, versionId]
  );
  if (previousPublishedId) {
    await run("UPDATE legal_terms_versions SET status = 'superseded', superseded_at = datetime('now') WHERE id = ?", [previousPublishedId]);
  }
  await run("UPDATE legal_terms_documents SET current_published_version_id = ?, updated_at = datetime('now') WHERE id = ?", [versionId, documentId]);

  await recordLegalTermsAudit(organizationId, documentId, "version_published", actorUserId, { version_id: versionId, version_number: version.version_number, content_hash: contentHash });

  const published = await getLegalTermsVersion(versionId);
  if (!published) throw new LegalTermsError("not_found", "Failed to reload published version");
  return published;
}

export interface MaintenanceAdminAuditRow {
  id: number;
  organization_id: number;
  entity_type: string;
  entity_id: number;
  event_type: string;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

export async function listMaintenanceAdminAudit(organizationId: number, entityType: string, entityId: number): Promise<MaintenanceAdminAuditRow[]> {
  return query<MaintenanceAdminAuditRow>(
    "SELECT * FROM maintenance_admin_audit WHERE organization_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC",
    [organizationId, entityType, entityId]
  );
}
