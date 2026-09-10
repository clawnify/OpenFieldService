import { z } from "zod";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/lib/r2";

const common = {
  clientMutationId: z.uuid(),
  jobId: z.uuid(),
  localCreatedAt: z.iso.datetime(),
  dependsOn: z.array(z.uuid()).max(8).default([]),
};
const text = (max: number) => z.string().trim().max(max);
const file = {
  filename: z.string().min(1).max(1024),
  contentType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

export const technicianSyncMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, operation: z.literal("save_report"), payload: z.strictObject({
    workPerformed: text(20_000), findings: text(20_000).default(""), notes: text(20_000).default(""),
    materialsUsed: text(20_000).default(""), expectedRowVersion: z.number().int().min(0), baseReportId: z.uuid().nullable(),
  }) }),
  z.strictObject({ ...common, operation: z.literal("submit_report"), payload: z.strictObject({
    expectedRowVersion: z.number().int().min(0),
  }) }),
  z.strictObject({ ...common, operation: z.literal("set_checklist"), payload: z.strictObject({
    itemId: z.uuid(), completed: z.boolean(),
  }) }),
  z.strictObject({ ...common, operation: z.literal("add_note"), payload: z.strictObject({
    body: z.string().trim().min(1).max(20_000),
  }) }),
  z.strictObject({ ...common, operation: z.literal("upload_evidence"), payload: z.strictObject({
    ...file, kind: z.enum(["pre_work_photo", "post_work_photo"]),
  }) }),
  z.strictObject({ ...common, operation: z.literal("capture_signature"), payload: z.strictObject({
    ...file, signerName: z.string().trim().min(1).max(200), signerRelationship: text(200).default(""),
    acknowledged: z.literal(true), expectedReportSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  }) }),
  z.strictObject({ ...common, operation: z.literal("complete_job"), payload: z.strictObject({}) }),
]).superRefine((value, context) => {
  if (new Set(value.dependsOn).size !== value.dependsOn.length) context.addIssue({ code: "custom", message: "Sync dependencies must be unique" });
  if (value.dependsOn.includes(value.clientMutationId)) context.addIssue({ code: "custom", message: "A sync mutation cannot depend on itself" });
});

export type TechnicianSyncMutation = z.infer<typeof technicianSyncMutationSchema>;
