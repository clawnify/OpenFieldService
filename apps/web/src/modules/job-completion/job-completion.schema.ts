import { z } from "zod";

const boundedText = (max: number) => z.string().trim().max(max);

export const addJobEvidenceSchema = z.strictObject({
  attachmentId: z.uuid(),
  kind: z.enum(["pre_work_photo", "post_work_photo"]),
});

export const saveJobReportSchema = z.strictObject({
  workPerformed: boundedText(20_000),
  findings: boundedText(20_000).default(""),
  notes: boundedText(20_000).default(""),
  materialsUsed: boundedText(20_000).default(""),
  expectedRowVersion: z.number().int().min(0),
});

export const submitJobReportSchema = z.strictObject({
  expectedRowVersion: z.number().int().min(0),
});

export const captureJobSignatureSchema = z.strictObject({
  attachmentId: z.uuid(),
  signerName: z.string().trim().min(1).max(200),
  signerRelationship: boundedText(200).default(""),
  acknowledged: z.literal(true),
});

export type JobEvidenceInput = z.input<typeof addJobEvidenceSchema>;
export type SaveJobReportInput = z.input<typeof saveJobReportSchema>;
export type CaptureJobSignatureInput = z.input<typeof captureJobSignatureSchema>;
