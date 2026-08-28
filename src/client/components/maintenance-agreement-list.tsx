import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Plus, Search, X } from "lucide-preact";
import { CustomerSearchSelect } from "./customer-search-select";
import type { MaintenanceAgreement, MaintenancePlan, LegalTermsDocument } from "../types";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", sent: "Sent", viewed: "Viewed", signed: "Signed", active: "Active",
  cancelled: "Cancelled", expired: "Expired", superseded: "Superseded",
};
const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280", sent: "#2563eb", viewed: "#2563eb", signed: "#0891b2",
  active: "#16a34a", cancelled: "#dc2626", expired: "#b45309", superseded: "#6b7280",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

/**
 * Phase 19B — Maintenance Agreement list. Self-contained (own local fetch/
 * state), same precedent as contract-list.tsx/quote-list.tsx: irrelevant to
 * the technician role.
 */
export function MaintenanceAgreementList({ navigate }: { navigate: (to: string) => void }) {
  const [agreements, setAgreements] = useState<MaintenanceAgreement[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [newCustomerId, setNewCustomerId] = useState<number | null>(null);
  const [newCustomerLabel, setNewCustomerLabel] = useState("");
  const [newPlanId, setNewPlanId] = useState<number | null>(null);
  const [termsDocuments, setTermsDocuments] = useState<LegalTermsDocument[]>([]);
  const [newTermsDocumentId, setNewTermsDocumentId] = useState<number | "">("");
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const data = await api<{ agreements: MaintenanceAgreement[] }>("GET", `/api/maintenance/agreements?${params.toString()}`);
      setAgreements(data.agreements);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = async () => {
    const [plansRes, termsRes] = await Promise.all([
      api<{ plans: MaintenancePlan[] }>("GET", "/api/maintenance/plans"),
      api<{ documents: LegalTermsDocument[] }>("GET", "/api/legal-terms?type=MAINTENANCE"),
    ]);
    setPlans(plansRes.plans);
    // Only a document with a published version is bindable — createAgreement
    // silently no-ops the binding otherwise, so don't offer an unpublished
    // draft-only document here (Architecture review finding, Phase 19B).
    setTermsDocuments(termsRes.documents.filter((d) => d.current_published_version_id !== null));
    setNewCustomerId(null);
    setNewCustomerLabel("");
    setNewPlanId(plansRes.plans[0]?.id ?? null);
    setNewTermsDocumentId("");
    setShowCreate(true);
  };

  const createAgreement = async () => {
    if (!newCustomerId || !newPlanId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ agreement: { id: number } }>("POST", "/api/maintenance/agreements", {
        customer_id: newCustomerId, plan_id: newPlanId, legal_terms_document_id: newTermsDocumentId || undefined,
      });
      setShowCreate(false);
      navigate(`/maintenance-agreements/${res.agreement.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const filtered = search
    ? agreements.filter((a) => a.identifier.toLowerCase().includes(search.toLowerCase()) || (a.customer_name ?? "").toLowerCase().includes(search.toLowerCase()))
    : agreements;

  return (
    <div class="page">
      <div class="page-header">
        <h1>Maintenance Agreements</h1>
        <button class="btn btn-primary" onClick={openCreate}><Plus size={16} /> New Agreement</button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text" class="jobs-search-input" placeholder="Search agreements by number or customer..."
          aria-label="Search agreements by number or customer" value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        {search && (
          <button type="button" class="jobs-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>
            <X size={16} />
          </button>
        )}
      </div>

      <div class="toolbar">
        <div class="filter-group">
          <button class={`filter-btn ${status === "" ? "active" : ""}`} onClick={() => setStatus("")}>All</button>
          {Object.keys(STATUS_LABELS).map((s) => (
            <button key={s} class={`filter-btn ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>{STATUS_LABELS[s]}</button>
          ))}
        </div>
      </div>

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : filtered.length === 0 ? (
          <div class="empty-state"><p>No maintenance agreements found</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Agreement #</th><th>Customer</th><th>Plan</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} class="table-row clickable" onClick={() => navigate(`/maintenance-agreements/${a.id}`)}>
                    <td><span class="identifier">{a.identifier}</span></td>
                    <td class="text-bold">{a.customer_name || "—"}</td>
                    <td class="text-muted">{a.plan_name || "—"}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td class="text-muted">{a.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <div class="modal-overlay" onClick={() => setShowCreate(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>New Maintenance Agreement</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowCreate(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label id="ma-customer-label">Customer</label>
                <CustomerSearchSelect value={newCustomerId} valueLabel={newCustomerLabel} onChange={(id, label) => { setNewCustomerId(id); setNewCustomerLabel(label); }} />
              </div>
              <div class="form-group">
                <label for="ma-plan">Plan</label>
                <select id="ma-plan" value={newPlanId ?? ""} onChange={(e) => setNewPlanId(Number((e.target as HTMLSelectElement).value))}>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.tier})</option>)}
                </select>
              </div>
              {termsDocuments.length > 0 && (
                <div class="form-group">
                  <label for="ma-terms">Legal Terms (optional)</label>
                  <select id="ma-terms" value={newTermsDocumentId} onChange={(e) => setNewTermsDocumentId(Number((e.target as HTMLSelectElement).value) || "")}>
                    <option value="">None</option>
                    {termsDocuments.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowCreate(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={creating || !newCustomerId || !newPlanId} onClick={createAgreement}>
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { StatusBadge as AgreementStatusBadge };
