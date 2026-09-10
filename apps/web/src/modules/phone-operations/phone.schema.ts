import { z } from "zod";
import { PHONE_TOOLS, type PhoneToolName } from "./phone.rules";

const e164 = z.string().trim().regex(/^\+[1-9]\d{7,14}$/);
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
export const settingsSchema = z.strictObject({ operatingMode: z.enum(["active", "paused", "maintenance", "disabled", "emergency_stop"]), inboundEnabled: z.boolean(), outboundEnabled: z.boolean(), maxConcurrentCalls: z.number().int().min(1).max(100), dailyCallCap: z.number().int().min(1).max(10000), voiceRuntimeUrl: z.url().max(2000).optional().or(z.literal("")) });
export const providerCredentialSchema = z.strictObject({ accountSid: z.string().trim().regex(/^AC[a-zA-Z0-9]{32}$/), authToken: z.string().min(16).max(256) });
export const runtimeCredentialSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
export const voiceAgentSchema = z.strictObject({ logicalName: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(20000), voice: z.string().trim().min(1).max(100), isDefault: z.boolean().default(false), toolPolicy: z.array(z.enum(PHONE_TOOLS)).max(PHONE_TOOLS.length).default([]) });
export const phoneNumberSchema = z.strictObject({ providerNumberId: z.string().trim().min(1).max(255), e164, label: optionalText(100), inboundEnabled: z.boolean().default(true), outboundEnabled: z.boolean().default(true), voiceAgentId: z.uuid().nullable().optional() });
export const callFilterSchema = z.strictObject({ query: z.string().trim().max(100).optional(), status: z.enum(["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"]).optional(), direction: z.enum(["inbound", "outbound"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
export const outboundCallSchema = z.strictObject({ phoneNumberId: z.uuid(), destination: e164, idempotencyKey: z.uuid(), customerId: z.uuid().optional() });
export const inboundCallSchema = z.strictObject({ providerCallId: z.string().trim().min(1).max(255), to: e164, from: e164 });
export const providerEventSchema = z.strictObject({ providerEventId: z.string().trim().min(1).max(255), providerCallId: z.string().trim().min(1).max(255), status: z.string().trim().min(1).max(50), occurredAt: z.iso.datetime({ offset: true }) });
export const updateCallSchema = z.strictObject({ assignedUserId: z.uuid().nullable().optional(), disposition: optionalText(100), notes: optionalText(5000), customerId: z.uuid().nullable().optional(), leadId: z.uuid().nullable().optional() }).refine(v => !(v.customerId && v.leadId), { message: "A call cannot link to both a Customer and Lead" });
export const transcriptSchema = z.strictObject({ sequence: z.number().int().min(0), speaker: z.enum(["customer", "agent", "system"]), content: z.string().trim().min(1).max(20000), occurredAt: z.iso.datetime({ offset: true }) });
export const outcomeSchema = z.strictObject({ summary: z.string().trim().min(1).max(5000), disposition: z.string().trim().min(1).max(100) });
export const toolInvocationSchema = z.strictObject({ idempotencyKey: z.uuid(), toolName: z.enum(PHONE_TOOLS), arguments: z.record(z.string(), z.unknown()) });
const toolArgumentSchemas: Record<PhoneToolName, z.ZodType<Record<string, unknown>>> = {
  find_customer_by_phone: z.strictObject({ phone: z.string().trim().min(7).max(30).optional() }),
  get_customer_service_context: z.strictObject({}),
  get_job_status: z.strictObject({ jobId: z.uuid() }),
  get_available_slots: z.strictObject({ technicianUserId: z.uuid(), date: z.iso.date(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), durationMinutes: z.number().int().min(1).max(1440).default(60) }),
  create_lead_from_call: z.strictObject({ name: z.string().trim().min(1).max(200), phone: z.string().trim().min(7).max(30).optional(), notes: optionalText(2000) }),
  create_follow_up: z.strictObject({ title: z.string().trim().min(1).max(200), description: optionalText(2000), dueAt: z.iso.datetime({ offset: true }).nullable().optional() }),
  create_appointment_for_customer: z.strictObject({ title: z.string().trim().min(1).max(200), description: optionalText(2000), serviceAddress: z.string().trim().min(1).max(500), scheduledDate: z.iso.date().nullable().optional(), scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), durationMinutes: z.number().int().min(1).max(1440).default(60) }),
};
export function parseToolArguments(tool: PhoneToolName, value: unknown) { return toolArgumentSchemas[tool].parse(value); }
