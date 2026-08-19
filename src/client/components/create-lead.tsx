import { useEffect, useState } from "preact/hooks";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { useReferenceData } from "../reference-data";
import { useAssignableUsers } from "../hooks/use-assignable-users";
import { resolveReferralFieldsOnSourceChange } from "../lead-helpers";
import { parseDollarsToCents } from "../money";
import { JOB_TYPE_LABELS, JOB_TYPE_OPTIONS } from "../job-type-labels";
import { ConfirmDialog } from "./confirm-dialog";
import { CustomerSearchSelect } from "./customer-search-select";
import { X } from "lucide-preact";
import type { Lead } from "../types";

/**
 * Phase 8.4 — Create Lead. Same sectioned/scrollable/stage-then-confirm
 * pattern as create-customer.tsx. Posts to the existing POST /api/leads
 * (Phase 8.2) — no new endpoint. `status` is never sent (the server always
 * starts a new Lead at "new"); `identifier`/actor fields don't even exist
 * in this form, matching the server's own .strict() schema exactly.
 */
export function CreateLead({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> | void }) {
  const { user } = useAuth();
  const { referralSources } = useReferenceData();
  const { users: assignableUsers, available: assigneesAvailable } = useAssignableUsers(user?.role);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [referralName, setReferralName] = useState("");
  const [referredById, setReferredById] = useState<number | null>(null);
  const [referredByLabel, setReferredByLabel] = useState("");
  const [assignedUserId, setAssignedUserId] = useState<number | null>(null);
  const [programInterest, setProgramInterest] = useState("");
  const [estimatedValueInput, setEstimatedValueInput] = useState("");
  const [notes, setNotes] = useState("");

  const [formError, setFormError] = useState<string | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Escape-to-close, scoped to this modal only — same precedent as
  // ScheduleEditModal (Phase 7): a new component starts correct, the
  // shared ConfirmDialog's own lack of Escape handling is a documented,
  // separately-tracked pre-existing gap this phase doesn't fix.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape" && !pendingSubmit) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingSubmit, onClose]);

  const handleReferralSourceChange = (value: string) => {
    setReferralSource(value);
    const cleared = resolveReferralFieldsOnSourceChange(value, { referralName, referredById });
    setReferralName(cleared.referralName);
    setReferredById(cleared.referredById);
    if (cleared.referredById === null) setReferredByLabel("");
  };

  const requestSubmit = (e: Event) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError("Name is required"); return; }
    if (referralSource === "Referral" && !referralName.trim()) { setFormError("Referral Name is required"); return; }
    if (referralSource === "Existing Customer" && referredById === null) { setFormError("Select the customer who made the referral"); return; }
    setPendingSubmit(true);
  };

  const confirmSubmit = async () => {
    setSubmitting(true);
    try {
      await api<Lead>("POST", "/api/leads", {
        name: name.trim(),
        phone, email, address, city, state, zip,
        assigned_user_id: assignedUserId,
        referral_source: referralSource,
        referral_name: referralName,
        referred_by_customer_id: referredById,
        program_interest: programInterest || null,
        estimated_value_cents: parseDollarsToCents(estimatedValueInput),
        notes,
      });
      await onCreated();
      onClose();
    } catch (err) {
      setFormError((err as Error).message);
      setPendingSubmit(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>New Lead</h2>
          <button class="btn-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <form class="lead-form" onSubmit={requestSubmit}>
          <div class="modal-body-scroll">
            {formError && <div class="inline-error" style={{ marginBottom: 12 }}>{formError}</div>}

            <div class="form-section">
              <div class="form-section-heading">Contact Information</div>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Name *</label>
                  <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required placeholder="Jane Prospect" />
                </div>
                <div class="form-group">
                  <label>Phone</label>
                  <input type="tel" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} placeholder="(555) 123-4567" />
                </div>
                <div class="form-group">
                  <label>Email</label>
                  <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="jane@example.com" />
                </div>
                <div class="form-group full-width">
                  <label>Address</label>
                  <input type="text" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} placeholder="123 Main St" />
                </div>
                <div class="form-group">
                  <label>City</label>
                  <input type="text" value={city} onInput={(e) => setCity((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Province/State</label>
                  <input type="text" value={state} onInput={(e) => setState((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Postal Code</label>
                  <input type="text" value={zip} onInput={(e) => setZip((e.target as HTMLInputElement).value)} />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Lead Details</div>
              <div class="form-grid">
                <div class="form-group">
                  <label>Referral Source</label>
                  <select value={referralSource} onChange={(e) => handleReferralSourceChange((e.target as HTMLSelectElement).value)}>
                    <option value="">Select...</option>
                    {referralSources.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Assigned To</label>
                  {assigneesAvailable ? (
                    <select
                      value={assignedUserId ?? ""}
                      onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setAssignedUserId(v ? parseInt(v, 10) : null); }}
                    >
                      <option value="">Unassigned</option>
                      {assignableUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  ) : (
                    <p class="text-muted" style={{ fontSize: 12, margin: 0 }}>
                      Couldn't load the assignable user list — leave unassigned, or try again in a moment.
                    </p>
                  )}
                </div>
                <div class="form-group">
                  <label>Program Interest</label>
                  <select value={programInterest} onChange={(e) => setProgramInterest((e.target as HTMLSelectElement).value)}>
                    <option value="">Not sure yet</option>
                    {JOB_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{JOB_TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Estimated Value</label>
                  <input
                    type="text" inputMode="decimal" value={estimatedValueInput}
                    onInput={(e) => setEstimatedValueInput((e.target as HTMLInputElement).value)}
                    placeholder="$0.00"
                  />
                  <span class="text-muted" style={{ fontSize: 12 }}>Estimated opportunity value — this does not create an invoice.</span>
                </div>

                {referralSource === "Referral" && (
                  <div class="form-group full-width">
                    <label>Referral Name *</label>
                    <input
                      type="text" value={referralName}
                      onInput={(e) => setReferralName((e.target as HTMLInputElement).value)}
                      placeholder="Jane Smith" required
                    />
                  </div>
                )}
                {referralSource === "Existing Customer" && (
                  <div class="form-group full-width">
                    <label>Referred By Customer *</label>
                    <CustomerSearchSelect
                      value={referredById}
                      valueLabel={referredByLabel}
                      onChange={(id, label) => { setReferredById(id); setReferredByLabel(label); }}
                    />
                  </div>
                )}

                <div class="form-group full-width">
                  <label>Notes</label>
                  <textarea rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating..." : "Create Lead"}
            </button>
          </div>
        </form>
      </div>
    </div>

    {pendingSubmit && (
      <ConfirmDialog
        title="Create this lead?"
        message={`Create a new lead for "${name.trim()}"?`}
        confirmLabel="Create"
        submitting={submitting}
        onConfirm={confirmSubmit}
        onClose={() => setPendingSubmit(false)}
      />
    )}
    </>
  );
}
