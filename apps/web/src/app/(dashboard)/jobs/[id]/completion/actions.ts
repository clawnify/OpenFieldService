"use server";

import { revalidatePath } from "next/cache";
import { currentActor } from "@/auth/current-actor";
import { ValidationError } from "@/lib/errors";
import { AttachmentService } from "@/modules/attachments/attachment.service";
import { JobCompletionService } from "@/modules/job-completion/job-completion.service";

type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif" | "image/gif";

function path(jobId: string) {
  revalidatePath("/jobs/" + jobId);
  revalidatePath("/jobs/" + jobId + "/completion");
}

async function uploadJobImage(jobId: string, data: FormData) {
  const actor = await currentActor();
  if (!actor) throw new ValidationError("Authentication required");
  const file = data.get("file");
  if (!(file instanceof File) || !file.type.startsWith("image/")) throw new ValidationError("An image file is required");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const attachment = await new AttachmentService().uploadAttachment(actor, {
    targetType: "job",
    targetId: jobId,
    filename: file.name,
    contentType: file.type as ImageType,
    sizeBytes: bytes.byteLength,
  }, bytes);
  return { actor, attachment };
}

export async function uploadCompletionEvidenceAction(jobId: string, kind: "pre_work_photo" | "post_work_photo", data: FormData) {
  const { actor, attachment } = await uploadJobImage(jobId, data);
  await new JobCompletionService().addEvidence(actor, jobId, { attachmentId: attachment.id, kind });
  path(jobId);
}

export async function saveJobReportAction(jobId: string, data: FormData) {
  const actor = await currentActor();
  await new JobCompletionService().saveReport(actor!, jobId, {
    workPerformed: String(data.get("workPerformed") ?? ""),
    findings: String(data.get("findings") ?? ""),
    notes: String(data.get("notes") ?? ""),
    materialsUsed: String(data.get("materialsUsed") ?? ""),
    expectedRowVersion: Number(data.get("expectedRowVersion") ?? 0),
  });
  path(jobId);
}

export async function submitJobReportAction(jobId: string, expectedRowVersion: number) {
  const actor = await currentActor();
  await new JobCompletionService().submitReport(actor!, jobId, { expectedRowVersion });
  path(jobId);
}

export async function captureJobCustomerSignatureAction(jobId: string, data: FormData) {
  const { actor, attachment } = await uploadJobImage(jobId, data);
  await new JobCompletionService().captureCustomerSignature(actor, jobId, {
    attachmentId: attachment.id,
    signerName: String(data.get("signerName") ?? ""),
    signerRelationship: String(data.get("signerRelationship") ?? ""),
    acknowledged: data.get("acknowledged") === "yes",
  });
  path(jobId);
}

export async function completeCompliantJobAction(jobId: string) {
  const actor = await currentActor();
  await new JobCompletionService().completeJob(actor!, jobId);
  path(jobId);
}
