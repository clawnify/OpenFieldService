import { authorize } from "@/auth/authorization";
import type { Permission, Role } from "@/auth/permissions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { changedFields, nullable, parseEntityId } from "@/modules/crm/crm.helpers";
import { DrizzleCrmUnitOfWork, type CrmUnitOfWork } from "@/modules/crm/crm.unit-of-work";
import { createCustomerSchema, customerFilterSchema, updateCustomerSchema, type CreateCustomerInput, type CustomerFilter, type UpdateCustomerInput } from "./customer.schema";
import { DrizzleCustomerRepository, type CustomerRepository } from "./customer.repository";
import type { Customer } from "./customer.types";

export interface RequestActor { userId: string; organizationId: string; role: Role }
export type Authorizer = (actor: RequestActor, permission: Permission) => Promise<RequestActor>;

export class CustomerService {
  constructor(private readonly repository: CustomerRepository = new DrizzleCustomerRepository(), private readonly authorizer: Authorizer = authorize, private readonly unitOfWork: CrmUnitOfWork = new DrizzleCrmUnitOfWork()) {}
  async getCustomer(actor: RequestActor, id: string): Promise<Customer> { await this.authorizer(actor, "customer.read"); const value = await this.repository.findById(actor.organizationId, parseEntityId(id)); if (!value) throw new NotFoundError("Customer not found"); return value; }
  async listCustomers(actor: RequestActor, raw: CustomerFilter) { await this.authorizer(actor, "customer.read"); const filter = parseInput(customerFilterSchema, raw); const result = await this.repository.findMany(actor.organizationId, { query: filter.query, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }); return { ...result, page: filter.page, pageSize: filter.pageSize }; }

  async createCustomer(actor: RequestActor, raw: CreateCustomerInput): Promise<Customer> {
    await this.authorizer(actor, "customer.create"); const input = parseInput(createCustomerSchema, raw);
    return this.unitOfWork.transaction(async ({ customers, companies, audit }) => {
      if (input.companyId && !await companies.findById(actor.organizationId, input.companyId)) throw new NotFoundError("Company not found");
      const customer = await customers.create({ organizationId: actor.organizationId, companyId: input.companyId, name: input.name, email: nullable(input.email), phone: nullable(input.phone), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), notes: nullable(input.notes), createdBy: actor.userId, updatedBy: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "customer.created", entityType: "customer", entityId: customer.id, metadata: { companyId: customer.companyId } }); return customer;
    });
  }

  async updateCustomer(actor: RequestActor, id: string, raw: UpdateCustomerInput): Promise<Customer> {
    await this.authorizer(actor, "customer.update"); id = parseEntityId(id); const input = parseInput(updateCustomerSchema, raw);
    return this.unitOfWork.transaction(async ({ customers, companies, audit }) => {
      if (!await customers.findById(actor.organizationId, id)) throw new NotFoundError("Customer not found");
      if (input.companyId && !await companies.findById(actor.organizationId, input.companyId)) throw new NotFoundError("Company not found");
      const customer = await customers.update(actor.organizationId, id, { ...input, email: nullable(input.email), phone: nullable(input.phone), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), notes: nullable(input.notes), updatedBy: actor.userId });
      if (!customer) throw new NotFoundError("Customer not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "customer.updated", entityType: "customer", entityId: id, metadata: { fields: changedFields(input) } }); return customer;
    });
  }

  async archiveCustomer(actor: RequestActor, id: string): Promise<void> {
    await this.authorizer(actor, "customer.delete"); id = parseEntityId(id);
    await this.unitOfWork.transaction(async ({ customers, contacts, audit }) => {
      if (await contacts.hasActiveForCustomer(actor.organizationId, id)) throw new ConflictError("Remove active contacts before archiving this customer");
      const customer = await customers.archive(actor.organizationId, id, actor.userId); if (!customer) throw new NotFoundError("Customer not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "customer.archived", entityType: "customer", entityId: id, metadata: {} });
    });
  }

  /** Backward-compatible service name for the original proving slice. */
  deleteCustomer(actor: RequestActor, id: string): Promise<void> { return this.archiveCustomer(actor, id); }
}
