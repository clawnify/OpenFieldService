import { useEffect, useState } from "preact/hooks";
import { CheckCircle2, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-preact";

interface FollowUpView {
  status: string;
  jobIdentifier: string;
  customerName: string;
}

interface RespondResult {
  status: string;
  reviewUrl: string | null;
  planOffer: { id: number; name: string; description: string; tier: string; priceCents: number }[] | null;
}

/**
 * Phase 19D — the public, token-scoped post-job follow-up response page.
 * Mirrors sign-maintenance-agreement.tsx exactly: standalone, rendered by
 * main.tsx BEFORE AuthProvider mounts (no session — the bearer token in
 * the URL is the entire authorization boundary), raw fetch not the
 * authenticated api() helper. A negative response (Section 11's guard)
 * never shows a review link, even server-side never returns one for it —
 * this page has no client-side logic that could accidentally show one
 * anyway, since it only ever renders whatever reviewUrl the server sent.
 */
export function FollowUpResponse({ token }: { token: string }) {
  const [view, setView] = useState<FollowUpView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RespondResult | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/public/follow-up/${encodeURIComponent(token)}`);
        if (!r.ok) { setNotFound(true); return; }
        setView(await r.json() as FollowUpView);
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const respond = async (response: "satisfied" | "needs_attention") => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/follow-up/${encodeURIComponent(token)}/respond`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, notes }),
      });
      const data = await r.json() as RespondResult | { error: string };
      if (!r.ok) { setError((data as { error: string }).error || "Something went wrong."); return; }
      setResult(data as RespondResult);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const trackReviewClick = () => {
    fetch(`/api/public/follow-up/${encodeURIComponent(token)}/review-click`, { method: "POST" }).catch(() => {});
  };

  if (loading) return <div class="auth-page"><div class="loading-text">Loading...</div></div>;

  if (notFound || !view) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <h1 class="auth-title">Link invalid or expired</h1>
          <p class="auth-subtitle">This follow-up link is no longer valid.</p>
        </div>
      </div>
    );
  }

  // Already responded on a prior visit — the server is idempotent and
  // won't reprocess a second submission, but resubmitting through this
  // page would show a confirmation reflecting the ORIGINAL response, not
  // whatever the customer just clicked. Short-circuit before that's
  // possible rather than let a stale form invite a misleading resubmit.
  if (!result && view.status !== "pending") {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Thanks, we've already got your response</h1>
          <p class="auth-subtitle">There's nothing more to do here.</p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Thank you{result.status === "satisfied" ? ", we're glad to hear it!" : " for letting us know"}</h1>
          {result.status === "needs_attention" && (
            <p class="auth-subtitle">A member of our team will follow up with you shortly.</p>
          )}
          {result.reviewUrl && (
            <p class="auth-subtitle">
              Would you take a moment to share your experience?{" "}
              <a href={result.reviewUrl} target="_blank" rel="noopener noreferrer" onClick={trackReviewClick}>Leave a review</a>
            </p>
          )}
          {result.planOffer && result.planOffer.length > 0 && (
            <div class="sign-document-body">
              <p class="text-bold">Keep your equipment running smoothly:</p>
              {result.planOffer.map((p) => (
                <div key={p.id} style={{ marginBottom: 8 }}>
                  <p class="text-bold">{p.name}</p>
                  <p class="text-muted">{p.description}</p>
                </div>
              ))}
              <p class="text-muted" style={{ fontSize: 12 }}>Contact us if you'd like to enroll — no automatic sign-up happens from this page.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <div class="auth-brand">
          <ShieldCheck size={18} />
          {view.jobIdentifier}
        </div>
        <h1 class="auth-title">How did we do?</h1>
        <p class="auth-subtitle">Hi {view.customerName}, we'd love to know how your recent service went.</p>

        {error && <div class="auth-error">{error}</div>}

        <div class="form-group full-width">
          <label for="followup-notes">Notes (optional)</label>
          <textarea id="followup-notes" rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
        </div>

        <div class="form-row" style={{ marginTop: 12 }}>
          <button type="button" class="btn btn-primary" disabled={submitting} onClick={() => respond("satisfied")}>
            <ThumbsUp size={16} /> I'm satisfied
          </button>
          <button type="button" class="btn" disabled={submitting} onClick={() => respond("needs_attention")}>
            <ThumbsDown size={16} /> I have a concern
          </button>
        </div>
      </div>
    </div>
  );
}
