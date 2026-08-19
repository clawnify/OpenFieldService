import { get, query, run } from "./db.js";

export type SettingDataType = "string" | "number" | "boolean" | "json";

export interface GlobalSettingRow {
  id: number;
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
 *  today: pass the job's own evaluation timestamp as `asOf`. */
export async function getSettingRow(key: string, asOf?: string): Promise<GlobalSettingRow | null> {
  const at = asOf ?? new Date().toISOString();
  const row = await get<GlobalSettingRow>(
    `SELECT * FROM global_settings
     WHERE key = ? AND active = 1 AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until > ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [key, at, at]
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

export async function getSettingValue<T = unknown>(key: string, asOf?: string): Promise<T | null> {
  const row = await getSettingRow(key, asOf);
  return row ? (coerce(row) as T) : null;
}

/** Current (as-of-now) version of every key, optionally narrowed to one category.
 *  One row per key — the version currently in effect. */
export async function listCurrentSettings(category?: string): Promise<GlobalSettingRow[]> {
  const now = new Date().toISOString();
  const rows = await query<GlobalSettingRow>(
    `SELECT s.* FROM global_settings s
     WHERE s.active = 1 AND s.effective_from <= ?
       AND (s.effective_until IS NULL OR s.effective_until > ?)
       AND s.effective_from = (
         SELECT MAX(s2.effective_from) FROM global_settings s2
         WHERE s2.key = s.key AND s2.active = 1 AND s2.effective_from <= ?
       )
     ORDER BY s.category ASC, s.key ASC`,
    [now, now, now]
  );
  return category ? rows.filter((r) => r.category === category) : rows;
}

export async function getSettingHistory(key: string): Promise<GlobalSettingRow[]> {
  return query<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE key = ? ORDER BY effective_from DESC", [key]
  );
}

export class SettingVersionError extends Error {}

/** Publishes a new version of `key`, effective from `effectiveFrom` (default now).
 *  Never mutates a past version's value — it closes the previously-open version's
 *  `effective_until` at the new version's start and inserts a fresh row. Historical
 *  reads (`getSettingValue(key, someOldDate)`) are therefore stable across this call,
 *  which is the whole point: an admin changing CLEANBC_INCOME_THRESHOLD today must
 *  never silently change what a job evaluated last month was eligible under. */
export async function publishSetting(input: {
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
    "SELECT * FROM global_settings WHERE key = ? ORDER BY effective_from DESC LIMIT 1", [input.key]
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
    `INSERT INTO global_settings (key, value, data_type, category, description, effective_from, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.key, input.value, input.dataType,
      input.category ?? latest?.category ?? "general",
      input.description ?? latest?.description ?? "",
      effectiveFrom, input.updatedBy,
    ]
  );
  const row = await get<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE key = ? ORDER BY id DESC LIMIT 1", [input.key]
  );
  return row!;
}

/** Retires `key` as of `effectiveFrom` (default now) — no replacement version is
 *  inserted, so getSettingValue(key) resolves to null going forward, while every
 *  past resolution before the retirement date is untouched. */
export async function retireSetting(key: string, updatedBy: number, effectiveFrom?: string): Promise<boolean> {
  const at = effectiveFrom ?? new Date().toISOString();
  const latest = await get<GlobalSettingRow>(
    "SELECT * FROM global_settings WHERE key = ? AND effective_until IS NULL ORDER BY effective_from DESC LIMIT 1",
    [key]
  );
  if (!latest) return false;
  await run(
    "UPDATE global_settings SET effective_until = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
    [at, updatedBy, latest.id]
  );
  return true;
}
