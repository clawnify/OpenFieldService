import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ConflictError, ValidationError } from "@/lib/errors";

export const PHONE_TOOLS = ["find_customer_by_phone", "get_customer_service_context", "get_job_status", "get_available_slots", "create_lead_from_call", "create_follow_up", "create_appointment_for_customer"] as const;
export type PhoneToolName = typeof PHONE_TOOLS[number];
export const TERMINAL_CALL_STATUSES = new Set(["completed", "failed", "no_answer", "busy", "canceled"]);
const transitions: Record<string, string[]> = { queued: ["ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"], ringing: ["in_progress", "completed", "failed", "no_answer", "busy", "canceled"], in_progress: ["completed", "failed", "no_answer", "busy", "canceled"] };

export function normalizePhone(value: string) { const digits = value.replace(/\D/g, ""); const canonical = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits; if (canonical.length < 7 || canonical.length > 15) throw new ValidationError("Invalid phone number"); return canonical; }
export function toE164(value: string) { const digits = value.replace(/\D/g, ""); if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) throw new ValidationError("Phone number must be E.164"); return `+${digits}`; }
export function assertCallTransition(from: string, to: string) { if (from === to) return; if (!transitions[from]?.includes(to)) throw new ConflictError(`Cannot transition call from ${from} to ${to}`); }
export function mapTwilioCallStatus(value: string) { const mapped: Record<string, "queued"|"ringing"|"in_progress"|"completed"|"failed"|"no_answer"|"busy"|"canceled"> = { queued: "queued", initiated: "queued", ringing: "ringing", "in-progress": "in_progress", answered: "in_progress", completed: "completed", failed: "failed", "no-answer": "no_answer", busy: "busy", canceled: "canceled" }; const result = mapped[value.toLowerCase()]; if (!result) throw new ValidationError("Unknown provider call status"); return result; }
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string) { const data = url + Object.keys(params).sort().map(k => `${k}${params[k]}`).join(""); const expected = createHmac("sha1", authToken).update(data).digest("base64"); const a = Buffer.from(expected), b = Buffer.from(signature); return a.length === b.length && timingSafeEqual(a, b); }
export function hashPhonePayload(value: unknown) { const source = value && typeof value === "object" ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : value; return createHash("sha256").update(JSON.stringify(source)).digest("hex"); }
