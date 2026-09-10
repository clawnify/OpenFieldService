import "server-only";
import { and, asc, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { organizations, pipelines } from "@/db/schema";
import type { NewPipeline, Pipeline } from "./pipeline.types";

export class PipelineRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  private active(organizationId: string) { return and(eq(pipelines.organizationId, organizationId), isNull(pipelines.archivedAt)); }
  async lockOrganization(organizationId: string): Promise<boolean> { const rows = await this.executor.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).for("update"); return rows.length === 1; }
  async findById(organizationId: string, id: string): Promise<Pipeline | null> { const [value] = await this.executor.select().from(pipelines).where(and(this.active(organizationId), eq(pipelines.id, id))).limit(1); return value ?? null; }
  async findByIdForUpdate(organizationId: string, id: string): Promise<Pipeline | null> { const [value] = await this.executor.select().from(pipelines).where(and(this.active(organizationId), eq(pipelines.id, id))).for("update").limit(1); return value ?? null; }
  async list(organizationId: string, query?: string): Promise<Pipeline[]> { return this.executor.select().from(pipelines).where(and(this.active(organizationId), query ? ilike(pipelines.name, `%${query}%`) : undefined)).orderBy(sql`${pipelines.isDefault} desc`, asc(pipelines.createdAt), asc(pipelines.id)); }
  async countActive(organizationId: string): Promise<number> { const [row] = await this.executor.select({ value: sql<number>`count(*)::int` }).from(pipelines).where(this.active(organizationId)); return row.value; }
  async nameExists(organizationId: string, name: string, exceptId?: string): Promise<boolean> { const [row] = await this.executor.select({ id: pipelines.id }).from(pipelines).where(and(this.active(organizationId), sql`lower(${pipelines.name}) = lower(${name})`, exceptId ? ne(pipelines.id, exceptId) : undefined)).limit(1); return Boolean(row); }
  async create(input: NewPipeline): Promise<Pipeline> { const [value] = await this.executor.insert(pipelines).values(input).returning(); return value; }
  async update(organizationId: string, id: string, input: Partial<NewPipeline>): Promise<Pipeline | null> { const [value] = await this.executor.update(pipelines).set({ ...input, id: undefined, organizationId: undefined, isDefault: undefined, updatedAt: new Date() }).where(and(this.active(organizationId), eq(pipelines.id, id))).returning(); return value ?? null; }
  async clearDefault(organizationId: string): Promise<void> { await this.executor.update(pipelines).set({ isDefault: false, updatedAt: new Date() }).where(and(this.active(organizationId), eq(pipelines.isDefault, true))); }
  async markDefault(organizationId: string, id: string, actorUserId: string): Promise<Pipeline | null> { const [value] = await this.executor.update(pipelines).set({ isDefault: true, updatedBy: actorUserId, updatedAt: new Date() }).where(and(this.active(organizationId), eq(pipelines.id, id))).returning(); return value ?? null; }
  async archive(organizationId: string, id: string, actorUserId: string): Promise<Pipeline | null> { const [value] = await this.executor.update(pipelines).set({ isDefault: false, archivedAt: new Date(), updatedBy: actorUserId, updatedAt: new Date() }).where(and(this.active(organizationId), eq(pipelines.id, id))).returning(); return value ?? null; }
}
