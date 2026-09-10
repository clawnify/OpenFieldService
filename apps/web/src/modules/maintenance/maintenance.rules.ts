import { createHash, randomBytes } from "node:crypto";
import { ConflictError, ValidationError } from "@/lib/errors";

export type Recurrence="annual"|"semi_annual"|"quarterly"|"custom_days";
const DAY=86_400_000;
export const REMINDER_MILESTONES=[60,30,14] as const;
export const createCapability=()=>randomBytes(32).toString("base64url");
export const hashCapability=(value:string)=>createHash("sha256").update(value).digest("hex");
export const snapshotHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function addDays(date:string,days:number){const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
export function daysBetween(from:string,to:string){return Math.round((Date.parse(`${to}T12:00:00Z`)-Date.parse(`${from}T12:00:00Z`))/DAY)}
export function advanceDueDate(date:string,recurrence:Recurrence,custom?:number|null){if(recurrence==="custom_days")return addDays(date,custom??365);const months=recurrence==="annual"?12:recurrence==="semi_annual"?6:3;const [year,month,day]=date.split("-").map(Number);const last=new Date(Date.UTC(year!,month!-1+months+1,0)).getUTCDate();return new Date(Date.UTC(year!,month!-1+months,Math.min(day!,last))).toISOString().slice(0,10)}
export function renewalTerm(effectiveDate:string,expiresOn:string){const days=Math.max(1,daysBetween(effectiveDate,expiresOn));return{effectiveDate:expiresOn,expiresOn:addDays(expiresOn,days)}}
export function dueState(next:string,today:string):"not_due"|"upcoming"|"due"|"overdue"{const days=daysBetween(today,next);return days<0?"overdue":days===0?"due":days<=30?"upcoming":"not_due"}
export function agreementTransition(from:string,to:string){const allowed:Record<string,string[]>={draft:["sent","cancelled"],sent:["viewed","active","cancelled"],viewed:["active","cancelled"],active:["cancelled","expired","superseded"]};if(!allowed[from]?.includes(to))throw new ConflictError(`Invalid Maintenance Agreement transition: ${from} to ${to}`)}
export function planMaterialChanges(snapshot:Record<string,unknown>,plan:{status:string;priceCents:number;discountType:string;discountBasisPoints:number|null;discountFixedCents:number|null;visitEntitlementCount:number|null}){const reasons:string[]=[];if(plan.status!=="active")reasons.push("plan_unavailable");if(snapshot.priceCents!==plan.priceCents)reasons.push("price_changed");if(snapshot.discountType!==plan.discountType||snapshot.discountBasisPoints!==plan.discountBasisPoints||snapshot.discountFixedCents!==plan.discountFixedCents)reasons.push("discount_terms_changed");if(snapshot.visitEntitlementCount!==plan.visitEntitlementCount)reasons.push("visit_entitlement_changed");return reasons}
export function assertEntitlement(included:number|null,effective:number){if(included!==null&&effective<=0)throw new ConflictError("No remaining maintenance visit entitlement")}
export function validateTerm(start:string,end:string){if(end<start)throw new ValidationError("Agreement expiry cannot precede its effective date")}
