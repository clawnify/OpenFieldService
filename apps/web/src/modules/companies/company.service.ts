import { authorize } from "@/auth/authorization";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { changedFields, nullable, parseEntityId } from "@/modules/crm/crm.helpers";
import { DrizzleCrmUnitOfWork, type CrmUnitOfWork } from "@/modules/crm/crm.unit-of-work";
import type { Authorizer, RequestActor } from "@/modules/customers/customer.service";
import { companyFilterSchema, createCompanySchema, updateCompanySchema, type CompanyFilter, type CreateCompanyInput, type UpdateCompanyInput } from "./company.schema";
import { CompanyRepository } from "./company.repository";

export class CompanyService {
  constructor(private readonly repository = new CompanyRepository(), private readonly authorizer: Authorizer = authorize, private readonly unitOfWork: CrmUnitOfWork = new DrizzleCrmUnitOfWork()) {}

  async getCompany(actor: RequestActor, rawId: string) {
    await this.authorizer(actor, "company.read"); const id = parseEntityId(rawId);
    const company = await this.repository.findById(actor.organizationId, id); if (!company) throw new NotFoundError("Company not found"); return company;
  }
  async listCompanies(actor: RequestActor, raw: CompanyFilter) {
    await this.authorizer(actor, "company.read"); const filter = parseInput(companyFilterSchema, raw);
    return { ...await this.repository.findMany(actor.organizationId, { query: filter.query, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }), page: filter.page, pageSize: filter.pageSize };
  }
  async createCompany(actor: RequestActor, raw: CreateCompanyInput) {
    await this.authorizer(actor, "company.create"); const input = parseInput(createCompanySchema, raw);
    return this.unitOfWork.transaction(async ({ companies, audit }) => {
      const company = await companies.create({ organizationId: actor.organizationId, ...input, legalName: nullable(input.legalName), email: nullable(input.email), phone: nullable(input.phone), website: nullable(input.website), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), notes: nullable(input.notes), createdBy: actor.userId, updatedBy: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "company.created", entityType: "company", entityId: company.id, metadata: {} }); return company;
    });
  }
  async updateCompany(actor: RequestActor, rawId: string, raw: UpdateCompanyInput) {
    await this.authorizer(actor, "company.update"); const id = parseEntityId(rawId); const input = parseInput(updateCompanySchema, raw);
    return this.unitOfWork.transaction(async ({ companies, audit }) => {
      const company = await companies.update(actor.organizationId, id, { ...input, legalName: nullable(input.legalName), email: nullable(input.email), phone: nullable(input.phone), website: nullable(input.website), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), notes: nullable(input.notes), updatedBy: actor.userId });
      if (!company) throw new NotFoundError("Company not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "company.updated", entityType: "company", entityId: id, metadata: { fields: changedFields(input) } }); return company;
    });
  }
  async archiveCompany(actor: RequestActor, rawId: string) {
    await this.authorizer(actor, "company.delete"); const id = parseEntityId(rawId);
    return this.unitOfWork.transaction(async ({ companies, customers, contacts, audit }) => {
      if (await customers.hasActiveForCompany(actor.organizationId, id) || await contacts.hasActiveForCompany(actor.organizationId, id)) throw new ConflictError("Detach active customers and contacts before archiving this company");
      const company = await companies.archive(actor.organizationId, id, actor.userId); if (!company) throw new NotFoundError("Company not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "company.archived", entityType: "company", entityId: id, metadata: {} }); return company;
    });
  }
}
