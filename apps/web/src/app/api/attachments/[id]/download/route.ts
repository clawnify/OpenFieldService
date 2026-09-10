import { NextResponse } from "next/server";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { AttachmentService } from "@/modules/attachments/attachment.service";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{const actor=await currentActor();const{id}=await params;const result=await new AttachmentService().createDownloadUrl(actor!,id,{expiresIn:300});return NextResponse.redirect(result.url,307);}catch(error){if(error instanceof ApplicationError)return NextResponse.json({error:error.message},{status:error.code==="NOT_FOUND"?404:error.code==="FORBIDDEN"?403:error.code==="UNAUTHORIZED"?401:409});throw error;}}
