import { randomUUID } from "node:crypto";
import { authorize } from "@/auth/authorization";
import type { Permission } from "@/auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { changedFields, nullable, parseEntityId } from "@/modules/crm/crm.helpers";
import { DrizzleCrmUnitOfWork, type CrmUnitOfWork } from "@/modules/crm/crm.unit-of-work";
import type { RequestActor, Authorizer } from "@/modules/customers/customer.service";
import { LeadRepository } from "./lead.repository";
import { assignLeadSchema, changeLeadStatusSchema, convertLeadSchema, createLeadSchema, leadFilterSchema, updateLeadSchema, type AssignLeadInput, type ChangeLeadStatusInput, type CreateLeadInput, type LeadFilter, type UpdateLeadInput } from "./lead.schema";
import type { Lead } from "./lead.types";
import { canTransitionLead } from "./lead.workflow";

export interface ConvertLeadResult { lead: Lead; customerId: string; created: boolean }

export class LeadService {
  constructor(private readonly repository = new LeadRepository(), private readonly authorizer: Authorizer = authorize, private readonly unitOfWork: CrmUnitOfWork = new DrizzleCrmUnitOfWork()) {}

  private authorize(actor: RequestActor, permission: Permission) { return this.authorizer(actor, permission); }
  async getLead(actor: RequestActor, id: string): Promise<Lead> { await this.authorize(actor, "lead.read"); const lead = await this.repository.findById(actor.organizationId, parseEntityId(id)); if (!lead) throw new NotFoundError("Lead not found"); return lead; }
  async listLeads(actor: RequestActor, raw: LeadFilter) { await this.authorize(actor, "lead.read"); const filter = parseInput(leadFilterSchema, raw); const result = await this.repository.findMany(actor.organizationId, { query: filter.query, status: filter.status, source: filter.source, assignedUserId: filter.assignedUserId, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }); return { ...result, page: filter.page, pageSize: filter.pageSize }; }

  async createLead(actor: RequestActor, raw: CreateLeadInput): Promise<Lead> {
    await this.authorize(actor, "lead.create"); const input = parseInput(createLeadSchema, raw); if (input.assignedUserId) await this.authorize(actor, "lead.assign");
    return this.unitOfWork.transaction(async ({ leads, memberships, audit }) => {
      if (input.assignedUserId) await this.requireAssignableMembership(memberships, actor.organizationId, input.assignedUserId);
      const lead = await leads.create({ organizationId: actor.organizationId, identifier: `LEAD-${randomUUID().slice(0, 8).toUpperCase()}`, name: input.name, email: nullable(input.email), phone: nullable(input.phone), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), source: nullable(input.source), notes: nullable(input.notes), estimatedValueCents: input.estimatedValueCents, estimateNotes: nullable(input.estimateNotes), assignedUserId: input.assignedUserId, createdBy: actor.userId, updatedBy: actor.userId });
      await leads.recordStatus({ organizationId: actor.organizationId, leadId: lead.id, oldStatus: null, newStatus: "new", reason: "Lead created", actorUserId: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "lead.created", entityType: "lead", entityId: lead.id, metadata: { identifier: lead.identifier, assigned: Boolean(lead.assignedUserId) } });
      return lead;
    });
  }

  async updateLead(actor: RequestActor, id: string, raw: UpdateLeadInput): Promise<Lead> {
    await this.authorize(actor, "lead.update"); id = parseEntityId(id); const input = parseInput(updateLeadSchema, raw);
    return this.unitOfWork.transaction(async ({ leads, audit }) => {
      if (!await leads.findById(actor.organizationId, id)) throw new NotFoundError("Lead not found");
      const lead = await leads.update(actor.organizationId, id, { ...input, email: nullable(input.email), phone: nullable(input.phone), addressLine1: nullable(input.addressLine1), addressLine2: nullable(input.addressLine2), city: nullable(input.city), region: nullable(input.region), postalCode: nullable(input.postalCode), source: nullable(input.source), notes: nullable(input.notes), estimateNotes: nullable(input.estimateNotes), updatedBy: actor.userId });
      if (!lead) throw new NotFoundError("Lead not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "lead.updated", entityType: "lead", entityId: id, metadata: { fields: changedFields(input) } }); return lead;
    });
  }

  async assignLead(actor: RequestActor, id: string, raw: AssignLeadInput): Promise<Lead> {
    await this.authorize(actor, "lead.assign"); id = parseEntityId(id); const input = parseInput(assignLeadSchema, raw);
    return this.unitOfWork.transaction(async ({ leads, memberships, audit }) => {
      const current = await leads.findById(actor.organizationId, id); if (!current) throw new NotFoundError("Lead not found");
      if (input.assignedUserId) await this.requireAssignableMembership(memberships, actor.organizationId, input.assignedUserId);
      const lead = await leads.update(actor.organizationId, id, { assignedUserId: input.assignedUserId, updatedBy: actor.userId }); if (!lead) throw new NotFoundError("Lead not found");
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: input.assignedUserId ? "lead.assigned" : "lead.unassigned", entityType: "lead", entityId: id, metadata: { assignedUserId: input.assignedUserId } }); return lead;
    });
  }

  async changeStatus(actor: RequestActor, id: string, raw: ChangeLeadStatusInput): Promise<Lead> {
    await this.authorize(actor, "lead.status"); id = parseEntityId(id); const input = parseInput(changeLeadStatusSchema, raw);
    return this.unitOfWork.transaction(async ({ leads, audit }) => {
      const current = await leads.findByIdForUpdate(actor.organizationId, id); if (!current) throw new NotFoundError("Lead not found");
      if (!canTransitionLead(current.status, input.status)) throw new ConflictError(`Cannot transition lead from "${current.status}" to "${input.status}"`);
      if (input.status === "lost" && !input.lostReason) throw new ValidationError("A lost reason is required", [{ path: "lostReason", message: "Select a lost reason" }]);
      const lead = await leads.update(actor.organizationId, id, { status: input.status, lostReason: input.status === "lost" ? input.lostReason : undefined, lostReasonNote: input.status === "lost" ? nullable(input.lostReasonNote) : undefined, updatedBy: actor.userId }); if (!lead) throw new ConflictError("Lead changed during status update");
      await leads.recordStatus({ organizationId: actor.organizationId, leadId: id, oldStatus: current.status, newStatus: input.status, reason: input.status === "lost" ? input.lostReason : undefined, actorUserId: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "lead.status_changed", entityType: "lead", entityId: id, metadata: { from: current.status, to: input.status } }); return lead;
    });
  }

  async convertLead(actor: RequestActor, id: string, raw: unknown = {}): Promise<ConvertLeadResult> {
    await this.authorize(actor, "lead.convert"); id = parseEntityId(id); parseInput(convertLeadSchema, raw);
    return this.unitOfWork.transaction(async ({ leads, customers, audit }) => {
      const current = await leads.findByIdForUpdate(actor.organizationId, id); if (!current) throw new NotFoundError("Lead not found");
      if (current.convertedCustomerId) throw new ConflictError("This lead has already been converted");
      if (current.status !== "estimate" && current.status !== "won") throw new ConflictError("Lead must be in estimate or won status before conversion");
      const matches = await leads.findMatchingCustomerIds(actor.organizationId, current);
      if (matches.length > 1) throw new ConflictError("Multiple customers match this lead; resolve duplicates before converting");
      let customerId = matches[0]; let created = false;
      if (!customerId) {
        const customer = await customers.create({ organizationId: actor.organizationId, name: current.name, email: current.email, phone: current.phone, addressLine1: current.addressLine1, addressLine2: current.addressLine2, city: current.city, region: current.region, postalCode: current.postalCode, notes: current.notes, createdBy: actor.userId, updatedBy: actor.userId });
        customerId = customer.id; created = true;
        await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "customer.created", entityType: "customer", entityId: customer.id, metadata: { sourceLeadId: current.id } });
      }
      const lead = await leads.update(actor.organizationId, id, { status: "won", convertedCustomerId: customerId, convertedAt: new Date(), convertedBy: actor.userId, updatedBy: actor.userId }); if (!lead) throw new ConflictError("Lead changed during conversion");
      if (current.status === "estimate") await leads.recordStatus({ organizationId: actor.organizationId, leadId: id, oldStatus: "estimate", newStatus: "won", reason: "Converted to customer", actorUserId: actor.userId });
      await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "lead.converted", entityType: "lead", entityId: id, metadata: { customerId, customerCreated: created } });
      return { lead, customerId, created };
    });
  }

  async archiveLead(actor: RequestActor, id: string): Promise<void> { await this.authorize(actor, "lead.delete"); id = parseEntityId(id); await this.unitOfWork.transaction(async ({ leads, audit }) => { const lead = await leads.archive(actor.organizationId, id, actor.userId); if (!lead) throw new NotFoundError("Lead not found"); await audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "lead.archived", entityType: "lead", entityId: id, metadata: {} }); }); }

  private async requireAssignableMembership(memberships: Parameters<Parameters<CrmUnitOfWork["transaction"]>[0]>[0]["memberships"], organizationId: string, userId: string) {
    const membership = await memberships.find(organizationId, userId); if (!membership || !["owner", "admin", "manager"].includes(membership.role)) throw new NotFoundError("Assignable organization member not found");
  }
}
