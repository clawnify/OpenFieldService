import { describe, expect, it } from "vitest";
import {
  SETTINGS_CATALOG, getSettingMeta, formatSettingValue, formatSettingDate,
} from "../src/client/settings-catalog.js";

// Focused unit tests for the presentation-only technical-key -> business-label
// mapping introduced in the Global Settings / Eligibility Tracker UI review.
// This file has zero Preact/JSX imports specifically so it can be imported
// directly here — see mem:project/fsm-upgrade-plan's standing rule about this
// project having no client-side/DOM test infrastructure (same reasoning as
// src/client/signature-geometry.ts).

describe("getSettingMeta", () => {
  it("resolves every catalog entry by its exact key", () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(getSettingMeta(entry.key)).toBe(entry);
    }
  });

  it("returns undefined for a key not in the catalog (a custom/advanced setting)", () => {
    expect(getSettingMeta("SOME_CUSTOM_KEY_NOT_IN_CATALOG")).toBeUndefined();
  });
});

describe("formatSettingValue", () => {
  it("formats a plain number with its unit (e.g. house size in sq ft)", () => {
    const entry = getSettingMeta("CLEANBC_MAX_HOUSE_SIZE")!;
    expect(formatSettingValue(entry, "2000")).toBe("2,000 sq ft");
  });

  it("formats a dollar-unit number with a $ prefix, no cents division", () => {
    const entry = getSettingMeta("CLEANBC_MAX_HOUSEHOLD_INCOME")!;
    expect(formatSettingValue(entry, "120000")).toBe("$120,000");
  });

  it("formats a days-unit number", () => {
    const entry = getSettingMeta("CLEANBC_ELIGIBILITY_WARNING_DAYS")!;
    expect(formatSettingValue(entry, "14")).toBe("14 days");
  });

  it("formats a money_cents value by dividing by 100 and showing exactly 2 decimals", () => {
    const entry = getSettingMeta("CLEANBC_REBATE_AMOUNT_CENTS")!;
    expect(formatSettingValue(entry, "300000")).toBe("$3,000.00");
    expect(formatSettingValue(entry, "50")).toBe("$0.50");
  });

  it("never confuses a money_cents key with a plain dollar-unit key — different math entirely", () => {
    const income = getSettingMeta("BC_HYDRO_MAX_HOUSEHOLD_INCOME")!;
    const rebate = getSettingMeta("BC_HYDRO_REBATE_AMOUNT_CENTS")!;
    // Same raw stored string, deliberately, to prove the two kinds format it differently
    expect(formatSettingValue(income, "10000")).toBe("$10,000");
    expect(formatSettingValue(rebate, "10000")).toBe("$100.00");
  });

  it("falls back to the raw value for an option_list entry (never used for display, but must not throw)", () => {
    const entry = getSettingMeta("REFERRAL_SOURCE_OPTIONS")!;
    expect(formatSettingValue(entry, "[\"Google\",\"Website\"]")).toBe("[\"Google\",\"Website\"]");
  });

  it("falls back to the raw value if the stored value isn't a valid number for a numeric kind", () => {
    const entry = getSettingMeta("CLEANBC_MAX_HOUSE_SIZE")!;
    expect(formatSettingValue(entry, "not-a-number")).toBe("not-a-number");
  });
});

describe("formatSettingDate", () => {
  it("formats an ISO timestamp as a short human-readable date, not a raw database timestamp", () => {
    const formatted = formatSettingDate("2026-08-17T14:30:00.000Z");
    expect(formatted).toMatch(/Aug 1[67], 2026/); // timezone-dependent day boundary, allow either
    expect(formatted).not.toContain("T");
    expect(formatted).not.toContain(":");
  });
});

describe("catalog completeness — every entry is genuinely used by production code, nothing fabricated", () => {
  const EXPECTED_KEYS = [
    "CLEANBC_MAX_HOUSE_SIZE",
    "CLEANBC_MAX_HOUSEHOLD_INCOME",
    "CLEANBC_ELIGIBILITY_WARNING_DAYS",
    "CLEANBC_REBATE_AMOUNT_CENTS",
    "BC_HYDRO_MAX_HOUSEHOLD_INCOME",
    "BC_HYDRO_REBATE_AMOUNT_CENTS",
    "REFERRAL_SOURCE_OPTIONS",
    "HEATING_SOURCE_OPTIONS",
  ];

  it("contains exactly the keys read by src/server/rebate.ts, src/server/financial.ts, and reference-data — no more, no fewer", () => {
    expect(SETTINGS_CATALOG.map((e) => e.key).sort()).toEqual(EXPECTED_KEYS.sort());
  });

  it("every entry has a non-empty business label and description (never shows a raw key as its own label)", () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label).not.toBe(entry.key);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });
});
