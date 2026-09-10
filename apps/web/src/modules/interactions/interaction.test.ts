import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { ConflictError } from "@/lib/errors";
import { createActivitySchema, createNoteSchema, createTaskSchema, taskFilterSchema } from "./interaction.schema";
import { assertTaskTransition } from "./task.rules";
describe("CRM interactions domain", () => {
  it("validates Tasks without accepting tenant or lifecycle fields", () => { expect(createTaskSchema.parse({ title: " Follow up ", priority: "urgent", targetType: "deal", targetId: "00000000-0000-4000-8000-000000000001" }).title).toBe("Follow up"); expect(() => createTaskSchema.parse({ title: "x", organizationId: crypto.randomUUID(), targetType: "deal", targetId: crypto.randomUUID() })).toThrow(); });
  it("validates bounded filters and target pairs", () => { expect(taskFilterSchema.parse({ pageSize: 100 }).page).toBe(1); expect(() => taskFilterSchema.parse({ targetId: crypto.randomUUID() })).toThrow(); expect(() => taskFilterSchema.parse({ pageSize: 101 })).toThrow(); });
  it("validates user Activities and keeps type system-owned on update", () => { expect(createActivitySchema.parse({ type: "call", subject: " Check-in ", occurredAt: new Date().toISOString(), targetType: "customer", targetId: crypto.randomUUID() }).subject).toBe("Check-in"); expect(() => createActivitySchema.parse({ type: "system", subject: "x", occurredAt: new Date().toISOString(), targetType: "customer", targetId: crypto.randomUUID() })).toThrow(); });
  it("rejects empty Notes", () => { expect(() => createNoteSchema.parse({ body: "   ", targetType: "lead", targetId: crypto.randomUUID() })).toThrow(); });
  it("enforces completion/reopen transition rules", () => { expect(() => assertTaskTransition("open", "completed")).not.toThrow(); expect(() => assertTaskTransition("completed", "open")).not.toThrow(); expect(() => assertTaskTransition("completed", "in_progress")).toThrow(ConflictError); expect(() => assertTaskTransition("open", "open")).toThrow(ConflictError); });
  it("keeps viewers read-only and grants managers workflow permissions", () => { expect(can({ role: "viewer" }, "task.read")).toBe(true); expect(can({ role: "viewer" }, "note.create")).toBe(false); expect(can({ role: "manager" }, "task.assign")).toBe(true); expect(can({ role: "manager" }, "activity.create")).toBe(true); });
});
