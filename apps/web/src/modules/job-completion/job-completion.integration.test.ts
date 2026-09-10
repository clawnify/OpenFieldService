import { describe, expect, it } from "vitest";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { AttachmentService } from "@/modules/attachments/attachment.service";
import { CustomerService } from "@/modules/customers/customer.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";
import { JobService } from "@/modules/jobs/job.service";
import type { ObjectStorage } from "@/lib/r2";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { JobCompletionService } from "./job-completion.service";

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array) { this.objects.set(key, body); }
  async delete(key: string) { this.objects.delete(key); }
  async signedDownloadUrl(key: string) { return "https://storage.example.test/" + encodeURIComponent(key); }
}

describe.sequential("PostgreSQL global Job completion compliance", () => {
  const storage = new MemoryStorage();
  const attachments = new AttachmentService(undefined, undefined, undefined, storage);
  const completion = new JobCompletionService();
  const jobs = new JobService();
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  let a: Awaited<ReturnType<OrganizationService["createOrganizationWithOwner"]>>;
  let b: typeof a;
  let customerA: Awaited<ReturnType<CustomerService["createCustomer"]>>;
  let customerB: typeof customerA;
  let techA: Awaited<ReturnType<UserService["createUserWithMembership"]>>;
  let techA2: typeof techA;
  let techB: typeof techA;
  const actorA = () => ({ userId: a.user.id, organizationId: a.organization.id, role: "owner" as const });
  const actorB = () => ({ userId: b.user.id, organizationId: b.organization.id, role: "owner" as const });
  const technicianA = () => ({ userId: techA.user.id, organizationId: a.organization.id, role: "member" as const });
  const technicianA2 = () => ({ userId: techA2.user.id, organizationId: a.organization.id, role: "member" as const });

  async function inProgress(technicianUserId = techA.user.id) {
    const job = await jobs.createJob(actorA(), { customerId: customerA.id, title: "Completion " + crypto.randomUUID(), serviceAddress: "100 Test St", technicianUserId, scheduledDate: null, scheduledTime: null });
    await jobs.transitionJob(actorA(), job.id, { toStatus: "in_progress" });
    return job;
  }

  async function upload(jobId: string, label: string) {
    return attachments.uploadAttachment(actorA(), { targetType: "job", targetId: jobId, filename: label + ".jpg", contentType: "image/jpeg", sizeBytes: image.byteLength }, image);
  }

  async function addEvidence(jobId: string, kind: "pre_work_photo" | "post_work_photo") {
    const attachment = await upload(jobId, kind);
    await completion.addEvidence(actorA(), jobId, { attachmentId: attachment.id, kind });
    return attachment;
  }

  async function submitReport(jobId: string) {
    const draft = await completion.saveReport(actorA(), jobId, { workPerformed: "Inspected and tested system", findings: "Operating normally", notes: "", materialsUsed: "", expectedRowVersion: 0 });
    return completion.submitReport(actorA(), jobId, { expectedRowVersion: draft.rowVersion });
  }

  async function sign(jobId: string, signerName = "Synthetic Customer") {
    const attachment = await upload(jobId, "signature");
    return completion.captureCustomerSignature(actorA(), jobId, { attachmentId: attachment.id, signerName, signerRelationship: "Customer", acknowledged: true });
  }

  async function readyJob() {
    const job = await inProgress();
    await addEvidence(job.id, "pre_work_photo");
    await addEvidence(job.id, "post_work_photo");
    await submitReport(job.id);
    await sign(job.id);
    return job;
  }

  it("creates tenant and technician fixtures", async () => {
    const organizations = new OrganizationService();
    a = await organizations.createOrganizationWithOwner({ name: "Completion A", slug: "completion-a-" + crypto.randomUUID() }, { name: "Owner A", email: "completion-a-" + crypto.randomUUID() + "@example.test", password: "Synthetic-Pass-123" });
    b = await organizations.createOrganizationWithOwner({ name: "Completion B", slug: "completion-b-" + crypto.randomUUID() }, { name: "Owner B", email: "completion-b-" + crypto.randomUUID() + "@example.test", password: "Synthetic-Pass-456" });
    customerA = await new CustomerService().createCustomer(actorA(), { name: "Customer A" });
    customerB = await new CustomerService().createCustomer(actorB(), { name: "Customer B" });
    const users = new UserService();
    techA = await users.createUserWithMembership(actorA(), { name: "Tech A", email: "completion-tech-a-" + crypto.randomUUID() + "@example.test", password: "Synthetic-Pass-789" }, "member");
    techA2 = await users.createUserWithMembership(actorA(), { name: "Tech A2", email: "completion-tech-a2-" + crypto.randomUUID() + "@example.test", password: "Synthetic-Pass-789" }, "member");
    techB = await users.createUserWithMembership(actorB(), { name: "Tech B", email: "completion-tech-b-" + crypto.randomUUID() + "@example.test", password: "Synthetic-Pass-789" }, "member");
  });

  it("enforces every global completion prerequisite and persists immutable provenance", async () => {
    const job = await inProgress();
    await expect(completion.completeJob(technicianA(), job.id)).rejects.toThrow("pre-work");
    await addEvidence(job.id, "pre_work_photo");
    await expect(completion.completeJob(technicianA(), job.id)).rejects.toThrow("post-work");
    await addEvidence(job.id, "post_work_photo");
    const draft = await completion.saveReport(technicianA(), job.id, { workPerformed: "Completed work", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0 });
    await expect(completion.completeJob(technicianA(), job.id)).rejects.toThrow("submitted Job report");
    await completion.submitReport(technicianA(), job.id, { expectedRowVersion: draft.rowVersion });
    await expect(completion.completeJob(technicianA(), job.id)).rejects.toThrow("customer signature");
    await sign(job.id);
    const result = await completion.completeJob(technicianA(), job.id);
    expect(result).toMatchObject({ idempotent: false, job: { status: "completed" } });
    expect(result.completion.reportSnapshot).toMatchObject({ job: { id: job.id, technicianUserId: techA.user.id }, report: { workPerformed: "Completed work" } });
    expect(result.completion.preWorkEvidenceSnapshot).toHaveLength(1);
    expect(result.completion.postWorkEvidenceSnapshot).toHaveLength(1);
    const view = await jobs.getJob(actorA(), job.id);
    expect(view.history.filter((row) => row.toStatus === "completed")).toHaveLength(1);
    expect((await new AuditRepository().listForEntity(a.organization.id, "job", job.id)).filter((row) => row.action === "job.completed")).toHaveLength(1);
  });

  it("requires assigned-technician ownership while preserving audited office completion", async () => {
    const job = await readyJob();
    await expect(completion.completeJob(technicianA2(), job.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await completion.completeJob(actorA(), job.id)).job.status).toBe("completed");
  });

  it("rejects cross-tenant evidence, report, signature, completion and reads", async () => {
    const jobA = await inProgress();
    const jobB = await jobs.createJob(actorB(), { customerId: customerB.id, title: "Foreign", serviceAddress: "B", technicianUserId: techB.user.id, scheduledDate: null, scheduledTime: null });
    const foreignAttachment = await attachments.uploadAttachment(actorB(), { targetType: "job", targetId: jobB.id, filename: "foreign.jpg", contentType: "image/jpeg", sizeBytes: image.byteLength }, image);
    await expect(completion.addEvidence(actorA(), jobA.id, { attachmentId: foreignAttachment.id, kind: "pre_work_photo" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completion.saveReport(actorA(), jobB.id, { workPerformed: "breach", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completion.captureCustomerSignature(actorA(), jobB.id, { attachmentId: foreignAttachment.id, signerName: "breach", signerRelationship: "", acknowledged: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completion.completeJob(actorB(), jobA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(completion.getCompletionView(actorB(), jobA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(completion.getCompletionView(technicianA2(), jobA.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("serializes simultaneous completion and makes retries idempotent", async () => {
    const job = await readyJob();
    const results = await Promise.all([completion.completeJob(technicianA(), job.id), completion.completeJob(technicianA(), job.id)]);
    expect(results.filter((row) => !row.idempotent)).toHaveLength(1);
    expect(results.filter((row) => row.idempotent)).toHaveLength(1);
    expect((await completion.completeJob(technicianA(), job.id)).idempotent).toBe(true);
    const view = await jobs.getJob(actorA(), job.id);
    expect(view.history.filter((row) => row.toStatus === "completed")).toHaveLength(1);
  });

  it("invalidates a signature when its submitted report is revised", async () => {
    const job = await readyJob();
    const before = await completion.getCompletionView(actorA(), job.id);
    const draft = await completion.saveReport(actorA(), job.id, { workPerformed: "Corrected work", findings: "", notes: "", materialsUsed: "", expectedRowVersion: before.report!.rowVersion });
    await completion.submitReport(actorA(), job.id, { expectedRowVersion: draft.rowVersion });
    await expect(completion.completeJob(actorA(), job.id)).rejects.toThrow("customer signature");
    await sign(job.id, "Corrected Customer");
    expect((await completion.completeJob(actorA(), job.id)).job.status).toBe("completed");
  });

  it("serializes completion against reassignment and cancellation", async () => {
    const reassignmentJob = await readyJob();
    const reassignment = await Promise.allSettled([
      completion.completeJob(actorA(), reassignmentJob.id),
      jobs.scheduleJob(actorA(), reassignmentJob.id, { technicianUserId: techA2.user.id, scheduledDate: null, scheduledTime: null, durationMinutes: 60, timezone: "America/Vancouver", reason: "Race" }),
    ]);
    expect(reassignment.filter((row) => row.status === "fulfilled")).toHaveLength(1);

    const cancellationJob = await readyJob();
    const cancellation = await Promise.allSettled([
      completion.completeJob(actorA(), cancellationJob.id),
      jobs.transitionJob(actorA(), cancellationJob.id, { toStatus: "cancelled", reason: "Race" }),
    ]);
    expect(cancellation.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  });

  it("serializes completion against report mutation and evidence deletion", async () => {
    const reportJob = await readyJob();
    const reportView = await completion.getCompletionView(actorA(), reportJob.id);
    const reportRace = await Promise.allSettled([
      completion.completeJob(actorA(), reportJob.id),
      completion.saveReport(actorA(), reportJob.id, { workPerformed: "Raced edit", findings: "", notes: "", materialsUsed: "", expectedRowVersion: reportView.report!.rowVersion }),
    ]);
    expect(reportRace.filter((row) => row.status === "fulfilled")).toHaveLength(1);

    const evidenceJob = await readyJob();
    const evidenceView = await completion.getCompletionView(actorA(), evidenceJob.id);
    const preWork = evidenceView.evidence.find((row) => row.evidence.kind === "pre_work_photo")!;
    const evidenceRace = await Promise.allSettled([
      completion.completeJob(actorA(), evidenceJob.id),
      attachments.archiveAttachment(actorA(), preWork.attachment.id),
    ]);
    expect(evidenceRace.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  });

  it("serializes completion against customer signature capture and permits a safe retry", async () => {
    const job = await inProgress();
    await addEvidence(job.id, "pre_work_photo");
    await addEvidence(job.id, "post_work_photo");
    await submitReport(job.id);
    const signatureAttachment = await upload(job.id, "signature-race");
    const race = await Promise.allSettled([
      completion.completeJob(actorA(), job.id),
      completion.captureCustomerSignature(actorA(), job.id, { attachmentId: signatureAttachment.id, signerName: "Race Customer", signerRelationship: "Customer", acknowledged: true }),
    ]);
    expect(race[1]!.status).toBe("fulfilled");
    expect((await completion.completeJob(actorA(), job.id)).job.status).toBe("completed");
  });

  it("preserves submitted snapshots and files after completion and rejects reopen", async () => {
    const job = await readyJob();
    const view = await completion.getCompletionView(actorA(), job.id);
    await completion.completeJob(actorA(), job.id);
    await expect(completion.saveReport(actorA(), job.id, { workPerformed: "mutate", findings: "", notes: "", materialsUsed: "", expectedRowVersion: view.report!.rowVersion })).rejects.toBeInstanceOf(ConflictError);
    await expect(attachments.archiveAttachment(actorA(), view.evidence[0]!.attachment.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(jobs.transitionJob(actorA(), job.id, { toStatus: "in_progress" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not persist completion/history/audit when the gate rejects", async () => {
    const job = await inProgress();
    await expect(completion.completeJob(actorA(), job.id)).rejects.toBeInstanceOf(ConflictError);
    const view = await completion.getCompletionView(actorA(), job.id);
    expect(view.completion).toBeUndefined();
    expect((await jobs.getJob(actorA(), job.id)).history.filter((row) => row.toStatus === "completed")).toHaveLength(0);
    expect((await new AuditRepository().listForEntity(a.organization.id, "job", job.id)).filter((row) => row.action === "job.completed")).toHaveLength(0);
  });
});
