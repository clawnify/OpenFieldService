import { get, query, run } from "./db.js";
import { recordAdminAudit } from "./legal-terms.js";

/**
 * Phase 19B — Maintenance Checklist Templates. Mirrors
 * contract_templates/contract_template_versions (migration 0018) exactly:
 * identity row + versioned content rows, DRAFT freely editable, a new
 * version created explicitly, `current_version_id` pointing at whichever
 * version is "live" for new Service Reports. A `sections` JSON blob (not a
 * merge-field text body) holds the structured checklist content — an
 * ordered array of { title, items: [{ id, label, input_type, required,
 * options? }] }, input_type one of PASS_FAIL/YES_NO/TEXT/NUMBER/
 * MEASUREMENT/SELECT/PHOTO_REQUIRED (Section 18).
 */

export const CHECKLIST_ITEM_TYPES = ["PASS_FAIL", "YES_NO", "TEXT", "NUMBER", "MEASUREMENT", "SELECT", "PHOTO_REQUIRED"] as const;
export type ChecklistItemType = typeof CHECKLIST_ITEM_TYPES[number];

export interface ChecklistItem {
  id: string;
  label: string;
  input_type: ChecklistItemType;
  required: boolean;
  options?: string[];
}

export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

export interface Actor {
  id: number;
  role: "admin" | "dispatcher" | "technician";
}

export function canManageChecklistTemplates(actor: Actor): boolean {
  return actor.role === "admin";
}

export class ChecklistTemplateError extends Error {
  code: "not_found" | "validation" | "invalid_state";
  constructor(code: ChecklistTemplateError["code"], message: string) {
    super(message);
    this.name = "ChecklistTemplateError";
    this.code = code;
  }
}

export interface ChecklistTemplateRow {
  id: number;
  organization_id: number;
  name: string;
  applicability: string;
  active: number;
  current_version_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChecklistTemplateVersionRow {
  id: number;
  template_id: number;
  version_number: number;
  sections: string;
  created_by: number | null;
  created_at: string;
}

function validateSections(sections: ChecklistSection[]): void {
  if (!Array.isArray(sections) || sections.length === 0) throw new ChecklistTemplateError("validation", "At least one section is required");
  const seenIds = new Set<string>();
  for (const section of sections) {
    if (!section.title?.trim()) throw new ChecklistTemplateError("validation", "Every section requires a title");
    if (!Array.isArray(section.items) || section.items.length === 0) throw new ChecklistTemplateError("validation", `Section "${section.title}" requires at least one item`);
    for (const item of section.items) {
      if (!item.id?.trim() || !item.label?.trim()) throw new ChecklistTemplateError("validation", "Every checklist item requires an id and label");
      if (seenIds.has(item.id)) throw new ChecklistTemplateError("validation", `Duplicate item id "${item.id}" — item ids must be unique within a template version`);
      seenIds.add(item.id);
      if (!CHECKLIST_ITEM_TYPES.includes(item.input_type)) throw new ChecklistTemplateError("validation", `Unknown input_type "${item.input_type}"`);
      if (item.input_type === "SELECT" && (!item.options || item.options.length === 0)) {
        throw new ChecklistTemplateError("validation", `Item "${item.label}" of type SELECT requires at least one option`);
      }
    }
  }
}

const recordTemplateAudit = (organizationId: number, templateId: number, eventType: string, actorUserId: number, details: Record<string, unknown>): Promise<void> =>
  recordAdminAudit(organizationId, "checklist_template", templateId, eventType, actorUserId, details);

export async function listChecklistTemplates(organizationId: number, includeInactive: boolean): Promise<ChecklistTemplateRow[]> {
  if (includeInactive) return query<ChecklistTemplateRow>("SELECT * FROM maintenance_checklist_templates WHERE organization_id = ? ORDER BY name ASC", [organizationId]);
  return query<ChecklistTemplateRow>("SELECT * FROM maintenance_checklist_templates WHERE organization_id = ? AND active = 1 ORDER BY name ASC", [organizationId]);
}

export async function getChecklistTemplate(organizationId: number, templateId: number): Promise<ChecklistTemplateRow | null> {
  const row = await get<ChecklistTemplateRow>("SELECT * FROM maintenance_checklist_templates WHERE id = ? AND organization_id = ?", [templateId, organizationId]);
  return row ?? null;
}

export async function getChecklistTemplateVersion(versionId: number): Promise<ChecklistTemplateVersionRow | null> {
  const row = await get<ChecklistTemplateVersionRow>("SELECT * FROM maintenance_checklist_template_versions WHERE id = ?", [versionId]);
  return row ?? null;
}

/** Tenant-safe variant of getChecklistTemplateVersion — joins through the
 *  owning template to confirm it belongs to this organization before
 *  returning it. Security review finding (Phase 19B): the bare
 *  getChecklistTemplateVersion() has no tenant filter at all and must never
 *  be called with a client-supplied version id without this check first. */
export async function getChecklistTemplateVersionInOrganization(organizationId: number, versionId: number): Promise<ChecklistTemplateVersionRow | null> {
  const row = await get<ChecklistTemplateVersionRow>(
    `SELECT v.* FROM maintenance_checklist_template_versions v
     JOIN maintenance_checklist_templates t ON v.template_id = t.id
     WHERE v.id = ? AND t.organization_id = ?`,
    [versionId, organizationId]
  );
  return row ?? null;
}

export async function listChecklistTemplateVersions(templateId: number): Promise<ChecklistTemplateVersionRow[]> {
  return query<ChecklistTemplateVersionRow>("SELECT * FROM maintenance_checklist_template_versions WHERE template_id = ? ORDER BY version_number DESC", [templateId]);
}

export async function createChecklistTemplate(organizationId: number, actorUserId: number, name: string, applicability: string[], sections: ChecklistSection[]): Promise<{ template: ChecklistTemplateRow; version: ChecklistTemplateVersionRow }> {
  if (!name?.trim()) throw new ChecklistTemplateError("validation", "Template name is required");
  validateSections(sections);

  const templateResult = await run(
    "INSERT INTO maintenance_checklist_templates (organization_id, name, applicability, created_by) VALUES (?, ?, ?, ?)",
    [organizationId, name.trim(), JSON.stringify(applicability), actorUserId]
  );
  const templateId = Number(templateResult.lastInsertRowid);

  const versionResult = await run(
    "INSERT INTO maintenance_checklist_template_versions (template_id, version_number, sections, created_by) VALUES (?, 1, ?, ?)",
    [templateId, JSON.stringify(sections), actorUserId]
  );
  const versionId = Number(versionResult.lastInsertRowid);
  await run("UPDATE maintenance_checklist_templates SET current_version_id = ? WHERE id = ?", [versionId, templateId]);

  await recordTemplateAudit(organizationId, templateId, "template_created", actorUserId, { name });

  const template = await getChecklistTemplate(organizationId, templateId);
  const version = await getChecklistTemplateVersion(versionId);
  if (!template || !version) throw new ChecklistTemplateError("not_found", "Failed to load newly created template");
  return { template, version };
}

/** Historical Service Reports must retain the EXACT checklist used
 *  (Section 18) — so editing a template never mutates an existing version;
 *  it always creates a NEW version and repoints current_version_id. Past
 *  Service Reports keep their own checklist_template_version_id
 *  (immutable) and a full checklist_snapshot copy besides. */
export async function createNextChecklistTemplateVersion(organizationId: number, actorUserId: number, templateId: number, sections: ChecklistSection[]): Promise<ChecklistTemplateVersionRow> {
  const template = await getChecklistTemplate(organizationId, templateId);
  if (!template) throw new ChecklistTemplateError("not_found", "Checklist template not found");
  validateSections(sections);

  const versions = await listChecklistTemplateVersions(templateId);
  const nextVersionNumber = versions.length > 0 ? Math.max(...versions.map((v) => v.version_number)) + 1 : 1;

  const result = await run(
    "INSERT INTO maintenance_checklist_template_versions (template_id, version_number, sections, created_by) VALUES (?, ?, ?, ?)",
    [templateId, nextVersionNumber, JSON.stringify(sections), actorUserId]
  );
  const versionId = Number(result.lastInsertRowid);
  await run("UPDATE maintenance_checklist_templates SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?", [versionId, templateId]);
  await recordTemplateAudit(organizationId, templateId, "version_created", actorUserId, { version_number: nextVersionNumber });

  const version = await getChecklistTemplateVersion(versionId);
  if (!version) throw new ChecklistTemplateError("not_found", "Failed to load newly created version");
  return version;
}

export async function updateChecklistTemplateMeta(organizationId: number, actorUserId: number, templateId: number, input: { name?: string; applicability?: string[]; active?: boolean }): Promise<ChecklistTemplateRow> {
  const existing = await getChecklistTemplate(organizationId, templateId);
  if (!existing) throw new ChecklistTemplateError("not_found", "Checklist template not found");
  const name = input.name?.trim() || existing.name;
  const applicability = input.applicability ?? JSON.parse(existing.applicability);
  const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;

  await run(
    "UPDATE maintenance_checklist_templates SET name = ?, applicability = ?, active = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?",
    [name, JSON.stringify(applicability), active, templateId, organizationId]
  );
  await recordTemplateAudit(organizationId, templateId, input.active !== undefined ? (input.active ? "template_activated" : "template_deactivated") : "template_meta_updated", actorUserId, {});

  const updated = await getChecklistTemplate(organizationId, templateId);
  if (!updated) throw new ChecklistTemplateError("not_found", "Failed to reload updated template");
  return updated;
}
