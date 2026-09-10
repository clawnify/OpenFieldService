import { z } from "zod";

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().or(z.literal(""));

export const createCompanySchema = z.strictObject({
  name: z.string().trim().min(1).max(200), legalName: optionalText(255), email: z.email().max(255).optional().or(z.literal("")), phone: optionalText(80),
  website: z.url().max(500).optional().or(z.literal("")), addressLine1: optionalText(255), addressLine2: optionalText(255), city: optionalText(120), region: optionalText(120), postalCode: optionalText(24), notes: optionalText(10_000),
});
export const updateCompanySchema = createCompanySchema.partial();
export const companyFilterSchema = z.strictObject({ query: z.string().trim().max(200).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type CompanyFilter = z.infer<typeof companyFilterSchema>;
