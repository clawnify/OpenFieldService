import { get, query, run } from "./db.js";
import { recordAdminAudit } from "./legal-terms.js";

/**
 * Phase 19B — organization-scoped Maintenance Plan catalog. Not rigidly
 * three hardcoded plans (Section 6) — `tier` is a plain string label
 * ("BASIC"/"STANDARD"/"PREMIUM"/"CUSTOM" by convention, never a DB CHECK,
 * matching jobs.status/assets.status precedent) so an org can define any
 * number of plans. Money is integer cents throughout (standing rule, see
 * Serena architecture/data-model).
 */

export interface Actor {
  id: number;
  role: "admin" | "dispatcher" | "technician";
}

export function canManagePlans(actor: Actor): boolean {
  return actor.role === "admin";
}

export function canViewPlans(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class MaintenancePlanError extends Error {
  code: "not_found" | "validation" | "conflict";
  constructor(code: MaintenancePlanError["code"], message: string) {
    super(message);
    this.name = "MaintenancePlanError";
    this.code = code;
  }
}

export interface MaintenancePlanRow {
  id: number;
  organization_id: number;
  code: string;
  name: string;
  description: string;
  tier: string;
  active: number;
  price_cents: number;
  currency: string;
  taxable: number;
  visit_entitlement_count: number | null;
  frequency_description: string;
  priority_benefit: string;
  discount_type: string;
  discount_percent: number | null;
  discount_fixed_cents: number | null;
  included_services: string;
  excluded_services: string;
  other_benefits: string;
  equipment_eligibility: string;
  effective_from: string | null;
  effective_until: string | null;
  sort_order: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenancePlanInput {
  code: string;
  name: string;
  description?: string;
  tier?: string;
  active?: boolean;
  price_cents?: number;
  currency?: string;
  taxable?: boolean;
  visit_entitlement_count?: number | null;
  frequency_description?: string;
  priority_benefit?: string;
  discount_type?: "none" | "percent" | "fixed";
  discount_percent?: number | null;
  discount_fixed_cents?: number | null;
  included_services?: string[];
  excluded_services?: string[];
  other_benefits?: string[];
  equipment_eligibility?: string[];
  effective_from?: string | null;
  effective_until?: string | null;
  sort_order?: number;
}

const recordPlanAudit = (organizationId: number, planId: number, eventType: string, actorUserId: number, details: Record<string, unknown>): Promise<void> =>
  recordAdminAudit(organizationId, "plan", planId, eventType, actorUserId, details);

function validatePlanInput(input: MaintenancePlanInput): void {
  if (!input.code?.trim()) throw new MaintenancePlanError("validation", "Plan code is required");
  if (!input.name?.trim()) throw new MaintenancePlanError("validation", "Plan name is required");
  if (input.price_cents !== undefined && (!Number.isInteger(input.price_cents) || input.price_cents < 0)) {
    throw new MaintenancePlanError("validation", "price_cents must be a non-negative integer");
  }
  if (input.visit_entitlement_count !== undefined && input.visit_entitlement_count !== null
    && (!Number.isInteger(input.visit_entitlement_count) || input.visit_entitlement_count < 0)) {
    throw new MaintenancePlanError("validation", "visit_entitlement_count must be a non-negative integer or null (unlimited)");
  }
  if (input.discount_type === "percent" && (input.discount_percent == null || input.discount_percent < 0 || input.discount_percent > 100)) {
    throw new MaintenancePlanError("validation", "discount_percent must be between 0 and 100 when discount_type is percent");
  }
  if (input.discount_type === "fixed" && (input.discount_fixed_cents == null || input.discount_fixed_cents < 0)) {
    throw new MaintenancePlanError("validation", "discount_fixed_cents must be a non-negative integer when discount_type is fixed");
  }
}

export async function listMaintenancePlans(organizationId: number, includeInactive: boolean): Promise<MaintenancePlanRow[]> {
  if (includeInactive) {
    return query<MaintenancePlanRow>(
      "SELECT * FROM maintenance_plans WHERE organization_id = ? ORDER BY sort_order ASC, name ASC", [organizationId]
    );
  }
  return query<MaintenancePlanRow>(
    "SELECT * FROM maintenance_plans WHERE organization_id = ? AND active = 1 ORDER BY sort_order ASC, name ASC", [organizationId]
  );
}

export async function getMaintenancePlan(organizationId: number, planId: number): Promise<MaintenancePlanRow | null> {
  const row = await get<MaintenancePlanRow>("SELECT * FROM maintenance_plans WHERE id = ? AND organization_id = ?", [planId, organizationId]);
  return row ?? null;
}

export async function assertPlanInOrganization(organizationId: number, planId: number): Promise<MaintenancePlanRow> {
  const plan = await getMaintenancePlan(organizationId, planId);
  if (!plan) throw new MaintenancePlanError("not_found", "Maintenance plan not found");
  return plan;
}

export async function createMaintenancePlan(organizationId: number, actorUserId: number, input: MaintenancePlanInput): Promise<MaintenancePlanRow> {
  validatePlanInput(input);
  const existing = await get<{ id: number }>(
    "SELECT id FROM maintenance_plans WHERE organization_id = ? AND code = ?", [organizationId, input.code.trim()]
  );
  if (existing) throw new MaintenancePlanError("conflict", `A plan with code "${input.code.trim()}" already exists`);

  const result = await run(
    `INSERT INTO maintenance_plans
      (organization_id, code, name, description, tier, active, price_cents, currency, taxable,
       visit_entitlement_count, frequency_description, priority_benefit, discount_type, discount_percent,
       discount_fixed_cents, included_services, excluded_services, other_benefits, equipment_eligibility,
       effective_from, effective_until, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, input.code.trim(), input.name.trim(), input.description ?? "", input.tier ?? "CUSTOM",
      input.active === false ? 0 : 1, input.price_cents ?? 0, input.currency ?? "CAD", input.taxable === false ? 0 : 1,
      input.visit_entitlement_count ?? null, input.frequency_description ?? "", input.priority_benefit ?? "",
      input.discount_type ?? "none", input.discount_percent ?? null, input.discount_fixed_cents ?? null,
      JSON.stringify(input.included_services ?? []), JSON.stringify(input.excluded_services ?? []),
      JSON.stringify(input.other_benefits ?? []), JSON.stringify(input.equipment_eligibility ?? []),
      input.effective_from ?? null, input.effective_until ?? null, input.sort_order ?? 0, actorUserId,
    ]
  );
  const planId = Number(result.lastInsertRowid);
  await recordPlanAudit(organizationId, planId, "plan_created", actorUserId, { code: input.code, name: input.name });

  const plan = await getMaintenancePlan(organizationId, planId);
  if (!plan) throw new MaintenancePlanError("not_found", "Failed to load newly created plan");
  return plan;
}

export async function updateMaintenancePlan(organizationId: number, actorUserId: number, planId: number, input: Partial<MaintenancePlanInput>): Promise<MaintenancePlanRow> {
  const existing = await assertPlanInOrganization(organizationId, planId);
  const merged: MaintenancePlanInput = {
    code: input.code ?? existing.code,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    tier: input.tier ?? existing.tier,
    active: input.active,
    price_cents: input.price_cents ?? existing.price_cents,
    currency: input.currency ?? existing.currency,
    taxable: input.taxable,
    visit_entitlement_count: input.visit_entitlement_count !== undefined ? input.visit_entitlement_count : existing.visit_entitlement_count,
    frequency_description: input.frequency_description ?? existing.frequency_description,
    priority_benefit: input.priority_benefit ?? existing.priority_benefit,
    discount_type: (input.discount_type ?? existing.discount_type) as MaintenancePlanInput["discount_type"],
    discount_percent: input.discount_percent !== undefined ? input.discount_percent : existing.discount_percent,
    discount_fixed_cents: input.discount_fixed_cents !== undefined ? input.discount_fixed_cents : existing.discount_fixed_cents,
    included_services: input.included_services ?? JSON.parse(existing.included_services),
    excluded_services: input.excluded_services ?? JSON.parse(existing.excluded_services),
    other_benefits: input.other_benefits ?? JSON.parse(existing.other_benefits),
    equipment_eligibility: input.equipment_eligibility ?? JSON.parse(existing.equipment_eligibility),
    effective_from: input.effective_from !== undefined ? input.effective_from : existing.effective_from,
    effective_until: input.effective_until !== undefined ? input.effective_until : existing.effective_until,
    sort_order: input.sort_order ?? existing.sort_order,
  };
  validatePlanInput(merged);

  if (merged.code.trim() !== existing.code) {
    const conflict = await get<{ id: number }>(
      "SELECT id FROM maintenance_plans WHERE organization_id = ? AND code = ? AND id != ?", [organizationId, merged.code.trim(), planId]
    );
    if (conflict) throw new MaintenancePlanError("conflict", `A plan with code "${merged.code.trim()}" already exists`);
  }

  const activeValue = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
  const taxableValue = input.taxable !== undefined ? (input.taxable ? 1 : 0) : existing.taxable;

  await run(
    `UPDATE maintenance_plans SET
      code = ?, name = ?, description = ?, tier = ?, active = ?, price_cents = ?, currency = ?, taxable = ?,
      visit_entitlement_count = ?, frequency_description = ?, priority_benefit = ?, discount_type = ?, discount_percent = ?,
      discount_fixed_cents = ?, included_services = ?, excluded_services = ?, other_benefits = ?, equipment_eligibility = ?,
      effective_from = ?, effective_until = ?, sort_order = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ?`,
    [
      merged.code.trim(), merged.name.trim(), merged.description ?? "", merged.tier ?? "CUSTOM", activeValue,
      merged.price_cents ?? 0, merged.currency ?? "CAD", taxableValue, merged.visit_entitlement_count ?? null,
      merged.frequency_description ?? "", merged.priority_benefit ?? "", merged.discount_type ?? "none",
      merged.discount_percent ?? null, merged.discount_fixed_cents ?? null, JSON.stringify(merged.included_services ?? []),
      JSON.stringify(merged.excluded_services ?? []), JSON.stringify(merged.other_benefits ?? []),
      JSON.stringify(merged.equipment_eligibility ?? []), merged.effective_from ?? null, merged.effective_until ?? null,
      merged.sort_order ?? 0, planId, organizationId,
    ]
  );

  if (input.active !== undefined && (input.active ? 1 : 0) !== existing.active) {
    await recordPlanAudit(organizationId, planId, input.active ? "plan_activated" : "plan_deactivated", actorUserId, {});
  } else {
    await recordPlanAudit(organizationId, planId, "plan_updated", actorUserId, { fields: Object.keys(input) });
  }

  const updated = await getMaintenancePlan(organizationId, planId);
  if (!updated) throw new MaintenancePlanError("not_found", "Failed to reload updated plan");
  return updated;
}

/** Frozen, self-contained snapshot of a plan's terms at the moment an
 *  Agreement Version is created — see Section 7 (Historical Plan
 *  Integrity). Every field a signed Agreement's PDF/UI needs is copied by
 *  value; a later plan edit can never alter an already-signed Agreement. */
export function buildPlanSnapshot(plan: MaintenancePlanRow): Record<string, unknown> {
  return {
    plan_id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    tier: plan.tier,
    price_cents: plan.price_cents,
    currency: plan.currency,
    taxable: !!plan.taxable,
    visit_entitlement_count: plan.visit_entitlement_count,
    frequency_description: plan.frequency_description,
    priority_benefit: plan.priority_benefit,
    discount_type: plan.discount_type,
    discount_percent: plan.discount_percent,
    discount_fixed_cents: plan.discount_fixed_cents,
    included_services: JSON.parse(plan.included_services),
    excluded_services: JSON.parse(plan.excluded_services),
    other_benefits: JSON.parse(plan.other_benefits),
    equipment_eligibility: JSON.parse(plan.equipment_eligibility),
    snapshotted_at: new Date().toISOString(),
  };
}
