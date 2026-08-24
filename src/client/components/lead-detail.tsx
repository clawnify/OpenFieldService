import { useCallback, useEffect, useState } from "preact/hooks";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { useReferenceData } from "../reference-data";
import { useAssignableUsers } from "../hooks/use-assignable-users";
import { resolveReferralFieldsOnSourceChange, summarizeConversionResult } from "../lead-helpers";
import { canOfferConversion, LEAD_STATUS_LABELS, resolveLeadDisplayTransitions } from "../lead-status";
import { formatCents, formatCentsForInput, parseDollarsToCents } from "../money";
import { JOB_TYPE_LABELS, JOB_TYPE_OPTIONS } from "../job-type-labels";
import { ConfirmDialog } from "./confirm-dialog";
import { CustomerSearchSelect } from "./customer-search-select";
import { LeadStatusBadge } from "./lead-status-badge";
import { NotificationPreferences } from "./notification-preferences";
import { NotificationHistory } from "./notification-history";
import { RelatedQuotes } from "./related-quotes";
import { ArrowLeft, Edit3, Save, X, CheckCircle2 } from "lucide-preact";
import type { Lead, LeadStatusHistoryRow } from "../types";

const emptyForm = {
  name: "", phone: "", email: "", address: "", city: "", state: "", zip: "",
  referral_source: "", referral_name: "", referred_by_customer_id: null as number | null,
  program_interest: "", estimated_value_input: "", estimate_notes: "", notes: "",
};

/** Phase 8.4 — Lead detail. Self-contained (own fetch, not AppContext) —
 *  `id` is passed as a plain prop from the router, same reasoning as
 *  lead-list.tsx. Status changes exclusively via POST /api/leads/{id}/transition
 *  (Phase 8.1/8.2) and conversion exclusively via POST /api/leads/{id}/convert
 *  (Phase 8.3) — this component never writes `status` or any conversion
 *  field through the ordinary PUT /api/leads/{id} edit path (that route's
 *  own .strict() schema would reject it anyway, but the UI doesn't even try). */
export function LeadDetail({ id, navigate }: { id: number; navigate: (to: string) => void }) {
  const { user } = useAuth();
  const { referralSources, leadLostReasons } = useReferenceData();
  const { users: assignableUsers, available: assigneesAvailable } = useAssignableUsers(user?.role);

  const [lead, setLead] = useState<Lead | null>(null);
  const [history, setHistory] = useState<LeadStatusHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [referredByLabel, setReferredByLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pendingTransition, setPendingTransition] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const [pendingLost, setPendingLost] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [lostReasonNote, setLostReasonNote] = useState("");
  const [losing, setLosing] = useState(false);

  const [pendingAssignment, setPendingAssignment] = useState<{ id: number | null; name: string } | null>(null);
  const [assigning, setAssigning] = useState(false);

  const [pendingConvert, setPendingConvert] = useState(false);
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [conversionSuccess, setConversionSuccess] = useState<{ created: boolean; customerId: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [leadRes, historyRes] = await Promise.all([
        api<{ lead: Lead }>("GET", `/api/leads/${id}`),
        api<{ history: LeadStatusHistoryRow[] }>("GET", `/api/leads/${id}/status-history`),
      ]);
      setLead(leadRes.lead);
      setHistory(historyRes.history);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Escape-to-close for this component's own custom modals (Lost, Convert,
  // conversion-success) — same precedent as ScheduleEditModal (Phase 7):
  // new components start correct; the shared ConfirmDialog's own lack of
  // Escape handling (used elsewhere in this file for Save/Reassign) is a
  // documented, separately-tracked pre-existing gap this phase doesn't fix.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingLost && !losing) setPendingLost(false);
      else if (pendingConvert && !converting) setPendingConvert(false);
      else if (conversionSuccess) setConversionSuccess(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingLost, losing, pendingConvert, converting, conversionSuccess]);

  if (loading) return <div class="page loading-text">Loading...</div>;

  if (loadError || !lead) {
    return (
      <div class="page">
        <button class="btn btn-back" onClick={() => navigate("/leads")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="inline-error" style={{ marginTop: 16 }}>{loadError || "This lead could not be found."}</div>
      </div>
    );
  }

  const startEdit = () => {
    setForm({
      name: lead.name, phone: lead.phone, email: lead.email,
      address: lead.address, city: lead.city, state: lead.state, zip: lead.zip,
      referral_source: lead.referral_source, referral_name: lead.referral_name,
      referred_by_customer_id: lead.referred_by_customer_id,
      program_interest: lead.program_interest || "",
      estimated_value_input: formatCentsForInput(lead.estimated_value_cents),
      estimate_notes: lead.estimate_notes, notes: lead.notes,
    });
    setReferredByLabel(lead.referred_by_customer_name || "");
    setFormError(null);
    setEditing(true);
  };

  const handleReferralSourceChange = (value: string) => {
    const cleared = resolveReferralFieldsOnSourceChange(value, {
      referralName: form.referral_name, referredById: form.referred_by_customer_id,
    });
    setForm((f) => ({ ...f, referral_source: value, referral_name: cleared.referralName, referred_by_customer_id: cleared.referredById }));
    if (cleared.referredById === null) setReferredByLabel("");
  };

  const requestSave = () => {
    setFormError(null);
    if (!form.name.trim()) { setFormError("Name is required"); return; }
    if (form.referral_source === "Referral" && !form.referral_name.trim()) { setFormError("Referral Name is required"); return; }
    if (form.referral_source === "Existing Customer" && form.referred_by_customer_id === null) { setFormError("Select the customer who made the referral"); return; }
    setPendingSave(true);
  };

  const confirmSave = async () => {
    setSaving(true);
    try {
      await api("PUT", `/api/leads/${id}`, {
        name: form.name.trim(), phone: form.phone, email: form.email,
        address: form.address, city: form.city, state: form.state, zip: form.zip,
        referral_source: form.referral_source, referral_name: form.referral_name,
        referred_by_customer_id: form.referred_by_customer_id,
        program_interest: form.program_interest || null,
        estimated_value_cents: parseDollarsToCents(form.estimated_value_input),
        estimate_notes: form.estimate_notes, notes: form.notes,
      });
      await load();
      setEditing(false);
      setPendingSave(false);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startTransition = (toStatus: string) => {
    setTransitionError(null);
    if (toStatus === "lost") { setLostReason(""); setLostReasonNote(""); setPendingLost(true); return; }
    setPendingTransition(toStatus);
  };

  const confirmTransition = async () => {
    if (!pendingTransition) return;
    setTransitioning(true);
    try {
      await api("POST", `/api/leads/${id}/transition`, { to_status: pendingTransition });
      await load();
      setPendingTransition(null);
    } catch (err) {
      setTransitionError((err as Error).message);
    } finally {
      setTransitioning(false);
    }
  };

  const confirmLost = async () => {
    setLosing(true);
    try {
      await api("POST", `/api/leads/${id}/transition`, { to_status: "lost", lost_reason: lostReason, lost_reason_note: lostReasonNote });
      await load();
      setPendingLost(false);
    } catch (err) {
      setTransitionError((err as Error).message);
    } finally {
      setLosing(false);
    }
  };

  const confirmAssignment = async () => {
    if (!pendingAssignment) return;
    setAssigning(true);
    try {
      await api("PUT", `/api/leads/${id}`, { assigned_user_id: pendingAssignment.id });
      await load();
      setPendingAssignment(null);
    } catch (err) {
      setTransitionError((err as Error).message);
    } finally {
      setAssigning(false);
    }
  };

  const confirmConvert = async () => {
    setConverting(true);
    setConversionError(null);
    try {
      const res = await api<{ lead: Lead; customer: { id: number }; created: boolean }>("POST", `/api/leads/${id}/convert`, {});
      setConversionSuccess({ created: res.created, customerId: res.customer.id });
      await load();
      setPendingConvert(false);
    } catch (err) {
      setConversionError((err as Error).message);
    } finally {
      setConverting(false);
    }
  };

  const isAmbiguousMatch = conversionError !== null && /multiple existing customers/i.test(conversionError);

  const displayTransitions = resolveLeadDisplayTransitions(lead.status);
  const showConvert = canOfferConversion(lead.status, lead.converted_customer_id);
  const isConverted = lead.converted_customer_id !== null;

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/leads")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          {editing ? (
            <>
              <button class="btn" onClick={() => { setEditing(false); setFormError(null); }}><X size={14} /> Cancel</button>
              <button class="btn btn-primary" onClick={requestSave}><Save size={14} /> Save</button>
            </>
          ) : (
            <button class="btn" onClick={startEdit}><Edit3 size={14} /> Edit</button>
          )}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{lead.identifier}</span>
            <LeadStatusBadge status={lead.status} />
          </div>
          <h2 class="detail-customer-name">{lead.name}</h2>

          {formError && <div class="inline-error" style={{ marginBottom: 12 }}>{formError}</div>}

          {editing ? (
            <div class="lead-form">
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Name</label>
                  <input type="text" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Phone</label>
                  <input type="tel" value={form.phone} onInput={(e) => setForm({ ...form, phone: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Email</label>
                  <input type="email" value={form.email} onInput={(e) => setForm({ ...form, email: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group full-width">
                  <label>Address</label>
                  <input type="text" value={form.address} onInput={(e) => setForm({ ...form, address: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>City</label>
                  <input type="text" value={form.city} onInput={(e) => setForm({ ...form, city: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Province/State</label>
                  <input type="text" value={form.state} onInput={(e) => setForm({ ...form, state: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Postal Code</label>
                  <input type="text" value={form.zip} onInput={(e) => setForm({ ...form, zip: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Referral Source</label>
                  <select value={form.referral_source} onChange={(e) => handleReferralSourceChange((e.target as HTMLSelectElement).value)}>
                    <option value="">Select...</option>
                    {referralSources.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {form.referral_source === "Referral" && (
                  <div class="form-group full-width">
                    <label>Referral Name *</label>
                    <input
                      type="text" value={form.referral_name}
                      onInput={(e) => setForm({ ...form, referral_name: (e.target as HTMLInputElement).value })}
                      required
                    />
                  </div>
                )}
                {form.referral_source === "Existing Customer" && (
                  <div class="form-group full-width">
                    <label>Referred By Customer *</label>
                    <CustomerSearchSelect
                      value={form.referred_by_customer_id}
                      valueLabel={referredByLabel}
                      onChange={(cid, label) => { setForm({ ...form, referred_by_customer_id: cid }); setReferredByLabel(label); }}
                    />
                  </div>
                )}
                <div class="form-group">
                  <label>Program Interest</label>
                  <select value={form.program_interest} onChange={(e) => setForm({ ...form, program_interest: (e.target as HTMLSelectElement).value })}>
                    <option value="">Not sure yet</option>
                    {JOB_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{JOB_TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Estimated Value</label>
                  <input
                    type="text" inputMode="decimal" value={form.estimated_value_input}
                    onInput={(e) => setForm({ ...form, estimated_value_input: (e.target as HTMLInputElement).value })}
                    placeholder="$0.00"
                  />
                  <span class="text-muted" style={{ fontSize: 12 }}>Estimated opportunity value — this does not create an invoice.</span>
                </div>
                <div class="form-group full-width">
                  <label>Estimate Notes</label>
                  <textarea rows={2} value={form.estimate_notes} onInput={(e) => setForm({ ...form, estimate_notes: (e.target as HTMLTextAreaElement).value })} />
                </div>
                <div class="form-group full-width">
                  <label>Notes</label>
                  <textarea rows={3} value={form.notes} onInput={(e) => setForm({ ...form, notes: (e.target as HTMLTextAreaElement).value })} />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div class="detail-meta-grid">
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Phone</span>
                  <span>{lead.phone || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Email</span>
                  <span>{lead.email || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Address</span>
                  <span>{[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Assigned To</span>
                  <span>{lead.assigned_user_name || "Unassigned"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Program Interest</span>
                  <span>{lead.program_interest ? (JOB_TYPE_LABELS[lead.program_interest as keyof typeof JOB_TYPE_LABELS] || lead.program_interest) : "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Estimated Value</span>
                  <span>{lead.estimated_value_cents !== null ? formatCents(lead.estimated_value_cents) : "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Referral Source</span>
                  <span>{lead.referral_source || "—"}</span>
                </div>
                {lead.referral_source === "Referral" && lead.referral_name && (
                  <div class="detail-meta-item">
                    <span class="detail-meta-label">Referral Name</span>
                    <span>{lead.referral_name}</span>
                  </div>
                )}
                {lead.referral_source === "Existing Customer" && lead.referred_by_customer_name && (
                  <div class="detail-meta-item">
                    <span class="detail-meta-label">Referred By</span>
                    <span class="link" onClick={() => lead.referred_by_customer_id && navigate(`/customers/${lead.referred_by_customer_id}`)}>
                      {lead.referred_by_customer_name}
                    </span>
                  </div>
                )}
              </div>

              {lead.estimate_notes && (
                <div class="detail-section">
                  <h3>Estimate Notes</h3>
                  <p class="detail-notes">{lead.estimate_notes}</p>
                </div>
              )}
              {lead.notes && (
                <div class="detail-section">
                  <h3>Notes</h3>
                  <p class="detail-notes">{lead.notes}</p>
                </div>
              )}
            </>
          )}

          <div class="detail-section">
            <h3>Status History</h3>
            {history.length === 0 ? (
              <p class="text-muted">No history yet</p>
            ) : (
              <div class="card">
                <table class="table">
                  <thead>
                    <tr><th>From</th><th>To</th><th>When</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} class="table-row">
                        <td>{h.old_status ? (LEAD_STATUS_LABELS[h.old_status] || h.old_status) : "—"}</td>
                        <td>{LEAD_STATUS_LABELS[h.new_status] || h.new_status}</td>
                        <td class="text-muted">{new Date(h.created_at).toLocaleString()}</td>
                        <td class="text-muted">{h.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <RelatedQuotes customerId={lead.converted_customer_id ?? undefined} leadId={lead.id} navigate={navigate} />

          <NotificationHistory entityType="lead" entityId={id} role={user?.role} />
        </div>

        <div class="detail-sidebar">
          <NotificationPreferences recipientType="lead" recipientId={id} role={user?.role} />
          {isConverted ? (
            <div class="detail-sidebar-section">
              <h4><CheckCircle2 size={14} style={{ verticalAlign: "text-bottom" }} /> Converted</h4>
              <p class="text-muted" style={{ marginBottom: 8 }}>
                This lead was converted{lead.converted_at ? ` on ${new Date(lead.converted_at).toLocaleDateString()}` : ""}.
              </p>
              <button class="btn btn-sm btn-primary" onClick={() => navigate(`/customers/${lead.converted_customer_id}`)}>
                View Customer
              </button>
            </div>
          ) : (
            <div class="detail-sidebar-section">
              <h4>Status</h4>
              <p class="text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
                Current: {LEAD_STATUS_LABELS[lead.status] || lead.status}
              </p>
              {transitionError && <div class="inline-error" style={{ marginBottom: 8 }}>{transitionError}</div>}
              {displayTransitions.length === 0 && !showConvert ? (
                <p class="text-muted">No further actions available</p>
              ) : (
                <div class="status-buttons">
                  {displayTransitions.map((s) => (
                    <button key={s} class="status-btn" onClick={() => startTransition(s)}>
                      {s === "lost" ? "Mark Lost" : s === "contacted" && lead.status === "lost" ? "Reopen Lead" : `Move to ${LEAD_STATUS_LABELS[s]}`}
                    </button>
                  ))}
                </div>
              )}
              {showConvert && (
                <button class="btn btn-primary btn-sm" style={{ marginTop: 10, width: "100%" }} onClick={() => { setConversionError(null); setPendingConvert(true); }}>
                  Convert Lead
                </button>
              )}
            </div>
          )}

          {lead.status === "lost" && (lead.lost_reason || lead.lost_reason_note) && (
            <div class="detail-sidebar-section">
              <h4>Lost Reason</h4>
              <p class="text-muted">{lead.lost_reason}{lead.lost_reason_note ? ` — ${lead.lost_reason_note}` : ""}</p>
            </div>
          )}

          <div class="detail-sidebar-section">
            <h4>Assignment</h4>
            {assigneesAvailable ? (
              <select
                value={lead.assigned_user_id || ""}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  const uid = v ? parseInt(v, 10) : null;
                  const name = uid ? (assignableUsers.find((u) => u.id === uid)?.name || "Unknown") : "Unassigned";
                  setPendingAssignment({ id: uid, name });
                }}
              >
                <option value="">Unassigned</option>
                {assignableUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            ) : (
              <p class="text-muted" style={{ fontSize: 12 }}>
                Couldn't load the assignable user list — try again in a moment.
              </p>
            )}
          </div>
        </div>
      </div>

      {pendingSave && (
        <ConfirmDialog
          title="Save changes?"
          message={`Save changes to "${form.name}"?`}
          confirmLabel="Save"
          submitting={saving}
          onConfirm={confirmSave}
          onClose={() => setPendingSave(false)}
        />
      )}

      {pendingTransition && (
        <ConfirmDialog
          title={pendingTransition === "contacted" && lead.status === "lost" ? "Reopen this lead?" : "Change status?"}
          message={
            pendingTransition === "contacted" && lead.status === "lost"
              ? "Reopen this Lead and move it back to Contacted? This does not erase its lost history."
              : `Move lead ${lead.identifier} from "${LEAD_STATUS_LABELS[lead.status] || lead.status}" to "${LEAD_STATUS_LABELS[pendingTransition] || pendingTransition}"?`
          }
          confirmLabel="Confirm"
          submitting={transitioning}
          onConfirm={confirmTransition}
          onClose={() => setPendingTransition(null)}
        />
      )}

      {pendingLost && (
        <div class="modal-overlay" onClick={() => !losing && setPendingLost(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Mark this lead as lost?</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setPendingLost(false)}><X size={18} /></button>
            </div>
            <div class="confirm-body">
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Lost Reason *</label>
                  <select value={lostReason} onChange={(e) => setLostReason((e.target as HTMLSelectElement).value)} required>
                    <option value="">Select a reason...</option>
                    {leadLostReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                {lostReason === "Other" && (
                  <div class="form-group full-width">
                    <label>Additional Details</label>
                    <textarea rows={2} value={lostReasonNote} onInput={(e) => setLostReasonNote((e.target as HTMLTextAreaElement).value)} />
                  </div>
                )}
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingLost(false)} disabled={losing}>Cancel</button>
              <button type="button" class="btn btn-danger" disabled={losing || !lostReason} onClick={confirmLost}>
                {losing ? "Please wait..." : "Mark Lost"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingAssignment !== null && (
        <ConfirmDialog
          title="Change assignment?"
          message={`Assign lead ${lead.identifier} to ${pendingAssignment.name}?`}
          confirmLabel="Assign"
          submitting={assigning}
          onConfirm={confirmAssignment}
          onClose={() => setPendingAssignment(null)}
        />
      )}

      {pendingConvert && (
        <div class="modal-overlay" onClick={() => !converting && setPendingConvert(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Convert this lead?</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setPendingConvert(false)}><X size={18} /></button>
            </div>
            <div class="confirm-body">
              <p>
                Convert <strong>{lead.name}</strong> into a customer record? Field Scheduler will reuse a matching
                existing customer if one is found (by phone or email), or create a new one. This does not create a Job.
              </p>
              {conversionError && (
                <div class="inline-error" style={{ marginTop: 8 }}>
                  {conversionError}
                  {isAmbiguousMatch && (
                    <div style={{ marginTop: 8 }}>
                      <button type="button" class="btn btn-sm" onClick={() => navigate("/customers")}>Open Customers</button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingConvert(false)} disabled={converting}>Cancel</button>
              <button type="button" class="btn btn-primary" disabled={converting} onClick={confirmConvert}>
                {converting ? "Converting..." : "Convert Lead"}
              </button>
            </div>
          </div>
        </div>
      )}

      {conversionSuccess && (
        <div class="modal-overlay" onClick={() => setConversionSuccess(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Lead converted</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setConversionSuccess(null)}><X size={18} /></button>
            </div>
            <div class="confirm-body">
              <p>{summarizeConversionResult(conversionSuccess.created)}</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setConversionSuccess(null)}>Close</button>
              <button
                type="button" class="btn btn-primary"
                onClick={() => { const cid = conversionSuccess.customerId; setConversionSuccess(null); navigate(`/customers/${cid}`); }}
              >
                View Customer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
