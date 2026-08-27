import { get, query, run } from "./db.js";

/** Phase 17 — Pricebook (Core). A reusable, organization-scoped product/
 *  service catalog — the future authoritative source for Quote line-item
 *  selection, Contract equipment metadata, Invoice line items, and Phase
 *  18's Good/Better/Best packages. Industry-neutral by design: `type` is a
 *  flat, platform-general enum (not HVAC-specific), and HVAC-ish structured
 *  attributes (capacity, fuel type, refrigerant, etc.) live inside the
 *  `equipment_metadata`/`warranty_metadata` JSON blobs this file treats as
 *  opaque strings — it never inspects or validates their HVAC-specific
 *  keys, matching Core's "no industry logic leaks back in" boundary
 *  (validation of specific known keys, if ever needed, belongs to the
 *  HVAC module or the client form, not here).
 *
 *  Deliberately NOT unified with two existing, narrower, tenant-scoped
 *  tables found during this phase's pre-implementation audit:
 *    - `service_types` (job-scheduling default helper — name/duration/
 *      REAL-dollar price/color, no cost-split/SKU/taxability/category)
 *    - `materials`/`job_materials` (job-material-usage tracker — REAL-
 *      dollar cost only, no sell price/SKU/taxability/category)
 *  Both remain untouched; see docs/PHASE17-PRICEBOOK.md for the full
 *  audit write-up and why coexistence (not migration) was the correct,
 *  minimal-risk choice for this phase.
 */

export type PricebookItemType = "EQUIPMENT" | "PART" | "MATERIAL" | "SERVICE" | "LABOR" | "OTHER";
export const PRICEBOOK_ITEM_TYPES: PricebookItemType[] = ["EQUIPMENT", "PART", "MATERIAL", "SERVICE", "LABOR", "OTHER"];

export type PricebookItemStatus = "active" | "inactive";
export const PRICEBOOK_ITEM_STATUSES: PricebookItemStatus[] = ["active", "inactive"];

export class PricebookError extends Error {
  code: "not_found" | "invalid_type" | "invalid_status" | "invalid_category" | "invalid_price" | "invalid_filter" | "duplicate_sku" | "referenced" | "invalid_metadata" | "invalid_name";
  constructor(code: PricebookError["code"], message: string) {
    super(message);
    this.name = "PricebookError";
    this.code = code;
  }
}

/** Admin-only: full catalog management (create/edit/archive/categories/
 *  cost visibility/import-export). Section 30/31 — cost is sensitive
 *  business data, never exposed beyond this role. */
export function canManagePricebook(role: string): boolean {
  return role === "admin";
}

/** Admin + Dispatcher: read the catalog and select items into Quotes —
 *  never cost (stripped at serialization, see `toPricebookItemView`), never
 *  catalog administration. Technician gets NO access to this surface at
 *  all — same binary front-office/sales-vs-field-work split already
 *  established for Leads/Quotes/Contracts/Phone-Operations in this
 *  codebase (a technician's actual field-work surface is the Job/Asset
 *  data they're assigned, not direct catalog browsing; dispatch/quoting
 *  stays a human/dispatcher decision, matching the Phase 16 "dispatch
 *  stays human" precedent). Documented, evidence-based policy choice, not
 *  left as the task's own "Possible" suggestion of a partial technician
 *  read — see docs/PHASE17-PRICEBOOK.md. */
export function canViewPricebook(role: string): boolean {
  return role === "admin" || role === "dispatcher";
}

export interface PricebookCategory {
  id: number;
  organization_id: number;
  name: string;
  description: string;
  active: boolean;
  sort_order: number;
  parent_category_id: number | null;
  created_at: string;
  updated_at: string;
}

interface PricebookCategoryRow extends Omit<PricebookCategory, "active"> { active: number }
function toCategory(row: PricebookCategoryRow): PricebookCategory {
  return { ...row, active: !!row.active };
}

export interface PricebookCategoryInput {
  name?: string;
  description?: string;
  active?: boolean;
  sort_order?: number;
  parent_category_id?: number | null;
}

export interface PricebookItem {
  id: number;
  organization_id: number;
  type: PricebookItemType;
  name: string;
  description: string;
  internal_notes: string;
  sku: string;
  category_id: number | null;
  manufacturer: string;
  model: string;
  unit: string;
  default_quantity: number;
  cost_cents: number;
  sell_price_cents: number;
  taxable: boolean;
  status: PricebookItemStatus;
  preferred_vendor: string;
  vendor_sku: string;
  equipment_metadata: string;
  warranty_metadata: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface PricebookItemRow extends Omit<PricebookItem, "taxable"> { taxable: number }
function toItem(row: PricebookItemRow): PricebookItem {
  return { ...row, taxable: !!row.taxable };
}

/** Cost/internal fields stripped for any role without `canManagePricebook`
 *  — Section 31's "test direct API response projections... do not rely on
 *  hiding columns only" is satisfied by never SELECTing these columns for
 *  an unauthorized caller in the first place (see `listItems`/`getItem`'s
 *  `includeCost` parameter), not just omitting them in a client-side view
 *  model. This type/function pair is the second layer for call sites that
 *  already have a full row in hand. */
export type PricebookItemPublicView = Omit<PricebookItem, "cost_cents" | "internal_notes" | "preferred_vendor" | "vendor_sku">;
export function stripCost(item: PricebookItem): PricebookItemPublicView {
  return {
    id: item.id,
    organization_id: item.organization_id,
    type: item.type,
    name: item.name,
    description: item.description,
    sku: item.sku,
    category_id: item.category_id,
    manufacturer: item.manufacturer,
    model: item.model,
    unit: item.unit,
    default_quantity: item.default_quantity,
    sell_price_cents: item.sell_price_cents,
    taxable: item.taxable,
    status: item.status,
    equipment_metadata: item.equipment_metadata,
    warranty_metadata: item.warranty_metadata,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

export interface PricebookItemInput {
  type?: string;
  name?: string;
  description?: string;
  internal_notes?: string;
  sku?: string;
  category_id?: number | null;
  manufacturer?: string;
  model?: string;
  unit?: string;
  default_quantity?: number;
  cost_cents?: number;
  sell_price_cents?: number;
  taxable?: boolean;
  status?: string;
  preferred_vendor?: string;
  vendor_sku?: string;
  equipment_metadata?: string;
  warranty_metadata?: string;
}

// Escapes SQLite LIKE metacharacters and caps wildcard density before a
// free-text filter reaches a bound LIKE parameter — same pattern (and same
// "D1 rejects an overly-wildcard-dense pattern before ESCAPE semantics even
// apply" reasoning) already established locally in assets.ts/quotes.ts/
// contracts.ts; duplicated here per this codebase's own per-module
// convention (grepped: none of those three share a common helper either)
// rather than introducing new shared infrastructure for one function.
function likePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}
const MAX_LIKE_WILDCARD_CHARS = 20;
function assertSearchableFilter(value: string): void {
  const wildcardCount = (value.match(/[%_]/g) || []).length;
  if (wildcardCount > MAX_LIKE_WILDCARD_CHARS) {
    throw new PricebookError("invalid_filter", "Search filter is too complex — try a shorter or simpler value");
  }
}

const MAX_METADATA_JSON_LENGTH = 8000;
function validateMetadataJson(value: string | undefined, label: string): string {
  if (value === undefined || value === "") return "{}";
  if (value.length > MAX_METADATA_JSON_LENGTH) {
    throw new PricebookError("invalid_metadata", `${label} is too large`);
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
  } catch {
    throw new PricebookError("invalid_metadata", `${label} must be a valid JSON object`);
  }
  return value;
}

function validateMoney(value: number | undefined, fieldLabel: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new PricebookError("invalid_price", `${fieldLabel} must be a non-negative integer (cents)`);
  }
  return value;
}

async function assertCategoryInOrganization(organizationId: number, categoryId: number): Promise<void> {
  const row = await get<{ id: number }>(
    "SELECT id FROM pricebook_categories WHERE id = ? AND organization_id = ?", [categoryId, organizationId]
  );
  if (!row) throw new PricebookError("invalid_category", "Category not found");
}

async function recordAudit(organizationId: number, itemId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO pricebook_item_audit (organization_id, item_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?, ?)",
    [organizationId, itemId, eventType, actorUserId, JSON.stringify(details)]
  );
}

// ── Categories ───────────────────────────────────────────────────────

export async function listCategories(organizationId: number, activeOnly = false): Promise<PricebookCategory[]> {
  const where = activeOnly ? "WHERE organization_id = ? AND active = 1" : "WHERE organization_id = ?";
  const rows = await query<PricebookCategoryRow>(
    `SELECT * FROM pricebook_categories ${where} ORDER BY sort_order ASC, name ASC`, [organizationId]
  );
  return rows.map(toCategory);
}

export async function getCategory(organizationId: number, id: number): Promise<PricebookCategory | null> {
  const row = await get<PricebookCategoryRow>("SELECT * FROM pricebook_categories WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return row ? toCategory(row) : null;
}

export async function createCategory(organizationId: number, input: PricebookCategoryInput): Promise<PricebookCategory> {
  if (!input.name || !input.name.trim()) throw new PricebookError("invalid_name", "Category name is required");
  if (input.parent_category_id != null) await assertCategoryInOrganization(organizationId, input.parent_category_id);
  const result = await run(
    `INSERT INTO pricebook_categories (organization_id, name, description, active, sort_order, parent_category_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [organizationId, input.name.trim(), input.description ?? "", input.active === false ? 0 : 1, input.sort_order ?? 0, input.parent_category_id ?? null]
  );
  const category = await getCategory(organizationId, Number(result.lastInsertRowid));
  return category as PricebookCategory;
}

export async function updateCategory(organizationId: number, id: number, input: PricebookCategoryInput): Promise<PricebookCategory | null> {
  const existing = await getCategory(organizationId, id);
  if (!existing) return null;
  if (input.parent_category_id != null) {
    if (input.parent_category_id === id) throw new PricebookError("invalid_category", "A category cannot be its own parent");
    await assertCategoryInOrganization(organizationId, input.parent_category_id);
  }
  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: string, value: unknown) => { fields.push(`${col} = ?`); vals.push(value); };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new PricebookError("invalid_name", "Category name is required");
    setIfPresent("name", input.name.trim());
  }
  if (input.description !== undefined) setIfPresent("description", input.description);
  if (input.active !== undefined) setIfPresent("active", input.active ? 1 : 0);
  if (input.sort_order !== undefined) setIfPresent("sort_order", input.sort_order);
  if (input.parent_category_id !== undefined) setIfPresent("parent_category_id", input.parent_category_id);
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE pricebook_categories SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return getCategory(organizationId, id);
}

/** Categories are never hard-deleted once items may reference them — a
 *  category with items should be deactivated instead. Delete is only
 *  permitted when nothing (no item, no child category) references it,
 *  same "retire, don't delete out from under real data" discipline as
 *  Assets/Jobs elsewhere in this codebase. */
export async function deleteCategory(organizationId: number, id: number): Promise<boolean> {
  const existing = await getCategory(organizationId, id);
  if (!existing) return false;
  const itemRef = await get<{ id: number }>("SELECT id FROM pricebook_items WHERE category_id = ? LIMIT 1", [id]);
  if (itemRef) throw new PricebookError("referenced", "This category has Pricebook items — deactivate it instead of deleting");
  const childRef = await get<{ id: number }>("SELECT id FROM pricebook_categories WHERE parent_category_id = ? LIMIT 1", [id]);
  if (childRef) throw new PricebookError("referenced", "This category has child categories — deactivate it instead of deleting");
  await run("DELETE FROM pricebook_categories WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return true;
}

// ── Items ────────────────────────────────────────────────────────────

export interface PricebookItemListFilters {
  type?: string;
  status?: string;
  category_id?: number;
  manufacturer?: string;
  search?: string;
}

export async function listItems(
  organizationId: number, filters: PricebookItemListFilters, limit: number, offset: number
): Promise<{ items: PricebookItem[]; total: number }> {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];

  if (filters.type) { conditions.push("type = ?"); params.push(filters.type); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  if (filters.category_id !== undefined) { conditions.push("category_id = ?"); params.push(filters.category_id); }
  if (filters.manufacturer) {
    assertSearchableFilter(filters.manufacturer);
    conditions.push("manufacturer LIKE ? ESCAPE '\\'");
    params.push(likePattern(filters.manufacturer));
  }
  if (filters.search) {
    assertSearchableFilter(filters.search);
    conditions.push("(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')");
    const like = likePattern(filters.search);
    params.push(like, like, like, like);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM pricebook_items ${where}`, params);
  const rows = await query<PricebookItemRow>(
    `SELECT * FROM pricebook_items ${where} ORDER BY name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(toItem), total: countRow?.count || 0 };
}

export async function getItem(organizationId: number, id: number): Promise<PricebookItem | null> {
  const row = await get<PricebookItemRow>("SELECT * FROM pricebook_items WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return row ? toItem(row) : null;
}

function normalizeSku(sku: string | undefined): string {
  return (sku ?? "").trim();
}

async function assertSkuAvailable(organizationId: number, sku: string, excludeId?: number): Promise<void> {
  if (!sku) return; // Section 22 — uniqueness only enforced when non-empty.
  const row = await get<{ id: number }>(
    "SELECT id FROM pricebook_items WHERE organization_id = ? AND sku = ? AND id != ?",
    [organizationId, sku, excludeId ?? -1]
  );
  if (row) throw new PricebookError("duplicate_sku", `SKU "${sku}" is already in use by another item`);
}

export async function createItem(organizationId: number, actorUserId: number | null, input: PricebookItemInput): Promise<PricebookItem> {
  if (!input.name || !input.name.trim()) throw new PricebookError("invalid_name", "Item name is required");
  if (!input.type || !PRICEBOOK_ITEM_TYPES.includes(input.type as PricebookItemType)) {
    throw new PricebookError("invalid_type", `type must be one of ${PRICEBOOK_ITEM_TYPES.join(", ")}`);
  }
  const status = input.status ?? "active";
  if (!PRICEBOOK_ITEM_STATUSES.includes(status as PricebookItemStatus)) {
    throw new PricebookError("invalid_status", `status must be one of ${PRICEBOOK_ITEM_STATUSES.join(", ")}`);
  }
  if (input.category_id != null) await assertCategoryInOrganization(organizationId, input.category_id);
  const sku = normalizeSku(input.sku);
  await assertSkuAvailable(organizationId, sku);
  const costCents = validateMoney(input.cost_cents, "cost_cents", 0);
  const sellPriceCents = validateMoney(input.sell_price_cents, "sell_price_cents", 0);
  const equipmentMetadata = validateMetadataJson(input.equipment_metadata, "equipment_metadata");
  const warrantyMetadata = validateMetadataJson(input.warranty_metadata, "warranty_metadata");
  const defaultQuantity = input.default_quantity !== undefined && input.default_quantity > 0 ? input.default_quantity : 1;

  let result;
  try {
    result = await run(
      `INSERT INTO pricebook_items
         (organization_id, type, name, description, internal_notes, sku, category_id, manufacturer, model, unit,
          default_quantity, cost_cents, sell_price_cents, taxable, status, preferred_vendor, vendor_sku,
          equipment_metadata, warranty_metadata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId, input.type, input.name.trim(), input.description ?? "", input.internal_notes ?? "", sku,
        input.category_id ?? null, input.manufacturer ?? "", input.model ?? "", input.unit ?? "each",
        defaultQuantity, costCents, sellPriceCents, input.taxable === false ? 0 : 1, status,
        input.preferred_vendor ?? "", input.vendor_sku ?? "", equipmentMetadata, warrantyMetadata, actorUserId,
      ]
    );
  } catch (err) {
    // Defense in depth against the partial-unique-index race the pre-check
    // above can't fully close (two concurrent creates with the same new
    // SKU) — same "claim via the DB constraint, translate its failure into
    // a clean domain error" idiom used elsewhere in this codebase (e.g.
    // phone-operations-crm.ts's idempotency claim).
    if (String(err).includes("UNIQUE") && sku) throw new PricebookError("duplicate_sku", `SKU "${sku}" is already in use by another item`);
    throw err;
  }
  const item = await getItem(organizationId, Number(result.lastInsertRowid));
  await recordAudit(organizationId, item!.id, "created", actorUserId, { type: item!.type, name: item!.name, sell_price_cents: sellPriceCents, cost_cents: costCents });
  return item as PricebookItem;
}

export async function updateItem(organizationId: number, actorUserId: number | null, id: number, input: PricebookItemInput): Promise<PricebookItem | null> {
  const existing = await getItem(organizationId, id);
  if (!existing) return null;

  if (input.type !== undefined && !PRICEBOOK_ITEM_TYPES.includes(input.type as PricebookItemType)) {
    throw new PricebookError("invalid_type", `type must be one of ${PRICEBOOK_ITEM_TYPES.join(", ")}`);
  }
  if (input.status !== undefined && !PRICEBOOK_ITEM_STATUSES.includes(input.status as PricebookItemStatus)) {
    throw new PricebookError("invalid_status", `status must be one of ${PRICEBOOK_ITEM_STATUSES.join(", ")}`);
  }
  if (input.category_id != null) await assertCategoryInOrganization(organizationId, input.category_id);
  let sku = existing.sku;
  if (input.sku !== undefined) {
    sku = normalizeSku(input.sku);
    await assertSkuAvailable(organizationId, sku, id);
  }
  const costCents = input.cost_cents !== undefined ? validateMoney(input.cost_cents, "cost_cents", existing.cost_cents) : existing.cost_cents;
  const sellPriceCents = input.sell_price_cents !== undefined ? validateMoney(input.sell_price_cents, "sell_price_cents", existing.sell_price_cents) : existing.sell_price_cents;
  const equipmentMetadata = input.equipment_metadata !== undefined ? validateMetadataJson(input.equipment_metadata, "equipment_metadata") : undefined;
  const warrantyMetadata = input.warranty_metadata !== undefined ? validateMetadataJson(input.warranty_metadata, "warranty_metadata") : undefined;
  if (input.name !== undefined && !input.name.trim()) throw new PricebookError("invalid_name", "Item name is required");

  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: string, value: unknown) => { fields.push(`${col} = ?`); vals.push(value); };
  if (input.type !== undefined) setIfPresent("type", input.type);
  if (input.name !== undefined) setIfPresent("name", input.name.trim());
  if (input.description !== undefined) setIfPresent("description", input.description);
  if (input.internal_notes !== undefined) setIfPresent("internal_notes", input.internal_notes);
  if (input.sku !== undefined) setIfPresent("sku", sku);
  if (input.category_id !== undefined) setIfPresent("category_id", input.category_id);
  if (input.manufacturer !== undefined) setIfPresent("manufacturer", input.manufacturer);
  if (input.model !== undefined) setIfPresent("model", input.model);
  if (input.unit !== undefined) setIfPresent("unit", input.unit);
  if (input.default_quantity !== undefined) setIfPresent("default_quantity", input.default_quantity > 0 ? input.default_quantity : 1);
  if (input.cost_cents !== undefined) setIfPresent("cost_cents", costCents);
  if (input.sell_price_cents !== undefined) setIfPresent("sell_price_cents", sellPriceCents);
  if (input.taxable !== undefined) setIfPresent("taxable", input.taxable ? 1 : 0);
  if (input.status !== undefined) setIfPresent("status", input.status);
  if (input.preferred_vendor !== undefined) setIfPresent("preferred_vendor", input.preferred_vendor);
  if (input.vendor_sku !== undefined) setIfPresent("vendor_sku", input.vendor_sku);
  if (equipmentMetadata !== undefined) setIfPresent("equipment_metadata", equipmentMetadata);
  if (warrantyMetadata !== undefined) setIfPresent("warranty_metadata", warrantyMetadata);

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    try {
      await run(`UPDATE pricebook_items SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
    } catch (err) {
      if (String(err).includes("UNIQUE") && sku) throw new PricebookError("duplicate_sku", `SKU "${sku}" is already in use by another item`);
      throw err;
    }
  }

  // Price-change audit (Section 47) — only recorded when cost or sell price
  // actually changed, not on every unrelated field edit, so the audit log
  // stays a meaningful "commercial change" trail rather than firing on
  // every metadata tweak.
  if (costCents !== existing.cost_cents || sellPriceCents !== existing.sell_price_cents) {
    await recordAudit(organizationId, id, "price_changed", actorUserId, {
      old_cost_cents: existing.cost_cents, new_cost_cents: costCents,
      old_sell_price_cents: existing.sell_price_cents, new_sell_price_cents: sellPriceCents,
    });
  }
  if (input.status !== undefined && input.status !== existing.status) {
    await recordAudit(organizationId, id, input.status === "active" ? "activated" : "deactivated", actorUserId, { from: existing.status, to: input.status });
  }

  return getItem(organizationId, id);
}

export async function listItemAudit(organizationId: number, itemId: number): Promise<Array<{ id: number; event_type: string; actor_user_id: number | null; details: string; created_at: string }>> {
  return query("SELECT id, event_type, actor_user_id, details, created_at FROM pricebook_item_audit WHERE organization_id = ? AND item_id = ? ORDER BY created_at DESC", [organizationId, itemId]);
}
