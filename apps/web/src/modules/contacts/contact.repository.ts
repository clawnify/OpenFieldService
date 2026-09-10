import "server-only";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { contacts } from "@/db/schema";
import type { Contact, NewContact } from "./contact.types";

export class ContactRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  async findById(organizationId: string, id: string): Promise<Contact | null> {
    const [value] = await this.executor.select().from(contacts).where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), eq(contacts.active, true), isNull(contacts.removedAt))).limit(1); return value ?? null;
  }
  async findMany(organizationId: string, input: { customerId?: string; companyId?: string; limit: number; offset: number }) {
    const where = and(eq(contacts.organizationId, organizationId), eq(contacts.active, true), isNull(contacts.removedAt), input.customerId ? eq(contacts.customerId, input.customerId) : undefined, input.companyId ? eq(contacts.companyId, input.companyId) : undefined);
    const [items, [{ total }]] = await Promise.all([this.executor.select().from(contacts).where(where).orderBy(asc(contacts.lastName), asc(contacts.firstName)).limit(input.limit).offset(input.offset), this.executor.select({ total: count() }).from(contacts).where(where)]);
    return { items, total };
  }
  async hasActiveForCustomer(organizationId: string, customerId: string): Promise<boolean> { const [row] = await this.executor.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.organizationId, organizationId), eq(contacts.customerId, customerId), eq(contacts.active, true))).limit(1); return Boolean(row); }
  async hasActiveForCompany(organizationId: string, companyId: string): Promise<boolean> { const [row] = await this.executor.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.organizationId, organizationId), eq(contacts.companyId, companyId), eq(contacts.active, true))).limit(1); return Boolean(row); }
  async clearPrimary(organizationId: string, customerId?: string | null, companyId?: string | null): Promise<void> {
    const parent = customerId ? eq(contacts.customerId, customerId) : companyId ? eq(contacts.companyId, companyId) : undefined;
    if (parent) await this.executor.update(contacts).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(contacts.organizationId, organizationId), parent, eq(contacts.active, true), eq(contacts.isPrimary, true)));
  }
  async create(input: NewContact): Promise<Contact> { const [value] = await this.executor.insert(contacts).values(input).returning(); return value; }
  async update(organizationId: string, id: string, input: Partial<NewContact>): Promise<Contact | null> { const [value] = await this.executor.update(contacts).set({ ...input, id: undefined, organizationId: undefined, updatedAt: new Date() }).where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), eq(contacts.active, true))).returning(); return value ?? null; }
  async remove(organizationId: string, id: string, actorUserId: string): Promise<Contact | null> { const [value] = await this.executor.update(contacts).set({ active: false, isPrimary: false, removedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId }).where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), eq(contacts.active, true))).returning(); return value ?? null; }
}
