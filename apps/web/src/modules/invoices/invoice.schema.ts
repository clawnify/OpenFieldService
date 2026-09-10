import { z } from "zod";

const id = z.uuid();
const line = z.object({ pricebookItemId: id.optional(), description: z.string().trim().min(1).max(500), category: z.string().trim().min(1).max(80).default("other"), unit: z.string().trim().min(1).max(40).default("each"), quantityMilli: z.int().min(1).max(100_000_000).default(1000), unitPriceCents: z.int().min(0).max(9_000_000_000), taxable: z.boolean().default(true) }).strict();
const terms = z.enum(["due_on_receipt", "net_15", "net_30", "net_60", "custom"]);
const common = { paymentTerms: terms.default("due_on_receipt"), dueDate: z.iso.date().optional(), notes: z.string().max(10_000).default(""), terms: z.string().max(20_000).default("") };
export const createInvoiceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("manual"), customerId: id, lines: z.array(line).min(1).max(200), ...common }).strict(),
  z.object({ source: z.literal("job"), jobId: id, lines: z.array(line).min(1).max(200), ...common }).strict(),
  z.object({ source: z.literal("contract"), contractId: id, ...common }).strict(),
]);
export const updateInvoiceSchema = z.object({ expectedRowVersion: z.int().min(0), notes: z.string().max(10_000).optional(), terms: z.string().max(20_000).optional(), paymentTerms: terms.optional(), dueDate: z.iso.date().nullable().optional() }).strict();
export const invoiceLineSchema = line.extend({ expectedRowVersion: z.int().min(0) }).strict();
export const reorderInvoiceLinesSchema = z.object({ expectedRowVersion: z.int().min(0), lineIds: z.array(id).min(1).max(200).refine(v => new Set(v).size === v.length, "Line IDs must be unique") }).strict();
export const invoiceFilterSchema = z.object({ search: z.string().trim().max(100).optional(), status: z.enum(["draft", "issued", "partially_paid", "paid", "void"]).optional(), customerId: id.optional(), contractId: id.optional(), jobId: id.optional(), dueBefore: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
