import { useEffect, useState } from "preact/hooks";
import { formatCents } from "../money";
import { CheckCircle2, FileX, ShieldCheck } from "lucide-preact";

interface SigningView {
  contract_identifier: string;
  contract_status: string;
  version_title: string;
  version_body: string;
  effective_date: string | null;
  expires_at: string | null;
  commercial_snapshot: string;
  signer_name: string;
  signer_email: string;
  signer_role: string;
  request_status: string;
  consent_at: string | null;
  signed_at: string | null;
}

const CONSENT_TEXT_VERSION = "esign-consent-v1";
const CONSENT_TEXT =
  "By checking this box, you agree to conduct this transaction electronically and to sign this document using an electronic signature. " +
  "Your electronic signature is legally binding, in the same way as a handwritten signature, to the extent permitted by applicable law.";

/**
 * Phase 13 — the ONLY page a customer/signer ever sees for E-Sign
 * (Section 43: no Customer Portal). Deliberately standalone: rendered by
 * main.tsx BEFORE AuthProvider even mounts (see main.tsx's `/sign/:token`
 * intercept) — no session, no sidebar, no AppContext. The token in the URL
 * is the entire authorization boundary; every request here goes through
 * the public `/api/public/contracts/sign/{token}` routes with no
 * Authorization header of any kind.
 */
export function SignContract({ token }: { token: string }) {
  const [view, setView] = useState<SigningView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submittingConsent, setSubmittingConsent] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [submittingSign, setSubmittingSign] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [submittingDecline, setSubmittingDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"signed" | "declined" | null>(null);

  const load = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const r = await fetch(`/api/public/contracts/sign/${encodeURIComponent(token)}`);
      if (!r.ok) { setNotFound(true); return; }
      const data = await r.json() as { view: SigningView };
      setView(data.view);
      if (data.view.signed_at) setOutcome("signed");
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitConsent = async () => {
    setSubmittingConsent(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/contracts/sign/${encodeURIComponent(token)}/consent`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent_text_version: CONSENT_TEXT_VERSION }),
      });
      if (!r.ok) { const body = await r.json() as { error: string }; throw new Error(body.error); }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingConsent(false);
    }
  };

  const submitSign = async () => {
    if (!signerName.trim()) { setError("Type your full legal name to sign"); return; }
    setSubmittingSign(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/contracts/sign/${encodeURIComponent(token)}/sign`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signer_name: signerName.trim(), signature_method: "typed" }),
      });
      if (!r.ok) { const body = await r.json() as { error: string }; throw new Error(body.error); }
      setOutcome("signed");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingSign(false);
    }
  };

  const submitDecline = async () => {
    setSubmittingDecline(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/contracts/sign/${encodeURIComponent(token)}/decline`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: declineReason }),
      });
      if (!r.ok) { const body = await r.json() as { error: string }; throw new Error(body.error); }
      setOutcome("declined");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingDecline(false);
    }
  };

  if (loading) {
    return <div class="auth-page"><div class="auth-card sign-card loading-text">Loading...</div></div>;
  }

  if (notFound) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <FileX size={32} style={{ color: "#dc2626" }} />
          <h1 class="auth-title">Link invalid or expired</h1>
          <p class="auth-subtitle">This signing link is no longer valid. Please contact the sender for a new one.</p>
        </div>
      </div>
    );
  }

  if (!view) return null;

  if (outcome === "signed") {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Signed successfully</h1>
          <p class="auth-subtitle">Thank you, {view.signer_name}. Contract {view.contract_identifier} has been signed. A copy of the signed record is retained for your reference.</p>
        </div>
      </div>
    );
  }

  if (outcome === "declined") {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <FileX size={32} style={{ color: "#6b7280" }} />
          <h1 class="auth-title">Declined</h1>
          <p class="auth-subtitle">You have declined to sign contract {view.contract_identifier}. The sender has been notified.</p>
        </div>
      </div>
    );
  }

  let commercial: { line_items?: { description: string; quantity: number; unit_price_cents: number; total_cents: number }[]; total_cents?: number } = {};
  try { commercial = JSON.parse(view.commercial_snapshot); } catch { /* leave empty — never crash the signing page over a display detail */ }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <div class="auth-brand">
          <ShieldCheck size={18} />
          {view.contract_identifier}
        </div>
        <h1 class="auth-title">{view.version_title || "Agreement"}</h1>
        <p class="auth-subtitle">Prepared for {view.signer_name} ({view.signer_role.replace("_", " ")})</p>

        {error && <div class="auth-error">{error}</div>}

        <div class="sign-document-body">{view.version_body || "No document text was provided."}</div>

        {commercial.line_items && commercial.line_items.length > 0 && (
          <div class="card" style={{ marginTop: 16 }}>
            <table class="table">
              <thead><tr><th>Description</th><th>Qty</th><th class="text-right">Amount</th></tr></thead>
              <tbody>
                {commercial.line_items.map((li, i) => (
                  <tr key={i} class="table-row">
                    <td>{li.description}</td>
                    <td>{li.quantity}</td>
                    <td class="text-right">{formatCents(li.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={2} class="text-right text-bold">Total</td><td class="text-right text-bold">{formatCents(commercial.total_cents ?? 0)}</td></tr>
              </tfoot>
            </table>
          </div>
        )}

        {!view.consent_at ? (
          <div class="sign-consent-block">
            <p class="text-muted" style={{ fontSize: 13 }}>{CONSENT_TEXT}</p>
            <label class="checkbox-row">
              <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked((e.target as HTMLInputElement).checked)} />
              I agree to sign electronically
            </label>
            <button type="button" class="btn btn-primary btn-block" disabled={!consentChecked || submittingConsent} onClick={submitConsent}>
              {submittingConsent ? "Please wait..." : "Continue"}
            </button>
          </div>
        ) : !showDecline ? (
          <div class="sign-consent-block">
            <div class="form-group">
              <label>Type your full legal name to sign</label>
              <input type="text" value={signerName} onInput={(e) => setSignerName((e.target as HTMLInputElement).value)} placeholder="Full name" autoFocus />
            </div>
            <button type="button" class="btn btn-primary btn-block" disabled={submittingSign} onClick={submitSign}>
              {submittingSign ? "Signing..." : "Sign Contract"}
            </button>
            <button type="button" class="btn btn-block" style={{ marginTop: 8 }} onClick={() => setShowDecline(true)}>
              Decline to sign
            </button>
          </div>
        ) : (
          <div class="sign-consent-block">
            <div class="form-group">
              <label>Reason (optional)</label>
              <textarea rows={3} value={declineReason} onInput={(e) => setDeclineReason((e.target as HTMLTextAreaElement).value)} />
            </div>
            <button type="button" class="btn btn-danger btn-block" disabled={submittingDecline} onClick={submitDecline}>
              {submittingDecline ? "Please wait..." : "Confirm Decline"}
            </button>
            <button type="button" class="btn btn-block" style={{ marginTop: 8 }} onClick={() => setShowDecline(false)}>
              Back
            </button>
          </div>
        )}

        <p class="text-muted" style={{ fontSize: 11, marginTop: 16 }}>
          This is a technical record of electronic signature evidence. It is not a substitute for legal advice regarding enforceability in your jurisdiction.
        </p>
      </div>
    </div>
  );
}
