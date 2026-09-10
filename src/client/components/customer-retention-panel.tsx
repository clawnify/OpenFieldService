import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { X } from "lucide-preact";

interface Referral { id: number; referral_code: string; status: string; created_at: string }
interface Credit { id: number; amount_cents: number | null; value_description: string; status: string; reason: string; issued_at: string }

/**
 * Phase 19D — Customer-scoped Referrals + Loyalty Credits panel, dropped
 * into CustomerDetail's sidebar column alongside the existing
 * NotificationPreferences (same self-contained-fetch precedent). Minting a
 * referral code and viewing credits are admin+dispatcher
 * (canManageRetention); issuing a manual credit is admin-only — both
 * independently enforced server-side.
 */
export function CustomerRetentionPanel({ customerId, role }: { customerId: number; role: string | undefined }) {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [balanceCents, setBalanceCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueAmount, setIssueAmount] = useState("");
  const [issueReason, setIssueReason] = useState("");
  const [issuing, setIssuing] = useState(false);

  const isAdmin = role === "admin";

  const load = async () => {
    setLoading(true);
    try {
      const [referralsRes, creditsRes] = await Promise.all([
        api<{ referrals: Referral[] }>("GET", `/api/customers/${customerId}/referrals`),
        api<{ credits: Credit[]; availableBalanceCents: number }>("GET", `/api/customers/${customerId}/credits`),
      ]);
      setReferrals(referralsRes.referrals);
      setCredits(creditsRes.credits);
      setBalanceCents(creditsRes.availableBalanceCents);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (role !== "technician") load(); }, [customerId, role]); // eslint-disable-line react-hooks/exhaustive-deps

  if (role === "technician") return null;

  const mintReferral = async () => {
    setMinting(true);
    setError(null);
    try {
      await api("POST", `/api/customers/${customerId}/referrals`, {});
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMinting(false);
    }
  };

  const copyLink = (code: string) => {
    const url = `${window.location.origin}/refer/${code}`;
    navigator.clipboard?.writeText(url).catch(() => {});
  };

  const issueCredit = async () => {
    if (!issueReason.trim()) return;
    setIssuing(true);
    setError(null);
    try {
      const amountCents = issueAmount.trim() ? Math.round(parseFloat(issueAmount) * 100) : null;
      await api("POST", `/api/customers/${customerId}/credits`, { amount_cents: amountCents, reason: issueReason.trim() });
      setShowIssue(false);
      setIssueAmount("");
      setIssueReason("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIssuing(false);
    }
  };

  if (loading) return <div class="detail-sidebar-section"><h4>Referrals &amp; Loyalty</h4><p class="text-muted">Loading...</p></div>;

  return (
    <div class="detail-sidebar-section">
      <h4>Referrals &amp; Loyalty</h4>
      {error && <div class="inline-error" style={{ marginBottom: 8 }}>{error}</div>}

      <p class="text-bold" style={{ marginBottom: 4 }}>Referral Links</p>
      {referrals.length === 0 ? (
        <p class="text-muted" style={{ fontSize: 12 }}>No referral links yet.</p>
      ) : (
        <ul style={{ fontSize: 13 }}>
          {referrals.map((r) => (
            <li key={r.id}>
              <code style={{ fontSize: 11 }}>{r.referral_code}</code> — {r.status}
              {r.status === "active" && (
                <button class="btn-icon" aria-label={`Copy referral link ${r.referral_code}`} onClick={() => copyLink(r.referral_code)} style={{ marginLeft: 4 }}>copy</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button class="btn btn-sm" disabled={minting} onClick={mintReferral} style={{ marginTop: 4 }}>
        {minting ? "Creating..." : "New Referral Link"}
      </button>

      <p class="text-bold" style={{ marginTop: 12, marginBottom: 4 }}>Loyalty Credit — Available: {formatCents(balanceCents)}</p>
      {credits.length === 0 ? (
        <p class="text-muted" style={{ fontSize: 12 }}>No credits issued yet.</p>
      ) : (
        <ul style={{ fontSize: 13 }}>
          {credits.map((c) => (
            <li key={c.id}>
              {c.amount_cents != null ? formatCents(c.amount_cents) : c.value_description || "Non-cash"} — {c.status} ({c.reason})
            </li>
          ))}
        </ul>
      )}
      {isAdmin && <button class="btn btn-sm" onClick={() => setShowIssue(true)} style={{ marginTop: 4 }}>Issue Credit</button>}

      {showIssue && (
        <div class="modal-overlay" onClick={() => setShowIssue(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Issue Loyalty Credit</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowIssue(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label for="credit-amount">Amount (dollars, blank for non-cash)</label>
                <input id="credit-amount" type="text" inputMode="decimal" value={issueAmount} onInput={(e) => setIssueAmount((e.target as HTMLInputElement).value)} />
              </div>
              <div class="form-group">
                <label for="credit-reason">Reason *</label>
                <input id="credit-reason" type="text" value={issueReason} onInput={(e) => setIssueReason((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowIssue(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={issuing || !issueReason.trim()} onClick={issueCredit}>{issuing ? "Saving..." : "Issue"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
