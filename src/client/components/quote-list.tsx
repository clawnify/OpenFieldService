import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { QUOTE_STATUSES, QUOTE_STATUS_COLORS, QUOTE_STATUS_LABELS } from "../quote-status";
import { formatCents } from "../money";
import { Pagination } from "./pagination";
import { CreateQuote } from "./create-quote";
import { Plus, Search, X } from "lucide-preact";
import type { PaginatedState, Quote } from "../types";

function QuoteStatusBadge({ status }: { status: string }) {
  const color = QUOTE_STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {QUOTE_STATUS_LABELS[status] || status}
    </span>
  );
}

/**
 * Phase 12 — Quote list. Self-contained (own local fetch/state), NOT wired
 * into the central AppContext/use-app.ts — same precedent as
 * lead-list.tsx/eligibility-tracker.tsx: entirely irrelevant to the
 * technician role, doesn't need to be part of the app-wide initial-load
 * Promise.all.
 */
export function QuoteList({ navigate }: { navigate: (to: string) => void }) {
  const [quotes, setQuotes] = useState<(Quote & { total_cents: number | null })[]>([]);
  const [pag, setPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(pag.page));
      params.set("limit", String(pag.limit));
      params.set("offset", String((pag.page - 1) * pag.limit));
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      const data = await api<{ quotes: (Quote & { total_cents: number | null })[]; total: number }>("GET", `/api/quotes?${params.toString()}`);
      setQuotes(data.quotes);
      setPag((p) => ({ ...p, total: data.total }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pag.page, pag.limit, search, status]);

  useEffect(() => { fetchQuotes(); }, [pag.page, search, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSearchAndReset = (v: string) => { setSearch(v); setPag((p) => ({ ...p, page: 1 })); };
  const setStatusAndReset = (v: string) => { setStatus(v); setPag((p) => ({ ...p, page: 1 })); };
  const setPage = (page: number) => setPag((p) => ({ ...p, page }));
  const hasFilters = !!(search || status);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Quotes</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Quote
        </button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text"
          class="jobs-search-input"
          placeholder="Search quotes by number or customer name..."
          aria-label="Search quotes by number or customer name"
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
          {QUOTE_STATUSES.map((s) => (
            <button key={s} class={`filter-btn ${status === s ? "active" : ""}`} onClick={() => setStatusAndReset(s)}>
              {QUOTE_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : quotes.length === 0 ? (
          <div class="empty-state">
            {hasFilters ? (
              <>
                <p>No quotes found</p>
                <p class="text-muted">Try adjusting your search or filters.</p>
              </>
            ) : (
              <>
                <p>No quotes yet</p>
                <p class="text-muted">Create a quote for a customer to get started.</p>
                <button class="btn btn-primary" onClick={() => setShowCreate(true)}>New Quote</button>
              </>
            )}
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Quote #</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th class="text-right">Total</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id} class="table-row clickable" onClick={() => navigate(`/quotes/${q.id}`)}>
                    <td><span class="identifier">{q.identifier}</span></td>
                    <td class="text-bold">{q.customer_name || "—"}</td>
                    <td><QuoteStatusBadge status={q.status} /></td>
                    <td class="text-right">{q.total_cents !== null ? formatCents(q.total_cents) : "—"}</td>
                    <td class="text-muted">{q.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination pag={pag} setPage={setPage} />
      {showCreate && <CreateQuote onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/quotes/${id}`)} />}
    </div>
  );
}
