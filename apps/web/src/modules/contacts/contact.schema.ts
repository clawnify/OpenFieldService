import { z } from "zod";

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().or(z.literal(""));
export const createContactSchema = z.strictObject({
  customerId: z.uuid().nullable().optional(), companyId: z.uuid().nullable().optional(),
  firstName: z.string().trim().min(1).max(120), lastName: z.string().trim().min(1).max(120),
  email: z.email().max(255).optional().or(z.literal("")), phone: optionalText(80), title: optionalText(160), isPrimary: z.boolean().default(false),
}).refine((value) => Boolean(value.customerId || value.companyId), { message: "A contact must belong to a customer, a company, or both", path: ["customerId"] });
export const updateContactSchema = z.strictObject({
  customerId: z.uuid().nullable().optional(), companyId: z.uuid().nullable().optional(), firstName: z.string().trim().min(1).max(120).optional(), lastName: z.string().trim().min(1).max(120).optional(),
  email: z.email().max(255).optional().or(z.literal("")), phone: optionalText(80), title: optionalText(160), isPrimary: z.boolean().optional(),
});
export const contactFilterSchema = z.strictObject({ customerId: z.uuid().optional(), companyId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });
export type CreateContactInput = z.input<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ContactFilter = z.infer<typeof contactFilterSchema>;
