"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ContractService } from "@/modules/contracts";
export async function createContractAction(data: FormData) { const actor = await currentActor(); const contract = await new ContractService().create(actor!, { quoteId: String(data.get("quoteId") ?? ""), title: String(data.get("title") ?? "Service Agreement"), body: String(data.get("body") ?? "") }); revalidatePath("/contracts"); redirect(`/contracts/${contract.id}`); }
export async function addContractSignerAction(id: string, data: FormData) { const actor = await currentActor(); await new ContractService().addSigner(actor!, id, { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), role: String(data.get("role") ?? "customer") }); revalidatePath(`/contracts/${id}`); }
export async function sendContractAction(id: string) { const actor = await currentActor(); const result = await new ContractService().send(actor!, id, {}); revalidatePath(`/contracts/${id}`); redirect(`/contracts/${id}?token=${encodeURIComponent(result.links[0]?.token ?? "")}`); }
export async function reviseContractAction(id: string) { const actor = await currentActor(); await new ContractService().createRevision(actor!, id); revalidatePath(`/contracts/${id}`); }
export async function revokeSigningRequestAction(id: string, requestId: string) { const actor = await currentActor(); await new ContractService().revokeSigningRequest(actor!, id, requestId); revalidatePath(`/contracts/${id}`); }
export async function voidContractAction(id: string, data: FormData) { const actor = await currentActor(); await new ContractService().void(actor!, id, { reason: String(data.get("reason") ?? "") }); revalidatePath(`/contracts/${id}`); }

