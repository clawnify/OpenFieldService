"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";

export async function placeCallAction(data: FormData) { const actor = await currentActor(); if (!actor) redirect("/login"); await new PhoneOperationsService().placeOutboundCall(actor, { phoneNumberId: String(data.get("phoneNumberId") ?? ""), destination: String(data.get("destination") ?? ""), customerId: String(data.get("customerId") ?? "") || undefined, idempotencyKey: crypto.randomUUID() }); revalidatePath("/phone"); }
export async function updateCallAction(id: string, data: FormData) { const actor = await currentActor(); if (!actor) redirect("/login"); const subject = String(data.get("subject") ?? ""), subjectId = String(data.get("subjectId") ?? ""); await new PhoneOperationsService().updateCall(actor, id, { disposition: String(data.get("disposition") ?? ""), notes: String(data.get("notes") ?? ""), customerId: subject === "customer" ? subjectId : subject === "none" ? null : undefined, leadId: subject === "lead" ? subjectId : subject === "none" ? null : undefined }); revalidatePath(`/phone/${id}`); }
