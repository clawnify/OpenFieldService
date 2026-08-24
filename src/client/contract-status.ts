/**
 * Phase 13 — Contract status display data. Dependency-free (no Preact
 * import), same precedent as quote-status.ts/lead-status.ts. Mirrors
 * src/server/contract-workflow.ts's approved matrix for DISPLAY PURPOSES
 * ONLY — the server remains the sole transition authority; the worst case
 * of drift here is a button the server rejects with a 400/409, never a
 * security or data-integrity issue. Do not add business validation logic
 * here.
 */

export const CONTRACT_STATUSES = ["draft", "sent", "partially_signed", "signed", "declined", "expired", "cancelled", "voided"] as const;
export type ContractStatus = typeof CONTRACT_STATUSES[number];

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  partially_signed: "Partially Signed",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  voided: "Voided",
};

export const CONTRACT_STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  sent: "#3b82f6",
  partially_signed: "#ca8a04",
  signed: "#16a34a",
  declined: "#dc2626",
  expired: "#9ca3af",
  cancelled: "#9ca3af",
  voided: "#9ca3af",
};

export const SIGNER_ROLES = ["customer", "co_owner", "company_rep", "guarantor", "other"] as const;

export const SIGNER_ROLE_LABELS: Record<string, string> = {
  customer: "Customer",
  co_owner: "Co-Owner",
  company_rep: "Company Representative",
  guarantor: "Guarantor",
  other: "Other",
};
