import type { JobStatus, Priority } from "../types";

export const STATUS_COLORS: Record<JobStatus, string> = {
  scheduled: "#3b82f6",
  in_progress: "#f59e0b",
  completed: "#16a34a",
  invoiced: "#0f766e",
  free_estimate: "#8b5cf6",
  application_pending: "#a855f7",
  eligibility_approved: "#0891b2",
  install_scheduled: "#2563eb",
  gov_portal_submitted: "#15803d",
  cancelled: "#6b7280",
};

// Record<string, ...>, not Record<JobStatus, ...>: also used to look up labels for
// arbitrary status strings returned by GET /api/jobs/{id}/transitions (job-detail.tsx),
// which the client doesn't (and must not) re-validate against its own status list —
// the server is the source of truth for which statuses exist.
export const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In Progress",
  completed: "Completed",
  invoiced: "Invoiced",
  free_estimate: "Free Estimate",
  application_pending: "Application Pending",
  eligibility_approved: "Eligibility Approved",
  install_scheduled: "Install Scheduled",
  gov_portal_submitted: "Gov Portal Submitted",
  cancelled: "Cancelled",
};

// Short visible-text alternative to the bare status-color dot used on the
// Scheduler's month-grid tiles (Phase 7) — "do not rely on color alone" is
// satisfied by an aria-label alone for screen readers, but a sighted
// color-blind user needs a VISIBLE distinguishing mark too, not just an
// accessible name. Kept intentionally short (≤3 chars) so it doesn't
// overload a small calendar tile the way the full STATUS_LABELS text would.
export const STATUS_ABBR: Record<string, string> = {
  scheduled: "SCH",
  in_progress: "IP",
  completed: "C",
  invoiced: "INV",
  free_estimate: "FE",
  application_pending: "AP",
  eligibility_approved: "EA",
  install_scheduled: "IS",
  gov_portal_submitted: "GPS",
  cancelled: "X",
};

const PRIORITY_COLORS: Record<Priority, string> = {
  low: "#6b7280",
  normal: "#3b82f6",
  high: "#f59e0b",
  urgent: "#dc2626",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const color = PRIORITY_COLORS[priority] || "#6b7280";
  return (
    <span class="priority-badge" style={{ color }}>
      {priority.charAt(0).toUpperCase() + priority.slice(1)}
    </span>
  );
}
