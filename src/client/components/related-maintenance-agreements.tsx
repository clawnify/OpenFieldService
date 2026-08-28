import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { AgreementStatusBadge } from "./maintenance-agreement-list";
import type { MaintenanceAgreement, MaintenanceMembership } from "../types";

/**
 * Phase 19B — small embedded "Maintenance" card on a Customer's own detail
 * page: their agreements plus active membership summary (visits used/
 * remaining, per Section 29's "Customer detail should expose active
 * Membership, plan, Agreement status..."). Mirrors related-contracts.tsx's
 * shape exactly (own local fetch, read-only, no create action here — an
 * Agreement is created from the Maintenance Agreements list page).
 */
export function RelatedMaintenanceAgreements({ customerId, navigate }: { customerId: number; navigate: (to: string) => void }) {
  const [agreements, setAgreements] = useState<MaintenanceAgreement[]>([]);
  const [memberships, setMemberships] = useState<MaintenanceMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agreementsRes, membershipsRes] = await Promise.all([
        api<{ agreements: MaintenanceAgreement[] }>("GET", `/api/maintenance/agreements?customer_id=${customerId}`),
        api<{ memberships: MaintenanceMembership[] }>("GET", `/api/maintenance/memberships?customer_id=${customerId}`),
      ]);
      setAgreements(agreementsRes.agreements);
      setMemberships(membershipsRes.memberships);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const activeMembership = memberships.find((m) => m.status === "active");

  return (
    <div class="detail-section">
      <h3>Maintenance ({agreements.length})</h3>
      {error && <div class="inline-error" style={{ marginBottom: 10 }}>{error}</div>}
      {loading ? (
        <p class="text-muted">Loading...</p>
      ) : (
        <>
          {activeMembership && (
            <div class="card" style={{ marginBottom: 10 }}>
              <p class="text-bold">Active Membership</p>
              <p>Visits included: {activeMembership.visits_included == null ? "Unlimited" : activeMembership.visits_included}</p>
            </div>
          )}
          {agreements.length === 0 ? (
            <p class="text-muted">No maintenance agreements yet</p>
          ) : (
            <div class="card">
              <table class="table">
                <thead><tr><th>Agreement #</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id} class="table-row clickable" onClick={() => navigate(`/maintenance-agreements/${a.id}`)}>
                      <td><span class="identifier">{a.identifier}</span></td>
                      <td><AgreementStatusBadge status={a.status} /></td>
                      <td class="text-muted">{a.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
