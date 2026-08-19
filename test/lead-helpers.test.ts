import { describe, expect, it } from "vitest";
import {
  buildLeadListQuery, resolveReferralFieldsOnSourceChange, summarizeConversionResult,
} from "../src/client/lead-helpers.js";

describe("resolveReferralFieldsOnSourceChange", () => {
  it("keeps referralName when switching to Referral, clears referredById", () => {
    const result = resolveReferralFieldsOnSourceChange("Referral", { referralName: "Bob", referredById: 5 });
    expect(result).toEqual({ referralName: "Bob", referredById: null });
  });

  it("keeps referredById when switching to Existing Customer, clears referralName", () => {
    const result = resolveReferralFieldsOnSourceChange("Existing Customer", { referralName: "Bob", referredById: 5 });
    expect(result).toEqual({ referralName: "", referredById: 5 });
  });

  it("clears both fields for any other source, including blank", () => {
    expect(resolveReferralFieldsOnSourceChange("Website", { referralName: "Bob", referredById: 5 }))
      .toEqual({ referralName: "", referredById: null });
    expect(resolveReferralFieldsOnSourceChange("", { referralName: "Bob", referredById: 5 }))
      .toEqual({ referralName: "", referredById: null });
  });
});

describe("buildLeadListQuery", () => {
  it("always includes page and limit", () => {
    const q = buildLeadListQuery({ page: 2, limit: 25, search: "", status: "", assignedUserId: "" });
    expect(q).toBe("page=2&limit=25");
  });

  it("includes search/status/assignedUserId only when non-empty", () => {
    const q = buildLeadListQuery({ page: 1, limit: 50, search: "jane", status: "contacted", assignedUserId: "3" });
    const params = new URLSearchParams(q);
    expect(params.get("search")).toBe("jane");
    expect(params.get("status")).toBe("contacted");
    expect(params.get("assigned_user_id")).toBe("3");
  });
});

describe("summarizeConversionResult", () => {
  it("describes a new-customer conversion", () => {
    expect(summarizeConversionResult(true)).toMatch(/new customer/i);
  });

  it("describes a reused-customer conversion", () => {
    expect(summarizeConversionResult(false)).toMatch(/existing/i);
  });
});
