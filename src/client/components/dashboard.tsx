import { useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { Briefcase, Users, CalendarCheck, DollarSign, Clock, CheckCircle, FileText, AlertCircle, BadgeAlert } from "lucide-preact";
import type { EligibilityCodeRow } from "../types";

export function Dashboard() {
  const { stats, navigate, jobs } = useApp();
  const { user } = useAuth();
  // Technicians have no financial access (see mem:project/fsm-upgrade-plan
  // Phase 5) — these cards navigate straight to /invoices, which would just
  // 403 for them, so hide rather than show a dead end.
  const canViewFinancials = user?.role === "admin" || user?.role === "dispatcher";

  const todayStr = new Date().toISOString().split("T")[0];
  const todayJobs = jobs.filter((j) => j.scheduled_date === todayStr && j.status !== "cancelled");

  const [expiringSoon, setExpiringSoon] = useState<EligibilityCodeRow[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ rows: EligibilityCodeRow[] }>("GET", "/api/jobs/eligibility-codes");
        setExpiringSoon(res.rows.filter((r) => r.code_status === "expiring_soon"));
      } catch {
        setExpiringSoon([]);
      }
    })();
  }, []);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>

      <div class="stats-grid">
        <button class="stat-card" onClick={() => navigate("/jobs")}>
          <div class="stat-icon" style={{ background: "#3b82f614", color: "#3b82f6" }}>
            <Briefcase size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.jobs}</div>
            <div class="stat-label">Total Jobs</div>
          </div>
        </button>
        <button class="stat-card" onClick={() => navigate("/customers")}>
          <div class="stat-icon" style={{ background: "#8b5cf614", color: "#8b5cf6" }}>
            <Users size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.customers}</div>
            <div class="stat-label">Customers</div>
          </div>
        </button>
        <button class="stat-card" onClick={() => navigate("/schedule")}>
          <div class="stat-icon" style={{ background: "#f59e0b14", color: "#f59e0b" }}>
            <Clock size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.today_jobs}</div>
            <div class="stat-label">Today's Jobs</div>
          </div>
        </button>
        <div class="stat-card">
          <div class="stat-icon" style={{ background: "#16a34a14", color: "#16a34a" }}>
            <CalendarCheck size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.upcoming_jobs}</div>
            <div class="stat-label">Upcoming</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style={{ background: "#0891b214", color: "#0891b2" }}>
            <CheckCircle size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.completed_jobs}</div>
            <div class="stat-label">Completed</div>
          </div>
        </div>
        {canViewFinancials && (
          <div class="stat-card">
            <div class="stat-icon" style={{ background: "#16a34a14", color: "#16a34a" }}>
              <DollarSign size={20} />
            </div>
            <div class="stat-info">
              <div class="stat-value">${stats.revenue.toLocaleString()}</div>
              <div class="stat-label">Revenue</div>
            </div>
          </div>
        )}
        {canViewFinancials && (
          <button class="stat-card" onClick={() => navigate("/invoices")}>
            <div class="stat-icon" style={{ background: "#f59e0b14", color: "#f59e0b" }}>
              <FileText size={20} />
            </div>
            <div class="stat-info">
              <div class="stat-value">{stats.invoices_outstanding}</div>
              <div class="stat-label">Outstanding Invoices</div>
            </div>
          </button>
        )}
        {canViewFinancials && stats.invoices_overdue > 0 && (
          <button class="stat-card" onClick={() => navigate("/invoices")}>
            <div class="stat-icon" style={{ background: "#dc262614", color: "#dc2626" }}>
              <AlertCircle size={20} />
            </div>
            <div class="stat-info">
              <div class="stat-value">{stats.invoices_overdue}</div>
              <div class="stat-label">Overdue</div>
            </div>
          </button>
        )}
      </div>

      {todayJobs.length > 0 && (
        <div class="section">
          <h2 class="section-title">Today's Schedule</h2>
          <div class="card">
            <table class="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Job</th>
                  <th>Customer</th>
                  <th>Technician</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {todayJobs.map((job) => (
                  <tr key={job.id} class="table-row clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td class="text-muted">{job.scheduled_time}</td>
                    <td><span class="identifier">{job.identifier}</span></td>
                    <td>{job.customer_name}</td>
                    <td>
                      {job.technician_name ? (
                        <span class="tech-pill" style={{ borderColor: job.technician_color || "#ccc" }}>
                          <span class="tech-dot" style={{ background: job.technician_color || "#ccc" }} />
                          {job.technician_name}
                        </span>
                      ) : (
                        <span class="text-muted">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <span class="status-badge-sm" style={{ color: job.status === "completed" ? "#16a34a" : "#3b82f6" }}>
                        {job.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {expiringSoon.length > 0 && (
        <div class="section">
          <h2 class="section-title"><BadgeAlert size={16} style={{ verticalAlign: "text-bottom" }} /> Expiring Soon Eligibility Codes</h2>
          <div class="card">
            <table class="table">
              <thead>
                <tr>
                  <th>Customer</th><th>Job</th><th>Code</th><th>Expiry</th><th>Days Remaining</th><th>Technician</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {expiringSoon.map((r) => (
                  <tr key={r.id} class="table-row clickable" onClick={() => navigate(`/jobs/${r.id}`)}>
                    <td>{r.customer_name || "—"}</td>
                    <td><span class="identifier">{r.identifier}</span></td>
                    <td><code>{r.eligibility_code}</code></td>
                    <td>{r.eligibility_code_expiry}</td>
                    <td class="text-bold">{r.days_remaining}</td>
                    <td>{r.technician_name || "Unassigned"}</td>
                    <td>{r.status.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
