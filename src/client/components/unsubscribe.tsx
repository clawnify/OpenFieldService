import { useEffect, useState } from "preact/hooks";
import { CheckCircle2 } from "lucide-preact";

/**
 * Phase 19D — the public, token-scoped marketing-unsubscribe page. Same
 * standalone precedent as the other Phase 19D public pages (no session,
 * rendered before AuthProvider). Never touches transactional notifications
 * — only the separate marketing consent tier.
 */
export function Unsubscribe({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [valid, setValid] = useState(false);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/public/marketing-unsubscribe/${encodeURIComponent(token)}`);
        setValid(r.ok);
      } catch {
        setValid(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/marketing-unsubscribe/${encodeURIComponent(token)}`, { method: "POST" });
      if (!r.ok) { setError("Something went wrong. Please try again."); return; }
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div class="auth-page"><div class="loading-text">Loading...</div></div>;

  if (!valid) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <h1 class="auth-title">Link invalid</h1>
          <p class="auth-subtitle">This unsubscribe link is no longer valid.</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">You're unsubscribed</h1>
          <p class="auth-subtitle">You will no longer receive marketing emails or texts from us. Service-related messages (appointments, invoices, receipts) are unaffected.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <h1 class="auth-title">Unsubscribe from marketing?</h1>
        <p class="auth-subtitle">You'll stop receiving promotional emails and texts. This won't affect appointment, invoice, or receipt notifications.</p>
        {error && <div class="auth-error">{error}</div>}
        <button type="button" class="btn btn-primary" disabled={submitting} onClick={confirm}>
          {submitting ? "Please wait..." : "Unsubscribe"}
        </button>
      </div>
    </div>
  );
}
