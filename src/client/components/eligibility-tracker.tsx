import { useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { STATUS_LABELS } from "./status-badge";
import { BadgeCheck, Info, Settings as SettingsIcon } from "lucide-preact";
import type { EligibilityCodeRow, EligibilityCodeStatus } from "../types";

const SECTIONS: { status: EligibilityCodeStatus; title: string; empty: string }[] = [
  { status: "expiring_soon", title: "Expiring Soon", empty: "No codes are expiring soon." },
  { status: "expired", title: "Expired", empty: "No expired codes." },
  { status: "active", title: "Active", empty: "No active codes." },
  { status: "submitted", title: "Submitted", empty: "No codes submitted to the government portal yet." },
];

function CodeTable({ rows, navigate, empty }: { rows: EligibilityCodeRow[]; navigate: (to: string) => void; empty: string }) {
  if (rows.length === 0) return <p class="text-muted">{empty}</p>;
  return (
    <div class="card" style={{ marginBottom: 16 }}>
      <table class="table">
        <thead>
          <tr>
            <th>Job</th><th>Customer</th><th>Code</th><th>Expiry Date</th><th>Days Remaining</th><th>Technician</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} class="table-row clickable" onClick={() => navigate(`/jobs/${r.id}`)}>
              <td><span class="identifier">{r.identifier}</span></td>
              <td>{r.customer_name || "—"}</td>
              <td><code>{r.eligibility_code}</code></td>
              <td>{r.eligibility_code_expiry}</td>
              <td>{r.days_remaining !== null ? r.days_remaining : "—"}</td>
              <td>{r.technician_name || "Unassigned"}</td>
              <td>{STATUS_LABELS[r.status] || r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EligibilityTracker() {
  const { navigate } = useApp();
  const { user } = useAuth();
  const canConfigureSettings = user?.role === "admin";
  const [rows, setRows] = useState<EligibilityCodeRow[]>([]);
  const [warningDaysConfigured, setWarningDaysConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api<{ rows: EligibilityCodeRow[]; warning_days_configured: boolean }>("GET", "/api/jobs/eligibility-codes");
        setRows(res.rows);
        setWarningDaysConfigured(res.warning_days_configured);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div class="page">
      <div class="page-header">
        <h1><BadgeCheck size={20} style={{ verticalAlign: "text-bottom" }} /> CleanBC Eligibility Code Tracker</h1>
      </div>

      {!warningDaysConfigured && (
        <div class="inline-notice" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <strong>Eligibility Code Expiration</strong>
              <p style={{ margin: "4px 0 0" }}>
                "Expiring Soon" alerts are not configured yet. Set an advance warning
                period to receive alerts before CleanBC eligibility codes expire.
                Until then, codes are only classified as Active, Expired, or Submitted.
              </p>
            </div>
            {canConfigureSettings && (
              <button class="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => navigate("/settings")}>
                <SettingsIcon size={14} /> Configure Settings
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div class="empty-state"><p>Loading...</p></div>
      ) : rows.length === 0 ? (
        <div class="card">
          <div class="empty-state">
            <BadgeCheck size={28} class="text-muted" />
            <p>No CleanBC jobs have an eligibility code yet</p>
            <p class="text-muted" style={{ fontSize: 13, maxWidth: 380, textAlign: "center" }}>
              Codes appear here automatically once a CleanBC job passes eligibility
              approval. Approve a job's eligibility from its job detail page to see
              it tracked here.
            </p>
          </div>
        </div>
      ) : (
        SECTIONS.map(({ status, title, empty }) => (
          <div key={status}>
            <h2 class="section-title">{title} ({rows.filter((r) => r.code_status === status).length})</h2>
            <CodeTable rows={rows.filter((r) => r.code_status === status)} navigate={navigate} empty={empty} />
          </div>
        ))
      )}
    </div>
  );
}
