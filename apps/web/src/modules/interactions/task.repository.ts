import "server-only";
import { and, count, desc, eq, ilike, isNull, lte, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { tasks } from "@/db/schema";
import type { NewTask, Task } from "./interaction.types";
export interface TaskListQuery { query?: string; status?: Task["status"]; priority?: Task["priority"]; assigneeUserId?: string | null; targetType?: Task["targetType"]; targetId?: string; dueBefore?: Date; limit: number; offset: number }
export class TaskRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  private active(org: string) { return and(eq(tasks.organizationId, org), isNull(tasks.archivedAt)); }
  async findById(org: string, id: string) { const [v] = await this.executor.select().from(tasks).where(and(this.active(org), eq(tasks.id, id))).limit(1); return v ?? null; }
  async findByIdForUpdate(org: string, id: string) { const [v] = await this.executor.select().from(tasks).where(and(this.active(org), eq(tasks.id, id))).for("update").limit(1); return v ?? null; }
  async list(org: string, q: TaskListQuery) { const where = and(this.active(org), q.query ? or(ilike(tasks.title, `%${q.query}%`), ilike(tasks.description, `%${q.query}%`)) : undefined, q.status ? eq(tasks.status, q.status) : undefined, q.priority ? eq(tasks.priority, q.priority) : undefined, q.assigneeUserId === null ? isNull(tasks.assigneeUserId) : q.assigneeUserId ? eq(tasks.assigneeUserId, q.assigneeUserId) : undefined, q.targetType ? eq(tasks.targetType, q.targetType) : undefined, q.targetId ? eq(tasks.targetId, q.targetId) : undefined, q.dueBefore ? lte(tasks.dueAt, q.dueBefore) : undefined); const [items, [{ total }]] = await Promise.all([this.executor.select().from(tasks).where(where).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(q.limit).offset(q.offset), this.executor.select({ total: count() }).from(tasks).where(where)]); return { items, total }; }
  async create(input: NewTask) { const [v] = await this.executor.insert(tasks).values(input).returning(); return v; }
  async update(org: string, id: string, input: Partial<NewTask>) { const [v] = await this.executor.update(tasks).set({ ...input, id: undefined, organizationId: undefined, targetType: undefined, targetId: undefined, createdBy: undefined, createdAt: undefined, updatedAt: new Date() }).where(and(this.active(org), eq(tasks.id, id))).returning(); return v ?? null; }
  async archive(org: string, id: string, actor: string) { const [v] = await this.executor.update(tasks).set({ archivedAt: new Date(), updatedBy: actor, updatedAt: new Date() }).where(and(this.active(org), eq(tasks.id, id))).returning(); return v ?? null; }
}
