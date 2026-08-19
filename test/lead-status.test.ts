import { describe, expect, it } from "vitest";
import { canOfferConversion, resolveLeadDisplayTransitions } from "../src/client/lead-status.js";

describe("resolveLeadDisplayTransitions", () => {
  it("matches the approved matrix for ordinary transitions", () => {
    expect(resolveLeadDisplayTransitions("new")).toEqual(["contacted", "lost"]);
    expect(resolveLeadDisplayTransitions("contacted")).toEqual(["qualified", "lost"]);
    expect(resolveLeadDisplayTransitions("qualified")).toEqual(["estimate", "lost"]);
    expect(resolveLeadDisplayTransitions("lost")).toEqual(["contacted"]);
  });

  it("excludes won as a plain transition target from estimate — conversion is the only path to won", () => {
    const fromEstimate = resolveLeadDisplayTransitions("estimate");
    expect(fromEstimate).toEqual(["lost"]);
    expect(fromEstimate).not.toContain("won");
  });

  it("won is terminal — no display transitions", () => {
    expect(resolveLeadDisplayTransitions("won")).toEqual([]);
  });

  it("returns an empty array for an unrecognized status rather than throwing", () => {
    expect(resolveLeadDisplayTransitions("bogus")).toEqual([]);
  });
});

describe("canOfferConversion", () => {
  it("offers conversion from estimate when unconverted", () => {
    expect(canOfferConversion("estimate", null)).toBe(true);
  });

  it("offers conversion from won when unconverted (the safe retry state)", () => {
    expect(canOfferConversion("won", null)).toBe(true);
  });

  it("never offers conversion once converted, regardless of status", () => {
    expect(canOfferConversion("estimate", 42)).toBe(false);
    expect(canOfferConversion("won", 42)).toBe(false);
  });

  it("never offers conversion from any other status", () => {
    for (const status of ["new", "contacted", "qualified", "lost"]) {
      expect(canOfferConversion(status, null)).toBe(false);
    }
  });
});
