"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/auth/current-actor";
import { ValidationError } from "@/lib/errors";
import { AttachmentService } from "@/modules/attachments/attachment.service";
type AllowedType="image/jpeg"|"image/png"|"image/webp"|"image/heic"|"image/heif"|"image/gif"|"application/pdf";
export async function uploadDealAttachmentAction(dealId:string,formData:FormData):Promise<void>{const actor=await currentActor();const file=formData.get("file");if(!(file instanceof File))throw new ValidationError("File is required");const bytes=new Uint8Array(await file.arrayBuffer());await new AttachmentService().uploadAttachment(actor!,{targetType:"deal",targetId:dealId,filename:file.name,contentType:file.type as AllowedType,sizeBytes:bytes.byteLength},bytes);revalidatePath(`/deals/${dealId}`);}
export async function archiveDealAttachmentAction(dealId:string,attachmentId:string):Promise<void>{const actor=await currentActor();await new AttachmentService().archiveAttachment(actor!,attachmentId);revalidatePath(`/deals/${dealId}`);}
