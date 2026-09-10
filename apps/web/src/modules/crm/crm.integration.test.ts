import { describe, expect, it } from "vitest";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { CompanyService } from "@/modules/companies/company.service";
import { ContactService } from "@/modules/contacts/contact.service";
import { CustomerService } from "@/modules/customers/customer.service";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";

const organizationService = new OrganizationService();
const customerService = new CustomerService();
const companyService = new CompanyService();
const contactService = new ContactService();

describe.sequential("PostgreSQL CRM identity domain", () => {
  let orgA: Awaited<ReturnType<typeof organizationService.createOrganizationWithOwner>>;
  let orgB: Awaited<ReturnType<typeof organizationService.createOrganizationWithOwner>>;

  it("creates isolated organizations for synthetic CRM tests", async () => {
    orgA = await organizationService.createOrganizationWithOwner({ name: "CRM Alpha", slug: "crm-alpha" }, { name: "Alpha Owner", email: "crm-alpha@example.test", password: "Synthetic-Pass-123" });
    orgB = await organizationService.createOrganizationWithOwner({ name: "CRM Beta", slug: "crm-beta" }, { name: "Beta Owner", email: "crm-beta@example.test", password: "Synthetic-Pass-456" });
  });

  it("creates, reads, updates, and searches customers with audit events", async () => {
    const actor = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const created = await customerService.createCustomer(actor, { name: "Harbour Test Account", email: "dispatch@example.test", addressLine1: "100 Example Street" });
    expect((await customerService.getCustomer(actor, created.id)).name).toBe("Harbour Test Account");
    expect((await customerService.listCustomers(actor, { query: "Harbour", page: 1, pageSize: 10 })).items.map((item) => item.id)).toEqual([created.id]);
    expect((await customerService.updateCustomer(actor, created.id, { phone: "+1 555 0100" })).phone).toBe("+1 555 0100");
    expect((await new AuditRepository().listForEntity(actor.organizationId, "customer", created.id)).map((event) => event.action)).toEqual(["customer.created", "customer.updated"]);
  });

  it("never leaks customers through read, update, or list operations", async () => {
    const actorA = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const actorB = { userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const };
    const customerB = await customerService.createCustomer(actorB, { name: "Beta Secret Account" });
    await expect(customerService.getCustomer(actorA, customerB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(customerService.updateCustomer(actorA, customerB.id, { name: "Tenant breach" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await customerService.listCustomers(actorA, { query: "Beta Secret", page: 1, pageSize: 25 })).total).toBe(0);
  });

  it("enforces persisted viewer permissions before persistence", async () => {
    const owner = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const { user } = await new UserService().createUserWithMembership(owner, { name: "CRM Viewer", email: "viewer@crm-alpha.example", password: "Synthetic-Viewer-123" }, "viewer");
    const viewer = { userId: user.id, organizationId: orgA.organization.id, role: "viewer" as const };
    await expect(customerService.createCustomer(viewer, { name: "Denied" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates and updates tenant-isolated companies", async () => {
    const actorA = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const actorB = { userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const };
    const company = await companyService.createCompany(actorB, { name: "Beta Facilities Ltd", website: "https://example.test" });
    expect((await companyService.updateCompany(actorB, company.id, { legalName: "Beta Facilities Limited" })).legalName).toBe("Beta Facilities Limited");
    expect((await new AuditRepository().listForEntity(actorB.organizationId, "company", company.id)).map((event) => event.action)).toEqual(["company.created", "company.updated"]);
    await expect(companyService.getCompany(actorA, company.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(companyService.updateCompany(actorA, company.id, { name: "Tenant breach" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await companyService.listCompanies(actorA, { query: "Beta Facilities", page: 1, pageSize: 25 })).total).toBe(0);
  });

  it("links contacts to tenant-local customer and company parents", async () => {
    const actor = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const company = await companyService.createCompany(actor, { name: "Alpha Property Group" });
    const customer = await customerService.createCustomer(actor, { name: "Alpha Service Account", companyId: company.id });
    const contact = await contactService.createContact(actor, { customerId: customer.id, companyId: company.id, firstName: "Casey", lastName: "Example", email: "casey@example.test", isPrimary: true });
    expect((await contactService.getContact(actor, contact.id)).customerId).toBe(customer.id);
    expect((await contactService.listContacts(actor, { customerId: customer.id, page: 1, pageSize: 25 })).items).toHaveLength(1);
    expect((await new AuditRepository().listForEntity(actor.organizationId, "contact", contact.id)).map((event) => event.action)).toEqual(["contact.created"]);
  });

  it("rejects cross-tenant contact and customer parent injection without partial audit writes", async () => {
    const actorA = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const actorB = { userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const };
    const companyB = await companyService.createCompany(actorB, { name: "Foreign Company" });
    const customerA = await customerService.createCustomer(actorA, { name: "Local Customer" });
    await expect(contactService.createContact(actorA, { customerId: customerA.id, companyId: companyB.id, firstName: "Cross", lastName: "Tenant" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(customerService.createCustomer(actorA, { name: "Injected Company", companyId: companyB.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await contactService.listContacts(actorA, { customerId: customerA.id, page: 1, pageSize: 25 })).total).toBe(0);
  });

  it("does not expose another tenant contact or company by id", async () => {
    const actorA = { userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const };
    const actorB = { userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const };
    const companyB = await companyService.createCompany(actorB, { name: "Beta Contact Parent" });
    const contactB = await contactService.createContact(actorB, { companyId: companyB.id, firstName: "Private", lastName: "Person" });
    await expect(contactService.getContact(actorA, contactB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(companyService.getCompany(actorA, companyB.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await contactService.listContacts(actorA, { companyId: companyB.id, page: 1, pageSize: 25 })).total).toBe(0);
  });
});
