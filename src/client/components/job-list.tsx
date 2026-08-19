import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { JobRow } from "./job-row";
import { CreateJob } from "./create-job";
import { Pagination } from "./pagination";
import { STATUS_LABELS } from "./status-badge";
import { Plus, Search, X } from "lucide-preact";

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

export function JobList() {
  const {
    jobs, jobsPag, setJobsPage, jobsSearch, setJobsSearch,
    jobsStatusFilter, setJobsStatusFilter, isAgent,
  } = useApp();
  const { user } = useAuth();
  // Phase 7.2 security fix: POST /api/jobs now 403s a technician actor
  // server-side (mem:risks/job-creation-rbac) — hiding the button is a UX
  // improvement only, the server enforcement is what actually matters.
  const canCreateJob = user?.role !== "technician";
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Jobs</h1>
        {canCreateJob && (
          <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> New Job
          </button>
        )}
      </div>

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text"
          class="jobs-search-input"
          placeholder="Search jobs by customer, job number, address, or phone..."
          aria-label="Search jobs by customer, job number, address, or phone"
          value={jobsSearch}
          onInput={(e) => setJobsSearch((e.target as HTMLInputElement).value)}
        />
        {jobsSearch && (
          <button
            type="button"
            class="jobs-search-clear"
            aria-label="Clear search"
            onClick={() => setJobsSearch("")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div class="toolbar">
        <div class="filter-group">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              class={`filter-btn ${jobsStatusFilter === s.value ? "active" : ""}`}
              onClick={() => setJobsStatusFilter(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div class="card">
        {jobs.length === 0 ? (
          <div class="empty-state">
            <p>No jobs found</p>
            <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
              Create your first job
            </button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Date</th>
                <th>Time</th>
                <th>Customer</th>
                <th>Service</th>
                <th>Technician</th>
                <th>Status</th>
                <th>Price</th>
                {isAgent && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination pag={jobsPag} setPage={setJobsPage} />
      {showCreate && <CreateJob onClose={() => setShowCreate(false)} />}
    </div>
  );
}
