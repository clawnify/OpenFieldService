import { useEffect, useState } from "preact/hooks";
import { CheckCircle2, ShieldCheck } from "lucide-preact";

interface ReferralView {
  referrerName: string;
}

/**
 * Phase 19D — the public referral landing/claim page. Same standalone
 * precedent as sign-maintenance-agreement.tsx/follow-up-response.tsx: no
 * session, rendered before AuthProvider, raw fetch. The opaque code in the
 * URL is the entire authorization boundary — never a raw customer id
 * (Section 36). Submitting creates a Lead attributed to the referrer;
 * self-referral and duplicate-claim are both rejected server-side (a
 * generic "invalid or already-used" message either way — never disclosing
 * WHY a specific code was rejected, so this page can't be used to probe
 * who a referrer's contacts are).
 */
export function Refer({ code }: { code: string }) {
  const [view, setView] = useState<ReferralView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/public/refer/${encodeURIComponent(code)}`);
        if (!r.ok) { setNotFound(true); return; }
        setView(await r.json() as ReferralView);
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/refer/${encodeURIComponent(code)}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: "This referral link is invalid or has already been used." })) as { error: string };
        setError(data.error);
        return;
      }
      setClaimed(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div class="auth-page"><div class="loading-text">Loading...</div></div>;

  if (notFound || !view) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <h1 class="auth-title">Link invalid or expired</h1>
          <p class="auth-subtitle">This referral link is no longer valid.</p>
        </div>
      </div>
    );
  }

  if (claimed) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Thanks for your interest!</h1>
          <p class="auth-subtitle">We've received your information and a member of our team will reach out soon.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <div class="auth-brand">
          <ShieldCheck size={18} />
          Referred by {view.referrerName}
        </div>
        <h1 class="auth-title">You've been referred!</h1>
        <p class="auth-subtitle">Tell us a bit about yourself and we'll be in touch.</p>

        {error && <div class="auth-error">{error}</div>}

        <div class="form-group full-width">
          <label for="refer-name">Your Name *</label>
          <input id="refer-name" type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required />
        </div>
        <div class="form-group full-width">
          <label for="refer-phone">Phone</label>
          <input id="refer-phone" type="tel" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group full-width">
          <label for="refer-email">Email</label>
          <input id="refer-email" type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </div>

        <button type="button" class="btn btn-primary" style={{ marginTop: 12 }} disabled={submitting || !name.trim()} onClick={submit}>
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </div>
  );
}
