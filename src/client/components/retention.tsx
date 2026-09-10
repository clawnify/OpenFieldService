import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useAuth } from "../auth-context";
import { RefreshCw, X } from "lucide-preact";

/**
 * Phase 19D — Admin/Dispatcher Retention dashboard: follow-up queue,
 * satisfaction/escalation, referral program config + ledger, loyalty
 * credit management. Self-contained (own fetch/state), same precedent as
 * maintenance-automation.tsx (Phase 19C). Admin-only sections (referral
 * program config, run history, manual credit issuance) are additionally
 * gated client-side; independently enforced admin-only server-side
 * regardless of what renders here.
 */

interface FollowUp {
  id: number; job_id: number; customer_id: number; status: string; due_date: string;
  response: string; response_notes: string; review_status: string;
}
interface Referral {
  id: number; referrer_customer_id: number; referral_code: string; status: string;
  qualified_at: string | null; created_at: string;
}
interface ReferralProgram {
  enabled: number; reward_type: string; reward_value_cents: number | null; reward_description: string; qualification_rule: string;
}
interface RetentionRun {
  id: number; started_at: string; triggered_by: string; status: string;
  follow_ups_created: number; review_requests_sent: number; referrals_qualified: number; rewards_issued: number;
  campaign_recipients_queued: number; campaign_sends: number; errored_count: number;
}

const FOLLOWUP_STATUS_LABELS: Record<string, string> = {
  pending: "Pending", sent: "Sent", satisfied: "Satisfied", needs_attention: "Needs Attention",
  closed: "Closed", failed: "Failed", suppressed: "Suppressed",
};

export function Retention() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [followUpFilter, setFollowUpFilter] = useState("needs_attention");
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [program, setProgram] = useState<ReferralProgram | null>(null);
  const [runs, setRuns] = useState<RetentionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editingProgram, setEditingProgram] = useState(false);
  const [programDraft, setProgramDraft] = useState<ReferralProgram>({ enabled: 0, reward_type: "account_credit", reward_value_cents: 0, reward_description: "", qualification_rule: "first_completed_job" });
  const [savingProgram, setSavingProgram] = useState(false);
  // Kept as free-typed text, separate from programDraft.reward_value_cents — a
  // controlled input whose value is re-derived from cents on every keystroke
  // fights the user's cursor (e.g. typing "25" renders "2.00" then "2.01").
  // Cents are parsed from this text only on save.
  const [rewardValueText, setRewardValueText] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [followUpsRes, referralsRes, programRes] = await Promise.all([
        api<{ followUps: FollowUp[] }>("GET", `/api/retention/follow-ups${followUpFilter ? `?status=${followUpFilter}` : ""}`),
        api<{ referrals: Referral[] }>("GET", "/api/retention/referrals"),
        api<{ program: ReferralProgram }>("GET", "/api/retention/referral-program"),
      ]);
      setFollowUps(followUpsRes.followUps);
      setReferrals(referralsRes.referrals);
      setProgram(programRes.program);
      if (isAdmin) {
        const runsRes = await api<{ runs: RetentionRun[] }>("GET", "/api/retention/automation/runs");
        setRuns(runsRes.runs);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [followUpFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeFollowUp = async (id: number) => {
    try {
      await api("POST", `/api/retention/follow-ups/${id}/close`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await api("POST", "/api/retention/automation/run", {});
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const openEditProgram = () => {
    const draft = program ?? programDraft;
    setProgramDraft(draft);
    setRewardValueText(draft.reward_value_cents != null ? (draft.reward_value_cents / 100).toFixed(2) : "");
    setEditingProgram(true);
  };

  const saveProgram = async () => {
    setSavingProgram(true);
    setError(null);
    try {
      const rewardValueCents = rewardValueText.trim() === "" ? null : Math.round(parseFloat(rewardValueText) * 100);
      const res = await api<{ program: ReferralProgram }>("PUT", "/api/retention/referral-program", {
        enabled: !!programDraft.enabled, reward_type: programDraft.reward_type,
        reward_value_cents: rewardValueCents, reward_description: programDraft.reward_description,
        qualification_rule: programDraft.qualification_rule,
      });
      setProgram(res.program);
      setEditingProgram(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingProgram(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Retention</h1>
        {isAdmin && (
          <button class="btn btn-primary" disabled={running} onClick={runNow}><RefreshCw size={14} /> {running ? "Running..." : "Run Now"}</button>
        )}
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        <h2>Follow-Up Queue</h2>
        <div class="toolbar">
          <div class="filter-group">
            {["needs_attention", "pending", "sent", "satisfied", "closed", ""].map((s) => (
              <button key={s || "all"} class={`filter-btn ${followUpFilter === s ? "active" : ""}`} onClick={() => setFollowUpFilter(s)}>
                {s ? FOLLOWUP_STATUS_LABELS[s] : "All"}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : followUps.length === 0 ? (
          <div class="empty-state"><p>No follow-ups in this state.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Customer</th><th>Job</th><th>Status</th><th>Due</th><th>Response</th><th></th></tr></thead>
              <tbody>
                {followUps.map((f) => (
                  <tr key={f.id} class="table-row">
                    <td class="text-bold">#{f.customer_id}</td>
                    <td>#{f.job_id}</td>
                    <td>{FOLLOWUP_STATUS_LABELS[f.status] || f.status}</td>
                    <td class="text-muted">{f.due_date}</td>
                    <td>{f.response_notes || "—"}</td>
                    <td>{f.status !== "closed" && <button class="btn btn-sm" onClick={() => closeFollowUp(f.id)}>Close</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="card">
        <div class="page-header" style={{ marginBottom: 8 }}>
          <h2>Referral Program</h2>
          {isAdmin && <button class="btn btn-sm" onClick={openEditProgram}>Configure</button>}
        </div>
        {program ? (
          <p>
            {program.enabled ? "Enabled" : "Disabled"} · Reward: {program.reward_type}
            {program.reward_value_cents != null ? ` ($${(program.reward_value_cents / 100).toFixed(2)})` : ""}
            {" "}· Qualifies on: {program.qualification_rule === "first_completed_job" ? "first completed Job" : "first paid Invoice"}
          </p>
        ) : <p class="text-muted">Not configured.</p>}
      </div>

      <div class="card">
        <h2>Referrals</h2>
        {referrals.length === 0 ? (
          <div class="empty-state"><p>No referrals yet.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Referrer</th><th>Code</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {referrals.map((r) => (
                  <tr key={r.id} class="table-row">
                    <td class="text-bold">#{r.referrer_customer_id}</td>
                    <td><span class="identifier">{r.referral_code}</span></td>
                    <td>{r.status}</td>
                    <td class="text-muted">{r.created_at.slice(0, 10)}</td>
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
                <thead><tr><th>Started</th><th>Trigger</th><th>Follow-Ups</th><th>Referrals</th><th>Rewards</th><th>Campaign Sends</th><th>Errors</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} class="table-row">
                      <td class="text-muted">{r.started_at.slice(0, 16).replace("T", " ")}</td>
                      <td>{r.triggered_by}</td>
                      <td>{r.follow_ups_created}</td>
                      <td>{r.referrals_qualified}</td>
                      <td>{r.rewards_issued}</td>
                      <td>{r.campaign_sends}</td>
                      <td>{r.errored_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editingProgram && (
        <div class="modal-overlay" onClick={() => setEditingProgram(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Referral Program</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setEditingProgram(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <label class="checkbox-row">
                <input type="checkbox" checked={!!programDraft.enabled} onChange={(e) => setProgramDraft({ ...programDraft, enabled: (e.target as HTMLInputElement).checked ? 1 : 0 })} />
                Enabled
              </label>
              <div class="form-group">
                <label for="ref-reward-type">Reward Type</label>
                <select id="ref-reward-type" value={programDraft.reward_type} onChange={(e) => setProgramDraft({ ...programDraft, reward_type: (e.target as HTMLSelectElement).value })}>
                  <option value="account_credit">Account Credit</option>
                  <option value="fixed_reward">Fixed Reward</option>
                  <option value="service_credit">Service Credit</option>
                  <option value="future_discount">Future Discount</option>
                  <option value="non_cash">Non-Cash</option>
                </select>
              </div>
              <div class="form-group">
                <label for="ref-reward-value">Reward Value (dollars, blank for non-cash)</label>
                <input
                  id="ref-reward-value" type="text" inputMode="decimal"
                  value={rewardValueText}
                  onInput={(e) => setRewardValueText((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-group">
                <label for="ref-reward-desc">Reward Description</label>
                <input id="ref-reward-desc" type="text" value={programDraft.reward_description} onInput={(e) => setProgramDraft({ ...programDraft, reward_description: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="form-group">
                <label for="ref-qualify">Qualification Rule</label>
                <select id="ref-qualify" value={programDraft.qualification_rule} onChange={(e) => setProgramDraft({ ...programDraft, qualification_rule: (e.target as HTMLSelectElement).value })}>
                  <option value="first_completed_job">First completed Job</option>
                  <option value="first_paid_invoice">First paid Invoice</option>
                </select>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setEditingProgram(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={savingProgram} onClick={saveProgram}>{savingProgram ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
