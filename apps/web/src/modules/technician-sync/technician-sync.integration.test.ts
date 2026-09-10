import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ObjectStorage } from "@/lib/r2";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { AttachmentService } from "@/modules/attachments/attachment.service";
import { CustomerService } from "@/modules/customers/customer.service";
import { JobCompletionService } from "@/modules/job-completion/job-completion.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";
import { JobService } from "@/modules/jobs/job.service";
import { TechnicianSyncService } from "./technician-sync.service";

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  failAfterPut = false;
  async put(key: string, body: Uint8Array) { this.objects.set(key, body); if (this.failAfterPut) throw new Error("lost upload acknowledgement"); }
  async delete(key: string) { this.objects.delete(key); }
  async signedDownloadUrl(key: string) { return "https://storage.example.test/" + encodeURIComponent(key); }
}

describe.sequential("PostgreSQL Technician offline synchronization", () => {
  const storage = new MemoryStorage(), attachments = new AttachmentService(undefined, undefined, undefined, storage);
  const completion = new JobCompletionService(), jobs = new JobService();
  const sync = new TechnicianSyncService(attachments, completion, jobs);
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00]), imageHash = createHash("sha256").update(image).digest("hex");
  let a: Awaited<ReturnType<OrganizationService["createOrganizationWithOwner"]>>, b: typeof a;
  let customerA: Awaited<ReturnType<CustomerService["createCustomer"]>>, customerB: typeof customerA;
  let techA: Awaited<ReturnType<UserService["createUserWithMembership"]>>, techA2: typeof techA, techB: typeof techA;
  const ownerA = () => ({ userId: a.user.id, organizationId: a.organization.id, role: "owner" as const });
  const ownerB = () => ({ userId: b.user.id, organizationId: b.organization.id, role: "owner" as const });
  const actorA = () => ({ userId: techA.user.id, organizationId: a.organization.id, role: "member" as const });
  const actorA2 = () => ({ userId: techA2.user.id, organizationId: a.organization.id, role: "member" as const });
  const actorB = () => ({ userId: techB.user.id, organizationId: b.organization.id, role: "member" as const });
  const id = () => crypto.randomUUID(), at = "2026-09-09T20:00:00.000Z";
  const mutation = (jobId: string, operation: string, payload: Record<string, unknown>, clientMutationId = id(), dependsOn: string[] = []) => ({ clientMutationId, jobId, operation, payload, localCreatedAt: at, dependsOn });
  const staged = { bytes: image, filename: "offline.jpg", contentType: "image/jpeg" };
  const filePayload = { filename: staged.filename, contentType: staged.contentType, sizeBytes: image.byteLength, sha256: imageHash };

  async function job(technicianUserId = techA.user.id) {
    const value = await jobs.createJob(ownerA(), { customerId: customerA.id, title: "Offline " + id(), serviceAddress: "100 Test St", technicianUserId, scheduledDate: null, scheduledTime: null });
    await jobs.transitionJob(ownerA(), value.id, { toStatus: "in_progress" });
    return value;
  }

  it("creates isolated Technician fixtures", async () => {
    const organizations = new OrganizationService();
    a = await organizations.createOrganizationWithOwner({ name: "Offline A", slug: "offline-a-" + id() }, { name: "Owner A", email: "offline-a-" + id() + "@example.test", password: "Synthetic-Pass-123" });
    b = await organizations.createOrganizationWithOwner({ name: "Offline B", slug: "offline-b-" + id() }, { name: "Owner B", email: "offline-b-" + id() + "@example.test", password: "Synthetic-Pass-456" });
    customerA = await new CustomerService().createCustomer(ownerA(), { name: "Customer A" });
    customerB = await new CustomerService().createCustomer(ownerB(), { name: "Customer B" });
    const users = new UserService();
    techA = await users.createUserWithMembership(ownerA(), { name: "Tech A", email: "offline-tech-a-" + id() + "@example.test", password: "Synthetic-Pass-789" }, "member");
    techA2 = await users.createUserWithMembership(ownerA(), { name: "Tech A2", email: "offline-tech-a2-" + id() + "@example.test", password: "Synthetic-Pass-789" }, "member");
    techB = await users.createUserWithMembership(ownerB(), { name: "Tech B", email: "offline-tech-b-" + id() + "@example.test", password: "Synthetic-Pass-789" }, "member");
  });

  it("replays report saves exactly once and rejects mutation-key reuse", async () => {
    const value = await job(), key = id();
    const request = mutation(value.id, "save_report", { workPerformed: "Offline work", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }, key);
    const first = await sync.apply(actorA(), request), replay = await sync.apply(actorA(), request);
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect((await completion.getCompletionView(actorA(), value.id)).report?.rowVersion).toBe(0);
    await expect(sync.apply(actorA(), { ...request, payload: { ...request.payload, workPerformed: "Different" } })).rejects.toBeInstanceOf(ConflictError);
  });

  it("serializes duplicate server replay without duplicating the report", async () => {
    const value = await job(), key = id();
    const request = mutation(value.id, "save_report", { workPerformed: "Single flight", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }, key);
    const results = await Promise.allSettled([sync.apply(actorA(), request), sync.apply(actorA(), request)]);
    expect(results.filter((result) => result.status === "fulfilled")).not.toHaveLength(0);
    expect((await completion.getCompletionView(actorA(), value.id)).report?.workPerformed).toBe("Single flight");
  });

  it("rejects stale two-device and online/offline report writes", async () => {
    const value = await job();
    await sync.apply(actorA(), mutation(value.id, "save_report", { workPerformed: "Device one", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }));
    await expect(sync.apply(actorA(), mutation(value.id, "save_report", { workPerformed: "Device two", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }))).rejects.toThrow("changed concurrently");
    const report = (await completion.getCompletionView(actorA(), value.id)).report!;
    await completion.saveReport(actorA(), value.id, { workPerformed: "Online", findings: "", notes: "", materialsUsed: "", expectedRowVersion: report.rowVersion });
    await expect(sync.apply(actorA(), mutation(value.id, "submit_report", { expectedRowVersion: report.rowVersion }))).rejects.toThrow("changed concurrently");
  });

  it("replays checklist and note mutations without duplication", async () => {
    const value = await job(), checklist = await jobs.addChecklistItem(ownerA(), value.id, { label: "Pressure checked" });
    const checklistMutation = mutation(value.id, "set_checklist", { itemId: checklist.id, completed: true });
    const noteMutation = mutation(value.id, "add_note", { body: "Saved from field" });
    await sync.apply(actorA(), checklistMutation); await sync.apply(actorA(), checklistMutation);
    await sync.apply(actorA(), noteMutation); await sync.apply(actorA(), noteMutation);
    const view = await jobs.getJob(ownerA(), value.id);
    expect(view.checklist.find((item) => item.id === checklist.id)?.completed).toBe(true);
    expect(view.notes.filter((item) => item.body === "Saved from field")).toHaveLength(1);
  });

  it("finalizes staged evidence once and detects changed bytes", async () => {
    const value = await job(), key = id();
    const request = mutation(value.id, "upload_evidence", { ...filePayload, kind: "pre_work_photo" }, key);
    const before = storage.objects.size;
    storage.failAfterPut = true;
    await expect(sync.apply(actorA(), request, staged)).rejects.toThrow("temporarily unavailable");
    storage.failAfterPut = false;
    expect(storage.objects.size).toBe(before);
    await sync.apply(actorA(), request, staged);
    const objectCount = storage.objects.size;
    const replay = await sync.apply(actorA(), request, staged);
    expect(replay.replayed).toBe(true); expect(storage.objects.size).toBe(objectCount);
    await expect(sync.apply(actorA(), mutation(value.id, "upload_evidence", { ...filePayload, sha256: "a".repeat(64), kind: "post_work_photo" }), staged)).rejects.toThrow("integrity");
  });

  it("synchronizes signature and completion with lost-acknowledgment replay", async () => {
    const value = await job();
    await sync.apply(actorA(), mutation(value.id, "upload_evidence", { ...filePayload, kind: "pre_work_photo" }), staged);
    await sync.apply(actorA(), mutation(value.id, "upload_evidence", { ...filePayload, kind: "post_work_photo" }), staged);
    const saved = await sync.apply(actorA(), mutation(value.id, "save_report", { workPerformed: "Complete work", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }));
    const rowVersion = Number(saved.result.rowVersion), submitKey = id();
    await sync.apply(actorA(), mutation(value.id, "submit_report", { expectedRowVersion: rowVersion }, submitKey));
    const report = (await completion.getCompletionView(actorA(), value.id)).report!;
    const signatureKey = id(), signatureRequest = mutation(value.id, "capture_signature", { ...filePayload, signerName: "Customer", signerRelationship: "", acknowledged: true, expectedReportSnapshotHash: report.snapshotHash! }, signatureKey, [submitKey]);
    await sync.apply(actorA(), signatureRequest, staged); expect((await sync.apply(actorA(), signatureRequest, staged)).replayed).toBe(true);
    const completionKey = id(), completionRequest = mutation(value.id, "complete_job", {}, completionKey, [signatureKey]);
    await sync.apply(actorA(), completionRequest); expect((await sync.apply(actorA(), completionRequest)).replayed).toBe(true);
    expect((await jobs.getJob(ownerA(), value.id)).job.status).toBe("completed");
  });

  it("rejects changed report signatures and preserves staged retry", async () => {
    const value = await job();
    const draft = await completion.saveReport(actorA(), value.id, { workPerformed: "First", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0 });
    const submitted = await completion.submitReport(actorA(), value.id, { expectedRowVersion: draft.rowVersion });
    await completion.saveReport(actorA(), value.id, { workPerformed: "Revised", findings: "", notes: "", materialsUsed: "", expectedRowVersion: submitted.rowVersion });
    await expect(sync.apply(actorA(), mutation(value.id, "capture_signature", { ...filePayload, signerName: "Customer", signerRelationship: "", acknowledged: true, expectedReportSnapshotHash: submitted.snapshotHash! }), staged)).rejects.toThrow("changed");
  });

  it("prevents tenant, account and assignment crossover", async () => {
    const value = await job();
    await expect(sync.apply(actorB(), mutation(value.id, "add_note", { body: "Foreign" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(sync.apply(actorA2(), mutation(value.id, "add_note", { body: "Wrong technician" }))).rejects.toBeInstanceOf(ForbiddenError);
    const foreign = await jobs.createJob(ownerB(), { customerId: customerB.id, title: "Foreign", serviceAddress: "B", technicianUserId: techB.user.id, scheduledDate: null, scheduledTime: null });
    await expect(sync.apply(actorA(), mutation(foreign.id, "complete_job", {}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects queued work after reassignment, cancellation or completion", async () => {
    const reassigned = await job();
    await jobs.scheduleJob(ownerA(), reassigned.id, { technicianUserId: techA2.user.id, scheduledDate: null, scheduledTime: null, durationMinutes: 60, timezone: "America/Vancouver", reason: "Reassigned" });
    await expect(sync.apply(actorA(), mutation(reassigned.id, "add_note", { body: "Stale assignment" }))).rejects.toBeInstanceOf(ForbiddenError);
    const cancelled = await job();
    await jobs.transitionJob(ownerA(), cancelled.id, { toStatus: "cancelled", reason: "Cancelled" });
    await expect(sync.apply(actorA(), mutation(cancelled.id, "save_report", { workPerformed: "Late", findings: "", notes: "", materialsUsed: "", expectedRowVersion: 0, baseReportId: null }))).rejects.toThrow("Closed or cancelled");
  });
});
