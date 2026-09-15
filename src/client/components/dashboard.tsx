import { StatusBadge } from "./status-badge";
import { useApp } from "../context";
import { Briefcase, Users, CalendarCheck, DollarSign, Clock, CheckCircle, FileText, AlertCircle } from "lucide-preact";

export function Dashboard() {
  const { stats, navigate, jobs } = useApp();

  const todayStr = new Date().toISOString().split("T")[0];
  const todayJobs = jobs.filter((j) => j.scheduled_date === todayStr && j.status !== "cancelled");

  return (
    <div class="page">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>

      <div class="stats-grid">
        <button class="stat-card" onClick={() => navigate("/jobs")}>
          <div class="stat-icon">
            <Briefcase size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.jobs}</div>
            <div class="stat-label">Total Jobs</div>
          </div>
        </button>
        <button class="stat-card" onClick={() => navigate("/customers")}>
          <div class="stat-icon">
            <Users size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.customers}</div>
            <div class="stat-label">Customers</div>
          </div>
        </button>
        <button class="stat-card" onClick={() => navigate("/schedule")}>
          <div class="stat-icon">
            <Clock size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.today_jobs}</div>
            <div class="stat-label">Today's Jobs</div>
          </div>
        </button>
        <div class="stat-card">
          <div class="stat-icon">
            <CalendarCheck size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.upcoming_jobs}</div>
            <div class="stat-label">Upcoming</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <CheckCircle size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.completed_jobs}</div>
            <div class="stat-label">Completed</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">
            <DollarSign size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">${stats.revenue.toLocaleString()}</div>
            <div class="stat-label">Revenue</div>
          </div>
        </div>
        <button class="stat-card" onClick={() => navigate("/invoices")}>
          <div class="stat-icon">
            <FileText size={20} />
          </div>
          <div class="stat-info">
            <div class="stat-value">{stats.invoices_outstanding}</div>
            <div class="stat-label">Outstanding Invoices</div>
          </div>
        </button>
        {stats.invoices_overdue > 0 && (
          <button class="stat-card" onClick={() => navigate("/invoices")}>
            <div class="stat-icon">
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
          <div class="table-scroll">
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
                        <span class="tech-pill" style={{ borderColor: job.technician_color || "var(--text-muted)" }}>
                          <span class="tech-dot" style={{ background: job.technician_color || "var(--text-muted)" }} />
                          {job.technician_name}
                        </span>
                      ) : (
                        <span class="text-muted">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
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
