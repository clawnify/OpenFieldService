"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { CampaignService, RetentionAutomationService, RetentionService } from "@/modules/retention";
const actor=async()=>{const value=await currentActor();if(!value)redirect("/login");return value;};
export async function saveReferralProgramAction(form:FormData){await new RetentionService().saveProgram(await actor(),{enabled:form.get("enabled")==="on",rewardType:String(form.get("rewardType")),rewardValueCents:form.get("rewardValueCents")?Number(form.get("rewardValueCents")):null,rewardDescription:String(form.get("rewardDescription")??""),qualificationRule:String(form.get("qualificationRule"))});revalidatePath("/retention");}
export async function createCampaignAction(form:FormData){await new CampaignService().create(await actor(),{name:String(form.get("name")),campaignType:String(form.get("campaignType")??"seasonal"),channel:String(form.get("channel")),subject:String(form.get("subject")??""),body:String(form.get("body")??""),ctaLink:String(form.get("ctaLink")??""),audienceFilter:{city:String(form.get("city")??"")||undefined,membership:String(form.get("membership")??"any")}});revalidatePath("/retention");}
export async function scheduleCampaignAction(id:string,form:FormData){await new CampaignService().schedule(await actor(),id,{scheduledFor:String(form.get("scheduledFor"))});revalidatePath("/retention");}
export async function runRetentionAction(){await new RetentionAutomationService().runManual(await actor());revalidatePath("/retention");}
export async function saveMarketingPreferenceAction(form:FormData){await new RetentionService().savePreferences(await actor(),String(form.get("customerId")),{marketingEmailOptIn:form.get("email")==="on",marketingSmsOptIn:form.get("sms")==="on",consentSource:form.get("consentSource")||undefined,doNotContact:form.get("doNotContact")==="on"});revalidatePath("/retention");}
export async function issueLoyaltyAction(form:FormData){await new RetentionService().issueCredit(await actor(),String(form.get("customerId")),{amountCents:Number(form.get("amountCents")),reason:String(form.get("reason"))});revalidatePath("/retention");}
export async function mintReferralAction(form:FormData){await new RetentionService().mintReferral(await actor(),String(form.get("customerId")));revalidatePath("/retention");}
