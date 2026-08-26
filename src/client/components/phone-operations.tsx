import { useCallback, useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { Pagination } from "./pagination";
import { ConfirmDialog } from "./confirm-dialog";
import { Phone, PhoneOutgoing, Plus, Trash2, History } from "lucide-preact";
import type { PaginatedState } from "../types";

/** Phase 15 — Phone Operations Foundation. Self-contained (own local
 *  fetch/state), same precedent as quote-list.tsx/contract-list.tsx: not
 *  part of the app-wide initial-load Promise.all. Config tabs (Settings /
 *  Agents / Numbers / Credentials) are admin-only client-side gating on top
 *  of the server's own binary RBAC (canManagePhoneOperations) — a direct
 *  API call from a dispatcher session still 403s regardless of what this
 *  UI renders. The Calls tab is admin+dispatcher. */

interface POSettings {
  operating_mode: string; inbound_enabled: boolean; outbound_enabled: boolean;
  max_concurrent_calls: number; daily_call_cap: number; configured: boolean; effective_from: string; effective_until: string | null;
}
interface VoiceAgent {
  id: number; name: string; language: string; voice: string; model: string; instructions: string;
  is_default: boolean; status: string; effective_from: string; effective_until: string | null;
}
interface PhoneNumber {
  id: number; e164_number: string; voice_agent_id: number | null; inbound_enabled: boolean; outbound_enabled: boolean; status: string;
}
interface Call {
  id: number; direction: string; status: string; from_number: string; to_number: string;
  duration_seconds: number | null; end_reason: string; created_at: string;
}
interface CallEvent { id: number; event_type: string; from_status: string | null; to_status: string | null; actor_type: string; created_at: string }
interface TranscriptLine { sequence: number; speaker: string; text: string; created_at: string }
interface CallOutcome { outcome_type: string; summary: string; structured_data: string; created_at: string }
interface ServiceCredential { id: number; label: string; created_at: string; revoked_at: string | null; last_used_at: string | null }

const OPERATING_MODES = ["ACTIVE", "PAUSED", "MAINTENANCE", "DISABLED", "EMERGENCY_STOP"];
type Tab = "calls" | "settings" | "agents" | "numbers" | "credentials";

export function PhoneOperations() {
  const { setError } = useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<Tab>("calls");

  const tabs: { key: Tab; label: string; adminOnly?: boolean }[] = [
    { key: "calls", label: "Calls" },
    { key: "settings", label: "Settings", adminOnly: true },
    { key: "agents", label: "Voice Agents", adminOnly: true },
    { key: "numbers", label: "Phone Numbers", adminOnly: true },
    { key: "credentials", label: "Credentials", adminOnly: true },
  ];
  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Phone Operations</h1>
      </div>
      <div class="toolbar">
        <div class="filter-group">
          {visibleTabs.map((t) => (
            <button key={t.key} class={`filter-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      {tab === "calls" && <CallsTab setError={setError} />}
      {tab === "settings" && isAdmin && <SettingsTab setError={setError} />}
      {tab === "agents" && isAdmin && <AgentsTab setError={setError} />}
      {tab === "numbers" && isAdmin && <NumbersTab setError={setError} />}
      {tab === "credentials" && isAdmin && <CredentialsTab setError={setError} />}
    </div>
  );
}

type SetError = (msg: string | null) => void;

// ── Calls ────────────────────────────────────────────────────────────

function CallsTab({ setError }: { setError: SetError }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [pag, setPag] = useState<PaginatedState>({ page: 1, limit: 25, total: 0 });
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(pag.page));
      params.set("limit", String(pag.limit));
      if (status) params.set("status", status);
      const data = await api<{ calls: Call[]; total: number }>("GET", `/api/phone-operations/calls?${params.toString()}`);
      setCalls(data.calls);
      setPag((p) => ({ ...p, total: data.total }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pag.page, pag.limit, status, setError]);

  useEffect(() => { fetchCalls(); }, [pag.page, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStatusAndReset = (v: string) => { setStatus(v); setPag((p) => ({ ...p, page: 1 })); };

  if (selected) return <CallDetail id={selected} onBack={() => setSelected(null)} setError={setError} />;

  return (
    <>
      <div class="toolbar">
        <div class="filter-group">
          <button class={`filter-btn ${status === "" ? "active" : ""}`} onClick={() => setStatusAndReset("")}>All</button>
          {["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"].map((s) => (
            <button key={s} class={`filter-btn ${status === s ? "active" : ""}`} onClick={() => setStatusAndReset(s)}>{s.replace("_", " ")}</button>
          ))}
        </div>
      </div>
      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : calls.length === 0 ? (
          <div class="empty-state">
            <p>No calls yet</p>
            <p class="text-muted">Calls will appear here once Phone Operations is configured and ACTIVE.</p>
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Direction</th><th>From</th><th>To</th><th>Status</th><th>Duration</th><th>Started</th></tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} class="table-row clickable" onClick={() => setSelected(c.id)}>
                    <td>{c.direction === "inbound" ? <Phone size={14} /> : <PhoneOutgoing size={14} />} {c.direction}</td>
                    <td class="text-muted">{c.from_number}</td>
                    <td class="text-muted">{c.to_number}</td>
                    <td><span class="status-badge">{c.status.replace("_", " ")}</span></td>
                    <td class="text-muted">{c.duration_seconds != null ? `${c.duration_seconds}s` : "—"}</td>
                    <td class="text-muted">{c.created_at.slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination pag={pag} setPage={(page) => setPag((p) => ({ ...p, page }))} />
    </>
  );
}

function CallDetail({ id, onBack, setError }: { id: number; onBack: () => void; setError: SetError }) {
  const [call, setCall] = useState<Call | null>(null);
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [callRes, eventsRes, transcriptRes, outcomeRes] = await Promise.all([
          api<{ call: Call }>("GET", `/api/phone-operations/calls/${id}`),
          api<{ events: CallEvent[] }>("GET", `/api/phone-operations/calls/${id}/events`),
          api<{ transcript: TranscriptLine[] }>("GET", `/api/phone-operations/calls/${id}/transcript`),
          api<{ outcome: CallOutcome | null }>("GET", `/api/phone-operations/calls/${id}/outcome`),
        ]);
        setCall(callRes.call);
        setEvents(eventsRes.events);
        setTranscript(transcriptRes.transcript);
        setOutcome(outcomeRes.outcome);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div class="loading-text">Loading...</div>;
  if (!call) return null;

  return (
    <div class="detail-page">
      <button class="btn-secondary" onClick={onBack}>&larr; Back to Calls</button>
      <div class="card" style={{ marginTop: 12 }}>
        <h2>Call #{call.id} — {call.direction} — {call.status.replace("_", " ")}</h2>
        <p class="text-muted">{call.from_number} → {call.to_number} · {call.created_at.slice(0, 16).replace("T", " ")}</p>
      </div>

      {outcome && (
        <div class="card" style={{ marginTop: 12 }}>
          <h3>Outcome — {outcome.outcome_type}</h3>
          <p>{outcome.summary || "(no summary)"}</p>
          <p class="text-muted" style={{ fontSize: 12 }}>
            AI-produced result for human review only — never automatically applied to any Customer, Lead, or Job.
          </p>
        </div>
      )}

      <div class="card" style={{ marginTop: 12 }}>
        <h3>Transcript</h3>
        {transcript.length === 0 ? (
          <p class="text-muted">No transcript recorded.</p>
        ) : (
          <div class="transcript">
            {transcript.map((t) => (
              <p key={t.sequence}><strong>{t.speaker === "agent" ? "Agent" : "Caller"}:</strong> {t.text}</p>
            ))}
          </div>
        )}
      </div>

      <div class="card" style={{ marginTop: 12 }}>
        <h3>Event Log</h3>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Event</th><th>Status</th><th>Actor</th><th>At</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{e.event_type}</td>
                  <td class="text-muted">{e.from_status ?? "—"} → {e.to_status ?? "—"}</td>
                  <td class="text-muted">{e.actor_type}</td>
                  <td class="text-muted">{e.created_at.slice(0, 19).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────

function SettingsTab({ setError }: { setError: SetError }) {
  const [settings, setSettings] = useState<POSettings | null>(null);
  const [history, setHistory] = useState<POSettings[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [mode, setMode] = useState("DISABLED");
  const [inbound, setInbound] = useState(false);
  const [outbound, setOutbound] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState("1");
  const [dailyCap, setDailyCap] = useState("0");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ settings: POSettings }>("GET", "/api/phone-operations/settings");
      setSettings(res.settings);
      setMode(res.settings.operating_mode);
      setInbound(res.settings.inbound_enabled);
      setOutbound(res.settings.outbound_enabled);
      setMaxConcurrent(String(res.settings.max_concurrent_calls));
      setDailyCap(String(res.settings.daily_call_cap));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const loadHistory = async () => {
    if (showHistory) { setShowHistory(false); return; }
    const res = await api<{ history: POSettings[] }>("GET", "/api/phone-operations/settings/history");
    setHistory(res.history);
    setShowHistory(true);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("POST", "/api/phone-operations/settings", {
        operating_mode: mode, inbound_enabled: inbound, outbound_enabled: outbound,
        max_concurrent_calls: parseInt(maxConcurrent, 10) || 1, daily_call_cap: parseInt(dailyCap, 10) || 0,
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div class="loading-text">Loading...</div>;

  return (
    <div class="card">
      {settings && !settings.configured && (
        <p class="text-muted" style={{ marginBottom: 12 }}>
          Phone Operations has never been configured for this organization — it is DISABLED and will accept no calls until saved below.
        </p>
      )}
      <form onSubmit={submit} class="form-section">
        <div class="form-group">
          <label>Operating Mode</label>
          <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)}>
            {OPERATING_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div class="form-group">
          <label><input type="checkbox" checked={inbound} onChange={(e) => setInbound((e.target as HTMLInputElement).checked)} /> Inbound calling enabled</label>
        </div>
        <div class="form-group">
          <label><input type="checkbox" checked={outbound} onChange={(e) => setOutbound((e.target as HTMLInputElement).checked)} /> Outbound calling enabled</label>
        </div>
        <div class="form-group">
          <label>Max Concurrent Calls</label>
          <input type="number" min="1" value={maxConcurrent} onInput={(e) => setMaxConcurrent((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group">
          <label>Daily Call Cap (0 = unlimited)</label>
          <input type="number" min="0" value={dailyCap} onInput={(e) => setDailyCap((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" class="btn-secondary" onClick={loadHistory}><History size={14} /> {showHistory ? "Hide" : "Show"} History</button>
        </div>
      </form>

      {showHistory && (
        <div class="table-wrap" style={{ marginTop: 16 }}>
          <table class="table">
            <thead><tr><th>Mode</th><th>Effective From</th><th>Effective Until</th></tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td>{h.operating_mode}</td>
                  <td class="text-muted">{h.effective_from.slice(0, 19).replace("T", " ")}</td>
                  <td class="text-muted">{h.effective_until ? h.effective_until.slice(0, 19).replace("T", " ") : "current"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Voice Agents ─────────────────────────────────────────────────────

const EMPTY_AGENT_FORM = { name: "", language: "en", voice: "", model: "", instructions: "", is_default: false, status: "draft" };

function AgentsTab({ setError }: { setError: SetError }) {
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_AGENT_FORM);
  const [saving, setSaving] = useState(false);
  // Whether `form` is a new version of an EXISTING named agent (name locked
  // — server-side versioning is keyed by name, so editing it here would
  // silently orphan the old version thread and start an unrelated new one,
  // independent Architecture review finding) vs. a brand-new agent (name
  // still editable, since no version thread exists yet).
  const [editingExisting, setEditingExisting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ agents: VoiceAgent[] }>("GET", "/api/phone-operations/agents");
      setAgents(res.agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const editAgent = (a: VoiceAgent) => {
    setForm({ name: a.name, language: a.language, voice: a.voice, model: a.model, instructions: a.instructions, is_default: a.is_default, status: a.status });
    setEditingExisting(true);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api("POST", "/api/phone-operations/agents", form);
      setForm(EMPTY_AGENT_FORM);
      setEditingExisting(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : agents.length === 0 ? (
          <div class="empty-state"><p>No voice agents configured yet</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Language</th><th>Model</th><th>Default</th><th>Status</th><th /></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td class="text-bold">{a.name}</td>
                    <td class="text-muted">{a.language}</td>
                    <td class="text-muted">{a.model || "—"}</td>
                    <td>{a.is_default ? <span class="status-badge">default</span> : "—"}</td>
                    <td class="text-muted">{a.status}</td>
                    <td><button class="btn-secondary" onClick={() => editAgent(a)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="card" style={{ marginTop: 16 }}>
        <h3>{editingExisting ? `New version of "${form.name}"` : "New Agent"}</h3>
        <form onSubmit={submit} class="form-section">
          <div class="form-group">
            <label>Name{editingExisting && " (locked — archive and create a new agent to rename)"}</label>
            <input type="text" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} required disabled={editingExisting} />
          </div>
          <div class="form-group">
            <label>Language</label>
            <input type="text" value={form.language} onInput={(e) => setForm({ ...form, language: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="form-group">
            <label>Voice</label>
            <input type="text" value={form.voice} onInput={(e) => setForm({ ...form, voice: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="form-group">
            <label>Model</label>
            <input type="text" value={form.model} onInput={(e) => setForm({ ...form, model: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="form-group">
            <label>Instructions (system prompt)</label>
            <textarea rows={4} value={form.instructions} onInput={(e) => setForm({ ...form, instructions: (e.target as HTMLTextAreaElement).value })} />
          </div>
          <div class="form-group">
            <label>Status</label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: (e.target as HTMLSelectElement).value })}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div class="form-group">
            <label><input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: (e.target as HTMLInputElement).checked })} /> Default agent for this organization</label>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Version"}</button>
            {editingExisting && <button type="button" class="btn-secondary" onClick={() => { setForm(EMPTY_AGENT_FORM); setEditingExisting(false); }}>Cancel</button>}
          </div>
        </form>
      </div>
    </>
  );
}

// ── Phone Numbers ────────────────────────────────────────────────────

function NumbersTab({ setError }: { setError: SetError }) {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNumber, setNewNumber] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [numRes, agentRes] = await Promise.all([
        api<{ numbers: PhoneNumber[] }>("GET", "/api/phone-operations/numbers"),
        api<{ agents: VoiceAgent[] }>("GET", "/api/phone-operations/agents"),
      ]);
      setNumbers(numRes.numbers);
      setAgents(agentRes.agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const addNumber = async (e: Event) => {
    e.preventDefault();
    if (!newNumber.trim()) return;
    setAdding(true);
    try {
      await api("POST", "/api/phone-operations/numbers", { e164_number: newNumber.trim() });
      setNewNumber("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const updateNumber = async (id: number, patch: Record<string, unknown>) => {
    try {
      await api("PUT", `/api/phone-operations/numbers/${id}`, patch);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : numbers.length === 0 ? (
          <div class="empty-state"><p>No numbers provisioned yet</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Number</th><th>Agent</th><th>Inbound</th><th>Outbound</th><th>Status</th></tr></thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id}>
                    <td class="text-bold">{n.e164_number}</td>
                    <td>
                      <select value={n.voice_agent_id ?? ""} onChange={(e) => updateNumber(n.id, { voice_agent_id: (e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null })}>
                        <option value="">(none)</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </td>
                    <td><input type="checkbox" checked={n.inbound_enabled} onChange={(e) => updateNumber(n.id, { inbound_enabled: (e.target as HTMLInputElement).checked })} /></td>
                    <td><input type="checkbox" checked={n.outbound_enabled} onChange={(e) => updateNumber(n.id, { outbound_enabled: (e.target as HTMLInputElement).checked })} /></td>
                    <td>
                      <select value={n.status} onChange={(e) => updateNumber(n.id, { status: (e.target as HTMLSelectElement).value })}>
                        <option value="active">Active</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div class="card" style={{ marginTop: 16 }}>
        <h3>Add Number</h3>
        <form onSubmit={addNumber} class="form-section">
          <div class="form-group">
            <label>E.164 Number</label>
            <input type="text" placeholder="+16045551234" value={newNumber} onInput={(e) => setNewNumber((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={adding}><Plus size={14} /> Add</button>
          </div>
        </form>
      </div>
    </>
  );
}

// ── Credentials ──────────────────────────────────────────────────────

function CredentialsTab({ setError }: { setError: SetError }) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [twilioConfigured, setTwilioConfigured] = useState(false);
  const [savingTwilio, setSavingTwilio] = useState(false);

  const [credentials, setCredentials] = useState<ServiceCredential[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ServiceCredential | null>(null);

  const load = useCallback(async () => {
    try {
      const [twilioRes, credsRes] = await Promise.all([
        api<{ credential: { account_sid: string; configured: boolean } }>("GET", "/api/phone-operations/credentials/twilio"),
        api<{ credentials: ServiceCredential[] }>("GET", "/api/phone-operations/service-credentials"),
      ]);
      setAccountSid(twilioRes.credential.account_sid);
      setTwilioConfigured(twilioRes.credential.configured);
      setCredentials(credsRes.credentials);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const saveTwilio = async (e: Event) => {
    e.preventDefault();
    setSavingTwilio(true);
    try {
      await api("POST", "/api/phone-operations/credentials/twilio", { account_sid: accountSid, auth_token: authToken });
      setAuthToken("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingTwilio(false);
    }
  };

  const issueCredential = async (e: Event) => {
    e.preventDefault();
    setIssuing(true);
    try {
      const res = await api<{ id: number; token: string }>("POST", "/api/phone-operations/service-credentials", { label: newLabel });
      setIssuedToken(res.token);
      setNewLabel("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIssuing(false);
    }
  };

  const doRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await api("POST", `/api/phone-operations/service-credentials/${revokeTarget.id}/revoke`, {});
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div class="card">
        <h3>Twilio Account</h3>
        {twilioConfigured && <p class="text-muted">Configured — Account SID {accountSid}</p>}
        <form onSubmit={saveTwilio} class="form-section">
          <div class="form-group">
            <label>Account SID</label>
            <input type="text" value={accountSid} onInput={(e) => setAccountSid((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-group">
            <label>Auth Token</label>
            <input type="password" placeholder={twilioConfigured ? "•••••••• (enter to replace)" : ""} value={authToken} onInput={(e) => setAuthToken((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={savingTwilio}>{savingTwilio ? "Saving..." : "Save"}</button>
          </div>
        </form>
      </div>

      <div class="card" style={{ marginTop: 16 }}>
        <h3>Voice Engine Service Credentials</h3>
        <p class="text-muted">Issued to the separate Voice Engine runtime — never shared across organizations, resolved server-side on every request.</p>
        {issuedToken && (
          <div class="inline-error" style={{ background: "#f0fdf4", borderColor: "#86efac", color: "#166534", marginBottom: 12 }}>
            New token (shown once — copy it now, it cannot be recovered): <code>{issuedToken}</code>
            <button class="btn-secondary" style={{ marginLeft: 8 }} onClick={() => setIssuedToken(null)}>Dismiss</button>
          </div>
        )}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Label</th><th>Created</th><th>Last Used</th><th>Status</th><th /></tr></thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id}>
                  <td>{c.label || "(no label)"}</td>
                  <td class="text-muted">{c.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td class="text-muted">{c.last_used_at ? c.last_used_at.slice(0, 16).replace("T", " ") : "never"}</td>
                  <td>{c.revoked_at ? <span class="status-badge">revoked</span> : <span class="status-badge">active</span>}</td>
                  <td>
                    {!c.revoked_at && (
                      <button class="btn-icon" title="Revoke" onClick={() => setRevokeTarget(c)}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={issueCredential} class="form-section" style={{ marginTop: 12 }}>
          <div class="form-group">
            <label>Label</label>
            <input type="text" placeholder="e.g. production-voice-engine" value={newLabel} onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={issuing}><Plus size={14} /> Issue New Credential</button>
          </div>
        </form>
      </div>

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke Credential"
          message={`Revoke "${revokeTarget.label || "this credential"}"? The Voice Engine using it will immediately lose access to this organization's Phone Operations data.`}
          confirmLabel="Revoke"
          danger
          onConfirm={doRevoke}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}
