import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { companies, contacts, customers, deals, leads } from "@/db/schema";
import type { Target } from "./interaction.schema";
export class RelationRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  async exists(organizationId: string, target: Target): Promise<boolean> {
    switch (target.targetType) {
      case "customer": return Boolean((await this.executor.select({ id: customers.id }).from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.id, target.targetId), isNull(customers.archivedAt))).limit(1))[0]);
      case "contact": return Boolean((await this.executor.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, target.targetId), isNull(contacts.removedAt))).limit(1))[0]);
      case "company": return Boolean((await this.executor.select({ id: companies.id }).from(companies).where(and(eq(companies.organizationId, organizationId), eq(companies.id, target.targetId), isNull(companies.archivedAt))).limit(1))[0]);
      case "lead": return Boolean((await this.executor.select({ id: leads.id }).from(leads).where(and(eq(leads.organizationId, organizationId), eq(leads.id, target.targetId), isNull(leads.archivedAt))).limit(1))[0]);
      case "deal": return Boolean((await this.executor.select({ id: deals.id }).from(deals).where(and(eq(deals.organizationId, organizationId), eq(deals.id, target.targetId), isNull(deals.archivedAt))).limit(1))[0]);
    }
  }
}
