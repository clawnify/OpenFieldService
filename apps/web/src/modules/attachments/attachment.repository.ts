import "server-only";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { attachments } from "@/db/schema";
import type { NewAttachment } from "./attachment.types";
export class AttachmentRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  private active(org:string){return and(eq(attachments.organizationId,org),isNull(attachments.archivedAt));}
  async create(input:NewAttachment){const [v]=await this.executor.insert(attachments).values(input).returning();return v;}
  async findById(org:string,id:string){const[v]=await this.executor.select().from(attachments).where(and(this.active(org),eq(attachments.id,id))).limit(1);return v??null;}
  async findByIdIncludingArchived(org:string,id:string){const[v]=await this.executor.select().from(attachments).where(and(eq(attachments.organizationId,org),eq(attachments.id,id))).limit(1);return v??null;}
  async findByClientMutation(org:string,userId:string,clientMutationId:string){const[v]=await this.executor.select().from(attachments).where(and(eq(attachments.organizationId,org),eq(attachments.uploadedBy,userId),eq(attachments.clientMutationId,clientMutationId))).limit(1);return v??null;}
  async findByIdForUpdate(org:string,id:string){const[v]=await this.executor.select().from(attachments).where(and(eq(attachments.organizationId,org),eq(attachments.id,id))).for("update").limit(1);return v??null;}
  async listForTarget(org:string,type:typeof attachments.$inferSelect.targetType,id:string,limit=50){return this.executor.select().from(attachments).where(and(this.active(org),eq(attachments.targetType,type),eq(attachments.targetId,id))).orderBy(desc(attachments.createdAt),desc(attachments.id)).limit(limit);}
  async countForTarget(org:string,type:typeof attachments.$inferSelect.targetType,id:string){const[{value}]=await this.executor.select({value:count()}).from(attachments).where(and(this.active(org),eq(attachments.targetType,type),eq(attachments.targetId,id)));return value;}
  async archive(org:string,id:string,actor:string){const[v]=await this.executor.update(attachments).set({archivedAt:new Date(),archivedBy:actor}).where(and(this.active(org),eq(attachments.id,id))).returning();return v??null;}
  async markStorageDeleted(org:string,id:string){const[v]=await this.executor.update(attachments).set({storageDeletedAt:new Date()}).where(and(eq(attachments.organizationId,org),eq(attachments.id,id),isNull(attachments.storageDeletedAt))).returning();return v??null;}
}
