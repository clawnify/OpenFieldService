import { z } from "zod";

const uuid = z.string().uuid();
export const contractSignerRoles = [
  "customer",
  "co_owner",
  "company_rep",
  "guarantor",
  "other",
] as const;
export const signatureMethods = ["typed", "click_to_sign", "drawn"] as const;
export const createContractSchema = z
  .object({
    quoteId: uuid,
    title: z.string().trim().min(1).max(200).default("Service Agreement"),
    body: z.string().trim().max(100_000).default(""),
    effectiveOn: z.string().date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();
export const updateContractVersionSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().max(100_000).optional(),
    effectiveOn: z.string().date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    expectedRowVersion: z.number().int().nonnegative(),
  })
  .strict();
export const addSignerSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().max(40).nullable().optional(),
    role: z.enum(contractSignerRoles).default("customer"),
  })
  .strict();
export const sendContractSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(90).default(30),
    consentTextVersion: z.string().trim().min(1).max(50).default("v1"),
  })
  .strict();
export const publicContractTokenSchema = z.string().min(40).max(200);
export const consentSchema = z
  .object({ consentTextVersion: z.string().trim().min(1).max(50) })
  .strict();
export const signContractSchema = z
  .object({
    signerName: z.string().trim().min(1).max(160),
    method: z.enum(signatureMethods),
    signatureImageDataUrl: z.string().max(2_900_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === "drawn" && !value.signatureImageDataUrl)
      ctx.addIssue({
        code: "custom",
        path: ["signatureImageDataUrl"],
        message: "A drawn signature image is required",
      });
    if (value.method !== "drawn" && value.signatureImageDataUrl)
      ctx.addIssue({
        code: "custom",
        path: ["signatureImageDataUrl"],
        message: "Signature image is only valid for drawn signatures",
      });
  });
export const declineContractSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const voidContractSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const contractFilterSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    status: z
      .enum([
        "draft",
        "sent",
        "partially_signed",
        "signed",
        "declined",
        "expired",
        "cancelled",
        "voided",
      ])
      .optional(),
    customerId: uuid.optional(),
    quoteId: uuid.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
