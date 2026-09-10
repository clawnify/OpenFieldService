"use server";
import { redirect } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { RetentionService } from "@/modules/retention";

export type FollowUpActionState={status:string|null;reviewUrl:string|null;planOffer:Array<{id:string;name:string;description:string;tier:string;priceCents:number;currency:string}>|null;error:string|null};
export async function respondFollowUpAction(token:string,_previous:FollowUpActionState,form:FormData):Promise<FollowUpActionState>{try{return{...await new RetentionService().respondPublic(token,{response:String(form.get("response")),notes:String(form.get("notes")??"")}),error:null};}catch(error){if(error instanceof ApplicationError)return{status:null,reviewUrl:null,planOffer:null,error:"This link is invalid, expired, or already unavailable."};throw error;}}
export async function followReviewAction(token:string){try{const result=await new RetentionService().markReviewClicked(token);redirect(result.reviewUrl);}catch(error){if(error instanceof ApplicationError)redirect(`/follow-up/${encodeURIComponent(token)}?review=unavailable`);throw error;}}
