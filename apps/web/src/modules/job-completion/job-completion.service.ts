import "server-only";
import { authorize } from "@/auth/authorization";
import { getDb } from "@/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { parseEntityId } from "@/modules/crm/crm.helpers";
import type { Authorizer, RequestActor } from "@/modules/customers/customer.service";
import { JobRepository } from "@/modules/jobs/job.repository";
import { addJobEvidenceSchema, captureJobSignatureSchema, saveJobReportSchema, submitJobReportSchema } from "./job-completion.schema";
import { JobCompletionRepository } from "./job-completion.repository";
import { CUSTOMER_ACKNOWLEDGEMENT, completionRequirements, jobReportSnapshotHash } from "./job-completion.rules";

const mutableStatuses = new Set(["scheduled", "in_progress"]);

export class JobCompletionService {
  constructor(
    private readonly repository = new JobCompletionRepository(),
    private readonly authorizer: Authorizer = authorize,
  ) {}

  private assertActorOwnsAssignedJob(actor: RequestActor, technicianUserId: string | null) {
    if (actor.role === "member" && technicianUserId !== actor.userId) {
      throw new ForbiddenError("Only the assigned technician may manage Job completion");
    }
  }

  private assertMutable(status: string) {
    if (!mutableStatuses.has(status)) throw new ConflictError("Closed or cancelled Job completion evidence cannot be changed");
  }

  async getCompletionView(actor: RequestActor, rawJobId: string) {
    await this.authorizer(actor, "job.read");
    const jobId = parseEntityId(rawJobId);
    const job = await this.repository.findJob(actor.organizationId, jobId);
    if (!job) throw new NotFoundError("Job not found");
    this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
    const [evidence, report, signatures, completion] = await Promise.all([
      this.repository.listActiveEvidence(actor.organizationId, jobId),
      this.repository.report(actor.organizationId, jobId),
      this.repository.listSignatures(actor.organizationId, jobId),
      this.repository.completion(actor.organizationId, jobId),
    ]);
    const technicianActive = job.technicianUserId ? Boolean(await this.repository.activeTechnicianMembership(actor.organizationId, job.technicianUserId)) : false;
    const matchingSignature = report?.snapshotHash ? await this.repository.matchingSignature(actor.organizationId, jobId, report.id, report.snapshotHash) : null;
    const requirements = completionRequirements({
      technicianAssigned: Boolean(job.technicianUserId),
      technicianActive,
      preWorkEvidenceCount: evidence.filter((row) => row.evidence.kind === "pre_work_photo").length,
      postWorkEvidenceCount: evidence.filter((row) => row.evidence.kind === "post_work_photo").length,
      reportSubmitted: report?.status === "submitted",
      reportTechnicianMatches: Boolean(report && report.technicianUserId === job.technicianUserId),
      matchingCustomerSignature: Boolean(matchingSignature),
    });
    return { job, evidence, report, signatures, completion, requirements, allowed: requirements.every((item) => item.satisfied) };
  }

  async addEvidence(actor: RequestActor, rawJobId: string, raw: unknown) {
    await this.authorizer(actor, "job.evidence.manage");
    const jobId = parseEntityId(rawJobId);
    const input = parseInput(addJobEvidenceSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new JobCompletionRepository(tx);
      const job = await repository.lockJob(actor.organizationId, jobId);
      if (!job) throw new NotFoundError("Job not found");
      this.assertMutable(job.status);
      this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
      const attachment = await repository.attachmentForUpdate(actor.organizationId, input.attachmentId);
      if (!attachment || attachment.targetType !== "job" || attachment.targetId !== jobId || !attachment.contentType.startsWith("image/")) {
        throw new NotFoundError("Job evidence attachment not found");
      }
      if (await repository.signatureByAttachment(actor.organizationId, attachment.id)) throw new ConflictError("Signature files cannot also be Job evidence");
      const existing = await repository.evidenceByAttachment(actor.organizationId, attachment.id);
      if (existing) return existing;
      const evidence = await repository.createEvidence({
        organizationId: actor.organizationId,
        jobId,
        attachmentId: attachment.id,
        kind: input.kind,
        position: await repository.nextEvidencePosition(actor.organizationId, jobId, input.kind),
        required: true,
        createdBy: actor.userId,
      });
      if (!evidence) throw new ConflictError("Evidence was registered concurrently");
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: input.kind === "pre_work_photo" ? "job.prework_evidence_added" : "job.postwork_evidence_added",
        entityType: "job",
        entityId: jobId,
        metadata: { evidenceId: evidence.id, attachmentId: attachment.id },
      });
      return evidence;
    });
  }

  async saveReport(actor: RequestActor, rawJobId: string, raw: unknown, syncMutationId?: string) {
    await this.authorizer(actor, "job.report.write");
    const jobId = parseEntityId(rawJobId);
    if (syncMutationId) syncMutationId = parseEntityId(syncMutationId);
    const input = parseInput(saveJobReportSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new JobCompletionRepository(tx);
      const job = await repository.lockJob(actor.organizationId, jobId);
      if (!job) throw new NotFoundError("Job not found");
      this.assertMutable(job.status);
      this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
      if (!job.technicianUserId || !await repository.activeTechnicianMembership(actor.organizationId, job.technicianUserId)) {
        throw new ConflictError("An active assigned technician is required");
      }
      const current = await repository.lockReport(actor.organizationId, jobId);
      if (syncMutationId && current?.lastSyncMutationId === syncMutationId) return current;
      if (!current) {
        if (input.expectedRowVersion !== 0) throw new ConflictError("Job report changed concurrently");
        const report = await repository.createReport({
          organizationId: actor.organizationId,
          jobId,
          technicianUserId: job.technicianUserId,
          workPerformed: input.workPerformed,
          findings: input.findings,
          notes: input.notes,
          materialsUsed: input.materialsUsed,
          lastSyncMutationId: syncMutationId ?? null,
        });
        await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "job.report_draft_saved", entityType: "job", entityId: jobId, metadata: { reportId: report.id } });
        return report;
      }
      const report = await repository.saveReport(actor.organizationId, current.id, input.expectedRowVersion, {
        technicianUserId: job.technicianUserId,
        status: "draft",
        workPerformed: input.workPerformed,
        findings: input.findings,
        notes: input.notes,
        materialsUsed: input.materialsUsed,
        checklistSnapshot: [],
        submittedSnapshot: null,
        snapshotHash: null,
        submittedBy: null,
        submittedAt: null,
        lastSyncMutationId: syncMutationId ?? null,
      });
      if (!report) throw new ConflictError("Job report changed concurrently");
      await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "job.report_draft_saved", entityType: "job", entityId: jobId, metadata: { reportId: report.id } });
      return report;
    });
  }

  async submitReport(actor: RequestActor, rawJobId: string, raw: unknown, syncMutationId?: string) {
    await this.authorizer(actor, "job.report.submit");
    const jobId = parseEntityId(rawJobId);
    if (syncMutationId) syncMutationId = parseEntityId(syncMutationId);
    const input = parseInput(submitJobReportSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new JobCompletionRepository(tx);
      const job = await repository.lockJob(actor.organizationId, jobId);
      if (!job) throw new NotFoundError("Job not found");
      this.assertMutable(job.status);
      this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
      const report = await repository.lockReport(actor.organizationId, jobId);
      if (syncMutationId && report?.lastSyncMutationId === syncMutationId) return report;
      if (!report || !report.workPerformed.trim()) throw new ConflictError("Describe the work performed before submitting the report");
      if (report.technicianUserId !== job.technicianUserId) throw new ConflictError("Assigned technician changed; save the report again");
      const checklist = await repository.listChecklist(actor.organizationId, jobId);
      const checklistSnapshot = checklist.map((item) => ({ id: item.id, label: item.label, position: item.position, completed: item.completed, completedAt: item.completedAt?.toISOString() ?? null }));
      const submittedAt = new Date();
      const submittedSnapshot = {
        job: { id: job.id, identifier: job.identifier, customerId: job.customerId, title: job.title, description: job.description, serviceAddress: job.serviceAddress, technicianUserId: job.technicianUserId },
        report: { id: report.id, workPerformed: report.workPerformed, findings: report.findings, notes: report.notes, materialsUsed: report.materialsUsed },
        checklist: checklistSnapshot,
        submittedAt: submittedAt.toISOString(),
      };
      const snapshotHash = jobReportSnapshotHash(submittedSnapshot);
      const submitted = await repository.saveReport(actor.organizationId, report.id, input.expectedRowVersion, {
        status: "submitted",
        checklistSnapshot,
        submittedSnapshot,
        snapshotHash,
        submittedBy: actor.userId,
        submittedAt,
        lastSyncMutationId: syncMutationId ?? null,
      });
      if (!submitted) throw new ConflictError("Job report changed concurrently");
      await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "job.report_submitted", entityType: "job", entityId: jobId, metadata: { reportId: report.id, snapshotHash } });
      return submitted;
    });
  }

  async captureCustomerSignature(actor: RequestActor, rawJobId: string, raw: unknown) {
    await this.authorizer(actor, "job.signature.capture");
    const jobId = parseEntityId(rawJobId);
    const input = parseInput(captureJobSignatureSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new JobCompletionRepository(tx);
      const job = await repository.lockJob(actor.organizationId, jobId);
      if (!job) throw new NotFoundError("Job not found");
      this.assertMutable(job.status);
      this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
      const report = await repository.lockReport(actor.organizationId, jobId);
      if (!report || report.status !== "submitted" || !report.snapshotHash) throw new ConflictError("Submit the Job report before capturing customer signature");
      const attachment = await repository.attachmentForUpdate(actor.organizationId, input.attachmentId);
      if (!attachment || attachment.targetType !== "job" || attachment.targetId !== jobId || !attachment.contentType.startsWith("image/")) throw new NotFoundError("Customer signature attachment not found");
      if (await repository.evidenceByAttachment(actor.organizationId, attachment.id)) throw new ConflictError("Evidence files cannot also be customer signatures");
      const existing = await repository.signatureByAttachment(actor.organizationId, attachment.id);
      if (existing) return existing;
      const signature = await repository.createSignature({
        organizationId: actor.organizationId,
        jobId,
        reportId: report.id,
        attachmentId: attachment.id,
        reportSnapshotHash: report.snapshotHash,
        signerName: input.signerName,
        signerRelationship: input.signerRelationship,
        acknowledgement: CUSTOMER_ACKNOWLEDGEMENT,
        capturedBy: actor.userId,
      });
      if (!signature) throw new ConflictError("Customer signature was captured concurrently");
      await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "job.customer_signed", entityType: "job", entityId: jobId, metadata: { signatureId: signature.id, reportId: report.id, reportSnapshotHash: report.snapshotHash } });
      return signature;
    });
  }

  async completeJob(actor: RequestActor, rawJobId: string) {
    await this.authorizer(actor, "job.complete");
    const jobId = parseEntityId(rawJobId);
    return getDb().transaction(async (tx) => {
      const repository = new JobCompletionRepository(tx);
      const job = await repository.lockJob(actor.organizationId, jobId);
      if (!job) throw new NotFoundError("Job not found");
      if (await repository.maintenanceOccurrence(actor.organizationId, jobId)) throw new ConflictError("Maintenance Jobs must be completed through the Maintenance service report");
      const existingCompletion = await repository.completion(actor.organizationId, jobId);
      if (job.status === "completed" && existingCompletion) return { job, completion: existingCompletion, idempotent: true };
      if (job.status !== "in_progress") throw new ConflictError("Only an in-progress Job can be completed");
      this.assertActorOwnsAssignedJob(actor, job.technicianUserId);
      const technician = job.technicianUserId ? await repository.activeTechnicianMembership(actor.organizationId, job.technicianUserId) : null;
      const report = await repository.lockReport(actor.organizationId, jobId);
      const evidence = await repository.lockActiveEvidence(actor.organizationId, jobId);
      const signature = report?.snapshotHash ? await repository.lockMatchingSignature(actor.organizationId, jobId, report.id, report.snapshotHash) : null;
      const preWork = evidence.filter((row) => row.evidence.kind === "pre_work_photo");
      const postWork = evidence.filter((row) => row.evidence.kind === "post_work_photo");
      const requirements = completionRequirements({
        technicianAssigned: Boolean(job.technicianUserId),
        technicianActive: Boolean(technician),
        preWorkEvidenceCount: preWork.length,
        postWorkEvidenceCount: postWork.length,
        reportSubmitted: report?.status === "submitted",
        reportTechnicianMatches: Boolean(report && report.technicianUserId === job.technicianUserId),
        matchingCustomerSignature: Boolean(signature),
      });
      const missing = requirements.filter((item) => !item.satisfied);
      if (missing.length) throw new ConflictError("Cannot complete Job: " + missing.map((item) => item.label).join("; "));
      const completedAt = new Date();
      const evidenceSnapshot = (rows: typeof evidence) => rows.map((row) => ({
        evidenceId: row.evidence.id,
        attachmentId: row.attachment.id,
        kind: row.evidence.kind,
        position: row.evidence.position,
        sha256: row.attachment.sha256,
        contentType: row.attachment.contentType,
        uploadedBy: row.attachment.uploadedBy,
        createdAt: row.attachment.createdAt.toISOString(),
      }));
      const completion = await repository.createCompletion({
        organizationId: actor.organizationId,
        jobId,
        reportId: report!.id,
        signatureId: signature!.signature.id,
        technicianUserId: job.technicianUserId!,
        completedBy: actor.userId,
        reportSnapshot: report!.submittedSnapshot!,
        preWorkEvidenceSnapshot: evidenceSnapshot(preWork),
        postWorkEvidenceSnapshot: evidenceSnapshot(postWork),
        signatureSnapshot: {
          signatureId: signature!.signature.id,
          attachmentId: signature!.attachment.id,
          attachmentSha256: signature!.attachment.sha256,
          signerName: signature!.signature.signerName,
          signerRelationship: signature!.signature.signerRelationship,
          reportSnapshotHash: signature!.signature.reportSnapshotHash,
          capturedAt: signature!.signature.capturedAt.toISOString(),
        },
        idempotencyKey: "job:" + jobId + ":completion",
        completedAt,
      });
      if (!completion) throw new ConflictError("Job completion changed concurrently");
      const completedJob = await repository.completeJob(actor.organizationId, jobId, actor.userId, completedAt);
      if (!completedJob) throw new ConflictError("Job completion changed concurrently");
      const jobsRepository = new JobRepository(tx);
      await jobsRepository.addStatusHistory({ organizationId: actor.organizationId, jobId, fromStatus: "in_progress", toStatus: "completed", actorUserId: actor.userId, reason: "Compliance requirements satisfied" });
      await new AuditRepository(tx).record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "job.completed", entityType: "job", entityId: jobId, metadata: { completionId: completion.id, reportId: report!.id, signatureId: signature!.signature.id, technicianUserId: job.technicianUserId } });
      return { job: completedJob, completion, idempotent: false };
    });
  }
}
