import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { emailPreferenceSummary, smsConsentSummary, type ChannelPreferenceView } from "../notification-status";
import { X } from "lucide-preact";

interface PreferencesResponse {
  preferences: { hasRow: boolean; email: ChannelPreferenceView; sms: ChannelPreferenceView };
  sms_consent_sources: string[];
}

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  phone: "Phone call",
  in_person: "In person",
  web: "Website",
  written: "Written / signed form",
  other: "Other",
};

/**
 * Phase 9.3 — Notification Preferences for a Customer or Lead. Self-
 * contained (own fetch, own state), same precedent as LeadDetail
 * (Phase 8.4) rather than threading new state through the large
 * AppContext/use-app.ts hub — this drops into CustomerDetail (AppContext-
 * based) and LeadDetail (self-contained) equally well.
 *
 * `role` gates rendering client-side only (UI convenience, matching every
 * other role-hidden control in this app) — the server independently
 * enforces the real RBAC on every read/write regardless of what this
 * component does.
 */
export function NotificationPreferences({
  recipientType, recipientId, role,
}: {
  recipientType: "customer" | "lead";
  recipientId: number;
  role: string | undefined;
}) {
  const [data, setData] = useState<PreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [pendingEmailValue, setPendingEmailValue] = useState<boolean | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);

  const [pendingSmsDisable, setPendingSmsDisable] = useState(false);
  const [savingSmsDisable, setSavingSmsDisable] = useState(false);

  const [showEnableSms, setShowEnableSms] = useState(false);
  const [consentSourceDraft, setConsentSourceDraft] = useState("");
  const [enablingSms, setEnablingSms] = useState(false);

  const basePath = recipientType === "customer" ? `/api/customers/${recipientId}` : `/api/leads/${recipientId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<PreferencesResponse>("GET", `${basePath}/notification-preferences`);
      setData(res);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  useEffect(() => { load(); }, [load]);

  if (role === "technician") return null;

  if (loading) return <div class="detail-sidebar-section"><h4>Notification Preferences</h4><p class="text-muted">Loading...</p></div>;

  if (loadError || !data) {
    return (
      <div class="detail-sidebar-section">
        <h4>Notification Preferences</h4>
        <div class="inline-error">{loadError || "Couldn't load notification preferences."}</div>
      </div>
    );
  }

  const { preferences } = data;
  const emailSummary = emailPreferenceSummary(preferences.email, preferences.hasRow);
  const smsSummary = smsConsentSummary(preferences.sms);

  const requestEmailToggle = () => { setMutationError(null); setPendingEmailValue(!preferences.email.enabled); };

  const confirmEmailToggle = async () => {
    if (pendingEmailValue === null) return;
    setSavingEmail(true);
    setMutationError(null);
    try {
      const res = await api<PreferencesResponse>("PUT", `${basePath}/notification-preferences`, { email_enabled: pendingEmailValue });
      setData(res);
      setPendingEmailValue(null);
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setSavingEmail(false);
    }
  };

  const requestSmsDisable = () => { setMutationError(null); setPendingSmsDisable(true); };

  const confirmSmsDisable = async () => {
    setSavingSmsDisable(true);
    setMutationError(null);
    try {
      const res = await api<PreferencesResponse>("PUT", `${basePath}/notification-preferences`, { sms_enabled: false });
      setData(res);
      setPendingSmsDisable(false);
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setSavingSmsDisable(false);
    }
  };

  // Phase 9.4 — consent policy finalized: EVERY enable action (first-time
  // or re-enable after a disable) requires a fresh consent capture, even
  // if a consent timestamp survives from before a prior disable. Silently
  // reusing old historical consent to authorize a new enable was Phase
  // 9.3's original (disclosed, since-reversed) interpretation — the server
  // now rejects a bare `{sms_enabled: true}` with no source whenever SMS
  // isn't already validly enabled, so this UI never offers that path.
  const requestSmsEnable = () => {
    setMutationError(null);
    setConsentSourceDraft("");
    setShowEnableSms(true);
  };

  const confirmEnableSms = async () => {
    setEnablingSms(true);
    setMutationError(null);
    try {
      const res = await api<PreferencesResponse>("PUT", `${basePath}/notification-preferences`, {
        sms_enabled: true, sms_consent_source: consentSourceDraft,
      });
      setData(res);
      setShowEnableSms(false);
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setEnablingSms(false);
    }
  };

  return (
    <div class="detail-sidebar-section notification-preferences">
      <h4>Notification Preferences</h4>
      {mutationError && <div class="inline-error" style={{ marginBottom: 10 }}>{mutationError}</div>}

      <div class="notification-pref-row">
        <div>
          <strong>Email Notifications</strong>
          <p class="text-muted" style={{ margin: "2px 0 4px" }}>
            Receive operational updates such as appointment confirmations, schedule changes, invoices, and receipts.
          </p>
          <span class={`notification-pref-state ${preferences.email.enabled ? "on" : "off"}`}>{emailSummary.label}</span>
          <p class="text-muted" style={{ margin: "2px 0 0", fontSize: 12 }}>{emailSummary.detail}</p>
        </div>
        <button type="button" class="btn btn-sm" onClick={requestEmailToggle}>
          {preferences.email.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      <div class="notification-pref-row">
        <div>
          <strong>SMS Notifications</strong>
          <p class="text-muted" style={{ margin: "2px 0 4px" }}>
            Time-sensitive text messages such as "technician on the way" and day-before reminders. Requires recorded consent.
          </p>
          <span class={`notification-pref-state ${preferences.sms.enabled && !smsSummary.warning ? "on" : smsSummary.warning ? "warn" : "off"}`}>
            {smsSummary.label}
          </span>
          <p class="text-muted" style={{ margin: "2px 0 0", fontSize: 12 }}>{smsSummary.detail}</p>
        </div>
        {preferences.sms.enabled ? (
          <button type="button" class="btn btn-sm" onClick={requestSmsDisable}>Disable</button>
        ) : (
          <button type="button" class="btn btn-sm btn-primary" onClick={requestSmsEnable}>Enable</button>
        )}
      </div>

      {pendingEmailValue !== null && (
        <ConfirmDialog
          title={pendingEmailValue ? "Enable email notifications?" : "Disable email notifications?"}
          message={
            pendingEmailValue
              ? "This recipient will start receiving operational email updates again."
              : "This recipient will stop receiving operational email updates (confirmations, schedule changes, invoices, receipts)."
          }
          confirmLabel={pendingEmailValue ? "Enable" : "Disable"}
          danger={!pendingEmailValue}
          submitting={savingEmail}
          onConfirm={confirmEmailToggle}
          onClose={() => setPendingEmailValue(null)}
        />
      )}

      {pendingSmsDisable && (
        <ConfirmDialog
          title="Disable SMS notifications?"
          message="This recipient will stop receiving text messages. Their previously recorded consent stays on file as a historical record, but re-enabling SMS later will require capturing consent again."
          confirmLabel="Disable"
          danger
          submitting={savingSmsDisable}
          onConfirm={confirmSmsDisable}
          onClose={() => setPendingSmsDisable(false)}
        />
      )}

      {showEnableSms && (
        <div class="modal-overlay" onClick={() => !enablingSms && setShowEnableSms(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Enable SMS notifications?</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowEnableSms(false)}><X size={18} /></button>
            </div>
            <div class="confirm-body">
              <p>SMS requires recorded consent. Select how this recipient's consent was obtained.</p>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Consent Source *</label>
                  <select value={consentSourceDraft} onChange={(e) => setConsentSourceDraft((e.target as HTMLSelectElement).value)} required>
                    <option value="">Select...</option>
                    {data.sms_consent_sources.map((s) => <option key={s} value={s}>{CONSENT_SOURCE_LABELS[s] || s}</option>)}
                  </select>
                </div>
              </div>
              {mutationError && <div class="inline-error" style={{ marginTop: 8 }}>{mutationError}</div>}
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setShowEnableSms(false)} disabled={enablingSms}>Cancel</button>
              <button type="button" class="btn btn-primary" disabled={enablingSms || !consentSourceDraft} onClick={confirmEnableSms}>
                {enablingSms ? "Please wait..." : "Enable SMS"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
