import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useAuth } from "../auth-context";
import { Plus, X, Search } from "lucide-preact";

/**
 * Phase 19D — Admin/Dispatcher Seasonal Campaigns. Self-contained (own
 * fetch/state), same precedent as maintenance-automation.tsx. Create/edit/
 * schedule/pause/cancel are admin-only (canManageCampaigns server-side);
 * dispatcher gets read-only visibility (canViewCampaigns) — both
 * independently enforced server-side regardless of what renders here.
 */

interface Campaign {
  id: number; name: string; campaign_type: string; status: string; channel: string;
  subject: string; body: string; cta_link: string; audience_filter: string;
  scheduled_for: string | null; started_at: string | null; completed_at: string | null;
}
interface Recipient { id: number; customer_id: number; channel: string; status: string; reason: string }

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", scheduled: "Scheduled", running: "Running", paused: "Paused",
  completed: "Completed", cancelled: "Cancelled", failed: "Failed",
};

const EMPTY_FORM = { name: "", channel: "email", subject: "", body: "", cta_link: "", hasActiveMembership: "" as "" | "true" | "false" };

export function Campaigns({ navigate }: { navigate: (to: string) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api<{ campaigns: Campaign[] }>("GET", "/api/campaigns");
      setCampaigns(res.campaigns);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createCampaign = async () => {
    setSaving(true);
    setError(null);
    try {
      const audience_filter: Record<string, unknown> = {};
      if (form.hasActiveMembership) audience_filter.hasActiveMembership = form.hasActiveMembership === "true";
      const res = await api<{ campaign: { id: number } }>("POST", "/api/campaigns", {
        name: form.name, channel: form.channel, subject: form.subject || undefined,
        body: form.body, cta_link: form.cta_link || undefined, audience_filter,
      });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      navigate(`/campaigns/${res.campaign.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Seasonal Campaigns</h1>
        {isAdmin && <button class="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New Campaign</button>}
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : campaigns.length === 0 ? (
          <div class="empty-state"><p>No campaigns yet.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>Scheduled</th></tr></thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} class="table-row clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                    <td class="text-bold">{c.name}</td>
                    <td>{c.channel}</td>
                    <td>{STATUS_LABELS[c.status] || c.status}</td>
                    <td class="text-muted">{c.scheduled_for ? c.scheduled_for.slice(0, 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <div class="modal-overlay" onClick={() => setShowCreate(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>New Campaign</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowCreate(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label for="camp-name">Name</label>
                <input id="camp-name" type="text" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="form-group">
                <label for="camp-channel">Channel</label>
                <select id="camp-channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: (e.target as HTMLSelectElement).value })}>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <div class="form-group">
                <label for="camp-subject">Subject (email)</label>
                <input id="camp-subject" type="text" value={form.subject} onInput={(e) => setForm({ ...form, subject: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="form-group">
                <label for="camp-body">Message</label>
                <textarea id="camp-body" rows={4} value={form.body} onInput={(e) => setForm({ ...form, body: (e.target as HTMLTextAreaElement).value })} />
              </div>
              <div class="form-group">
                <label for="camp-cta">Link (optional)</label>
                <input id="camp-cta" type="text" value={form.cta_link} onInput={(e) => setForm({ ...form, cta_link: (e.target as HTMLInputElement).value })} placeholder="https://..." />
              </div>
              <div class="form-group">
                <label for="camp-audience">Audience — Active Membership</label>
                <select id="camp-audience" value={form.hasActiveMembership} onChange={(e) => setForm({ ...form, hasActiveMembership: (e.target as HTMLSelectElement).value as "" | "true" | "false" })}>
                  <option value="">Anyone</option>
                  <option value="true">Has an active membership</option>
                  <option value="false">Does not have an active membership</option>
                </select>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowCreate(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={saving || !form.name.trim() || !form.body.trim()} onClick={createCampaign}>
                {saving ? "Creating..." : "Create Draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Detail page — audience preview, schedule/pause/resume/cancel, send
 *  ledger. Separate component (not folded into the list) matching this
 *  app's own list/detail split precedent throughout (e.g.
 *  MaintenanceAgreementList/MaintenanceAgreementDetail). */
export function CampaignDetail({ id, navigate }: { id: number; navigate: (to: string) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ totalCandidates: number; eligible: number; suppressed: number; suppressedByReason: Record<string, number> } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = async () => {
    try {
      const [campaignRes, recipientsRes] = await Promise.all([
        api<{ campaign: Campaign }>("GET", `/api/campaigns/${id}`),
        api<{ recipients: Recipient[] }>("GET", `/api/campaigns/${id}/recipients`),
      ]);
      setCampaign(campaignRes.campaign);
      setRecipients(recipientsRes.recipients);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!campaign) return <div class="loading-text">Loading...</div>;

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await api<typeof preview>("POST", `/api/campaigns/${id}/preview-audience`, {});
      setPreview(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const schedule = async () => {
    if (!scheduleDate) return;
    try {
      await api("POST", `/api/campaigns/${id}/schedule`, { scheduled_for: scheduleDate });
      setShowSchedule(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pause = async () => {
    try { await api("POST", `/api/campaigns/${id}/pause`, {}); await load(); } catch (err) { setError((err as Error).message); }
  };
  const resume = async () => {
    try { await api("POST", `/api/campaigns/${id}/resume`, {}); await load(); } catch (err) { setError((err as Error).message); }
  };
  const cancel = async () => {
    if (!cancelReason.trim()) return;
    try {
      await api("POST", `/api/campaigns/${id}/cancel`, { reason: cancelReason.trim() });
      setShowCancel(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn-icon" aria-label="Back to Campaigns" onClick={() => navigate("/campaigns")}>←</button>
        <h1>{campaign.name}</h1>
        <span class="status-badge">{STATUS_LABELS[campaign.status] || campaign.status}</span>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        <h2>Content</h2>
        <p><strong>Channel:</strong> {campaign.channel}</p>
        {campaign.subject && <p><strong>Subject:</strong> {campaign.subject}</p>}
        <p style={{ whiteSpace: "pre-wrap" }}>{campaign.body}</p>
        {campaign.cta_link && <p><strong>Link:</strong> {campaign.cta_link}</p>}
        {campaign.status !== "draft" && <p class="text-muted">Content is frozen — this campaign has left draft status.</p>}
      </div>

      {isAdmin && (
        <div class="card">
          <h2>Audience</h2>
          <button class="btn btn-sm" disabled={previewing} onClick={runPreview}><Search size={14} /> {previewing ? "Loading..." : "Preview Audience"}</button>
          {preview && (
            <p style={{ marginTop: 8 }}>
              {preview.totalCandidates} candidates · {preview.eligible} eligible · {preview.suppressed} suppressed
              {Object.keys(preview.suppressedByReason).length > 0 && (
                <> ({Object.entries(preview.suppressedByReason).map(([reason, count]) => `${reason}: ${count}`).join(", ")})</>
              )}
            </p>
          )}
        </div>
      )}

      {isAdmin && (
        <div class="card">
          <h2>Lifecycle</h2>
          {campaign.status === "draft" && (
            !showSchedule ? (
              <button class="btn btn-primary" onClick={() => setShowSchedule(true)}>Schedule</button>
            ) : (
              <div class="form-row">
                <input type="date" value={scheduleDate} onInput={(e) => setScheduleDate((e.target as HTMLInputElement).value)} />
                <button class="btn" onClick={() => setShowSchedule(false)}>Cancel</button>
                <button class="btn btn-primary" disabled={!scheduleDate} onClick={schedule}>Confirm Schedule</button>
              </div>
            )
          )}
          {["scheduled", "running"].includes(campaign.status) && <button class="btn btn-sm" onClick={pause}>Pause</button>}
          {campaign.status === "paused" && <button class="btn btn-sm" onClick={resume}>Resume</button>}
          {!["completed", "cancelled"].includes(campaign.status) && (
            !showCancel ? (
              <button class="btn btn-sm btn-danger" style={{ marginLeft: 8 }} onClick={() => setShowCancel(true)}>Cancel Campaign</button>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div class="form-group">
                  <label for="camp-cancel-reason">Reason</label>
                  <textarea id="camp-cancel-reason" rows={2} value={cancelReason} onInput={(e) => setCancelReason((e.target as HTMLTextAreaElement).value)} />
                </div>
                <button class="btn" onClick={() => setShowCancel(false)}>Back</button>{" "}
                <button class="btn btn-danger" disabled={!cancelReason.trim()} onClick={cancel}>Confirm Cancel</button>
              </div>
            )
          )}
        </div>
      )}

      <div class="card">
        <h2>Send Ledger</h2>
        {recipients.length === 0 ? (
          <div class="empty-state"><p>No recipients processed yet.</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Customer</th><th>Channel</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {recipients.map((r) => (
                  <tr key={r.id} class="table-row">
                    <td class="text-bold">#{r.customer_id}</td>
                    <td>{r.channel}</td>
                    <td>{r.status}</td>
                    <td class="text-muted">{r.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
