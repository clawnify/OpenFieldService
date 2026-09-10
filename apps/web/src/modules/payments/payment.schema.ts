import { z } from "zod";

const method = z.enum(["cash", "check", "credit_card", "debit_card", "e_transfer", "bank_transfer", "financing", "other"]);
const payerType = z.enum(["customer", "government", "third_party"]);
const source = z.enum(["manual", "online_provider"]);

export const postPaymentSchema = z.object({
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  payerType,
  method,
  source: source.default("manual"),
  externalReference: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  receivedBy: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(2_000).default(""),
  postedAt: z.coerce.date().optional(),
}).strict();

export const reversePaymentSchema = z.object({ reason: z.string().trim().min(1).max(1_000) }).strict();
export const paymentFilterSchema = z.object({
  invoiceId: z.uuid().optional(), customerId: z.uuid().optional(), method: method.optional(), source: source.optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), search: z.string().trim().max(100).optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, { message: "Date range is invalid", path: ["to"] });

export type PostPaymentInput = z.infer<typeof postPaymentSchema>;
