import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { can, type Permission } from "@/auth/permissions";
import type { CustomerRepository } from "./customer.repository";
import { CustomerService, type RequestActor } from "./customer.service";
import type { Customer, NewCustomer } from "./customer.types";

const now = new Date("2026-01-01T00:00:00Z");
const actor: RequestActor = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", role: "manager" };
const authorizeForUnitTest = async (requestActor: RequestActor, permission: Permission) => {
  if (!can(requestActor, permission)) throw new ForbiddenError();
  return requestActor;
};

class MemoryCustomers implements CustomerRepository {
  records: Customer[] = [];
  async findById(organizationId: string, id: string) { return this.records.find((item) => item.organizationId === organizationId && item.id === id && !item.archivedAt) ?? null; }
  async findMany(organizationId: string) { const items = this.records.filter((item) => item.organizationId === organizationId && !item.archivedAt); return { items, total: items.length }; }
  async create(input: NewCustomer) { const record: Customer = { id: crypto.randomUUID(), organizationId: input.organizationId, companyId: input.companyId ?? null, name: input.name, email: input.email ?? null, phone: input.phone ?? null, addressLine1: input.addressLine1 ?? null, addressLine2: input.addressLine2 ?? null, city: input.city ?? null, region: input.region ?? null, postalCode: input.postalCode ?? null, notes: input.notes ?? null, status: input.status ?? "active", createdBy: input.createdBy ?? null, updatedBy: input.updatedBy ?? null, createdAt: now, updatedAt: now, archivedAt: null }; this.records.push(record); return record; }
  async update() { return null; }
  async archive() { return null; }
  async hasActiveForCompany() { return false; }
}

describe("CustomerService", () => {
  it("does not expose another organization's customer", async () => {
    const repository = new MemoryCustomers();
    const customer = await repository.create({ organizationId: "20000000-0000-4000-8000-000000000002", name: "Other tenant" });
    await expect(new CustomerService(repository, authorizeForUnitTest).getCustomer(actor, customer.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("enforces server-side permission checks", async () => {
    const viewer = { ...actor, role: "viewer" as const };
    await expect(new CustomerService(new MemoryCustomers(), authorizeForUnitTest).createCustomer(viewer, { name: "Denied" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
