import { get, query, run } from "./db.js";
import type { Role } from "./auth.js";
import { getItem as getPricebookItem } from "./pricebook.js";

/**
 * Phase 11.4 — Assets / Equipment (Core). A generic Core concept ("Asset";
 * the UI may label it "Equipment" for HVAC users — see customer-assets.tsx/
 * job-assets.tsx) representing a piece of physical equipment a Customer
 * owns. This file is fully industry-neutral: it has ZERO knowledge of HVAC-
 * specific asset types (heat pump, furnace, etc — see
 * src/server/modules/hvac/asset-types.ts) or any registry composed from
 * them. `asset_type` arrives here as an already-validated plain string —
 * validation against the known-type registry happens at the Zod schema
 * layer in index.ts (mirrors how JOB_TYPES validates job_type before
 * workflow.ts's functions ever run), so this file never imports modules/**
 * and needs no architecture-guard composition-root exception (unlike
 * workflow.ts's JOB_TYPE_REGISTRY, which has genuine per-type engine
 * behavior to close over — Assets have none, just a flat label lookup).
 *
 * Ownership: Organization -> Customer -> Asset. `organization_id` is a
 * direct column (DIRECT_TENANT_COLUMN, matching jobs/customers/leads/
 * invoices — see migrations/0016) because Assets need their own
 * independently listable/searchable/paginated endpoint, not just parent-
 * JOIN access. Every function below takes `organizationId` as its first
 * parameter and scopes every query by it — callers (index.ts route
 * handlers) must always pass `actorOrganizationId(c)`, never a
 * client-supplied value.
 */

export interface Actor {
  id: number;
  role: Role;
}

export type AssetStatus = "active" | "inactive" | "retired";
export const ASSET_STATUSES: AssetStatus[] = ["active", "inactive", "retired"];

export class AssetError extends Error {
  code: "not_found" | "invalid_customer" | "invalid_date" | "invalid_filter" | "referenced" | "cross_customer" | "already_linked" | "reparent_blocked" | "invalid_pricebook_item";
  constructor(code: AssetError["code"], message: string) {
    super(message);
    this.name = "AssetError";
    this.code = code;
  }
}

/** Same admin/dispatcher-manage, technician-read-linked-only split already
 *  established for Customers/Leads-adjacent operational data (see
 *  mem:architecture/auth) — a technician never manages a customer's
 *  equipment inventory, only views what's linked to their own assigned Job
 *  (enforced separately by listAssetsForJob's ownership check, not here). */
export function canManageAssets(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

/** Delete/retire follows the customer-delete precedent (admin AND
 *  dispatcher), not the technician-delete precedent (admin-only) — an
 *  Asset is customer-equipment operational data, not a staff/personnel
 *  record. See mem:risks/unrestricted-destructive-mutations. */
export const canDeleteAsset = canManageAssets;

export interface Asset {
  id: number;
  organization_id: number;
  customer_id: number;
  asset_type: string;
  display_name: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  installation_date: string | null;
  status: AssetStatus;
  notes: string;
  pricebook_item_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface AssetInput {
  customer_id?: number;
  asset_type?: string;
  display_name?: string;
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  installation_date?: string | null;
  status?: string;
  notes?: string;
  // Phase 17 — Pricebook. Purely a provenance pointer to the catalog
  // Equipment definition this Asset was sold/installed from (Section 40) —
  // never re-derives any of the Asset's own manufacturer/model/serial
  // fields, which stay independently editable. Nullable, no re-validation
  // once set beyond "belongs to this organization" at write time.
  pricebook_item_id?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateInstallationDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!DATE_RE.test(value)) {
    throw new AssetError("invalid_date", "installation_date must be in YYYY-MM-DD format");
  }
  return value;
}

/** Verifies `customerId` exists and belongs to `organizationId` — the exact
 *  "cross-entity FK reference must be same-org before trust" check every
 *  other domain in this app already applies (see e.g.
 *  resolveReferralAttribution). Throws rather than returning a boolean so
 *  callers can't accidentally forget to check a return value. */
async function assertCustomerInOrganization(organizationId: number, customerId: number): Promise<void> {
  const row = await get<{ id: number }>(
    "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [customerId, organizationId]
  );
  if (!row) throw new AssetError("invalid_customer", "Customer not found");
}

// Same "cross-entity FK reference must be same-org before trust" check as
// assertCustomerInOrganization above, for the Section 40 provenance link.
async function assertPricebookItemInOrganization(organizationId: number, pricebookItemId: number): Promise<void> {
  const item = await getPricebookItem(organizationId, pricebookItemId);
  if (!item) throw new AssetError("invalid_pricebook_item", "Pricebook item not found");
}

export async function createAsset(organizationId: number, input: AssetInput): Promise<Asset> {
  if (input.customer_id === undefined) throw new AssetError("invalid_customer", "customer_id is required");
  await assertCustomerInOrganization(organizationId, input.customer_id);
  const installationDate = validateInstallationDate(input.installation_date);
  if (input.pricebook_item_id != null) await assertPricebookItemInOrganization(organizationId, input.pricebook_item_id);

  const result = await run(
    `INSERT INTO assets
       (organization_id, customer_id, asset_type, display_name, manufacturer, model, serial_number, installation_date, status, notes, pricebook_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, input.customer_id, input.asset_type ?? "", input.display_name ?? "",
      input.manufacturer ?? "", input.model ?? "", input.serial_number ?? "",
      installationDate, input.status ?? "active", input.notes ?? "", input.pricebook_item_id ?? null,
    ]
  );
  const asset = await get<Asset>("SELECT * FROM assets WHERE id = ?", [result.lastInsertRowid]);
  return asset as Asset;
}

export async function getAsset(organizationId: number, id: number): Promise<Asset | null> {
  const asset = await get<Asset>("SELECT * FROM assets WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return asset ?? null;
}

export interface AssetListFilters {
  customer_id?: number;
  asset_type?: string;
  status?: string;
  manufacturer?: string;
  search?: string;
}

/** Escapes SQLite LIKE metacharacters (`%`, `_`) — and the escape character
 *  itself — in free-text filter input before wrapping it as a `%...%`
 *  substring pattern. Security-review finding (Phase 11.4): an
 *  unescaped `manufacturer`/`search` value containing many `%`/`_`
 *  characters could reach D1 as a literal LIKE pattern and trip SQLite's
 *  own "LIKE or GLOB pattern too complex" limit, which surfaced as an
 *  unhandled 500 with a raw error body — never a SQL-injection risk (the
 *  value is still a bound parameter, never concatenated into the query
 *  text), but a real input-validation gap. Escaping here turns a
 *  user-supplied `%`/`_` back into a literal character to match, exactly
 *  like every other LIKE-based search in this codebase should. */
function likePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

// Security-review follow-up: escaping alone does NOT prevent D1/SQLite's
// "LIKE or GLOB pattern too complex" error — confirmed live that it's
// triggered by the raw COUNT of `%`/`_` characters in the pattern, before
// ESCAPE semantics are even applied, so a wildcard-dense value still
// crashes the query even once escaped for correctness. A proactive count
// cap here (rather than pattern-matching D1's internal error text, which is
// brittle across engine versions) rejects the pathological input BEFORE it
// ever reaches SQL, with a clear, honest validation message instead of a
// raw 500. 20 is generously above any realistic manufacturer/serial/name
// search term's real `%`/`_` usage.
const MAX_LIKE_WILDCARD_CHARS = 20;

function assertSearchableFilter(value: string): void {
  const wildcardCount = (value.match(/[%_]/g) || []).length;
  if (wildcardCount > MAX_LIKE_WILDCARD_CHARS) {
    throw new AssetError("invalid_filter", "Search or manufacturer filter is too complex — try a shorter or simpler value");
  }
}

export async function listAssets(
  organizationId: number, filters: AssetListFilters, limit: number, offset: number
): Promise<{ assets: Asset[]; total: number }> {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];

  if (filters.customer_id !== undefined) {
    conditions.push("customer_id = ?");
    params.push(filters.customer_id);
  }
  if (filters.asset_type) {
    conditions.push("asset_type = ?");
    params.push(filters.asset_type);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.manufacturer) {
    assertSearchableFilter(filters.manufacturer);
    conditions.push("manufacturer LIKE ? ESCAPE '\\'");
    params.push(likePattern(filters.manufacturer));
  }
  if (filters.search) {
    assertSearchableFilter(filters.search);
    conditions.push("(display_name LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR serial_number LIKE ? ESCAPE '\\')");
    const like = likePattern(filters.search);
    params.push(like, like, like, like);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  // Tenant filtering happens first (organization_id is always conditions[0])
  // and identically in both the data and count queries, before pagination
  // is ever applied — same discipline as listCustomers/listJobs/listLeads.
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM assets ${where}`, params);
  const assets = await query<Asset>(
    `SELECT * FROM assets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { assets, total: countRow?.count || 0 };
}

export async function updateAsset(organizationId: number, id: number, input: AssetInput): Promise<Asset | null> {
  const existing = await getAsset(organizationId, id);
  if (!existing) return null;

  if (input.customer_id !== undefined && input.customer_id !== existing.customer_id) {
    await assertCustomerInOrganization(organizationId, input.customer_id);
    // Independent architecture review (Phase 11.4) caught a real gap: without
    // this check, re-parenting an asset to a different customer while it's
    // still linked to a Job of the OLD customer would silently violate the
    // migration's own documented "cross-customer linking is impossible by
    // construction" invariant — linkAssetToJob only checks this at link
    // time, so a later customer_id edit could leave job_assets rows
    // pointing at a Job whose customer no longer matches. Same "retire/
    // unlink first, don't mutate out from under an existing relationship"
    // philosophy already applied to deleteAsset's referenced-asset guard.
    const linked = await get<{ id: number }>("SELECT id FROM job_assets WHERE asset_id = ? LIMIT 1", [id]);
    if (linked) {
      throw new AssetError("reparent_blocked", "This asset is linked to at least one job — unlink it before reassigning it to a different customer");
    }
  }
  const installationDate = input.installation_date !== undefined
    ? validateInstallationDate(input.installation_date)
    : existing.installation_date;
  if (input.pricebook_item_id != null) await assertPricebookItemInOrganization(organizationId, input.pricebook_item_id);

  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: keyof AssetInput, value: unknown) => {
    if (input[col] !== undefined) {
      fields.push(`${col} = ?`);
      vals.push(value);
    }
  };
  setIfPresent("customer_id", input.customer_id);
  setIfPresent("asset_type", input.asset_type);
  setIfPresent("display_name", input.display_name);
  setIfPresent("manufacturer", input.manufacturer);
  setIfPresent("model", input.model);
  setIfPresent("serial_number", input.serial_number);
  if (input.installation_date !== undefined) {
    fields.push("installation_date = ?");
    vals.push(installationDate);
  }
  setIfPresent("status", input.status);
  setIfPresent("notes", input.notes);
  setIfPresent("pricebook_item_id", input.pricebook_item_id);

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE assets SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return getAsset(organizationId, id);
}

/** Hard-deletes an Asset only when nothing references it via job_assets —
 *  a referenced Asset must be retired (PUT status='retired') instead, never
 *  deleted out from under historical Job data. Returns false when the asset
 *  doesn't exist in this organization (caller 404s); throws AssetError
 *  ("referenced") when it exists but is still linked to at least one Job. */
export async function deleteAsset(organizationId: number, id: number): Promise<boolean> {
  const existing = await getAsset(organizationId, id);
  if (!existing) return false;

  const linked = await get<{ id: number }>("SELECT id FROM job_assets WHERE asset_id = ? LIMIT 1", [id]);
  if (linked) {
    throw new AssetError("referenced", "This asset is linked to at least one job — retire it instead of deleting");
  }
  await run("DELETE FROM assets WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return true;
}

interface JobCustomerRow {
  id: number;
  customer_id: number;
}

/** Links `assetId` to `jobId` — both must exist in `organizationId`, and
 *  the asset must belong to the SAME customer as the job (default DENY on
 *  cross-customer linking, per Phase 11.4's explicit requirement; this app
 *  has no shared-asset-across-customers concept). Idempotent-safe: linking
 *  an already-linked pair throws AssetError("already_linked") rather than
 *  silently duplicating (the UNIQUE(job_id, asset_id) index backstops this
 *  at the DB level regardless). */
export async function linkAssetToJob(organizationId: number, jobId: number, assetId: number): Promise<void> {
  const job = await get<JobCustomerRow>(
    "SELECT id, customer_id FROM jobs WHERE id = ? AND organization_id = ?", [jobId, organizationId]
  );
  if (!job) throw new AssetError("not_found", "Job not found");

  const asset = await getAsset(organizationId, assetId);
  if (!asset) throw new AssetError("not_found", "Asset not found");

  if (asset.customer_id !== job.customer_id) {
    throw new AssetError("cross_customer", "This asset belongs to a different customer than this job");
  }

  const already = await get<{ id: number }>(
    "SELECT id FROM job_assets WHERE job_id = ? AND asset_id = ?", [jobId, assetId]
  );
  if (already) throw new AssetError("already_linked", "This asset is already linked to this job");

  await run("INSERT INTO job_assets (job_id, asset_id) VALUES (?, ?)", [jobId, assetId]);
}

/** Unlinking is idempotent by design (same "DELETE never errors on an
 *  already-absent relationship" convention as every other delete route in
 *  this app) — the only failure mode reported is the job itself not
 *  existing in this organization; whether the link was actually present
 *  makes no difference to the caller. */
export async function unlinkAssetFromJob(organizationId: number, jobId: number, assetId: number): Promise<"job_not_found" | "ok"> {
  const job = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [jobId, organizationId]);
  if (!job) return "job_not_found";
  await run("DELETE FROM job_assets WHERE job_id = ? AND asset_id = ?", [jobId, assetId]);
  return "ok";
}

/** Returns the Assets linked to `jobId`, or `null` if the job doesn't exist
 *  in `organizationId` (caller 404s). No technician ownership check here —
 *  that's the route handler's job (index.ts), matching every other job
 *  sub-resource in this codebase (job notes/checklist/materials all follow
 *  the same "ownership check lives in the route, storage function trusts
 *  its caller" split). */
export async function listAssetsForJob(organizationId: number, jobId: number): Promise<Asset[] | null> {
  const job = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [jobId, organizationId]);
  if (!job) return null;
  return query<Asset>(
    `SELECT a.* FROM assets a
     JOIN job_assets ja ON ja.asset_id = a.id
     WHERE ja.job_id = ?
     ORDER BY a.created_at ASC`,
    [jobId]
  );
}
