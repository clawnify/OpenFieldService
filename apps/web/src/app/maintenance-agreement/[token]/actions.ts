"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { MaintenanceService } from "@/modules/maintenance";
export async function signMaintenanceAgreementAction(token: string, data: FormData) { const values = await headers(); try { await new MaintenanceService().signPublic(token, { signerName: String(data.get("signerName") ?? ""), signatureMethod: "typed", consentTextVersion: String(data.get("consentTextVersion") ?? "maintenance-consent-v1"), autoRenewEnabled: data.get("autoRenewEnabled") === "on" }, { ip: values.get("x-forwarded-for")?.split(",")[0]?.trim(), userAgent: values.get("user-agent") ?? undefined }); } catch (error) { if (error instanceof ApplicationError) redirect(`/maintenance-agreement/${encodeURIComponent(token)}?error=1`); throw error; } redirect(`/maintenance-agreement/${token}?signed=1`); }
