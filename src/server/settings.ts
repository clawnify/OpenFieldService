import { get, query, run } from "./db.js";

export type SettingDataType = "string" | "number" | "boolean" | "json";

export interface GlobalSettingRow {
  id: number;
  organization_id: number;
  key: string;
  value: string;
  data_type: SettingDataType;
  category: string;
  description: string;
  effective_from: string;
  effective_until: string | null;
  active: number;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

/** The version of `key` in effect at `asOf` (defaults to now) — the row whose
 *  effective range covers that instant. Returns null if the key has never been
 *  set, or was retired before `asOf`. This is what lets a job evaluated last
 *  month keep resolving last month's threshold even after an admin changes it
 *  today: pass the job's own evaluation timestamp as `asOf`.
 *
 *  Phase 11.5: every query here is scoped by `organizationId` first — Global
 *  Settings are business-level configuration (rebate thresholds, business
 *  timezone, reference-data option lists), so they're organization-owned,
 *  not truly global. Org A publishing a new threshold must never affect Org
 *  B's resolved values. */
export async function getSettingRow(organizationId: number, key: string, asOf?: string): Promise<GlobalSettingRow | null> {
  const at = asOf ?? new Date().toISOString();
  const row = await get<GlobalSettingRow>(
    `SELECT * FROM global_settings
     WHERE organization_id = ? AND key = ? AND active = 1 AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until > ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [organizationId, key, at, at]
  );
  return row ?? null;
}

function coerce(row: GlobalSettingRow): unknown {
  switch (row.data_type) {
    case "number": return Number(row.value);
    case "boolean": return row.value === "true";
    case "json": return JSON.parse(row.value);
    default: return row.value;
  }
}

export async function getSettingValue<T = unknown>(organizationId: number, key: string, asOf?: string): Promise<T | null> {
  const row = await getSettingRow(organizationId, key, asOf);
  return row ? (coerce(row) as T) : null;
}

/** Current (as-of-now) version of every key for `organizationId`, optionally
 *  narrowed to one category. One row per key — the version currently in
 *  effect. */
export async function listCurrentSettings(organizationId: number, category?: string): Promise<GlobalSettingRow[]> {
  const now = new Date().toISOString();
  const rows = await query<GlobalSettingRow>(
    `SELECT s.* FROM global_settings s
     WHERE s.organization_id = ? AND s.active = 1 AND s.effective_from <= ?
       AND (s.effective_until IS NULL OR s.effective_until > ?)
       AND s.effective_from = (
         SELECT MAX(s2.effective_from) FROM global_settings s2
         WHERE s2.organization_id = s.organization_id AND s2.key = s.key AND s2.active = 1 AND s2.effective_from <= ?
       )
     ORDER BY s.category ASC, s.key ASC`,
    [organizationId, now, now, now]
  );
  return category ? rows.filter((r) => r.category === category) : rows;
}

export async function getSettingHistory(organizationId: number, key: string): Promise<GlobalSettingRow[]> {
  return query<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE organization_id = ? AND key = ? ORDER BY effective_from DESC", [organizationId, key]
  );
}

export class SettingVersionError extends Error {}

/** Publishes a new version of `key` for `organizationId`, effective from
 *  `effectiveFrom` (default now). Never mutates a past version's value — it
 *  closes the previously-open version's `effective_until` at the new
 *  version's start and inserts a fresh row. Historical reads
 *  (`getSettingValue(orgId, key, someOldDate)`) are therefore stable across
 *  this call, which is the whole point: an admin changing
 *  CLEANBC_INCOME_THRESHOLD today must never silently change what a job
 *  evaluated last month was eligible under — and (Phase 11.5) must never
 *  affect a different organization's resolved values at all. */
export async function publishSetting(input: {
  organizationId: number;
  key: string;
  value: string;
  dataType: SettingDataType;
  category?: string;
  description?: string;
  effectiveFrom?: string;
  updatedBy: number;
}): Promise<GlobalSettingRow> {
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  const latest = await get<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE organization_id = ? AND key = ? ORDER BY effective_from DESC LIMIT 1",
    [input.organizationId, input.key]
  );
  if (latest && effectiveFrom <= latest.effective_from) {
    throw new SettingVersionError(
      `New version must be effective after the current one (${latest.effective_from})`
    );
  }
  if (latest && latest.effective_until === null) {
    await run("UPDATE global_settings SET effective_until = ? WHERE id = ?", [effectiveFrom, latest.id]);
  }
  await run(
    `INSERT INTO global_settings (organization_id, key, value, data_type, category, description, effective_from, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.organizationId, input.key, input.value, input.dataType,
      input.category ?? latest?.category ?? "general",
      input.description ?? latest?.description ?? "",
      effectiveFrom, input.updatedBy,
    ]
  );
  const row = await get<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE organization_id = ? AND key = ? ORDER BY id DESC LIMIT 1",
    [input.organizationId, input.key]
  );
  return row!;
}

/** Retires `key` for `organizationId` as of `effectiveFrom` (default now) —
 *  no replacement version is inserted, so getSettingValue(orgId, key)
 *  resolves to null going forward, while every past resolution before the
 *  retirement date is untouched. */
export async function retireSetting(organizationId: number, key: string, updatedBy: number, effectiveFrom?: string): Promise<boolean> {
  const at = effectiveFrom ?? new Date().toISOString();
  const latest = await get<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE organization_id = ? AND key = ? AND effective_until IS NULL ORDER BY effective_from DESC LIMIT 1",
    [organizationId, key]
  );
  if (!latest) return false;
  await run(
    "UPDATE global_settings SET effective_until = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
    [at, updatedBy, latest.id]
  );
  return true;
}
