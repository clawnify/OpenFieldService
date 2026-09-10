import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { dashboardMetricDefinitions, effectivePaymentCents, vancouverBusinessDate } from "./reporting.rules";

describe("Reporting rules", () => {
  it("uses America/Vancouver business dates across year and DST boundaries", () => {
    expect(vancouverBusinessDate(new Date("2026-01-01T07:30:00Z"))).toBe("2025-12-31");
    expect(vancouverBusinessDate(new Date("2026-03-08T07:30:00Z"))).toBe("2026-03-07");
    expect(vancouverBusinessDate(new Date("2026-03-08T10:30:00Z"))).toBe("2026-03-08");
  });

  it("uses exact signed cents for payment and reversal entries", () => {
    expect(effectivePaymentCents("payment", 12_345)).toBe(12_345);
    expect(effectivePaymentCents("reversal", 12_345)).toBe(-12_345);
  });

  it("documents lifecycle and cash definitions", () => {
    expect(dashboardMetricDefinitions.completedJobs).toContain("completed or invoiced");
    expect(dashboardMetricDefinitions.netCollected).toContain("reversal");
  });

  it("permits technician self-scope without granting financial reporting", () => {
    expect(can({ role: "member" }, "reports.view")).toBe(true);
    expect(can({ role: "member" }, "payment.read")).toBe(false);
    expect(can({ role: "manager" }, "reports.view")).toBe(true);
  });
});
