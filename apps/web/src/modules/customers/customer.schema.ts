import { z } from "zod";

const optionalContact = z.string().trim().max(255).optional().or(z.literal(""));
const optionalUuid = z.uuid().nullable().optional();

export const createCustomerSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  companyId: optionalUuid,
  email: z.email().max(255).optional().or(z.literal("")),
  phone: optionalContact,
  addressLine1: z.string().trim().max(255).optional().or(z.literal("")),
  addressLine2: z.string().trim().max(255).optional().or(z.literal("")),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  region: z.string().trim().max(120).optional().or(z.literal("")),
  postalCode: z.string().trim().max(24).optional().or(z.literal("")),
  notes: z.string().trim().max(10_000).optional().or(z.literal("")),
});

export const updateCustomerSchema = createCustomerSchema.partial();
export const customerFilterSchema = z.strictObject({
  query: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerFilter = z.infer<typeof customerFilterSchema>;
