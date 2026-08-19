import { describe, expect, it } from "vitest";
import { formatCents, formatCentsForInput, parseDollarsToCents } from "../src/client/money.js";

describe("formatCents", () => {
  it("formats a positive amount", () => {
    expect(formatCents(125000)).toBe("$1250.00");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats a negative amount with a leading minus, not $-", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });
});

describe("parseDollarsToCents", () => {
  it("converts a plain dollar-and-cents string without float corruption", () => {
    expect(parseDollarsToCents("1250.00")).toBe(125000);
    expect(parseDollarsToCents("19.99")).toBe(1999);
  });

  it("strips currency formatting (a leading $ and thousands commas)", () => {
    expect(parseDollarsToCents("$1,250.00")).toBe(125000);
  });

  it("treats a whole-dollar input with no decimal as .00", () => {
    expect(parseDollarsToCents("1250")).toBe(125000);
  });

  it("pads a single fractional digit to cents", () => {
    expect(parseDollarsToCents("10.5")).toBe(1050);
  });

  it("truncates extra fractional digits beyond cents", () => {
    expect(parseDollarsToCents("10.999")).toBe(1099);
  });

  it("returns null for a blank or whitespace-only input", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("   ")).toBeNull();
  });

  it("returns null for input with more than one decimal point", () => {
    expect(parseDollarsToCents("1.2.3")).toBeNull();
  });

  it("never produces a floating-point-corrupted result for known problem values", () => {
    // 19.99 * 100 in raw IEEE 754 is 1998.9999999999998, not 1999 — the
    // exact class of bug this function exists to avoid.
    expect(parseDollarsToCents("19.99")).toBe(1999);
    expect(Number.isInteger(parseDollarsToCents("19.99"))).toBe(true);
  });
});

describe("formatCentsForInput", () => {
  it("is the inverse of parseDollarsToCents for round-trippable values", () => {
    expect(formatCentsForInput(125000)).toBe("1250.00");
    expect(formatCentsForInput(1999)).toBe("19.99");
  });

  it("returns an empty string for null (no value entered)", () => {
    expect(formatCentsForInput(null)).toBe("");
  });

  it("formats zero explicitly, not as empty", () => {
    expect(formatCentsForInput(0)).toBe("0.00");
  });
});
