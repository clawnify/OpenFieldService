import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { CONTRACT_STATUSES, CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS } from "../contract-status";
import { Pagination } from "./pagination";
import { Search, X } from "lucide-preact";
import type { Contract, PaginatedState } from "../types";

function ContractStatusBadge({ status }: { status: string }) {
  const color = CONTRACT_STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {CONTRACT_STATUS_LABELS[status] || status}
    </span>
  );
}

/**
 * Phase 13 — Contract list. Self-contained (own local fetch/state), same
 * precedent as quote-list.tsx/lead-list.tsx: irrelevant to the technician
 * role, not part of the app-wide initial-load Promise.all. No "New
 * Contract" button here — Contracts are deliberately only createable from
 * an accepted Quote's own detail page (Section 45: "Do not auto-create a
 * Contract when Quote is accepted" — an explicit staff action is
 * required, and that action lives on the Quote, not here).
 */
export function ContractList({ navigate }: { navigate: (to: string) => void }) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [pag, setPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContracts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pag.limit));
      params.set("offset", String((pag.page - 1) * pag.limit));
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      const data = await api<{ contracts: Contract[]; total: number }>("GET", `/api/contracts?${params.toString()}`);
      setContracts(data.contracts);
      setPag((p) => ({ ...p, total: data.total }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pag.page, pag.limit, search, status]);

  useEffect(() => { fetchContracts(); }, [pag.page, search, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSearchAndReset = (v: string) => { setSearch(v); setPag((p) => ({ ...p, page: 1 })); };
  const setStatusAndReset = (v: string) => { setStatus(v); setPag((p) => ({ ...p, page: 1 })); };
  const setPage = (page: number) => setPag((p) => ({ ...p, page }));
  const hasFilters = !!(search || status);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Contracts</h1>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text"
          class="jobs-search-input"
          placeholder="Search contracts by number or customer name..."
          aria-label="Search contracts by number or customer name"
          value={search}
          onInput={(e) => setSearchAndReset((e.target as HTMLInputElement).value)}
        />
        {search && (
          <button type="button" class="jobs-search-clear" aria-label="Clear search" onClick={() => setSearchAndReset("")}>
            <X size={16} />
          </button>
        )}
      </div>

      <div class="toolbar">
        <div class="filter-group">
          <button class={`filter-btn ${status === "" ? "active" : ""}`} onClick={() => setStatusAndReset("")}>All</button>
          {CONTRACT_STATUSES.map((s) => (
            <button key={s} class={`filter-btn ${status === s ? "active" : ""}`} onClick={() => setStatusAndReset(s)}>
              {CONTRACT_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : contracts.length === 0 ? (
          <div class="empty-state">
            {hasFilters ? (
              <>
                <p>No contracts found</p>
                <p class="text-muted">Try adjusting your search or filters.</p>
              </>
            ) : (
              <>
                <p>No contracts yet</p>
                <p class="text-muted">Create a contract from an accepted quote to get started.</p>
              </>
            )}
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Contract #</th>
                  <th>Customer</th>
                  <th>Quote</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} class="table-row clickable" onClick={() => navigate(`/contracts/${c.id}`)}>
                    <td><span class="identifier">{c.identifier}</span></td>
                    <td class="text-bold">{c.customer_name || "—"}</td>
                    <td class="text-muted">{c.quote_identifier || "—"}</td>
                    <td><ContractStatusBadge status={c.status} /></td>
                    <td class="text-muted">{c.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination pag={pag} setPage={setPage} />
    </div>
  );
}
