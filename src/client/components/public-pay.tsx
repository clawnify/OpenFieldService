import { useEffect, useState } from "preact/hooks";
import { formatCents } from "../money";
import { CheckCircle2, CreditCard, FileX } from "lucide-preact";

interface PayView {
  invoice_identifier: string;
  company_name: string;
  balance_due_cents: number;
  status: string;
}

/**
 * Phase 13B — the ONE page a customer ever sees for online payment
 * (Section 35: no Customer Portal). Standalone, same precedent as
 * sign-contract.tsx: rendered by main.tsx BEFORE AuthProvider mounts, no
 * session, no sidebar. The token in the URL is the entire authorization
 * boundary — every request goes through the public
 * `/api/public/invoices/pay/{token}` routes with no Authorization header.
 *
 * Section 11's flow, made concrete: this page shows the server-
 * authoritative balance (never a client-computed number), "Pay Now"
 * triggers the mock provider's confirmation server-side, and the ONLY
 * thing this page ever displays as "paid" is the server's own
 * post-verification outcome — never a client-side assumption.
 */
export function PublicPay({ token }: { token: string }) {
  const [view, setView] = useState<PayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"paid" | "cancelled" | null>(null);

  const load = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const r = await fetch(`/api/public/invoices/pay/${encodeURIComponent(token)}`);
      if (!r.ok) { setNotFound(true); return; }
      const data = await r.json() as { view: PayView };
      setView(data.view);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmPay = async () => {
    setConfirming(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/invoices/pay/${encodeURIComponent(token)}/confirm`, { method: "POST" });
      const body = await r.json() as { outcome?: string; error?: string };
      if (!r.ok) throw new Error(body.error || "Payment could not be completed");
      if (body.outcome === "payment_recorded" || body.outcome === "already_processed") {
        setOutcome("paid");
      } else {
        throw new Error("Payment could not be completed — please try again or contact us.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const cancelPay = async () => {
    setCancelling(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/invoices/pay/${encodeURIComponent(token)}/cancel`, { method: "POST" });
      if (!r.ok) { const body = await r.json() as { error: string }; throw new Error(body.error); }
      setOutcome("cancelled");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(false);
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
          <p class="auth-subtitle">This payment link is no longer valid. Please contact the sender for a new one.</p>
        </div>
      </div>
    );
  }

  if (!view) return null;

  if (outcome === "paid") {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <CheckCircle2 size={32} style={{ color: "#16a34a" }} />
          <h1 class="auth-title">Payment successful</h1>
          <p class="auth-subtitle">
            Thank you! Your payment for invoice {view.invoice_identifier} has been received. A receipt has been emailed to you.
          </p>
        </div>
      </div>
    );
  }

  if (outcome === "cancelled") {
    return (
      <div class="auth-page">
        <div class="auth-card sign-card">
          <FileX size={32} style={{ color: "#6b7280" }} />
          <h1 class="auth-title">Cancelled</h1>
          <p class="auth-subtitle">This payment was cancelled. No charge was made.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="auth-page">
      <div class="auth-card sign-card">
        <div class="auth-brand">
          <CreditCard size={18} />
          {view.company_name || "Invoice Payment"}
        </div>
        <h1 class="auth-title">Invoice {view.invoice_identifier}</h1>
        <p class="auth-subtitle">Amount due</p>
        <p class="text-bold" style={{ fontSize: 28, margin: "4px 0 16px" }}>{formatCents(view.balance_due_cents)}</p>

        {error && <div class="auth-error">{error}</div>}

        <button type="button" class="btn btn-primary btn-block" disabled={confirming || cancelling} onClick={confirmPay}>
          {confirming ? "Processing..." : `Pay ${formatCents(view.balance_due_cents)} Now`}
        </button>
        <button type="button" class="btn btn-block" style={{ marginTop: 8 }} disabled={confirming || cancelling} onClick={cancelPay}>
          {cancelling ? "Please wait..." : "Cancel"}
        </button>

        <p class="text-muted" style={{ fontSize: 11, marginTop: 16 }}>
          This is a secure, tenant-scoped payment link. It expires automatically and cannot be reused after payment.
        </p>
      </div>
    </div>
  );
}
