import { get } from "./db.js";
import { getSettingValue } from "./settings.js";

/**
 * The ONE shared authority for "what timezone is this business in" — every
 * timezone-sensitive server operation (Google Calendar sync, the
 * notification day-before reminder, and any future one) must resolve
 * through `getBusinessTimezone()` here, never re-query `global_settings`
 * or `_meta` independently. See mem:risks/google-calendar-timezone-default
 * for the incident this closes: a fresh/unconfigured environment used to
 * silently sync every Google Calendar event as if the business were in
 * UTC, because the only timezone source (`_meta.timezone`) was hidden from
 * normal administration and defaulted to `'UTC'` with no admin-facing way
 * to change it.
 *
 * Resolution order:
 *  1. The current `BUSINESS_TIMEZONE` Global Setting (the authoritative,
 *     admin-editable source going forward — `migrations/0012` seeds this
 *     for every environment, so this is the normal path).
 *  2. `_meta.timezone` — kept ONLY for backward compatibility with any
 *     database that predates migration 0012 and hasn't re-run migrations
 *     yet. Not written to by any current code path; a pure read-only
 *     legacy fallback.
 *  3. `DEFAULT_BUSINESS_TIMEZONE` — this business's actual current
 *     timezone, never a placeholder. This is the true floor: it is
 *     impossible for this function to return `'UTC'` by mere absence of
 *     configuration the way the old `_meta`-only design could.
 *
 * Every returned value is validated as a real IANA zone before being
 * trusted (defense in depth against a corrupted/pre-validation legacy
 * `_meta` row) — an invalid stored value never propagates to Google's API
 * or the reminder scanner, it falls through to the next step instead.
 */
export const DEFAULT_BUSINESS_TIMEZONE = "America/Vancouver";

export const BUSINESS_TIMEZONE_SETTING_KEY = "BUSINESS_TIMEZONE";

/** True only for a canonical IANA Area/Location zone id (e.g.
 *  "America/Vancouver") or the literal "UTC" — never a legacy abbreviation
 *  ("PST"), a fixed offset ("-07:00", "UTC-7"), or a made-up string. Fixed
 *  offsets and abbreviations are explicitly rejected because they are not
 *  DST-safe: "PST" (a legacy ICU alias) never becomes "PDT" in summer the
 *  way "America/Vancouver" correctly does.
 *
 *  Deterministic and dependency-free — uses only `Intl`, which is built
 *  into the V8 engine Cloudflare Workers already runs, so no timezone
 *  database package is needed. `Intl.DateTimeFormat`'s own `timeZone`
 *  validation is deliberately NOT used alone here: it is too permissive
 *  (it accepts "PST" and "-07:00" as "valid", exactly the values this task
 *  requires rejecting) — `Intl.supportedValuesOf('timeZone')` returns the
 *  canonical IANA id list instead, which correctly excludes both. */
export function isValidIanaTimezone(value: string): boolean {
  if (value === "UTC") return true;
  try {
    return Intl.supportedValuesOf("timeZone").includes(value);
  } catch {
    // Intl.supportedValuesOf is a real, current-runtime API (available in
    // both the Workers runtime and every supported test/dev Node version)
    // — this catch is defense against a hypothetical runtime that lacks
    // it, not an expected path. Fail closed (reject) rather than silently
    // accepting an unvalidated value.
    return false;
  }
}

/** Resolves the current effective business timezone. See module doc above
 *  for the resolution order and why each fallback step exists. Always
 *  returns a validated IANA zone id — never propagates an invalid stored
 *  value to a caller. */
export async function getBusinessTimezone(organizationId: number): Promise<string> {
  const configured = await getSettingValue<string>(organizationId, BUSINESS_TIMEZONE_SETTING_KEY);
  if (configured && isValidIanaTimezone(configured)) return configured;

  const legacy = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'timezone'");
  if (legacy?.value && isValidIanaTimezone(legacy.value) && legacy.value !== "UTC") return legacy.value;

  return DEFAULT_BUSINESS_TIMEZONE;
}
