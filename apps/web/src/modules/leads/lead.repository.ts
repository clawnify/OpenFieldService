import "server-only";
import { and, asc, count, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { customers, leads, leadStatusHistory } from "@/db/schema";
import type { Lead, LeadStatus, NewLead } from "./lead.types";

export interface LeadPage { items: Lead[]; total: number }
export interface LeadListInput { query?: string; status?: LeadStatus; source?: string; assignedUserId?: string | null; limit: number; offset: number }

export class LeadRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}

  private activeScope(organizationId: string) { return and(eq(leads.organizationId, organizationId), isNull(leads.archivedAt)); }

  async findById(organizationId: string, id: string): Promise<Lead | null> {
    const [lead] = await this.executor.select().from(leads).where(and(this.activeScope(organizationId), eq(leads.id, id))).limit(1);
    return lead ?? null;
  }

  async findByIdForUpdate(organizationId: string, id: string): Promise<Lead | null> {
    const [lead] = await this.executor.select().from(leads).where(and(this.activeScope(organizationId), eq(leads.id, id))).for("update").limit(1);
    return lead ?? null;
  }

  async findMany(organizationId: string, input: LeadListInput): Promise<LeadPage> {
    const search = input.query ? or(ilike(leads.identifier, `%${input.query}%`), ilike(leads.name, `%${input.query}%`), ilike(leads.email, `%${input.query}%`), ilike(leads.phone, `%${input.query}%`)) : undefined;
    const where = and(this.activeScope(organizationId), search, input.status ? eq(leads.status, input.status) : undefined, input.source ? eq(leads.source, input.source) : undefined, input.assignedUserId === null ? isNull(leads.assignedUserId) : input.assignedUserId ? eq(leads.assignedUserId, input.assignedUserId) : undefined);
    const [items, [{ total }]] = await Promise.all([
      this.executor.select().from(leads).where(where).orderBy(desc(leads.createdAt), asc(leads.name)).limit(input.limit).offset(input.offset),
      this.executor.select({ total: count() }).from(leads).where(where),
    ]);
    return { items, total };
  }

  async create(input: NewLead): Promise<Lead> { const [lead] = await this.executor.insert(leads).values(input).returning(); return lead; }
  async update(organizationId: string, id: string, input: Partial<NewLead>): Promise<Lead | null> {
    const [lead] = await this.executor.update(leads).set({ ...input, id: undefined, organizationId: undefined, identifier: undefined, updatedAt: new Date() }).where(and(this.activeScope(organizationId), eq(leads.id, id))).returning(); return lead ?? null;
  }
  async archive(organizationId: string, id: string, actorUserId: string): Promise<Lead | null> {
    const [lead] = await this.executor.update(leads).set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId }).where(and(this.activeScope(organizationId), eq(leads.id, id))).returning(); return lead ?? null;
  }
  async recordStatus(input: { organizationId: string; leadId: string; oldStatus: LeadStatus | null; newStatus: LeadStatus; reason?: string | null; actorUserId: string }) {
    const [history] = await this.executor.insert(leadStatusHistory).values(input).returning(); return history;
  }
  async findMatchingCustomerIds(organizationId: string, input: { email: string | null; phone: string | null }): Promise<string[]> {
    const email = input.email?.trim().toLowerCase() ?? ""; const phone = input.phone?.replace(/\D/g, "") ?? "";
    if (!email && !phone) return [];
    const rows = await this.executor.select({ id: customers.id, email: customers.email, phone: customers.phone }).from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.status, "active"), isNull(customers.archivedAt)));
    return [...new Set(rows.filter((customer) => (email && customer.email?.trim().toLowerCase() === email) || (phone && customer.phone?.replace(/\D/g, "") === phone)).map((customer) => customer.id))];
  }
}
