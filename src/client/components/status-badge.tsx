import type { JobStatus, Priority, InvoiceStatus } from "../types";

const STATUS_TONES: Record<JobStatus | InvoiceStatus, string> = {
  scheduled: "info", confirmed: "info", in_progress: "warning", completed: "success",
  cancelled: "muted", draft: "muted", sent: "info", paid: "success", overdue: "danger",
};
const PRIORITY_TONES: Record<Priority, string> = { low: "muted", normal: "muted", high: "warning", urgent: "danger" };
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

export function StatusBadge({ status }: { status: JobStatus | InvoiceStatus }) {
  return <span class={`status-badge badge-${STATUS_TONES[status] || "muted"}`}><span class="status-dot" />{label(status)}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span class={`priority-badge badge-${PRIORITY_TONES[priority] || "muted"}`}>{label(priority)}</span>;
}
