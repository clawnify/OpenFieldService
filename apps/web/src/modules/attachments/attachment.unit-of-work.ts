import "server-only";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { AttachmentRepository } from "./attachment.repository";
import { AttachmentTargetRepository } from "./attachment-target.repository";
export interface AttachmentRepositories { attachments:AttachmentRepository; targets:AttachmentTargetRepository; audit:AuditRepository }
export interface AttachmentUnitOfWork { transaction<T>(operation:(repositories:AttachmentRepositories)=>Promise<T>):Promise<T> }
export class DrizzleAttachmentUnitOfWork implements AttachmentUnitOfWork { transaction<T>(operation:(repositories:AttachmentRepositories)=>Promise<T>):Promise<T>{return getDb().transaction((tx)=>operation({attachments:new AttachmentRepository(tx),targets:new AttachmentTargetRepository(tx),audit:new AuditRepository(tx)}));} }
