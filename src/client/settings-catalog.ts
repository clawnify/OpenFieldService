import type { SettingDataType } from "./types";

/**
 * Maps the technical Global Settings keys this app actually reads in code
 * (src/server/rebate.ts, src/server/financial.ts, src/client/create-customer.tsx
 * via reference-data.ts) to business-friendly presentation metadata. This is
 * a PRESENTATION-ONLY layer — the underlying versioned/effective-dated
 * GlobalSettings architecture (src/server/settings.ts) and its API are
 * completely unchanged; this file only controls how global-settings.tsx
 * labels, groups, and formats what the API already returns.
 *
 * Every entry here corresponds to a key genuinely read by production code —
 * nothing here is a fabricated/placeholder setting. Any setting an admin
 * creates that ISN'T in this catalog (a custom/advanced setting) still shows
 * up in the UI, just under "Other Settings" with its raw key, since there's
 * no business label to invent for something this app doesn't recognize.
 */

export type SettingKind = "number" | "money_cents" | "option_list" | "select";

export interface SettingSelectOption {
  value: string;
  label: string;
}

export interface SettingCatalogEntry {
  key: string;
  label: string;
  description: string;
  unit?: string;
  kind: SettingKind;
  dataType: SettingDataType;
  category: string;
  group?: string;
  /** Only for kind: "select" — the friendly-label choices shown in the
   *  dropdown. The stored/API value is always `option.value` (a canonical
   *  IANA timezone id for BUSINESS_TIMEZONE); labels are display-only. */
  options?: SettingSelectOption[];
}

/** Common IANA timezones for a North American field-service business —
 *  friendly labels for the picker, canonical IANA ids for storage. Not an
 *  exhaustive list of the ~400 IANA zones (the server accepts any valid
 *  IANA id, not just these — see src/server/business-timezone.ts); this is
 *  a curated set of realistic choices for this app's actual user base. */
export const TIMEZONE_OPTIONS: SettingSelectOption[] = [
  { value: "Pacific/Honolulu", label: "Hawaii Time — Honolulu" },
  { value: "America/Anchorage", label: "Alaska Time — Anchorage" },
  { value: "America/Los_Angeles", label: "Pacific Time — Los Angeles" },
  { value: "America/Vancouver", label: "Pacific Time — Vancouver" },
  { value: "America/Phoenix", label: "Mountain Time (no DST) — Phoenix" },
  { value: "America/Denver", label: "Mountain Time — Denver" },
  { value: "America/Edmonton", label: "Mountain Time — Edmonton" },
  { value: "America/Chicago", label: "Central Time — Chicago" },
  { value: "America/Winnipeg", label: "Central Time — Winnipeg" },
  { value: "America/New_York", label: "Eastern Time — New York" },
  { value: "America/Toronto", label: "Eastern Time — Toronto" },
  { value: "America/Halifax", label: "Atlantic Time — Halifax" },
  { value: "America/St_Johns", label: "Newfoundland Time — St. John's" },
  { value: "UTC", label: "UTC (no daylight saving)" },
];

export function timezoneLabel(ianaValue: string): string {
  return TIMEZONE_OPTIONS.find((o) => o.value === ianaValue)?.label ?? ianaValue;
}

export const SETTINGS_CATALOG: SettingCatalogEntry[] = [
  {
    key: "CLEANBC_MAX_HOUSE_SIZE",
    label: "Maximum House Size",
    description: "The maximum eligible home size used when evaluating CleanBC rebate eligibility.",
    unit: "sq ft",
    kind: "number",
    dataType: "number",
    category: "Rebate Programs",
    group: "CleanBC",
  },
  {
    key: "CLEANBC_MAX_HOUSEHOLD_INCOME",
    label: "Maximum Household Income",
    description: "The maximum eligible household income used when evaluating CleanBC rebate eligibility.",
    unit: "$",
    kind: "number",
    dataType: "number",
    category: "Rebate Programs",
    group: "CleanBC",
  },
  {
    key: "CLEANBC_ELIGIBILITY_WARNING_DAYS",
    label: "Eligibility Warning Period",
    description: "Number of days before an eligibility code expires when the system should display an Expiring Soon warning.",
    unit: "days",
    kind: "number",
    dataType: "number",
    category: "Rebate Programs",
    group: "CleanBC",
  },
  {
    key: "CLEANBC_REBATE_AMOUNT_CENTS",
    label: "Rebate Amount",
    description: "The rebate amount applied to a CleanBC job's invoice when it's generated.",
    unit: "$",
    kind: "money_cents",
    dataType: "number",
    category: "Rebate Programs",
    group: "CleanBC",
  },
  {
    key: "BC_HYDRO_MAX_HOUSEHOLD_INCOME",
    label: "Maximum Household Income",
    description: "The maximum eligible household income used when evaluating BC Hydro rebate eligibility.",
    unit: "$",
    kind: "number",
    dataType: "number",
    category: "Rebate Programs",
    group: "BC Hydro",
  },
  {
    key: "BC_HYDRO_REBATE_AMOUNT_CENTS",
    label: "Rebate Amount",
    description: "The rebate amount applied to a BC Hydro job's invoice when it's generated.",
    unit: "$",
    kind: "money_cents",
    dataType: "number",
    category: "Rebate Programs",
    group: "BC Hydro",
  },
  {
    key: "REFERRAL_SOURCE_OPTIONS",
    label: "Referral Sources",
    description: "The list of referral source options shown when adding a customer.",
    kind: "option_list",
    dataType: "json",
    category: "Customer Information",
  },
  {
    key: "HEATING_SOURCE_OPTIONS",
    label: "Primary Heating Sources",
    description: "The list of heating source options shown when adding a rebate customer.",
    kind: "option_list",
    dataType: "json",
    category: "Customer Information",
  },
  {
    key: "BUSINESS_TIMEZONE",
    label: "Business Timezone",
    description: "Used for job scheduling, Google Calendar sync, reminders, and other time-based operations.",
    kind: "select",
    dataType: "string",
    category: "Business Operations",
    options: TIMEZONE_OPTIONS,
  },
];

export function getSettingMeta(key: string): SettingCatalogEntry | undefined {
  return SETTINGS_CATALOG.find((e) => e.key === key);
}

/** Formats a raw stored value (always a string, per the backend's
 *  `value TEXT` column) into the business-friendly display string for its
 *  catalog entry. */
export function formatSettingValue(entry: SettingCatalogEntry, rawValue: string): string {
  const num = Number(rawValue);
  if (entry.kind === "money_cents") {
    if (!Number.isFinite(num)) return rawValue;
    return `$${(num / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (entry.kind === "number") {
    if (!Number.isFinite(num)) return rawValue;
    const formatted = entry.unit === "$" ? `$${num.toLocaleString()}` : num.toLocaleString();
    return entry.unit && entry.unit !== "$" ? `${formatted} ${entry.unit}` : formatted;
  }
  if (entry.kind === "select") {
    return entry.options?.find((o) => o.value === rawValue)?.label ?? rawValue;
  }
  return rawValue;
}

export function formatSettingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
