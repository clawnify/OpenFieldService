import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { auditLogs } from "@/db/schema";

export type AuditEventInput = typeof auditLogs.$inferInsert;
export class AuditRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  async record(input: AuditEventInput) { const [event] = await this.executor.insert(auditLogs).values(input).returning(); return event; }
  async listForEntity(organizationId: string, entityType: string, entityId: string) { return this.executor.select().from(auditLogs).where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId))).orderBy(asc(auditLogs.createdAt)); }
}
