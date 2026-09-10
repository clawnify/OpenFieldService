import "server-only";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { pipelineStages } from "@/db/schema";
import type { NewPipelineStage, PipelineStage } from "./pipeline.types";

export class PipelineStageRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  private active(organizationId: string, pipelineId?: string) { return and(eq(pipelineStages.organizationId, organizationId), isNull(pipelineStages.archivedAt), pipelineId ? eq(pipelineStages.pipelineId, pipelineId) : undefined); }
  async findById(organizationId: string, id: string): Promise<PipelineStage | null> { const [value] = await this.executor.select().from(pipelineStages).where(and(this.active(organizationId), eq(pipelineStages.id, id))).limit(1); return value ?? null; }
  async list(organizationId: string, pipelineId: string): Promise<PipelineStage[]> { return this.executor.select().from(pipelineStages).where(this.active(organizationId, pipelineId)).orderBy(asc(pipelineStages.position), asc(pipelineStages.id)); }
  async listForUpdate(organizationId: string, pipelineId: string): Promise<PipelineStage[]> { return this.executor.select().from(pipelineStages).where(this.active(organizationId, pipelineId)).orderBy(asc(pipelineStages.position), asc(pipelineStages.id)).for("update"); }
  async nameExists(organizationId: string, pipelineId: string, name: string, exceptId?: string): Promise<boolean> { const [row] = await this.executor.select({ id: pipelineStages.id }).from(pipelineStages).where(and(this.active(organizationId, pipelineId), sql`lower(${pipelineStages.name}) = lower(${name})`, exceptId ? ne(pipelineStages.id, exceptId) : undefined)).limit(1); return Boolean(row); }
  async create(input: NewPipelineStage): Promise<PipelineStage> { const [value] = await this.executor.insert(pipelineStages).values(input).returning(); return value; }
  async update(organizationId: string, pipelineId: string, id: string, input: Partial<NewPipelineStage>): Promise<PipelineStage | null> { const [value] = await this.executor.update(pipelineStages).set({ ...input, id: undefined, organizationId: undefined, pipelineId: undefined, position: undefined, updatedAt: new Date() }).where(and(this.active(organizationId, pipelineId), eq(pipelineStages.id, id))).returning(); return value ?? null; }
  async shiftToTemporaryPositions(organizationId: string, pipelineId: string): Promise<void> { await this.executor.update(pipelineStages).set({ position: sql`${pipelineStages.position} + 1000000` }).where(this.active(organizationId, pipelineId)); }
  async setPosition(organizationId: string, pipelineId: string, id: string, position: number, actorUserId: string): Promise<boolean> { const values = await this.executor.update(pipelineStages).set({ position, updatedBy: actorUserId, updatedAt: new Date() }).where(and(this.active(organizationId, pipelineId), eq(pipelineStages.id, id))).returning({ id: pipelineStages.id }); return values.length === 1; }
  async archive(organizationId: string, pipelineId: string, id: string, actorUserId: string): Promise<PipelineStage | null> { const [value] = await this.executor.update(pipelineStages).set({ archivedAt: new Date(), updatedBy: actorUserId, updatedAt: new Date() }).where(and(this.active(organizationId, pipelineId), eq(pipelineStages.id, id))).returning(); return value ?? null; }
  async archiveForPipeline(organizationId: string, pipelineId: string, actorUserId: string): Promise<void> { await this.executor.update(pipelineStages).set({ archivedAt: new Date(), updatedBy: actorUserId, updatedAt: new Date() }).where(this.active(organizationId, pipelineId)); }
}
