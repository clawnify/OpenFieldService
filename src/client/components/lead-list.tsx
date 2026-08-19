import { useCallback, useEffect, useState } from "preact/hooks";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { buildLeadListQuery } from "../lead-helpers";
import { useAssignableUsers } from "../hooks/use-assignable-users";
import { LeadStatusBadge } from "./lead-status-badge";
import { LEAD_STATUS_LABELS, LEAD_STATUSES } from "../lead-status";
import { formatCents } from "../money";
import { CreateLead } from "./create-lead";
import { Pagination } from "./pagination";
import { Plus, Search, X } from "lucide-preact";
import type { Lead, PaginatedState } from "../types";

/**
 * Phase 8.4 — Lead list. Self-contained (own local fetch/state), NOT wired
 * into the central AppContext/use-app.ts — same precedent as
 * eligibility-tracker.tsx (Phase 3), a page that's entirely irrelevant to
 * one role (here, technician) and doesn't need to be part of the app-wide
 * initial-load Promise.all. Search/status/assigned-user filtering all go
 * through the existing server-side GET /api/leads (Phase 8.2) — never a
 * client-side filter over an unpaginated full fetch.
 */
export function LeadList({ navigate }: { navigate: (to: string) => void }) {
  const { user } = useAuth();
  const { users: assignableUsers, available: assigneesAvailable } = useAssignableUsers(user?.role);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [pag, setPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const query = buildLeadListQuery({ page: pag.page, limit: pag.limit, search, status, assignedUserId });
      const data = await api<{ leads: Lead[]; total: number }>("GET", `/api/leads?${query}`);
      setLeads(data.leads);
      setPag((p) => ({ ...p, total: data.total }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pag.page, pag.limit, search, status, assignedUserId]);

  useEffect(() => { fetchLeads(); }, [pag.page, search, status, assignedUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 whenever a filter changes so a narrower result set never
  // strands the view on a now-nonexistent page.
  const setSearchAndReset = (v: string) => { setSearch(v); setPag((p) => ({ ...p, page: 1 })); };
  const setStatusAndReset = (v: string) => { setStatus(v); setPag((p) => ({ ...p, page: 1 })); };
  const setAssignedAndReset = (v: string) => { setAssignedUserId(v); setPag((p) => ({ ...p, page: 1 })); };

  const setPage = (page: number) => setPag((p) => ({ ...p, page }));

  const hasFilters = !!(search || status || assignedUserId);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Leads</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Lead
        </button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text"
          class="jobs-search-input"
          placeholder="Search leads by name, phone, email, or lead number..."
          aria-label="Search leads by name, phone, email, or lead number"
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
          {LEAD_STATUSES.map((s) => (
            <button key={s} class={`filter-btn ${status === s ? "active" : ""}`} onClick={() => setStatusAndReset(s)}>
              {LEAD_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {assigneesAvailable && assignableUsers.length > 0 && (
          <select
            value={assignedUserId}
            onChange={(e) => setAssignedAndReset((e.target as HTMLSelectElement).value)}
            aria-label="Filter by assigned user"
          >
            <option value="">All assignees</option>
            {assignableUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
      </div>

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : leads.length === 0 ? (
          <div class="empty-state">
            {hasFilters ? (
              <>
                <p>No leads found</p>
                <p class="text-muted">Try adjusting your search or filters.</p>
              </>
            ) : status === "lost" ? (
              <>
                <p>No lost leads</p>
                <p class="text-muted">Leads marked as lost will appear here.</p>
              </>
            ) : (
              <>
                <p>No leads yet</p>
                <p class="text-muted">New inquiries will appear here once they are added.</p>
                <button class="btn btn-primary" onClick={() => setShowCreate(true)}>New Lead</button>
              </>
            )}
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Lead #</th>
                  <th>Name</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Assigned To</th>
                  <th>Referral Source</th>
                  <th>Estimated Value</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} class="table-row clickable" onClick={() => navigate(`/leads/${l.id}`)}>
                    <td><span class="identifier">{l.identifier}</span></td>
                    <td class="text-bold">{l.name}</td>
                    <td class="text-muted">{l.phone || l.email || "—"}</td>
                    <td><LeadStatusBadge status={l.status} /></td>
                    <td>{l.assigned_user_name || "Unassigned"}</td>
                    <td class="text-muted">{l.referral_source || "—"}</td>
                    <td>{l.estimated_value_cents !== null ? formatCents(l.estimated_value_cents) : "—"}</td>
                    <td class="text-muted">{l.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination pag={pag} setPage={setPage} />
      {showCreate && <CreateLead onClose={() => setShowCreate(false)} onCreated={fetchLeads} />}
    </div>
  );
}
