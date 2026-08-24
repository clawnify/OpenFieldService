/**
 * Phase 12 — Quote status display data. Dependency-free (no Preact import),
 * same precedent as lead-status.ts. Mirrors src/server/quote-workflow.ts's
 * approved matrix for DISPLAY PURPOSES ONLY — the server (transitionQuote())
 * remains the sole transition authority; if this ever drifts, the worst
 * case is a button the server rejects with a 400/409, never a security or
 * data-integrity issue. Do not add business validation logic here.
 */

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "cancelled"] as const;
export type QuoteStatus = typeof QUOTE_STATUSES[number];

export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const QUOTE_STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  sent: "#3b82f6",
  accepted: "#16a34a",
  rejected: "#dc2626",
  expired: "#9ca3af",
  cancelled: "#9ca3af",
};

export const LINE_ITEM_CATEGORIES = ["service", "labor", "material", "equipment", "other"] as const;

export const LINE_ITEM_CATEGORY_LABELS: Record<string, string> = {
  service: "Service",
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  other: "Other",
};

export const DISCOUNT_TYPES = ["none", "fixed", "percent"] as const;
