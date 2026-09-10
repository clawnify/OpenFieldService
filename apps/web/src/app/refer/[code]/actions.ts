"use server";
import { redirect } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { RetentionService } from "@/modules/retention";
export async function claimReferralAction(code:string,form:FormData){try{await new RetentionService().claimReferral(code,{name:String(form.get("name")),email:String(form.get("email")??"")||undefined,phone:String(form.get("phone")??"")||undefined});}catch(error){if(error instanceof ApplicationError)redirect(`/refer/${encodeURIComponent(code)}?error=1`);throw error;}redirect(`/refer/${code}?claimed=1`);}
