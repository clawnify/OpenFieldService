import { useEffect, useRef, useState } from "preact/hooks";
import { formatCents } from "../money";
import { CheckCircle2, FileX, ShieldCheck } from "lucide-preact";
import { scalePointerPosition } from "../signature-geometry";

interface SigningView {
  agreement_identifier: string;
  agreement_status: string;
  plan_snapshot: string;
  customer_snapshot: string;
  effective_date: string | null;
  expires_at: string | null;
  renewal_preference: string;
  total_price_cents: number;
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
const AUTO_RENEW_CONSENT_TEXT_VERSION = "auto-renew-consent-v1";

/**
 * Phase 19B — the ONLY page a customer/signer ever sees for Maintenance
 * Agreement e-sign. Mirrors sign-contract.tsx exactly (deliberately
 * standalone, rendered by main.tsx BEFORE AuthProvider mounts — no
 * session, no sidebar). The token in the URL is the entire authorization
 * boundary. Adds ONE thing Contracts doesn't have: a separate, explicit,
 * never-preselected auto-renew choice (Section 14).
 */
export function SignMaintenanceAgreement({ token }: { token: string }) {
  const [view, setView] = useState<SigningView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submittingConsent, setSubmittingConsent] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signMethod, setSignMethod] = useState<"typed" | "drawn">("typed");
  const [autoRenewEnabled, setAutoRenewEnabled] = useState<boolean | null>(null);
  const [submittingSign, setSubmittingSign] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);

  const load = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const r = await fetch(`/api/public/maintenance-agreements/sign/${encodeURIComponent(token)}`);
      if (!r.ok) { setNotFound(true); return; }
      const data = await r.json() as { view: SigningView };
      setView(data.view);
      if (data.view.signed_at) setSigned(true);
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
      const r = await fetch(`/api/public/maintenance-agreements/sign/${encodeURIComponent(token)}/consent`, {
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

  const getPos = (e: PointerEvent, canvas: HTMLCanvasElement) =>
    scalePointerPosition(e.clientX, e.clientY, canvas.getBoundingClientRect(), canvas);
  const startDraw = (e: PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    hasDrawn.current = true;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const moveDraw = (e: PointerEvent) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e, canvas);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const endDraw = () => { drawing.current = false; };
  const clearDraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn.current = false;
  };

  const submitSign = async () => {
    if (!signerName.trim()) { setError("Type your full legal name to sign"); return; }
    if (signMethod === "drawn" && !hasDrawn.current) { setError("Please sign in the box before continuing"); return; }
    if (autoRenewEnabled === null) { setError("Please choose whether to enable auto-renew before signing"); return; }
    setSubmittingSign(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        signer_name: signerName.trim(), signature_method: signMethod,
        auto_renew_enabled: autoRenewEnabled, auto_renew_consent_text_version: AUTO_RENEW_CONSENT_TEXT_VERSION,
      };
      if (signMethod === "drawn" && canvasRef.current) {
        body.signature_image_data_url = canvasRef.current.toDataURL("image/png");
      }
      const r = await fetch(`/api/public/maintenance-agreements/sign/${encodeURIComponent(token)}/sign`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const body2 = await r.json() as { error: string }; throw new Error(body2.error); }
      setSigned(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingSign(false);
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

  if (signed) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Signed successfully</h1>
          <p class="auth-subtitle">Thank you, {view.signer_name}. Agreement {view.agreement_identifier} has been signed. A copy is retained for your reference.</p>
        </div>
      </div>
    );
  }

  let plan: { name?: string; description?: string; tier?: string; frequency_description?: string; visit_entitlement_count?: number | null; priority_benefit?: string; included_services?: string[] } = {};
  try { plan = JSON.parse(view.plan_snapshot); } catch { /* never crash the signing page over a display detail */ }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <div class="auth-brand">
          <ShieldCheck size={18} />
          {view.agreement_identifier}
        </div>
        <h1 class="auth-title">{plan.name || "Maintenance Agreement"}</h1>
        <p class="auth-subtitle">Prepared for {view.signer_name}</p>

        {error && <div class="auth-error">{error}</div>}

        <div class="sign-document-body">
          {plan.description || "No description provided."}
          {plan.frequency_description && <p>Visit frequency: {plan.frequency_description}</p>}
          <p>Included visits: {plan.visit_entitlement_count == null ? "Unlimited" : plan.visit_entitlement_count}</p>
          {plan.priority_benefit && <p>{plan.priority_benefit}</p>}
        </div>

        <div class="card" style={{ marginTop: 16 }}>
          <div class="form-row"><span>Total Price</span><span class="text-bold">{formatCents(view.total_price_cents)}</span></div>
          {view.effective_date && <div class="form-row"><span>Effective Date</span><span>{view.effective_date}</span></div>}
        </div>

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
        ) : (
          <div class="sign-consent-block">
            <div class="form-group">
              <label>Type your full legal name to sign</label>
              <input type="text" value={signerName} onInput={(e) => setSignerName((e.target as HTMLInputElement).value)} placeholder="Full name" autoFocus />
            </div>
            <div class="form-group">
              <label>Signature Method</label>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" class="btn btn-sm" style={signMethod === "typed" ? { fontWeight: 700 } : undefined} onClick={() => setSignMethod("typed")}>
                  Type Signature
                </button>
                <button type="button" class="btn btn-sm" style={signMethod === "drawn" ? { fontWeight: 700 } : undefined} onClick={() => setSignMethod("drawn")}>
                  Draw Signature
                </button>
              </div>
            </div>
            {signMethod === "drawn" && (
              <div class="form-group">
                <p class="text-muted" style={{ fontSize: 12 }}>Sign in the box below with your finger, stylus, or mouse.</p>
                <canvas
                  ref={canvasRef} width={400} height={160} class="signature-canvas"
                  aria-label="Signature drawing area"
                  onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={endDraw} onPointerLeave={endDraw}
                />
                <button type="button" class="btn btn-sm" style={{ marginTop: 6 }} onClick={clearDraw}>Clear</button>
              </div>
            )}
            <div class="form-group">
              <label>Auto-Renew</label>
              <p class="text-muted" style={{ fontSize: 12 }}>
                Choose whether this agreement should automatically renew when it reaches its end date. This choice is recorded separately from your signature and can be changed later by contacting us.
              </p>
              <label class="checkbox-row">
                <input type="radio" name="auto-renew" checked={autoRenewEnabled === true} onChange={() => setAutoRenewEnabled(true)} />
                Yes, enable auto-renew
              </label>
              <label class="checkbox-row">
                <input type="radio" name="auto-renew" checked={autoRenewEnabled === false} onChange={() => setAutoRenewEnabled(false)} />
                No, do not auto-renew
              </label>
            </div>
            <button type="button" class="btn btn-primary btn-block" disabled={submittingSign} onClick={submitSign}>
              {submittingSign ? "Signing..." : "Sign Agreement"}
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
