import { createHash } from "node:crypto";
import { authorize } from "@/auth/authorization";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertFileSignature, createObjectKey, DOWNLOAD_URL_TTL_SECONDS, r2Storage, safeDisplayFilename, type ObjectStorage } from "@/lib/r2";
import { parseInput } from "@/lib/validation";
import { parseEntityId } from "@/modules/crm/crm.helpers";
import type { Authorizer, RequestActor } from "@/modules/customers/customer.service";
import { attachmentListSchema, downloadAttachmentSchema, uploadAttachmentSchema, type AttachmentTarget, type UploadAttachmentInput } from "./attachment.schema";
import { AttachmentRepository } from "./attachment.repository";
import { DrizzleAttachmentUnitOfWork, type AttachmentUnitOfWork } from "./attachment.unit-of-work";
export class AttachmentService {
  constructor(private readonly repository=new AttachmentRepository(),private readonly authorizer:Authorizer=authorize,private readonly unitOfWork:AttachmentUnitOfWork=new DrizzleAttachmentUnitOfWork(),private readonly storage:ObjectStorage=r2Storage){}
  async getAttachment(actor:RequestActor,id:string){await this.authorizer(actor,"attachment.read");const value=await this.repository.findById(actor.organizationId,parseEntityId(id));if(!value)throw new NotFoundError("Attachment not found");return value;}
  async listAttachments(actor:RequestActor,raw:unknown){await this.authorizer(actor,"attachment.read");const i=parseInput(attachmentListSchema,raw);return this.unitOfWork.transaction(async(r)=>{if(!await r.targets.exists(actor.organizationId,i))throw new NotFoundError("Related record not found");return r.attachments.listForTarget(actor.organizationId,i.targetType,i.targetId,i.limit);});}
  async uploadAttachment(actor:RequestActor,raw:UploadAttachmentInput,body:Uint8Array){return this.upload(actor,raw,body,null);}
  async uploadAttachmentFromSync(actor:RequestActor,raw:UploadAttachmentInput,body:Uint8Array,rawClientMutationId:string){return this.upload(actor,raw,body,parseEntityId(rawClientMutationId));}
  private async upload(actor:RequestActor,raw:UploadAttachmentInput,body:Uint8Array,clientMutationId:string|null){
    await this.authorizer(actor,"attachment.create");
    const i=parseInput(uploadAttachmentSchema,raw);
    if(body.byteLength!==i.sizeBytes)throw new ValidationError("File size does not match uploaded content");
    let filename:string;
    try{filename=safeDisplayFilename(i.filename);assertFileSignature(body,i.contentType);}catch(error){throw new ValidationError(error instanceof Error?error.message:"Invalid file");}
    const sha256=createHash("sha256").update(body).digest("hex");
    const prior=clientMutationId?await this.repository.findByClientMutation(actor.organizationId,actor.userId,clientMutationId):null;
    if(prior){
      if(prior.targetType!==i.targetType||prior.targetId!==i.targetId||prior.contentType!==i.contentType||prior.sizeBytes!==body.byteLength||prior.sha256!==sha256)throw new ConflictError("Sync mutation was already used for different attachment content");
      return prior;
    }
    const key=createObjectKey(actor.organizationId,i.targetType,i.targetId);
    if(!await this.unitOfWork.transaction((r)=>r.targets.exists(actor.organizationId,i)))throw new NotFoundError("Related record not found");
    try{await this.storage.put(key,body,i.contentType);}catch{try{await this.storage.delete(key);}catch{}throw new ConflictError("File storage is temporarily unavailable");}
    try{return await this.unitOfWork.transaction(async(r)=>{
      if(!await r.targets.exists(actor.organizationId,i))throw new NotFoundError("Related record not found");
      if(clientMutationId){
        const existing=await r.attachments.findByClientMutation(actor.organizationId,actor.userId,clientMutationId);
        if(existing)return existing;
      }
      const value=await r.attachments.create({organizationId:actor.organizationId,targetType:i.targetType,targetId:i.targetId,objectKey:key,filename,contentType:i.contentType,sizeBytes:body.byteLength,sha256,uploadedBy:actor.userId,clientMutationId});
      await r.audit.record({organizationId:actor.organizationId,actorUserId:actor.userId,action:"attachment.created",entityType:"attachment",entityId:value.id,metadata:{targetType:value.targetType,targetId:value.targetId,filename:value.filename,contentType:value.contentType,sizeBytes:value.sizeBytes}});
      return value;
    });}catch(error){
      try{await this.storage.delete(key);}catch{}
      if(clientMutationId){
        const existing=await this.repository.findByClientMutation(actor.organizationId,actor.userId,clientMutationId);
        if(existing)return existing;
      }
      throw error;
    }
  }
  async createDownloadUrl(actor:RequestActor,id:string,raw:unknown={}){await this.authorizer(actor,"attachment.read");const i=parseInput(downloadAttachmentSchema,raw);const value=await this.getAttachment(actor,id);try{const url=await this.storage.signedDownloadUrl(value.objectKey,i.expiresIn??DOWNLOAD_URL_TTL_SECONDS);await this.unitOfWork.transaction((r)=>r.audit.record({organizationId:actor.organizationId,actorUserId:actor.userId,action:"attachment.download_authorized",entityType:"attachment",entityId:value.id,metadata:{expiresIn:i.expiresIn}}));return{url,expiresIn:i.expiresIn,filename:value.filename};}catch{throw new ConflictError("File storage is temporarily unavailable");}}
  async archiveAttachment(actor:RequestActor,id:string){
    await this.authorizer(actor,"attachment.delete");
    id=parseEntityId(id);
    const value=await this.unitOfWork.transaction(async(r)=>{
      const preliminary=await r.attachments.findByIdIncludingArchived(actor.organizationId,id);
      if(!preliminary)throw new NotFoundError("Attachment not found");
      if(preliminary.targetType==="job"){
        const job=await r.targets.lockJob(actor.organizationId,preliminary.targetId);
        if(!job)throw new NotFoundError("Related Job not found");
        if(job.status==="completed"||job.status==="invoiced")throw new ConflictError("Completed Job evidence cannot be removed");
      }
      const current=await r.attachments.findByIdForUpdate(actor.organizationId,id);
      if(!current)throw new NotFoundError("Attachment not found");
      if(!current.archivedAt){
        await r.attachments.archive(actor.organizationId,id,actor.userId);
        await r.audit.record({organizationId:actor.organizationId,actorUserId:actor.userId,action:"attachment.archived",entityType:"attachment",entityId:id,metadata:{targetType:current.targetType,targetId:current.targetId}});
      }
      return current;
    });
    if(value.storageDeletedAt)return;
    try{await this.storage.delete(value.objectKey);}catch{throw new ConflictError("Attachment was archived but physical deletion must be retried");}
    await this.unitOfWork.transaction(async(r)=>{await r.attachments.markStorageDeleted(actor.organizationId,id);await r.audit.record({organizationId:actor.organizationId,actorUserId:actor.userId,action:"attachment.deleted",entityType:"attachment",entityId:id,metadata:{}});});
  }
}
export type { AttachmentTarget };
