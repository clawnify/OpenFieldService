"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { LeadService } from "@/modules/leads/lead.service";

export interface LeadActionState { error?: string; issues?: ReadonlyArray<{ path: string; message: string }> }
function failure(error: unknown): LeadActionState { if (error instanceof ApplicationError) return { error: error.message, issues: "issues" in error ? error.issues as LeadActionState["issues"] : undefined }; throw error; }

export async function createLeadAction(_state: LeadActionState, formData: FormData): Promise<LeadActionState> {
  try { const actor = await currentActor(); const lead = await new LeadService().createLead(actor!, { name: String(formData.get("name") ?? ""), email: String(formData.get("email") ?? ""), phone: String(formData.get("phone") ?? ""), source: String(formData.get("source") ?? ""), notes: String(formData.get("notes") ?? "") }); revalidatePath("/leads"); redirect(`/leads/${lead.id}`); } catch (error) { return failure(error); }
}
export async function changeLeadStatusAction(id: string, _state: LeadActionState, formData: FormData): Promise<LeadActionState> {
  try { const actor = await currentActor(); const status = String(formData.get("status") ?? "new") as "new" | "contacted" | "qualified" | "estimate" | "won" | "lost"; const lostReason = (String(formData.get("lostReason") ?? "") || undefined) as "Price Too High" | "Chose Competitor" | "Not Ready" | "Unreachable" | "Outside Service Area" | "Not Eligible" | "Duplicate Lead" | "No Longer Needed" | "Other" | undefined; await new LeadService().changeStatus(actor!, id, { status, lostReason }); revalidatePath(`/leads/${id}`); return {}; } catch (error) { return failure(error); }
}
export async function convertLeadAction(id: string): Promise<void> { const actor = await currentActor(); await new LeadService().convertLead(actor!, id); revalidatePath(`/leads/${id}`); revalidatePath("/customers"); }
