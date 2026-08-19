import { useState, useEffect, useCallback } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import {
  Link2, CalendarSync, RefreshCw, Unlink, CircleCheck, CircleAlert, CircleX,
} from "lucide-preact";
import type { GoogleCalendarStatus, GoogleCalendarEntry, GoogleSyncResult } from "../types";

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Google Calendar connected successfully.",
  denied: "Google authorization was declined.",
  invalid_request: "The connection request was invalid or expired. Please try again.",
  error: "Something went wrong connecting Google Calendar. Please try again.",
  not_configured: "Google Calendar integration is not configured on this server.",
};

function statusLabel(status?: string): string {
  switch (status) {
    case "connected": return "Connected";
    case "needs_reauth": return "Needs Reauthorization";
    default: return status ? status.replace("_", " ") : "Unknown";
  }
}

function StatusIcon({ status }: { status?: string }) {
  if (status === "connected") return <CircleCheck size={16} color="#16a34a" />;
  if (status === "needs_reauth") return <CircleAlert size={16} color="#f59e0b" />;
  return <CircleX size={16} color="#dc2626" />;
}

export function Integrations() {
  const { setError } = useApp();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null);

  const [calendars, setCalendars] = useState<GoogleCalendarEntry[] | null>(null);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [selectedCalendarId, setSelectedCalendarId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<GoogleSyncResult | null>(null);

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<GoogleCalendarStatus>("GET", "/api/integrations/google-calendar");
      setStatus(res);
      if (res.calendar_id) setSelectedCalendarId(res.calendar_id);
      if (res.sync_enabled !== undefined) setSyncEnabled(res.sync_enabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  const fetchCalendars = useCallback(async () => {
    setCalendarsLoading(true);
    try {
      const res = await api<{ calendars: GoogleCalendarEntry[] }>("GET", "/api/integrations/google-calendar/calendars");
      setCalendars(res.calendars);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCalendarsLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (g) {
      setCallbackNotice(CALLBACK_MESSAGES[g] || null);
      window.history.replaceState(null, "", window.location.pathname);
    }
    fetchStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status?.connected) fetchCalendars();
  }, [status?.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = () => {
    window.location.href = "/api/integrations/google-calendar/connect";
  };

  const handleSaveSettings = async () => {
    if (!selectedCalendarId) { setError("Select a calendar to sync with"); return; }
    setSavingSettings(true);
    try {
      const chosen = calendars?.find((cal) => cal.id === selectedCalendarId);
      await api("PUT", "/api/integrations/google-calendar/settings", {
        calendar_id: selectedCalendarId,
        calendar_summary: chosen?.summary,
        sync_enabled: syncEnabled,
      });
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api<GoogleSyncResult>("POST", "/api/integrations/google-calendar/sync");
      setSyncResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api("POST", "/api/integrations/google-calendar/disconnect");
      setShowDisconnectConfirm(false);
      setCalendars(null);
      setSyncResult(null);
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Google Calendar</h1>
      </div>

      {callbackNotice && <div class="inline-notice">{callbackNotice}</div>}

      <div class="card integration-card">
        {loading ? (
          <div class="empty-state"><p>Loading...</p></div>
        ) : !status?.connected ? (
          <div class="integration-connect">
            <div class="integration-connect-icon"><CalendarSync size={28} /></div>
            <h2>Connect your Google Calendar</h2>
            <p class="text-muted">
              Sync scheduled Field Scheduler jobs into your own Google Calendar. Each user connects
              their own account — nobody else can see or use your Google credentials.
            </p>
            <button class="btn btn-primary" onClick={handleConnect}>
              <Link2 size={16} /> Connect Google Calendar
            </button>
          </div>
        ) : (
          <>
            <div class="integration-status-row">
              <div>
                <div class="integration-status-label">Status</div>
                <div class="integration-status-value">
                  <StatusIcon status={status.status} /> {statusLabel(status.status)}
                </div>
              </div>
              <div>
                <div class="integration-status-label">Account</div>
                <div class="integration-status-value">{status.account_email}</div>
              </div>
              <div>
                <div class="integration-status-label">Calendar</div>
                <div class="integration-status-value">{status.calendar_summary || status.calendar_id}</div>
              </div>
            </div>

            {status.status === "needs_reauth" && (
              <div class="inline-error">
                Google authorization has expired.{" "}
                <button class="btn-link" onClick={handleConnect}>Reconnect</button> to keep syncing.
              </div>
            )}

            <div class="integration-actions">
              <button class="btn btn-primary" onClick={handleSyncNow} disabled={syncing}>
                <RefreshCw size={16} class={syncing ? "spin" : ""} /> {syncing ? "Syncing..." : "Sync Now"}
              </button>
              <button class="btn btn-danger" onClick={() => setShowDisconnectConfirm(true)}>
                <Unlink size={16} /> Disconnect
              </button>
            </div>

            {syncResult && (
              <div class="sync-result">
                Sync completed — {syncResult.created} created, {syncResult.updated} updated,{" "}
                {syncResult.deleted} removed{syncResult.failed > 0 ? `, ${syncResult.failed} failed` : ""}.
              </div>
            )}
          </>
        )}
      </div>

      {status?.connected && (
        <div class="card">
          <div class="integration-settings">
            <h3>Calendar Selection</h3>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Calendar</label>
                {calendarsLoading ? (
                  <span class="text-muted">Loading calendars...</span>
                ) : (
                  <select
                    value={selectedCalendarId}
                    onChange={(e) => setSelectedCalendarId((e.target as HTMLSelectElement).value)}
                  >
                    {(calendars || []).map((cal) => (
                      <option key={cal.id} value={cal.id}>{cal.summary}{cal.primary ? " (Primary)" : ""}</option>
                    ))}
                  </select>
                )}
              </div>
              <div class="form-group full-width">
                <label>Synchronization</label>
                <label class="checkbox-row" style={{ marginBottom: 0 }}>
                  <input
                    type="checkbox" checked={syncEnabled}
                    onChange={(e) => setSyncEnabled((e.target as HTMLInputElement).checked)}
                  />
                  Sync scheduled jobs
                </label>
              </div>
            </div>
            <div class="integration-settings-footer">
              <button class="btn btn-primary" onClick={handleSaveSettings} disabled={savingSettings || calendarsLoading}>
                {savingSettings ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisconnectConfirm && (
        <ConfirmDialog
          title="Disconnect Google Calendar?"
          message="Your Field Scheduler jobs will no longer sync with Google Calendar. Events already created in your Google Calendar are not deleted."
          confirmLabel="Disconnect"
          danger
          submitting={disconnecting}
          onConfirm={handleDisconnect}
          onClose={() => setShowDisconnectConfirm(false)}
        />
      )}
    </div>
  );
}
