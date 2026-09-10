import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { jobs, notes } from "@/db/schema";
import { RelationRepository } from "@/modules/interactions/relation.repository";
import type { AttachmentTarget } from "./attachment.schema";
export class AttachmentTargetRepository {
  private readonly relations: RelationRepository;
  constructor(private readonly executor:DatabaseExecutor=getDb()){this.relations=new RelationRepository(executor);}
  async exists(org:string,target:AttachmentTarget){if(target.targetType==="note")return Boolean((await this.executor.select({id:notes.id}).from(notes).where(and(eq(notes.organizationId,org),eq(notes.id,target.targetId),isNull(notes.archivedAt))).limit(1))[0]);if(target.targetType==="job")return Boolean((await this.executor.select({id:jobs.id}).from(jobs).where(and(eq(jobs.organizationId,org),eq(jobs.id,target.targetId),isNull(jobs.archivedAt))).limit(1))[0]);return this.relations.exists(org,{targetType:target.targetType,targetId:target.targetId});}
  async lockJob(org:string,id:string){const[row]=await this.executor.select().from(jobs).where(and(eq(jobs.organizationId,org),eq(jobs.id,id),isNull(jobs.archivedAt))).for("update").limit(1);return row??null;}
}
