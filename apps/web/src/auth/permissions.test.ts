import { describe, expect, it } from "vitest";
import { can } from "./permissions";

describe("can", () => {
  it("allows owners to perform destructive customer operations", () => expect(can({ role: "owner" }, "customer.delete")).toBe(true));
  it("does not allow viewers to mutate customers", () => expect(can({ role: "viewer" }, "customer.update")).toBe(false));
  it("allows viewers to read customers", () => expect(can({ role: "viewer" }, "customer.read")).toBe(true));
});
