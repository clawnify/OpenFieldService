"use server";
import { redirect } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { RetentionService } from "@/modules/retention";

export async function unsubscribeAction(token:string){try{await new RetentionService().unsubscribePublic(token);redirect(`/unsubscribe/${encodeURIComponent(token)}?done=1`);}catch(error){if(error instanceof ApplicationError)redirect(`/unsubscribe/${encodeURIComponent(token)}?error=1`);throw error;}}
