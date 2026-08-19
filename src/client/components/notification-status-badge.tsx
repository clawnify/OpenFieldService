import { NOTIFICATION_STATUS_COLORS, NOTIFICATION_STATUS_LABELS } from "../notification-status";

/** Reuses the existing generic `.status-badge`/`.status-dot` CSS (see
 *  status-badge.tsx) — those classes were never job-status-specific, only
 *  the colors passed inline were, so this is genuine reuse, not a
 *  parallel copy. Text + color + a visible dot, never color alone. */
export function NotificationStatusBadge({ status }: { status: string }) {
  const color = NOTIFICATION_STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {NOTIFICATION_STATUS_LABELS[status] || status}
    </span>
  );
}
