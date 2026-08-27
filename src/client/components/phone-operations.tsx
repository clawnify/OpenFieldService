import { useCallback, useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { Pagination } from "./pagination";
import { ConfirmDialog } from "./confirm-dialog";
import {
  Phone, PhoneOutgoing, Plus, Trash2, History, ArrowLeft, User, Link2,
  Target, Briefcase, ClipboardList, ListChecks, Bot, Globe, Clock,
} from "lucide-preact";
import type { PaginatedState } from "../types";

/** Phase 15 — Phone Operations Foundation. Self-contained (own local
 *  fetch/state), same precedent as quote-list.tsx/contract-list.tsx: not
 *  part of the app-wide initial-load Promise.all. Config tabs (Settings /
 *  Agents / Numbers / Credentials) are admin-only client-side gating on top
 *  of the server's own binary RBAC (canManagePhoneOperations) — a direct
 *  API call from a dispatcher session still 403s regardless of what this
 *  UI renders. The Calls tab is admin+dispatcher.
 *
 *  Phase 16 UI/UX hardening: this file previously used two class names —
 *  `btn-secondary` and `form-actions` — that were never defined anywhere in
 *  styles.css, so every button/action row in here rendered as an unstyled
 *  native control (the "browser-default" defect from the baseline audit).
 *  Every button below now uses the SAME `.btn`/`.btn-primary`/`.btn-sm`/
 *  `.btn-back`/`.btn-icon` classes every other component in this app uses —
 *  no new button variant was introduced. Badges reuse the exact
 *  `.status-badge`/`.status-dot` + color-map pattern from
 *  `status-badge.tsx`/`contract-status.ts`/`quote-status.ts` rather than a
 *  new one. */

interface POSettings {
  operating_mode: string; inbound_enabled: boolean; outbound_enabled: boolean;
  max_concurrent_calls: number; daily_call_cap: number; configured: boolean; effective_from: string; effective_until: string | null;
}
interface VoiceAgent {
  id: number; name: string; language: string; voice: string; model: string; instructions: string;
  is_default: boolean; status: string; tool_policy: string[]; effective_from: string; effective_until: string | null;
}

// Phase 16 — must match src/server/phone-operations-crm.ts's KNOWN_TOOL_NAMES.
const KNOWN_TOOL_NAMES = [
  "find_customer_by_phone", "get_customer_service_context", "get_job_status", "get_available_slots",
  "create_lead_from_call", "create_follow_up", "create_appointment_for_customer",
] as const;
interface PhoneNumber {
  id: number; e164_number: string; voice_agent_id: number | null; inbound_enabled: boolean; outbound_enabled: boolean; status: string;
}
interface Call {
  id: number; direction: string; status: string; from_number: string; to_number: string;
  duration_seconds: number | null; end_reason: string; created_at: string;
  voice_agent_snapshot?: { name?: string; language?: string } | null;
}
interface CallEvent { id: number; event_type: string; from_status: string | null; to_status: string | null; actor_type: string; created_at: string }
interface TranscriptLine { sequence: number; speaker: string; text: string; created_at: string }
interface CallOutcome { outcome_type: string; summary: string; structured_data: string; created_at: string }
interface ServiceCredential { id: number; label: string; created_at: string; revoked_at: string | null; last_used_at: string | null }

// ── Phase 16 — Phone Operations <-> CRM integration types ────────────

interface CustomerVoiceContext { id: number; name: string; active_jobs: Array<{ id: number; identifier: string; status: string; scheduled_date: string; scheduled_time: string }>; most_recent_completed_job: { id: number; identifier: string; scheduled_date: string } | null }
interface LeadVoiceContext { id: number; name: string; status: string; program_interest: string | null }
interface JobVoiceStatus { id: number; identifier: string; status: string; scheduled_date: string; scheduled_time: string; technician_name: string | null }
interface FollowUp { id: number; note: string; status: string; due_date: string | null; created_by_type: string; created_at: string; completed_at: string | null }
interface ToolInvocation { tool_name: string; risk_category: string; status: string; created_at: string }
interface CrmContext {
  match_confidence: string; match_source: string;
  customer: CustomerVoiceContext | null; lead: LeadVoiceContext | null; job: JobVoiceStatus | null;
  follow_ups: FollowUp[]; tool_invocations: ToolInvocation[];
}

const OPERATING_MODES = ["ACTIVE", "PAUSED", "MAINTENANCE", "DISABLED", "EMERGENCY_STOP"];
type Tab = "calls" | "settings" | "agents" | "numbers" | "credentials";

// ── Status/badge color maps — same per-domain STATUS_COLORS convention as
// status-badge.tsx/contract-status.ts/quote-status.ts, not a new pattern. ──

const CALL_STATUS_COLORS: Record<string, string> = {
  queued: "#6b7280", ringing: "#3b82f6", in_progress: "#f59e0b", completed: "#16a34a",
  failed: "#dc2626", no_answer: "#9ca3af", busy: "#9ca3af", canceled: "#6b7280",
};
// The server only ever stores EXACT_PHONE / MANUAL / UNKNOWN
// (see MatchConfidence in phone-operations-crm.ts) — "multiple candidates"
// and "zero candidates" are NOT distinguished in the crm-context response,
// so this UI deliberately doesn't invent a "multiple match" badge state;
// both cases surface identically as UNKNOWN, exactly matching what the
// server actually knows and lets a human resolve manually either way.
const MATCH_CONFIDENCE_COLORS: Record<string, string> = { EXACT_PHONE: "#16a34a", MANUAL: "#3b82f6", UNKNOWN: "#9ca3af" };
const MATCH_CONFIDENCE_LABELS: Record<string, string> = { EXACT_PHONE: "Exact phone match", MANUAL: "Manually linked", UNKNOWN: "No match" };
const FOLLOW_UP_STATUS_COLORS: Record<string, string> = { open: "#f59e0b", completed: "#16a34a" };
const TOOL_STATUS_COLORS: Record<string, string> = { success: "#16a34a", failed: "#dc2626", denied: "#dc2626" };
const TOOL_RISK_COLORS: Record<string, string> = { read: "#6b7280", low_write: "#3b82f6", high_write: "#dc2626" };
const TOOL_RISK_LABELS: Record<string, string> = { read: "Read", low_write: "Low write", high_write: "High write" };

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

function statusSourceLabel(source: string): string {
  if (source === "system") return "auto-matched";
  if (source.startsWith("user:")) return "corrected by a dispatcher/admin";
  return source;
}

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
          // Deliberate mobile strategy for this table (Section 26): controlled
          // horizontal scroll via .table-wrap, not a card rewrite — a call log
          // is inherently a dense multi-column record set that dispatchers
          // triage quickly, and .table-wrap already guarantees the scrolling
          // stays contained to this element, never the whole page (Section 27).
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
                    <td><Badge label={c.status.replace("_", " ")} color={CALL_STATUS_COLORS[c.status] || "#6b7280"} /></td>
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
  const [crmContext, setCrmContext] = useState<CrmContext | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [callRes, eventsRes, transcriptRes, outcomeRes, crmRes] = await Promise.all([
        api<{ call: Call }>("GET", `/api/phone-operations/calls/${id}`),
        api<{ events: CallEvent[] }>("GET", `/api/phone-operations/calls/${id}/events`),
        api<{ transcript: TranscriptLine[] }>("GET", `/api/phone-operations/calls/${id}/transcript`),
        api<{ outcome: CallOutcome | null }>("GET", `/api/phone-operations/calls/${id}/outcome`),
        api<CrmContext>("GET", `/api/phone-operations/calls/${id}/crm-context`),
      ]);
      setCall(callRes.call);
      setEvents(eventsRes.events);
      setTranscript(transcriptRes.transcript);
      setOutcome(outcomeRes.outcome);
      setCrmContext(crmRes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  if (loading) return <div class="loading-text">Loading...</div>;
  if (!call) return null;

  const agentName = call.voice_agent_snapshot?.name;
  const agentLanguage = call.voice_agent_snapshot?.language;

  return (
    <div class="detail-page">
      <button class="btn btn-back" onClick={onBack}><ArrowLeft size={16} /> Back to Calls</button>

      <div class="detail-title-row" style={{ marginTop: 12 }}>
        <span class="identifier-lg">Call #{call.id}</span>
        <Badge label={call.status.replace("_", " ")} color={CALL_STATUS_COLORS[call.status] || "#6b7280"} />
        <span class="text-muted">{call.direction === "inbound" ? <Phone size={14} style={{ verticalAlign: "text-bottom" }} /> : <PhoneOutgoing size={14} style={{ verticalAlign: "text-bottom" }} />} {call.direction}</span>
      </div>

      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <Phone size={14} />
          <span class="detail-meta-label">From → To</span>
          <span>{call.from_number} → {call.to_number}</span>
        </div>
        <div class="detail-meta-item">
          <Clock size={14} />
          <span class="detail-meta-label">Started</span>
          <span>{call.created_at.slice(0, 16).replace("T", " ")}</span>
          <span class="text-muted">{call.duration_seconds != null ? `${call.duration_seconds}s duration` : "duration not yet recorded"}</span>
        </div>
        <div class="detail-meta-item">
          <Bot size={14} />
          <span class="detail-meta-label">Voice Agent</span>
          <span>{agentName || "—"}</span>
        </div>
        <div class="detail-meta-item">
          <Globe size={14} />
          <span class="detail-meta-label">Language</span>
          <span>{agentLanguage || "—"}</span>
        </div>
      </div>

      {crmContext && <CrmContextSection callId={id} context={crmContext} onChange={load} setError={setError} />}

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
          <p class="text-muted">No transcript recorded for this call.</p>
        ) : (
          <div class="po-transcript">
            {transcript.map((t) => (
              <div key={t.sequence} class={`po-transcript-line po-transcript-${t.speaker === "agent" ? "agent" : "caller"}`}>
                <span class="po-transcript-speaker">{t.speaker === "agent" ? "Agent" : "Caller"}</span>
                <span class="po-transcript-text">{t.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="card" style={{ marginTop: 12 }}>
        <h3>Event Log</h3>
        {events.length === 0 ? (
          <p class="text-muted">No events recorded for this call.</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Event</th><th>Transition</th><th>Actor</th><th>At</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td class="text-bold">{e.event_type.replace(/_/g, " ")}</td>
                    <td class="text-muted">{e.from_status ?? "—"} → {e.to_status ?? "—"}</td>
                    <td class="text-muted">{e.actor_type}</td>
                    <td class="text-muted">{e.created_at.slice(0, 19).replace("T", " ")}</td>
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

/** Phase 16 — matched Customer/Lead/Job, manual correction, follow-ups, and
 *  the tool-action audit trail for this call (Section 43-48). Manual
 *  link/unlink here calls the same server-side `linkCallToCustomer`/etc.
 *  the automatic matcher uses, always tagged `match_source: "user:<id>"` so
 *  a corrected match is never confused with an automatic one. Recomposed
 *  (UI/UX hardening pass) into distinct `.detail-section` groups — Match /
 *  Customer / Lead / Job / Follow-ups / Actions Taken — the same grouping
 *  convention job-detail.tsx already uses, instead of one long card. */
function CrmContextSection({ callId, context, onChange, setError }: { callId: number; context: CrmContext; onChange: () => void; setError: SetError }) {
  const [correctingCustomerId, setCorrectingCustomerId] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [followUpDueDate, setFollowUpDueDate] = useState("");
  const [savingFollowUp, setSavingFollowUp] = useState(false);

  const setCustomerLink = async (entityId: number | null) => {
    try {
      await api("POST", `/api/phone-operations/calls/${callId}/link`, { entity_type: "customer", entity_id: entityId });
      setCorrectingCustomerId("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submitFollowUp = async (e: Event) => {
    e.preventDefault();
    if (!followUpNote.trim()) return;
    setSavingFollowUp(true);
    try {
      await api("POST", `/api/phone-operations/calls/${callId}/follow-ups`, { note: followUpNote, due_date: followUpDueDate || null });
      setFollowUpNote("");
      setFollowUpDueDate("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFollowUp(false);
    }
  };

  const completeFollowUp = async (id: number) => {
    try {
      await api("POST", `/api/phone-operations/follow-ups/${id}/complete`, {});
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="card po-crm-context" style={{ marginTop: 12 }}>
      <h3>CRM Context</h3>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><Link2 size={13} /> Match</span>
        <div class="po-match-row">
          <Badge label={MATCH_CONFIDENCE_LABELS[context.match_confidence] || context.match_confidence} color={MATCH_CONFIDENCE_COLORS[context.match_confidence] || "#6b7280"} />
          {context.match_source && <span class="text-muted po-match-source">{statusSourceLabel(context.match_source)}</span>}
        </div>
      </div>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><User size={13} /> Customer</span>
        {context.customer ? (
          <div class="po-linked-record">
            <div>
              <div class="text-bold">{context.customer.name}</div>
              <div class="text-muted" style={{ fontSize: 12 }}>
                {context.customer.active_jobs.length} active job{context.customer.active_jobs.length === 1 ? "" : "s"}
              </div>
            </div>
            <button class="btn btn-sm" onClick={() => setCustomerLink(null)}>Unlink</button>
          </div>
        ) : (
          <p class="text-muted">No customer matched — link one below if you can identify the caller.</p>
        )}
        <div class="po-correction-row">
          <label class="sr-only" htmlFor={`po-customer-id-${callId}`}>Customer ID to link or correct</label>
          <input
            id={`po-customer-id-${callId}`} type="text" inputMode="numeric" placeholder="Customer ID"
            value={correctingCustomerId} onInput={(e) => setCorrectingCustomerId((e.target as HTMLInputElement).value)}
          />
          <button class="btn btn-sm" onClick={() => correctingCustomerId && setCustomerLink(Number(correctingCustomerId))} disabled={!correctingCustomerId}>
            {context.customer ? "Correct match" : "Link customer"}
          </button>
        </div>
      </div>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><Target size={13} /> Lead</span>
        {context.lead ? (
          <div class="po-linked-record">
            <div>
              <div class="text-bold">{context.lead.name}</div>
              <div class="text-muted" style={{ fontSize: 12 }}>{context.lead.status}{context.lead.program_interest ? ` · ${context.lead.program_interest}` : ""}</div>
            </div>
          </div>
        ) : (
          <p class="text-muted">No lead linked to this call.</p>
        )}
      </div>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><Briefcase size={13} /> Job / Appointment</span>
        {context.job ? (
          <div class="po-linked-record">
            <div>
              <span class="identifier">{context.job.identifier}</span> — {context.job.status.replace(/_/g, " ")}
              <div class="text-muted" style={{ fontSize: 12 }}>
                {context.job.scheduled_date}{context.job.scheduled_time ? ` at ${context.job.scheduled_time}` : ""} · {context.job.technician_name || "unassigned"}
              </div>
            </div>
          </div>
        ) : (
          <p class="text-muted">No appointment linked to this call.</p>
        )}
      </div>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><ClipboardList size={13} /> Follow-ups</span>
        {context.follow_ups.length === 0 ? (
          <p class="text-muted">No follow-ups yet.</p>
        ) : (
          <div class="po-followup-list">
            {context.follow_ups.map((f) => (
              <div key={f.id} class="po-followup-item">
                <div class="po-followup-main">
                  <span>{f.note}</span>
                  {f.due_date && <span class="text-muted po-followup-due">Due {f.due_date}</span>}
                </div>
                <div class="po-followup-actions">
                  <Badge label={f.status} color={FOLLOW_UP_STATUS_COLORS[f.status] || "#6b7280"} />
                  {f.status === "open" && <button class="btn btn-sm" onClick={() => completeFollowUp(f.id)}>Mark Done</button>}
                </div>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={submitFollowUp} class="po-followup-form">
          <label class="sr-only" htmlFor={`po-followup-note-${callId}`}>New follow-up note</label>
          <input
            id={`po-followup-note-${callId}`} type="text" placeholder="New follow-up note"
            value={followUpNote} onInput={(e) => setFollowUpNote((e.target as HTMLInputElement).value)}
          />
          <label class="sr-only" htmlFor={`po-followup-date-${callId}`}>Follow-up due date</label>
          <input
            id={`po-followup-date-${callId}`} type="date"
            value={followUpDueDate} onInput={(e) => setFollowUpDueDate((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="btn btn-primary btn-sm" disabled={savingFollowUp || !followUpNote.trim()}>
            {savingFollowUp ? "Saving..." : "Add Follow-up"}
          </button>
        </form>
      </div>

      <div class="form-section">
        <span class="form-section-heading po-crm-group-label"><ListChecks size={13} /> Actions Taken</span>
        {context.tool_invocations.length === 0 ? (
          <p class="text-muted">No AI tool actions taken on this call.</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Tool</th><th>Risk</th><th>Status</th><th>At</th></tr></thead>
              <tbody>
                {context.tool_invocations.map((t, i) => (
                  <tr key={i}>
                    <td class="text-bold">{t.tool_name}</td>
                    <td><span class="status-badge-sm" style={{ color: TOOL_RISK_COLORS[t.risk_category] || "#6b7280" }}>{TOOL_RISK_LABELS[t.risk_category] || t.risk_category}</span></td>
                    <td><Badge label={t.status} color={TOOL_STATUS_COLORS[t.status] || "#6b7280"} /></td>
                    <td class="text-muted">{t.created_at.slice(0, 19).replace("T", " ")}</td>
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
    <div class="card settings-card">
      {settings && !settings.configured && (
        <p class="text-muted" style={{ marginBottom: 12 }}>
          Phone Operations has never been configured for this organization — it is DISABLED and will accept no calls until saved below.
        </p>
      )}
      <form onSubmit={submit} class="form-grid">
        <div class="form-group">
          <label>Operating Mode</label>
          <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)}>
            {OPERATING_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div class="form-group">
          <label>Max Concurrent Calls</label>
          <input type="number" min="1" value={maxConcurrent} onInput={(e) => setMaxConcurrent((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group">
          <label>Daily Call Cap (0 = unlimited)</label>
          <input type="number" min="0" value={dailyCap} onInput={(e) => setDailyCap((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group">
          <label><input type="checkbox" checked={inbound} onChange={(e) => setInbound((e.target as HTMLInputElement).checked)} /> Inbound calling enabled</label>
        </div>
        <div class="form-group">
          <label><input type="checkbox" checked={outbound} onChange={(e) => setOutbound((e.target as HTMLInputElement).checked)} /> Outbound calling enabled</label>
        </div>
        <div class="form-group full-width po-form-actions">
          <button type="submit" class="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" class="btn" onClick={loadHistory}><History size={14} /> {showHistory ? "Hide" : "Show"} History</button>
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

const EMPTY_AGENT_FORM = { name: "", language: "en", voice: "", model: "", instructions: "", is_default: false, status: "draft", tool_policy: [] as string[] };

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
    setForm({ name: a.name, language: a.language, voice: a.voice, model: a.model, instructions: a.instructions, is_default: a.is_default, status: a.status, tool_policy: a.tool_policy });
    setEditingExisting(true);
  };

  const toggleTool = (tool: string) => {
    setForm((f) => ({ ...f, tool_policy: f.tool_policy.includes(tool) ? f.tool_policy.filter((t) => t !== tool) : [...f.tool_policy, tool] }));
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
              <thead><tr><th>Name</th><th>Language</th><th>Model</th><th>Default</th><th>Status</th><th>Tools</th><th /></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td class="text-bold">{a.name}</td>
                    <td class="text-muted">{a.language}</td>
                    <td class="text-muted">{a.model || "—"}</td>
                    <td>{a.is_default ? <Badge label="default" color="#16a34a" /> : "—"}</td>
                    <td class="text-muted">{a.status}</td>
                    <td class="text-muted">{a.tool_policy.length}</td>
                    <td><button class="btn btn-sm" onClick={() => editAgent(a)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="card settings-card" style={{ marginTop: 16 }}>
        <h3 class="settings-group-heading">{editingExisting ? `New version of "${form.name}"` : "New Agent"}</h3>
        <form onSubmit={submit} class="form-grid">
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
          <div class="form-group full-width">
            <label>Instructions (system prompt)</label>
            <textarea rows={4} value={form.instructions} onInput={(e) => setForm({ ...form, instructions: (e.target as HTMLTextAreaElement).value })} />
          </div>
          <div class="form-group full-width">
            <label>Allowed CRM tools (this version only — a later change never affects a call already run under this version)</label>
            <div class="po-tool-policy-grid">
              {KNOWN_TOOL_NAMES.map((tool) => (
                <label key={tool} class="po-tool-checkbox">
                  <input type="checkbox" checked={form.tool_policy.includes(tool)} onChange={() => toggleTool(tool)} /> {tool}
                </label>
              ))}
            </div>
          </div>
          <div class="form-group full-width po-form-actions">
            <button type="submit" class="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Version"}</button>
            {editingExisting && <button type="button" class="btn" onClick={() => { setForm(EMPTY_AGENT_FORM); setEditingExisting(false); }}>Cancel</button>}
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
                      <label class="sr-only" htmlFor={`po-number-agent-${n.id}`}>Voice agent for {n.e164_number}</label>
                      <select id={`po-number-agent-${n.id}`} value={n.voice_agent_id ?? ""} onChange={(e) => updateNumber(n.id, { voice_agent_id: (e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null })}>
                        <option value="">(none)</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </td>
                    <td><input type="checkbox" checked={n.inbound_enabled} onChange={(e) => updateNumber(n.id, { inbound_enabled: (e.target as HTMLInputElement).checked })} aria-label={`Inbound enabled for ${n.e164_number}`} /></td>
                    <td><input type="checkbox" checked={n.outbound_enabled} onChange={(e) => updateNumber(n.id, { outbound_enabled: (e.target as HTMLInputElement).checked })} aria-label={`Outbound enabled for ${n.e164_number}`} /></td>
                    <td>
                      <label class="sr-only" htmlFor={`po-number-status-${n.id}`}>Status for {n.e164_number}</label>
                      <select id={`po-number-status-${n.id}`} value={n.status} onChange={(e) => updateNumber(n.id, { status: (e.target as HTMLSelectElement).value })}>
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
      <div class="card settings-card" style={{ marginTop: 16 }}>
        <h3 class="settings-group-heading">Add Number</h3>
        <form onSubmit={addNumber} class="form-grid">
          <div class="form-group">
            <label>E.164 Number</label>
            <input type="text" placeholder="+16045551234" value={newNumber} onInput={(e) => setNewNumber((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-group full-width po-form-actions">
            <button type="submit" class="btn btn-primary" disabled={adding}><Plus size={14} /> Add</button>
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
      <div class="card settings-card">
        <h3 class="settings-group-heading">Twilio Account</h3>
        {twilioConfigured && <p class="text-muted" style={{ marginBottom: 8 }}>Configured — Account SID {accountSid}</p>}
        <form onSubmit={saveTwilio} class="form-grid">
          <div class="form-group">
            <label>Account SID</label>
            <input type="text" value={accountSid} onInput={(e) => setAccountSid((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-group">
            <label>Auth Token</label>
            <input type="password" placeholder={twilioConfigured ? "•••••••• (enter to replace)" : ""} value={authToken} onInput={(e) => setAuthToken((e.target as HTMLInputElement).value)} required />
          </div>
          <div class="form-group full-width po-form-actions">
            <button type="submit" class="btn btn-primary" disabled={savingTwilio}>{savingTwilio ? "Saving..." : "Save"}</button>
          </div>
        </form>
      </div>

      <div class="card settings-card" style={{ marginTop: 16 }}>
        <h3 class="settings-group-heading">Voice Engine Service Credentials</h3>
        <p class="text-muted" style={{ marginBottom: 12 }}>Issued to the separate Voice Engine runtime — never shared across organizations, resolved server-side on every request.</p>
        {issuedToken && (
          <div role="status" class="inline-error" style={{ background: "#f0fdf4", borderColor: "#86efac", color: "#166534", marginBottom: 12, flexWrap: "wrap" }}>
            <span>New token (shown once — copy it now, it cannot be recovered): <code>{issuedToken}</code></span>
            <button class="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setIssuedToken(null)}>Dismiss</button>
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
                  <td>{c.revoked_at ? <Badge label="revoked" color="#6b7280" /> : <Badge label="active" color="#16a34a" />}</td>
                  <td>
                    {!c.revoked_at && (
                      <button class="btn-icon danger" title="Revoke" aria-label={`Revoke credential "${c.label || "unlabeled"}"`} onClick={() => setRevokeTarget(c)}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={issueCredential} class="form-grid" style={{ marginTop: 12 }}>
          <div class="form-group">
            <label>Label</label>
            <input type="text" placeholder="e.g. production-voice-engine" value={newLabel} onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group full-width po-form-actions">
            <button type="submit" class="btn btn-primary" disabled={issuing}><Plus size={14} /> Issue New Credential</button>
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
