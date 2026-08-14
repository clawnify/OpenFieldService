import { useState } from "preact/hooks";
import { useApp } from "../context";
import { JobRow } from "./job-row";
import { CreateJob } from "./create-job";
import { Pagination } from "./pagination";
import { Plus, Search } from "lucide-preact";

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export function JobList() {
  const {
    jobs, jobsPag, setJobsPage, jobsSearch, setJobsSearch,
    jobsStatusFilter, setJobsStatusFilter, isAgent,
  } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div class="page">
      <div class="page-header">
        <h1>Jobs</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Job
        </button>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <Search size={14} class="search-icon" />
          <input
            type="text"
            placeholder="Search jobs..."
            value={jobsSearch}
            onInput={(e) => setJobsSearch((e.target as HTMLInputElement).value)}
          />
        </div>
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
