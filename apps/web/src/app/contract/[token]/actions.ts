"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { ContractService } from "@/modules/contracts";
const metadata = async () => { const values = await headers(); return { ip: values.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: values.get("user-agent") }; };
export async function signContractAction(token: string, data: FormData) { const service = new ContractService(), meta = await metadata(); try { await service.consent(token, { consentTextVersion: String(data.get("consentTextVersion") ?? "") }, meta); await service.sign(token, { signerName: String(data.get("signerName") ?? ""), method: String(data.get("method") ?? "typed") }, meta); } catch (error) { if (error instanceof ApplicationError) redirect(`/contract/${encodeURIComponent(token)}?error=1`); throw error; } redirect(`/contract/${token}?signed=1`); }
export async function declineContractAction(token: string, data: FormData) { try { await new ContractService().decline(token, { reason: String(data.get("reason") ?? "") }, await metadata()); } catch (error) { if (error instanceof ApplicationError) redirect(`/contract/${encodeURIComponent(token)}?error=1`); throw error; } redirect(`/contract/${token}?declined=1`); }

