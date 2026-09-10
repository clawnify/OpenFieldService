"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/auth/current-actor";
import { ActivityService } from "@/modules/interactions/activity.service";
import { NoteService } from "@/modules/interactions/note.service";
export async function addDealNoteAction(dealId: string, formData: FormData): Promise<void> { const actor=await currentActor(); await new NoteService().createNote(actor!,{body:String(formData.get("body")??""),targetType:"deal",targetId:dealId}); revalidatePath(`/deals/${dealId}`); }
export async function addDealActivityAction(dealId: string, formData: FormData): Promise<void> { const actor=await currentActor(); await new ActivityService().createActivity(actor!,{type:String(formData.get("type")??"other") as "call"|"email"|"meeting"|"visit"|"other",subject:String(formData.get("subject")??""),details:String(formData.get("details")??""),occurredAt:new Date().toISOString(),targetType:"deal",targetId:dealId}); revalidatePath(`/deals/${dealId}`); }
