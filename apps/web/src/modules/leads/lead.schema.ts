import { z } from "zod";
import { leadStatuses, legacyLostReasons } from "./lead.workflow";

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const optionalUuid = z.uuid().nullable().optional();

export const createLeadSchema = z.strictObject({
  name: z.string().trim().min(1).max(200), email: z.email().max(255).optional().or(z.literal("")), phone: optionalText(255),
  addressLine1: optionalText(255), addressLine2: optionalText(255), city: optionalText(120), region: optionalText(120), postalCode: optionalText(24),
  source: optionalText(120), notes: optionalText(10_000), assignedUserId: optionalUuid,
  estimatedValueCents: z.number().int().nonnegative().nullable().optional(), estimateNotes: optionalText(5_000),
});
export const updateLeadSchema = createLeadSchema.omit({ assignedUserId: true }).partial();
export const leadFilterSchema = z.strictObject({
  query: z.string().trim().max(200).optional(), status: z.enum(leadStatuses).optional(), source: z.string().trim().max(120).optional(), assignedUserId: z.uuid().nullable().optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const assignLeadSchema = z.strictObject({ assignedUserId: z.uuid().nullable() });
export const changeLeadStatusSchema = z.strictObject({ status: z.enum(leadStatuses), lostReason: z.enum(legacyLostReasons).optional(), lostReasonNote: optionalText(2_000) });
export const convertLeadSchema = z.strictObject({});
export type CreateLeadInput = z.input<typeof createLeadSchema>;
export type UpdateLeadInput = z.input<typeof updateLeadSchema>;
export type LeadFilter = z.input<typeof leadFilterSchema>;
export type AssignLeadInput = z.input<typeof assignLeadSchema>;
export type ChangeLeadStatusInput = z.input<typeof changeLeadStatusSchema>;
