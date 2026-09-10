"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { RetentionService } from "@/modules/retention";

export async function saveRetentionSettingsAction(form:FormData){const actor=await currentActor();if(!actor)redirect("/login");await new RetentionService().saveSettings(actor,{followUpDelayDays:Number(form.get("followUpDelayDays")),publicBaseUrl:String(form.get("publicBaseUrl")??""),reviewUrl:String(form.get("reviewUrl")??"")});revalidatePath("/settings/retention");}
