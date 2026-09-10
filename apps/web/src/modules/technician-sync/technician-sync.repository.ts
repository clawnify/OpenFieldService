import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { technicianSyncMutations } from "@/db/schema";

export class TechnicianSyncRepository {
  constructor(private readonly db: DatabaseExecutor = getDb()) {}

  async insertPending(input: typeof technicianSyncMutations.$inferInsert) {
    await this.db.insert(technicianSyncMutations).values(input).onConflictDoNothing();
  }

  async lockByClientKey(organizationId: string, actorUserId: string, clientMutationId: string) {
    const [row] = await this.db.select().from(technicianSyncMutations).where(and(
      eq(technicianSyncMutations.organizationId, organizationId),
      eq(technicianSyncMutations.actorUserId, actorUserId),
      eq(technicianSyncMutations.clientMutationId, clientMutationId),
    )).for("update").limit(1);
    return row ?? null;
  }

  async dependencies(organizationId: string, actorUserId: string, jobId: string, ids: string[]) {
    if (!ids.length) return [];
    return this.db.select().from(technicianSyncMutations).where(and(
      eq(technicianSyncMutations.organizationId, organizationId),
      eq(technicianSyncMutations.actorUserId, actorUserId),
      eq(technicianSyncMutations.jobId, jobId),
      inArray(technicianSyncMutations.clientMutationId, ids),
    ));
  }

  async acquire(id: string, leaseExpiresAt: Date) {
    const [row] = await this.db.update(technicianSyncMutations).set({
      leaseExpiresAt, attemptCount: sql`${technicianSyncMutations.attemptCount} + 1`,
    }).where(eq(technicianSyncMutations.id, id)).returning();
    return row;
  }

  async markApplied(id: string, result: Record<string, unknown>) {
    const [row] = await this.db.update(technicianSyncMutations).set({
      state: "applied", result, appliedAt: new Date(), leaseExpiresAt: null,
    }).where(eq(technicianSyncMutations.id, id)).returning();
    return row;
  }

  async release(id: string) {
    await this.db.update(technicianSyncMutations).set({ leaseExpiresAt: null }).where(eq(technicianSyncMutations.id, id));
  }
}
