import "server-only";
import { createHash } from "node:crypto";
import { authorize } from "@/auth/authorization";
import { getDb } from "@/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { AttachmentService } from "@/modules/attachments/attachment.service";
import type { RequestActor } from "@/modules/customers/customer.service";
import { JobCompletionRepository } from "@/modules/job-completion/job-completion.repository";
import { JobCompletionService } from "@/modules/job-completion/job-completion.service";
import { JobService } from "@/modules/jobs/job.service";
import { technicianSyncMutationSchema, type TechnicianSyncMutation } from "./technician-sync.schema";
import { technicianSyncPayloadHash } from "./technician-sync.rules";
import { TechnicianSyncRepository } from "./technician-sync.repository";

type SyncFile = { bytes: Uint8Array; filename: string; contentType: string };

export class TechnicianSyncService {
  constructor(
    private readonly attachments = new AttachmentService(),
    private readonly completion = new JobCompletionService(),
    private readonly jobs = new JobService(),
  ) {}

  async apply(actor: RequestActor, raw: unknown, file?: SyncFile) {
    await authorize(actor, "job.read");
    if (actor.role !== "member") throw new ForbiddenError("Offline sync is limited to assigned technicians");
    const mutation = parseInput(technicianSyncMutationSchema, raw);
    const payloadHash = technicianSyncPayloadHash(mutation);
    const claim = await getDb().transaction(async (tx) => {
      const completionRepository = new JobCompletionRepository(tx);
      const job = await completionRepository.lockJob(actor.organizationId, mutation.jobId);
      if (!job) throw new NotFoundError("Job not found");
      if (job.technicianUserId !== actor.userId) throw new ForbiddenError("Offline work belongs to another technician or workspace");
      if (await completionRepository.maintenanceOccurrence(actor.organizationId, mutation.jobId)) {
        throw new ConflictError("Maintenance offline sync requires its dedicated report workflow");
      }
      const repository = new TechnicianSyncRepository(tx);
      const dependencies = await repository.dependencies(actor.organizationId, actor.userId, mutation.jobId, mutation.dependsOn);
      if (dependencies.length !== mutation.dependsOn.length || dependencies.some((item) => item.state !== "applied")) {
        throw new ConflictError("Sync dependencies have not been applied");
      }
      await repository.insertPending({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        jobId: mutation.jobId,
        clientMutationId: mutation.clientMutationId,
        operation: mutation.operation,
        payloadHash,
      });
      const receipt = await repository.lockByClientKey(actor.organizationId, actor.userId, mutation.clientMutationId);
      if (!receipt) throw new ConflictError("Unable to claim sync mutation");
      if (receipt.jobId !== mutation.jobId || receipt.operation !== mutation.operation || receipt.payloadHash !== payloadHash) {
        throw new ConflictError("Sync mutation ID was already used with different content");
      }
      if (receipt.state === "applied") return { receipt, replayed: true };
      if (receipt.leaseExpiresAt && receipt.leaseExpiresAt.getTime() > Date.now()) {
        throw new ConflictError("Sync mutation is already being applied");
      }
      const leased = await repository.acquire(receipt.id, new Date(Date.now() + 30_000));
      return { receipt: leased, replayed: false };
    });
    if (claim.replayed) return { replayed: true, result: claim.receipt.result ?? {} };

    try {
      const result = await this.execute(actor, mutation, file);
      await getDb().transaction(async (tx) => new TechnicianSyncRepository(tx).markApplied(claim.receipt.id, result));
      return { replayed: false, result };
    } catch (error) {
      await getDb().transaction(async (tx) => new TechnicianSyncRepository(tx).release(claim.receipt.id));
      throw error;
    }
  }

  private async execute(actor: RequestActor, mutation: TechnicianSyncMutation, file?: SyncFile): Promise<Record<string, unknown>> {
    switch (mutation.operation) {
      case "save_report": {
        const current = (await this.completion.getCompletionView(actor, mutation.jobId)).report;
        if ((current?.id ?? null) !== mutation.payload.baseReportId) throw new ConflictError("Job report changed concurrently");
        const report = await this.completion.saveReport(actor, mutation.jobId, {
          workPerformed: mutation.payload.workPerformed,
          findings: mutation.payload.findings,
          notes: mutation.payload.notes,
          materialsUsed: mutation.payload.materialsUsed,
          expectedRowVersion: mutation.payload.expectedRowVersion,
        }, mutation.clientMutationId);
        return { reportId: report.id, status: report.status, rowVersion: report.rowVersion, snapshotHash: report.snapshotHash };
      }
      case "submit_report": {
        const report = await this.completion.submitReport(actor, mutation.jobId, mutation.payload, mutation.clientMutationId);
        return { reportId: report.id, status: report.status, rowVersion: report.rowVersion, snapshotHash: report.snapshotHash };
      }
      case "set_checklist": {
        const item = await this.jobs.setChecklistItem(actor, mutation.jobId, mutation.payload.itemId, { completed: mutation.payload.completed }, mutation.clientMutationId);
        return { itemId: item.id, completed: item.completed };
      }
      case "add_note": {
        const note = await this.jobs.addNote(actor, mutation.jobId, { body: mutation.payload.body }, mutation.clientMutationId);
        return { noteId: note.id };
      }
      case "upload_evidence": {
        const attachment = await this.upload(actor, mutation, file);
        const evidence = await this.completion.addEvidence(actor, mutation.jobId, { attachmentId: attachment.id, kind: mutation.payload.kind });
        return { attachmentId: attachment.id, evidenceId: evidence.id, kind: evidence.kind };
      }
      case "capture_signature": {
        const view = await this.completion.getCompletionView(actor, mutation.jobId);
        if (view.report?.status !== "submitted" || view.report.snapshotHash !== mutation.payload.expectedReportSnapshotHash) {
          throw new ConflictError("Submitted report changed before signature synchronization");
        }
        const attachment = await this.upload(actor, mutation, file);
        const signature = await this.completion.captureCustomerSignature(actor, mutation.jobId, {
          attachmentId: attachment.id,
          signerName: mutation.payload.signerName,
          signerRelationship: mutation.payload.signerRelationship,
          acknowledged: mutation.payload.acknowledged,
        });
        return { attachmentId: attachment.id, signatureId: signature.id, reportSnapshotHash: signature.reportSnapshotHash };
      }
      case "complete_job": {
        const completion = await this.completion.completeJob(actor, mutation.jobId);
        return { completionId: completion.completion.id, jobStatus: completion.job.status, idempotent: completion.idempotent };
      }
    }
  }

  private async upload(actor: RequestActor, mutation: Extract<TechnicianSyncMutation, { operation: "upload_evidence" | "capture_signature" }>, file?: SyncFile) {
    if (!file) throw new ValidationError("A staged image is required");
    if (file.filename !== mutation.payload.filename || file.contentType !== mutation.payload.contentType || file.bytes.byteLength !== mutation.payload.sizeBytes) {
      throw new ValidationError("Staged image metadata does not match the sync request");
    }
    if (!file.contentType.startsWith("image/")) throw new ValidationError("A staged image is required");
    const hash = createHash("sha256").update(file.bytes).digest("hex");
    if (hash !== mutation.payload.sha256) throw new ValidationError("Staged image integrity check failed");
    return this.attachments.uploadAttachmentFromSync(actor, {
      targetType: "job", targetId: mutation.jobId, filename: file.filename,
      contentType: file.contentType as "image/jpeg", sizeBytes: file.bytes.byteLength,
    }, file.bytes, mutation.clientMutationId);
  }
}
