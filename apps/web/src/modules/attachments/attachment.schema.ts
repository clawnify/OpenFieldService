import { z } from "zod";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/lib/r2";
export const attachmentTargetTypeSchema = z.enum(["customer", "contact", "company", "lead", "deal", "note", "job"]);
export const attachmentTargetSchema = z.strictObject({ targetType: attachmentTargetTypeSchema, targetId: z.uuid() });
export const uploadAttachmentSchema = attachmentTargetSchema.extend({ filename: z.string().min(1).max(1024), contentType: z.enum(ALLOWED_MIME_TYPES), sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES) });
export const attachmentListSchema = attachmentTargetSchema.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) });
export const downloadAttachmentSchema = z.strictObject({ expiresIn: z.number().int().min(30).max(900).default(300) });
export type AttachmentTarget = z.infer<typeof attachmentTargetSchema>; export type UploadAttachmentInput = z.input<typeof uploadAttachmentSchema>;
