import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { ValidationError } from "@/lib/errors";
import { createPipelineSchema, reorderPipelineStagesSchema } from "./pipeline.schema";
import { assertCompleteOrder, assertStageProbability } from "./pipeline.rules";

describe("pipeline domain rules", () => {
  it("validates strict pipeline input and unique reorder IDs", () => {
    expect(createPipelineSchema.parse({ name: " Sales " }).name).toBe("Sales");
    expect(() => createPipelineSchema.parse({ name: "Sales", organizationId: "tenant" })).toThrow();
    expect(() => reorderPipelineStagesSchema.parse({ stageIds: ["01890b8e-70f8-7000-8000-000000000001", "01890b8e-70f8-7000-8000-000000000001"] })).toThrow();
  });
  it("enforces complete ordering", () => { expect(() => assertCompleteOrder(["a", "b"], ["b", "a"])).not.toThrow(); expect(() => assertCompleteOrder(["a", "b"], ["a", "c"])).toThrow(ValidationError); });
  it("enforces terminal probabilities", () => { expect(() => assertStageProbability("won", 100)).not.toThrow(); expect(() => assertStageProbability("won", 80)).toThrow(ValidationError); expect(() => assertStageProbability("lost", 10)).toThrow(ValidationError); });
  it("keeps pipeline configuration administrative", () => { expect(can({ role: "admin" }, "pipeline_stage.update")).toBe(true); expect(can({ role: "manager" }, "pipeline.read")).toBe(true); expect(can({ role: "manager" }, "pipeline.update")).toBe(false); expect(can({ role: "viewer" }, "pipeline_stage.create")).toBe(false); });
});
