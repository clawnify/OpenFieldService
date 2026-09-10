import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { createLeadSchema, leadFilterSchema } from "./lead.schema";
import { canTransitionLead } from "./lead.workflow";

describe("lead domain rules", () => {
  it("preserves the legacy lifecycle", () => {
    expect(canTransitionLead("new", "contacted")).toBe(true);
    expect(canTransitionLead("new", "qualified")).toBe(false);
    expect(canTransitionLead("lost", "contacted")).toBe(true);
    expect(canTransitionLead("won", "lost")).toBe(false);
  });

  it("validates strict create input and bounded filters", () => {
    expect(createLeadSchema.parse({ name: " Synthetic Lead ", email: "lead@example.test" }).name).toBe("Synthetic Lead");
    expect(() => createLeadSchema.parse({ name: "Lead", status: "won" })).toThrow();
    expect(() => leadFilterSchema.parse({ pageSize: 101 })).toThrow();
  });

  it("separates lead management permissions", () => {
    expect(can({ role: "manager" }, "lead.convert")).toBe(true);
    expect(can({ role: "member" }, "lead.update")).toBe(true);
    expect(can({ role: "member" }, "lead.assign")).toBe(false);
    expect(can({ role: "viewer" }, "lead.create")).toBe(false);
  });
});
