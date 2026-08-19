import { Fragment } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Pagination } from "./pagination";
import { NotificationStatusBadge } from "./notification-status-badge";
import {
  businessFriendlyStatusMessage, channelLabel, describeSchedule, eventTypeLabel, formatNotificationDateTime,
} from "../notification-status";
import { ChevronDown, ChevronUp } from "lucide-preact";
import type { PaginatedState } from "../types";

interface NotificationRow {
  id: number; event_type: string; channel: string; recipient: string; status: string;
  attempts: number; last_error: string; scheduled_for: string; sent_at: string | null; created_at: string;
}
interface AttemptRow {
  notification_id: number; attempt_number: number; status: string; provider_message_id: string | null;
  error_code: string; error_message: string; attempted_at: string; completed_at: string | null;
}
interface HistoryResponse { notifications: NotificationRow[]; attempts: AttemptRow[]; total: number }

const ENTITY_PATHS: Record<string, string> = {
  customer: "/api/customers", lead: "/api/leads", job: "/api/jobs", invoice: "/api/invoices",
};

const COMPACT_LIMIT = 5;
const FULL_LIMIT = 25;

/**
 * Phase 9.3 — read-only notification history for a Customer/Lead/Job/
 * Invoice. Self-contained, same pattern as NotificationPreferences.
 * Starts compact (5 most recent); "View all" switches to a paginated full
 * table using the existing Pagination component. Delivery attempts are
 * shown per-row via an expand toggle — safe fields only (Section 16), and
 * only rendered for admin/dispatcher (the API itself already blocks a
 * technician from ever reaching this data at all).
 */
export function NotificationHistory({
  entityType, entityId, role,
}: {
  entityType: "customer" | "lead" | "job" | "invoice";
  entityId: number;
  role: string | undefined;
}) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewingAll, setViewingAll] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const limit = viewingAll ? FULL_LIMIT : COMPACT_LIMIT;
  const path = ENTITY_PATHS[entityType];

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<HistoryResponse>("GET", `${path}/${entityId}/notifications?page=${viewingAll ? page : 1}&limit=${limit}`);
      setData(res);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path, entityId, viewingAll, page, limit]);

  // Phase 9.5 browser verification fix — see the identical fix in
  // notification-preferences.tsx for the full explanation: the fetch used
  // to fire unconditionally even though a technician always renders null
  // below, causing a spontaneous, doomed 403 (and console error) on every
  // job/customer/lead/invoice detail page a technician opens.
  useEffect(() => { if (role !== "technician") load(); }, [load, role]);

  if (role === "technician") return null;

  if (loading) return <div class="detail-section"><h3>Notifications</h3><p class="text-muted">Loading...</p></div>;

  if (loadError) {
    return (
      <div class="detail-section">
        <h3>Notifications</h3>
        <div class="inline-error">{loadError}</div>
      </div>
    );
  }

  if (!data || data.notifications.length === 0) {
    return (
      <div class="detail-section">
        <h3>Notifications</h3>
        <p class="text-muted">No notification history yet. Messages sent for this record will appear here.</p>
      </div>
    );
  }

  const attemptsFor = (id: number) => data.attempts.filter((a) => a.notification_id === id);
  const pag: PaginatedState = { page, limit, total: data.total };

  return (
    <div class="detail-section">
      <div class="notification-history-header">
        <h3>Notifications ({data.total})</h3>
        {!viewingAll && data.total > COMPACT_LIMIT && (
          <button type="button" class="btn btn-sm" onClick={() => { setViewingAll(true); setPage(1); }}>View All</button>
        )}
      </div>
      <div class="table-wrap">
        <table class="table notification-history-table">
          <thead>
            <tr>
              <th>Type</th><th>Channel</th><th>Recipient</th><th>Status</th><th>When</th><th />
            </tr>
          </thead>
          <tbody>
            {data.notifications.map((n) => {
              const attempts = attemptsFor(n.id);
              const message = businessFriendlyStatusMessage(n.status, n.attempts, n.channel, n.last_error);
              const isExpanded = expanded === n.id;
              return (
                <Fragment key={n.id}>
                  <tr class="table-row">
                    <td>{eventTypeLabel(n.event_type)}</td>
                    <td>{channelLabel(n.channel)}</td>
                    <td class="text-muted">{n.recipient}</td>
                    <td><NotificationStatusBadge status={n.status} /></td>
                    <td class="text-muted">
                      {n.status === "sent" && n.sent_at ? formatNotificationDateTime(n.sent_at)
                        : n.status === "pending" ? describeSchedule(n.status, n.scheduled_for)
                          : formatNotificationDateTime(n.created_at)}
                    </td>
                    <td>
                      {attempts.length > 0 && (
                        <button
                          type="button" class="btn-icon" aria-label={isExpanded ? "Hide delivery attempts" : "Show delivery attempts"}
                          onClick={() => setExpanded(isExpanded ? null : n.id)}
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      )}
                    </td>
                  </tr>
                  {message && (
                    <tr class="notification-history-message-row">
                      <td colSpan={6} class="text-muted">{message}</td>
                    </tr>
                  )}
                  {isExpanded && attempts.length > 0 && (
                    <tr>
                      <td colSpan={6}>
                        <table class="table notification-attempts-table">
                          <thead>
                            <tr><th>Attempt</th><th>Status</th><th>Time</th><th>Provider ID</th><th>Error</th></tr>
                          </thead>
                          <tbody>
                            {attempts.map((a) => (
                              <tr key={a.attempt_number}>
                                <td>{a.attempt_number}</td>
                                <td>{a.status === "succeeded" ? "Succeeded" : "Failed"}</td>
                                <td class="text-muted">{formatNotificationDateTime(a.attempted_at)}</td>
                                <td class="text-muted">{a.provider_message_id || "—"}</td>
                                <td class="text-muted">{a.error_message || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {viewingAll && <Pagination pag={pag} setPage={setPage} />}
    </div>
  );
}
