import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS } from "../contract-status";
import type { Contract } from "../types";

/**
 * Phase 13 — small embedded "related Contracts" list, mirroring
 * related-quotes.tsx's dual-filter shape (customerId vs. leadId) exactly:
 * pass `quoteId` on a Quote's own detail page (contracts originating from
 * THIS quote specifically) or `customerId` on a Customer's detail page
 * (every contract for that customer, across all their quotes). Read-only
 * (Section 46: "avoid bloating Customer API payload if separate fetch is
 * cleaner") — no create action here; a Contract is only ever created from
 * an accepted Quote's own detail page (Section 45), never from this
 * embedded list.
 */
export function RelatedContracts({ customerId, quoteId, navigate }: { customerId?: number; quoteId?: number; navigate: (to: string) => void }) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = quoteId !== undefined ? `quote_id=${quoteId}` : `customer_id=${customerId}`;
      const res = await api<{ contracts: Contract[] }>("GET", `/api/contracts?${params}&limit=200`);
      setContracts(res.contracts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customerId, quoteId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div class="detail-section">
      <h3>Contracts ({contracts.length})</h3>
      {error && <div class="inline-error" style={{ marginBottom: 10 }}>{error}</div>}
      {loading ? (
        <p class="text-muted">Loading...</p>
      ) : contracts.length === 0 ? (
        <p class="text-muted">No contracts yet</p>
      ) : (
        <div class="card">
          <table class="table">
            <thead><tr><th>Contract #</th><th>Quote</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {contracts.map((c) => {
                const color = CONTRACT_STATUS_COLORS[c.status] || "#6b7280";
                return (
                  <tr key={c.id} class="table-row clickable" onClick={() => navigate(`/contracts/${c.id}`)}>
                    <td><span class="identifier">{c.identifier}</span></td>
                    <td class="text-muted">{c.quote_identifier || "—"}</td>
                    <td>
                      <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
                        <span class="status-dot" style={{ background: color }} />
                        {CONTRACT_STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                    <td class="text-muted">{c.created_at.slice(0, 10)}</td>
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
