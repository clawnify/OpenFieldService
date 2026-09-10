import { createHash } from "node:crypto";

export const CUSTOMER_ACKNOWLEDGEMENT = "I acknowledge the work described in this submitted Job report.";

export function completionRequirements(input: {
  technicianAssigned: boolean;
  technicianActive: boolean;
  preWorkEvidenceCount: number;
  postWorkEvidenceCount: number;
  reportSubmitted: boolean;
  reportTechnicianMatches: boolean;
  matchingCustomerSignature: boolean;
}) {
  return [
    { key: "technician_assigned", label: "An active assigned technician is required", satisfied: input.technicianAssigned && input.technicianActive },
    { key: "pre_work_evidence", label: "At least one active pre-work photo is required", satisfied: input.preWorkEvidenceCount > 0 },
    { key: "post_work_evidence", label: "At least one active post-work photo is required", satisfied: input.postWorkEvidenceCount > 0 },
    { key: "submitted_report", label: "A submitted Job report is required", satisfied: input.reportSubmitted && input.reportTechnicianMatches },
    { key: "customer_signature", label: "A customer signature for the submitted report is required", satisfied: input.matchingCustomerSignature },
  ] as const;
}

export function jobReportSnapshotHash(snapshot: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
