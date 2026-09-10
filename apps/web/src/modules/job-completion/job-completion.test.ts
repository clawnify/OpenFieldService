import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { addJobEvidenceSchema, captureJobSignatureSchema, saveJobReportSchema } from "./job-completion.schema";
import { completionRequirements, jobReportSnapshotHash } from "./job-completion.rules";

describe("Global Job completion rules", () => {
  it("requires technician, both evidence phases, submitted report and matching signature", () => {
    const blocked = completionRequirements({
      technicianAssigned: true,
      technicianActive: true,
      preWorkEvidenceCount: 1,
      postWorkEvidenceCount: 0,
      reportSubmitted: true,
      reportTechnicianMatches: true,
      matchingCustomerSignature: false,
    });
    expect(blocked.filter((item) => !item.satisfied).map((item) => item.key)).toEqual(["post_work_evidence", "customer_signature"]);
    expect(completionRequirements({
      technicianAssigned: true,
      technicianActive: true,
      preWorkEvidenceCount: 1,
      postWorkEvidenceCount: 1,
      reportSubmitted: true,
      reportTechnicianMatches: true,
      matchingCustomerSignature: true,
    }).every((item) => item.satisfied)).toBe(true);
  });

  it("binds signatures to deterministic submitted report content", () => {
    const snapshot = { job: { id: "job-1" }, report: { workPerformed: "Inspected" }, checklist: [] };
    expect(jobReportSnapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(jobReportSnapshotHash(snapshot)).toBe(jobReportSnapshotHash(snapshot));
    expect(jobReportSnapshotHash({ ...snapshot, report: { workPerformed: "Changed" } })).not.toBe(jobReportSnapshotHash(snapshot));
  });

  it("uses strict Zod 4 boundaries and rejects authoritative field injection", () => {
    expect(() => addJobEvidenceSchema.parse({ attachmentId: crypto.randomUUID(), kind: "pre_work_photo", organizationId: crypto.randomUUID() })).toThrow();
    expect(() => saveJobReportSchema.parse({ workPerformed: "Done", expectedRowVersion: 0, submittedAt: new Date() })).toThrow();
    expect(() => captureJobSignatureSchema.parse({ attachmentId: crypto.randomUUID(), signerName: "Customer", signerRelationship: "", acknowledged: false })).toThrow();
  });

  it("grants workflow permissions to office roles and field members, never viewers", () => {
    for (const permission of ["job.evidence.manage", "job.report.write", "job.report.submit", "job.signature.capture"] as const) {
      expect(can({ role: "owner" }, permission)).toBe(true);
      expect(can({ role: "manager" }, permission)).toBe(true);
      expect(can({ role: "member" }, permission)).toBe(true);
      expect(can({ role: "viewer" }, permission)).toBe(false);
    }
  });
});
