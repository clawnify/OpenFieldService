import { useState, useEffect, useCallback } from "preact/hooks";
import { api } from "../api";
import { CalendarCheck, CalendarClock, CalendarX, RefreshCw } from "lucide-preact";
import type { JobSyncStatus } from "../types";

/** Small "synced with Google Calendar" indicator for a job, shown only for users
 *  who have Google Calendar connected. Silently renders nothing otherwise. */
export function GoogleSyncBadge({ jobId }: { jobId: number }) {
  const [status, setStatus] = useState<JobSyncStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api<JobSyncStatus>("GET", `/api/integrations/google-calendar/jobs/${jobId}`);
      setStatus(res);
    } catch {
      // Not connected, or the request failed — just don't show a badge.
      setStatus(null);
    }
  }, [jobId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await api("POST", `/api/integrations/google-calendar/jobs/${jobId}/retry`);
      await fetchStatus();
    } finally {
      setRetrying(false);
    }
  };

  if (!status || !status.sync_status) return null;

  if (status.sync_status === "synced") {
    return (
      <div class="google-sync-badge synced">
        <CalendarCheck size={14} /> Google Calendar synced
      </div>
    );
  }

  if (status.sync_status === "failed") {
    return (
      <div class="google-sync-badge failed">
        <CalendarX size={14} /> Google Calendar sync failed
        <button class="btn btn-sm" onClick={handleRetry} disabled={retrying}>
          <RefreshCw size={12} class={retrying ? "spin" : ""} /> {retrying ? "Retrying..." : "Retry"}
        </button>
      </div>
    );
  }

  if (status.sync_status === "deleted") {
    return (
      <div class="google-sync-badge muted">
        <CalendarClock size={14} /> Not on Google Calendar
      </div>
    );
  }

  return null;
}
