/**
 * Phase 8.4 — Lead status display data. Dependency-free (no Preact import)
 * so it can be unit-tested directly, same precedent as navigation.ts
 * (Phase 6). Mirrors src/server/lead-workflow.ts's approved matrix for
 * DISPLAY PURPOSES ONLY — this file decides which transition buttons to
 * render, nothing more. The server (transitionLead()) remains the sole
 * transition authority; if this map ever drifts from the real one, the
 * worst case is a button the server rejects with a 409 (already handled by
 * every caller), never a security or data-integrity issue. Do not add
 * business validation logic here.
 */

export const LEAD_STATUSES = ["new", "contacted", "qualified", "estimate", "won", "lost"] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  estimate: "Estimate",
  won: "Won",
  lost: "Lost",
};

export const LEAD_STATUS_COLORS: Record<string, string> = {
  new: "#3b82f6",
  contacted: "#8b5cf6",
  qualified: "#0891b2",
  estimate: "#f59e0b",
  won: "#16a34a",
  lost: "#6b7280",
};

/** Ordinary (non-conversion) status-transition buttons to display for a
 *  given current status. Deliberately excludes "won" as a target from
 *  "estimate" — reaching Won goes through the dedicated Convert Lead flow
 *  (POST /api/leads/{id}/convert, Phase 8.3), never a plain status-transition
 *  button, so a Lead can never end up "won" without also being converted
 *  (or without the caller explicitly retrying conversion from that safe
 *  intermediate state — see lead-conversion.ts's module doc). */
export function resolveLeadDisplayTransitions(status: string): LeadStatus[] {
  switch (status) {
    case "new": return ["contacted", "lost"];
    case "contacted": return ["qualified", "lost"];
    case "qualified": return ["estimate", "lost"];
    case "estimate": return ["lost"];
    case "lost": return ["contacted"];
    default: return [];
  }
}

/** Whether the Convert Lead action should be offered — mirrors
 *  convertLead()'s own acceptance rule (estimate, or won-but-unconverted)
 *  exactly, per lead-conversion.ts. */
export function canOfferConversion(status: string, convertedCustomerId: number | null): boolean {
  if (convertedCustomerId !== null) return false;
  return status === "estimate" || status === "won";
}
