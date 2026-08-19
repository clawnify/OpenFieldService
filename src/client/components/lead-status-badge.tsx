import { LEAD_STATUS_COLORS, LEAD_STATUS_LABELS } from "../lead-status";

/** Same visual pattern as StatusBadge (status-badge.tsx) — a separate
 *  component because Lead statuses are a distinct vocabulary from Job
 *  statuses, not a variant of them. Status is never conveyed by color
 *  alone: the label text is always rendered alongside the color dot. */
export function LeadStatusBadge({ status }: { status: string }) {
  const color = LEAD_STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {LEAD_STATUS_LABELS[status] || status}
    </span>
  );
}
