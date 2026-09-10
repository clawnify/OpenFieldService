import { authorize } from "@/auth/authorization";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import type { Authorizer, RequestActor } from "@/modules/customers/customer.service";
import { changedFields, nullable, parseEntityId } from "@/modules/crm/crm.helpers";
import { DrizzleCrmUnitOfWork, type CrmUnitOfWork } from "@/modules/crm/crm.unit-of-work";
import { createContactSchema, contactFilterSchema, updateContactSchema, type ContactFilter, type CreateContactInput, type UpdateContactInput } from "./contact.schema";
import { ContactRepository } from "./contact.repository";

export class ContactService {
  constructor(private readonly repository = new ContactRepository(), private readonly authorizer: Authorizer = authorize, private readonly unitOfWork: CrmUnitOfWork = new DrizzleCrmUnitOfWork()) {}
  async getContact(actor: RequestActor, id: string) { await this.authorizer(actor, "contact.read"); const value = await this.repository.findById(actor.organizationId, parseEntityId(id)); if (!value) throw new NotFoundError("Contact not found"); return value; }
  async listContacts(actor: RequestActor, raw: ContactFilter) { await this.authorizer(actor, "contact.read"); const filter = parseInput(contactFilterSchema, raw); return { ...await this.repository.findMany(actor.organizationId, { customerId: filter.customerId, companyId: filter.companyId, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }), page: filter.page, pageSize: filter.pageSize }; }

  async createContact(actor: RequestActor, raw: CreateContactInput) {
    await this.authorizer(actor, "contact.create"); const input = parseInput(createContactSchema, raw);
    return this.unitOfWork.transaction(async ({ contacts, customers, companies, audit }) => {
      if (input.customerId && !await customers.findById(actor.organizationId, input.customerId)) throw new NotFoundError("Customer not found");
      if (input.companyId && !await companies.findById(actor.organizationId, input.companyId)) throw new NotFoundError("Company not found");
      if (input.isPrimary) { await contacts.clearPrimary(actor.organizationId, input.customerId, null); await contacts.clearPrimary(actor.organizationId, null, input.companyId); }
      const contact = await contacts.create({ organizationId: actor.organizationId, customerId: input.customerId, companyId: input.companyId, firstName: input.firstName, lastName: input.lastName, email: nullable(input.email), phone: nullable(input.phone), title: nullable(input.title), isPrimary: input.isPrimary, createdBy: actor.userId, updatedBy: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "contact.created", entityType: "contact", entityId: contact.id, metadata: { customerId: contact.customerId, companyId: contact.companyId, isPrimary: contact.isPrimary } }); return contact;
    });
  }

  async updateContact(actor: RequestActor, id: string, raw: UpdateContactInput) {
    await this.authorizer(actor, "contact.update"); id = parseEntityId(id); const input = parseInput(updateContactSchema, raw);
    return this.unitOfWork.transaction(async ({ contacts, customers, companies, audit }) => {
      const current = await contacts.findById(actor.organizationId, id); if (!current) throw new NotFoundError("Contact not found");
      const customerId = input.customerId === undefined ? current.customerId : input.customerId; const companyId = input.companyId === undefined ? current.companyId : input.companyId;
      const isPrimary = input.isPrimary ?? current.isPrimary;
      if (!customerId && !companyId) throw new ValidationError("A contact must belong to a customer, a company, or both", [{ path: "customerId", message: "A parent is required" }]);
      if (customerId && !await customers.findById(actor.organizationId, customerId)) throw new NotFoundError("Customer not found");
      if (companyId && !await companies.findById(actor.organizationId, companyId)) throw new NotFoundError("Company not found");
      if (isPrimary) { await contacts.clearPrimary(actor.organizationId, customerId, null); await contacts.clearPrimary(actor.organizationId, null, companyId); }
      const contact = await contacts.update(actor.organizationId, id, { ...input, customerId, companyId, isPrimary, email: nullable(input.email), phone: nullable(input.phone), title: nullable(input.title), updatedBy: actor.userId }); if (!contact) throw new NotFoundError("Contact not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "contact.updated", entityType: "contact", entityId: id, metadata: { fields: changedFields(input) } }); return contact;
    });
  }
  async removeContact(actor: RequestActor, id: string) { await this.authorizer(actor, "contact.delete"); id = parseEntityId(id); return this.unitOfWork.transaction(async ({ contacts, audit }) => { const contact = await contacts.remove(actor.organizationId, id, actor.userId); if (!contact) throw new NotFoundError("Contact not found"); await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "contact.removed", entityType: "contact", entityId: id, metadata: {} }); return contact; }); }
}
