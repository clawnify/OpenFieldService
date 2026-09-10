import { ConflictError, ValidationError } from "@/lib/errors";
import { createHash, randomBytes } from "node:crypto";

export type CampaignState = "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled" | "failed";
const transitions: Record<CampaignState, CampaignState[]> = { draft: ["scheduled", "cancelled"], scheduled: ["running", "paused", "cancelled"], running: ["completed", "failed"], paused: ["scheduled", "cancelled"], completed: [], cancelled: [], failed: [] };
export function assertCampaignTransition(from: CampaignState, to: CampaignState) { if (!transitions[from].includes(to)) throw new ConflictError(`Cannot transition campaign from ${from} to ${to}`); }
export function channels(channel: "email" | "sms" | "both") { return channel === "both" ? (["email", "sms"] as const) : [channel]; }
export function normalizePhone(value: string | null | undefined) { return value?.replace(/\D/g, "") ?? ""; }
export function assertNotSelfReferral(referrer: { email: string | null; phone: string | null }, referred: { email?: string; phone?: string }) { const email = referred.email?.trim().toLowerCase(); const phone = normalizePhone(referred.phone); if ((email && email === referrer.email?.trim().toLowerCase()) || (phone && phone === normalizePhone(referrer.phone))) throw new ValidationError("A customer cannot refer themselves", [{ path: "contact", message: "Referral contact must differ from the referrer" }]); }
export function creditBalance(rows: Array<{ amountCents: number | null; status: string }>) { return rows.reduce((total, row) => total + (row.status === "issued" ? row.amountCents ?? 0 : 0), 0); }
export function retentionState(lastCompletedAt: Date | null, completedCount: number, activeMembership: boolean, now = new Date()) { const daysSinceLastJob = lastCompletedAt ? Math.max(0, Math.floor((now.getTime() - lastCompletedAt.getTime()) / 86_400_000)) : null; return { daysSinceLastJob, repeatCustomer: completedCount > 1, activeMembership, atRisk: daysSinceLastJob !== null && daysSinceLastJob >= 365 && daysSinceLastJob < 730, inactive: daysSinceLastJob === null || daysSinceLastJob >= 730, winBackEligible: daysSinceLastJob !== null && daysSinceLastJob >= 365 && !activeMembership }; }
export function createRetentionCapability(){return randomBytes(32).toString("base64url");}
export function hashRetentionCapability(value:string){return createHash("sha256").update(value).digest("hex");}
export function vancouverDate(value=new Date()){return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Vancouver",year:"numeric",month:"2-digit",day:"2-digit"}).format(value);}
export function addBusinessDays(date:Date,days:number){return vancouverDate(new Date(date.getTime()+days*86_400_000));}
