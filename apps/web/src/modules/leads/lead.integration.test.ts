import { describe, expect, it } from "vitest";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { CustomerService } from "@/modules/customers/customer.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";
import { LeadService } from "./lead.service";

const organizations = new OrganizationService(); const leads = new LeadService(); const customers = new CustomerService();

describe.sequential("PostgreSQL leads domain", () => {
  let orgA: Awaited<ReturnType<typeof organizations.createOrganizationWithOwner>>; let orgB: typeof orgA;
  const actor = () => ({ userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const });
  const actorB = () => ({ userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const });

  it("creates isolated synthetic tenants", async () => {
    orgA = await organizations.createOrganizationWithOwner({ name: "Lead Alpha", slug: "lead-alpha" }, { name: "Alpha Owner", email: "lead-alpha@example.test", password: "Synthetic-Pass-123" });
    orgB = await organizations.createOrganizationWithOwner({ name: "Lead Beta", slug: "lead-beta" }, { name: "Beta Owner", email: "lead-beta@example.test", password: "Synthetic-Pass-456" });
  });

  it("creates, reads, updates, searches, and filters leads", async () => {
    const lead = await leads.createLead(actor(), { name: "Synthetic Intake", email: "intake@example.test", source: "Website" });
    expect(lead.identifier).toMatch(/^LEAD-[0-9A-F]{8}$/);
    expect((await leads.getLead(actor(), lead.id)).name).toBe("Synthetic Intake");
    expect((await leads.updateLead(actor(), lead.id, { phone: "+1 555 0103" })).phone).toBe("+1 555 0103");
    expect((await leads.listLeads(actor(), { query: "Intake", status: "new", source: "Website", page: 1, pageSize: 10 })).items.map((item) => item.id)).toContain(lead.id);
    expect((await new AuditRepository().listForEntity(actor().organizationId, "lead", lead.id)).map((event) => event.action)).toEqual(["lead.created", "lead.updated"]);
  });

  it("enforces read, update, list, assignment, and status tenant isolation", async () => {
    const foreign = await leads.createLead(actorB(), { name: "Beta Private Lead" });
    await expect(leads.getLead(actor(), foreign.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(leads.updateLead(actor(), foreign.id, { name: "Breach" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(leads.assignLead(actor(), foreign.id, { assignedUserId: orgA.user.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(leads.changeStatus(actor(), foreign.id, { status: "contacted" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await leads.listLeads(actor(), { query: "Beta Private", page: 1, pageSize: 25 })).total).toBe(0);
  });

  it("accepts only assignable active members in the same tenant", async () => {
    const lead = await leads.createLead(actor(), { name: "Assignment Lead" });
    const manager = await new UserService().createUserWithMembership(actor(), { name: "Synthetic Manager", email: "lead-manager@example.test", password: "Synthetic-Pass-789" }, "manager");
    expect((await leads.assignLead(actor(), lead.id, { assignedUserId: manager.user.id })).assignedUserId).toBe(manager.user.id);
    await expect(leads.assignLead(actor(), lead.id, { assignedUserId: orgB.user.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("enforces persisted RBAC for mutations", async () => {
    const viewerResult = await new UserService().createUserWithMembership(actor(), { name: "Lead Viewer", email: "lead-viewer@example.test", password: "Synthetic-Viewer-123" }, "viewer");
    const viewer = { userId: viewerResult.user.id, organizationId: orgA.organization.id, role: "viewer" as const };
    await expect(leads.createLead(viewer, { name: "Denied" })).rejects.toBeInstanceOf(ForbiddenError);
    const lead = await leads.createLead(actor(), { name: "Read Only" }); expect((await leads.getLead(viewer, lead.id)).id).toBe(lead.id);
  });

  it("applies lifecycle transitions and status audit atomically", async () => {
    const lead = await leads.createLead(actor(), { name: "Workflow Lead" });
    expect((await leads.changeStatus(actor(), lead.id, { status: "contacted" })).status).toBe("contacted");
    await expect(leads.changeStatus(actor(), lead.id, { status: "won" })).rejects.toBeInstanceOf(ConflictError);
    expect((await leads.getLead(actor(), lead.id)).status).toBe("contacted");
  });

  it("converts to a tenant-local existing customer without cross-tenant matching", async () => {
    const email = "shared-conversion@example.test";
    const localCustomer = await customers.createCustomer(actor(), { name: "Existing Local", email });
    await customers.createCustomer(actorB(), { name: "Foreign Match", email });
    const lead = await leads.createLead(actor(), { name: "Conversion Lead", email });
    await leads.changeStatus(actor(), lead.id, { status: "contacted" }); await leads.changeStatus(actor(), lead.id, { status: "qualified" }); await leads.changeStatus(actor(), lead.id, { status: "estimate" });
    const result = await leads.convertLead(actor(), lead.id); expect(result).toMatchObject({ customerId: localCustomer.id, created: false }); expect(result.lead.status).toBe("won");
    await expect(leads.convertLead(actor(), lead.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("creates a customer with provenance and rolls back ambiguous conversion", async () => {
    const unique = await leads.createLead(actor(), { name: "New Customer Lead", phone: "+1 555 0199" });
    await leads.changeStatus(actor(), unique.id, { status: "contacted" }); await leads.changeStatus(actor(), unique.id, { status: "qualified" }); await leads.changeStatus(actor(), unique.id, { status: "estimate" });
    const converted = await leads.convertLead(actor(), unique.id); expect(converted.created).toBe(true); expect((await customers.getCustomer(actor(), converted.customerId)).name).toBe("New Customer Lead");
    await customers.createCustomer(actor(), { name: "Duplicate One", email: "ambiguous@example.test" }); await customers.createCustomer(actor(), { name: "Duplicate Two", phone: "555-0188" });
    const ambiguous = await leads.createLead(actor(), { name: "Ambiguous", email: "ambiguous@example.test", phone: "5550188" });
    await leads.changeStatus(actor(), ambiguous.id, { status: "contacted" }); await leads.changeStatus(actor(), ambiguous.id, { status: "qualified" }); await leads.changeStatus(actor(), ambiguous.id, { status: "estimate" });
    await expect(leads.convertLead(actor(), ambiguous.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await leads.getLead(actor(), ambiguous.id))).toMatchObject({ status: "estimate", convertedCustomerId: null });
    expect((await new AuditRepository().listForEntity(actor().organizationId, "lead", ambiguous.id)).some((event) => event.action === "lead.converted")).toBe(false);
  });

  it("rejects cross-tenant conversion as not found", async () => {
    const foreign = await leads.createLead(actorB(), { name: "Foreign Conversion" });
    await expect(leads.convertLead(actor(), foreign.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
