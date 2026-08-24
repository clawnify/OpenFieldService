import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { QUOTE_STATUS_LABELS, QUOTE_STATUS_COLORS } from "../quote-status";
import { Plus } from "lucide-preact";
import type { Quote } from "../types";

/**
 * Phase 12 — small embedded "related Quotes" list for Customer/Lead detail
 * pages. Read-mostly (Section 32: "do not overload payloads") — reuses the
 * existing GET /api/quotes list filters rather than a bespoke endpoint.
 * `customerId` is required to create a quote here (Quote.customer_id is
 * mandatory); when only `leadId` is given (a not-yet-converted Lead), the
 * quotes shown are ones already linked to this lead, but creation is
 * disabled — a Lead converts to a Customer before it can be quoted.
 */
export function RelatedQuotes({ customerId, leadId, navigate }: { customerId?: number; leadId?: number; navigate: (to: string) => void }) {
  const [quotes, setQuotes] = useState<(Quote & { total_cents: number | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = leadId !== undefined ? `lead_id=${leadId}` : `customer_id=${customerId}`;
      const res = await api<{ quotes: (Quote & { total_cents: number | null })[] }>("GET", `/api/quotes?${params}&limit=200`);
      setQuotes(res.quotes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customerId, leadId]);

  useEffect(() => { load(); }, [load]);

  const createQuote = async () => {
    if (customerId === undefined) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ quote: { id: number } }>("POST", "/api/quotes", { customer_id: customerId, lead_id: leadId ?? undefined });
      navigate(`/quotes/${res.quote.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3>Quotes ({quotes.length})</h3>
        {customerId !== undefined && (
          <button class="btn btn-sm" disabled={creating} onClick={createQuote}><Plus size={14} /> New Quote</button>
        )}
      </div>
      {error && <div class="inline-error" style={{ marginBottom: 10 }}>{error}</div>}
      {loading ? (
        <p class="text-muted">Loading...</p>
      ) : quotes.length === 0 ? (
        <p class="text-muted">No quotes yet</p>
      ) : (
        <div class="card">
          <table class="table">
            <thead><tr><th>Quote #</th><th>Status</th><th class="text-right">Total</th><th>Created</th></tr></thead>
            <tbody>
              {quotes.map((q) => {
                const color = QUOTE_STATUS_COLORS[q.status] || "#6b7280";
                return (
                  <tr key={q.id} class="table-row clickable" onClick={() => navigate(`/quotes/${q.id}`)}>
                    <td><span class="identifier">{q.identifier}</span></td>
                    <td>
                      <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
                        <span class="status-dot" style={{ background: color }} />
                        {QUOTE_STATUS_LABELS[q.status] || q.status}
                      </span>
                    </td>
                    <td class="text-right">{q.total_cents !== null ? formatCents(q.total_cents) : "—"}</td>
                    <td class="text-muted">{q.created_at.slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
