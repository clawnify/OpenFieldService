import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createDealSchema, dealFilterSchema } from "./deal.schema";
import { assertMove } from "./deal.rules";
describe("deal domain rules", () => {
  it("validates exact money, currency, and supported relationships", () => { expect(createDealSchema.parse({ name: "Work", pipelineId: "01890b8e-70f8-7000-8000-000000000001", stageId: "01890b8e-70f8-7000-8000-000000000002", customerId: "01890b8e-70f8-7000-8000-000000000003", amountCents: 125050, currency: "cad" }).currency).toBe("CAD"); expect(() => createDealSchema.parse({ name: "Work", pipelineId: crypto.randomUUID(), stageId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountCents: 1.5 })).toThrow(); expect(() => createDealSchema.parse({ name: "Work", pipelineId: crypto.randomUUID(), stageId: crypto.randomUUID(), customerId: crypto.randomUUID(), companyId: crypto.randomUUID() })).toThrow(); expect(() => dealFilterSchema.parse({ minAmountCents: 20, maxAmountCents: 10 })).toThrow(); });
  it("requires lost context and rejects cross-pipeline or terminal movement", () => { expect(() => assertMove("p", "p", "open", "lost", undefined)).toThrow(ValidationError); expect(() => assertMove("p", "other", "open", "open")).toThrow(ConflictError); expect(() => assertMove("p", "p", "won", "open")).toThrow(ConflictError); });
  it("maps administrative sales permissions", () => { expect(can({ role: "manager" }, "deal.close")).toBe(true); expect(can({ role: "member" }, "deal.read")).toBe(true); expect(can({ role: "member" }, "deal.update")).toBe(false); expect(can({ role: "admin" }, "deal.delete")).toBe(true); });
});
