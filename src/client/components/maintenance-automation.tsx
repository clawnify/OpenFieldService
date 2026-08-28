import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useAuth } from "../auth-context";
import { RefreshCw, Search, X } from "lucide-preact";
import type { MaintenanceSchedule, MaintenanceOccurrence, MaintenanceAutomationRun } from "../types";

const SCHEDULE_STATUS_LABELS: Record<string, string> = { active: "Active", paused: "Paused", cancelled: "Cancelled" };
const OCCURRENCE_STATUS_LABELS: Record<string, string> = { pending: "Pending", job_generated: "Job Generated", skipped: "Skipped" };

interface PreviewOccurrence { scheduleId: number; membershipId: number; dueDate: string; dueState: string }
interface PreviewRenewal { agreementId: number; identifier: string; expiresAt: string; daysUntilExpiry: number; autoRenewEligible: boolean }
interface RunSummary {
  organizationsScanned: number; occurrencesProcessed: number; jobsGenerated: number;
  renewalsProcessed: number; remindersSent: number; erroredCount: number; errorSummary: string;
}

/**
 * Phase 19C — Admin/Dispatcher Maintenance Automation dashboard. Self-
 * contained (own local fetch/state), same precedent as maintenance-plans.tsx/
 * maintenance-agreement-list.tsx. Schedules/Occurrences are visible to both
 * admin and dispatcher (server's canManageSchedules); the execution ledger,
 * manual runner, and preview are admin-only (server enforces this
 * independently — see runAutomationRoute/listAutomationRunsRoute/
 * previewAutomationRoute in index.ts, admin-only regardless of what renders
 * here).
 */
export function MaintenanceAutomation({ navigate }: { navigate: (to: string) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [schedules, setSchedules] = useState<MaintenanceSchedule[]>([]);
  const [occurrences, setOccurrences] = useState<MaintenanceOccurrence[]>([]);
  const [runs, setRuns] = useState<MaintenanceAutomationRun[]>([]);
  const [previewOccurrences, setPreviewOccurrences] = useState<PreviewOccurrence[]>([]);
  const [previewRenewals, setPreviewRenewals] = useState<PreviewRenewal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRunSummary, setLastRunSummary] = useState<RunSummary | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reasonPrompt, setReasonPrompt] = useState<{ scheduleId: number; action: "pause" | "cancel" } | null>(null);
  const [reasonText, setReasonText] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [schedulesRes, occurrencesRes] = await Promise.all([
        api<{ schedules: MaintenanceSchedule[] }>("GET", "/api/maintenance/schedules"),
        api<{ occurrences: MaintenanceOccurrence[] }>("GET", "/api/maintenance/occurrences"),
      ]);
      setSchedules(schedulesRes.schedules);
      setOccurrences(occurrencesRes.occurrences);
      if (isAdmin) {
        const runsRes = await api<{ runs: MaintenanceAutomationRun[] }>("GET", "/api/maintenance/automation/runs");
        setRuns(runsRes.runs);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const summary = await api<RunSummary>("POST", "/api/maintenance/automation/run", {});
      setLastRunSummary(summary);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const data = await api<{ occurrences: PreviewOccurrence[]; renewals: PreviewRenewal[] }>("GET", "/api/maintenance/automation/preview");
      setPreviewOccurrences(data.occurrences);
      setPreviewRenewals(data.renewals);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const resumeSchedule = async (id: number) => {
    try {
      await api("POST", `/api/maintenance/schedules/${id}/resume`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submitReason = async () => {
    if (!reasonPrompt || !reasonText.trim()) return;
    try {
      await api("POST", `/api/maintenance/schedules/${reasonPrompt.scheduleId}/${reasonPrompt.action}`, { reason: reasonText.trim() });
      setReasonPrompt(null);
      setReasonText("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Maintenance Automation</h1>
        {isAdmin && (
          <div class="form-row">
            <button class="btn btn-sm" disabled={previewing} onClick={runPreview}><Search size={14} /> {previewing ? "Loading..." : "Preview"}</button>
            <button class="btn btn-primary" disabled={running} onClick={runNow}><RefreshCw size={14} /> {running ? "Running..." : "Run Now"}</button>
          </div>
        )}
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      {lastRunSummary && (
        <div class="card">
          <h2>Last Manual Run</h2>
          <p>
            Occurrences processed: {lastRunSummary.occurrencesProcessed} · Jobs generated: {lastRunSummary.jobsGenerated} ·
            {" "}Renewals processed: {lastRunSummary.renewalsProcessed} · Reminders sent: {lastRunSummary.remindersSent} ·
            {" "}Errors: {lastRunSummary.erroredCount}
          </p>
          {lastRunSummary.errorSummary && <p class="inline-error">{lastRunSummary.errorSummary}</p>}
        </div>
      )}

      {(previewOccurrences.length > 0 || previewRenewals.length > 0) && (
        <div class="card">
          <h2>Preview (not yet executed)</h2>
          {previewOccurrences.length > 0 && (
            <>
              <p class="text-bold">Due Occurrences</p>
              <ul>
                {previewOccurrences.map((p, i) => (
                  <li key={i}>Schedule #{p.scheduleId} (membership #{p.membershipId}) — due {p.dueDate} ({p.dueState})</li>
                ))}
              </ul>
            </>
          )}
          {previewRenewals.length > 0 && (
            <>
              <p class="text-bold">Upcoming Renewals</p>
              <ul>
                {previewRenewals.map((r) => (
                  <li key={r.agreementId}>
                    <a href={`/maintenance-agreements/${r.agreementId}`} onClick={(e) => { e.preventDefault(); navigate(`/maintenance-agreements/${r.agreementId}`); }}>{r.identifier}</a>
                    {" "}— expires {r.expiresAt} ({r.daysUntilExpiry}d) — {r.autoRenewEligible ? "auto-renew eligible" : "requires fresh acceptance"}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div class="card">
        <h2>Recurring Schedules</h2>
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : schedules.length === 0 ? (
          <div class="empty-state"><p>No recurring schedules yet — create one from a Maintenance Agreement's membership.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Membership</th><th>Recurrence</th><th>Status</th><th>Next Due</th><th>Cycles</th><th></th></tr></thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} class="table-row">
                    <td class="text-bold">#{s.membership_id}</td>
                    <td>{s.recurrence_type}{s.recurrence_type === "CUSTOM_DAYS" ? ` (${s.custom_interval_days}d)` : ""}</td>
                    <td>{SCHEDULE_STATUS_LABELS[s.status] || s.status}</td>
                    <td class="text-muted">{s.next_due_date}</td>
                    <td>{s.cycles_generated}</td>
                    <td>
                      {s.status === "active" && <button class="btn btn-sm" onClick={() => { setReasonPrompt({ scheduleId: s.id, action: "pause" }); setReasonText(""); }}>Pause</button>}
                      {s.status === "paused" && <button class="btn btn-sm" onClick={() => resumeSchedule(s.id)}>Resume</button>}
                      {s.status !== "cancelled" && <>{" "}<button class="btn btn-sm btn-danger" onClick={() => { setReasonPrompt({ scheduleId: s.id, action: "cancel" }); setReasonText(""); }}>Cancel</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="card">
        <h2>Occurrences</h2>
        {occurrences.length === 0 ? (
          <div class="empty-state"><p>No occurrences generated yet.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Schedule</th><th>Cycle</th><th>Due Date</th><th>Status</th><th>Job</th></tr></thead>
              <tbody>
                {occurrences.map((o) => (
                  <tr key={o.id} class="table-row">
                    <td class="text-bold">#{o.schedule_id}</td>
                    <td>{o.cycle_number}</td>
                    <td class="text-muted">{o.due_date}</td>
                    <td>{OCCURRENCE_STATUS_LABELS[o.status] || o.status}{o.skip_reason ? ` — ${o.skip_reason}` : ""}</td>
                    <td>{o.job_id ? <a href={`/jobs/${o.job_id}`} onClick={(e) => { e.preventDefault(); navigate(`/jobs/${o.job_id}`); }}>#{o.job_id}</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin && (
        <div class="card">
          <h2>Automation Run History</h2>
          {runs.length === 0 ? (
            <div class="empty-state"><p>No automation runs recorded yet.</p></div>
          ) : (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Occurrences</th><th>Jobs</th><th>Renewals</th><th>Reminders</th><th>Errors</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} class="table-row">
                      <td class="text-muted">{r.started_at.slice(0, 16).replace("T", " ")}</td>
                      <td>{r.triggered_by}</td>
                      <td>{r.status}</td>
                      <td>{r.occurrences_processed}</td>
                      <td>{r.jobs_generated}</td>
                      <td>{r.renewals_processed}</td>
                      <td>{r.reminders_sent}</td>
                      <td>{r.errored_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {reasonPrompt && (
        <div class="modal-overlay" onClick={() => setReasonPrompt(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{reasonPrompt.action === "pause" ? "Pause Schedule" : "Cancel Schedule"}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setReasonPrompt(null)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label for="ma-schedule-reason">Reason</label>
                <textarea id="ma-schedule-reason" rows={2} value={reasonText} onInput={(e) => setReasonText((e.target as HTMLTextAreaElement).value)} />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setReasonPrompt(null)}>Back</button>
              <button class="btn btn-primary" disabled={!reasonText.trim()} onClick={submitReason}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
