import { useMemo } from "preact/hooks";
import { useApp } from "../context";
import { StatusBadge, PriorityBadge } from "./status-badge";
import { buildNavigationUrl } from "../navigation";
import { Navigation2, ChevronRight, CalendarX } from "lucide-preact";
import type { Job } from "../types";

/** Technician mobile home ("My Jobs Today") — Phase 6. Deliberately reuses
 *  the existing `scheduleJobs` data already fetched by `useAppState`
 *  (`GET /api/schedule`, current Mon–Sun range) rather than a new API: that
 *  route is already server-side scoped to the caller's own jobs only (see
 *  `mem:risks/technician-job-read-scoping`), so this component never has to
 *  filter by technician identity itself — there is nothing else in the list
 *  to filter out. Full day/week scheduling UX is Phase 7's job; this is only
 *  the "enough for My Jobs Today" slice Phase 6 needs. */
export function TechnicianHome() {
  const { scheduleJobs } = useApp();
  const todayStr = new Date().toISOString().split("T")[0];

  const { inProgress, today, upcoming, completed } = useMemo(() => {
    const byTime = (a: Job, b: Job) =>
      `${a.scheduled_date} ${a.scheduled_time}`.localeCompare(`${b.scheduled_date} ${b.scheduled_time}`);
    const active = scheduleJobs.filter((j) => j.status !== "cancelled");
    const inProgress = active.filter((j) => j.status === "in_progress").sort(byTime);
    const today = active
      .filter((j) => j.scheduled_date === todayStr && j.status !== "in_progress" && j.status !== "completed")
      .sort(byTime);
    const upcoming = active
      .filter((j) => j.scheduled_date > todayStr && j.status !== "in_progress" && j.status !== "completed")
      .sort(byTime);
    const completed = active.filter((j) => j.status === "completed").sort((a, b) => byTime(b, a));
    return { inProgress, today, upcoming, completed };
  }, [scheduleJobs, todayStr]);

  const noJobsToday = inProgress.length === 0 && today.length === 0;

  return (
    <div class="page">
      <div class="page-header">
        <h1>My Jobs Today</h1>
      </div>

      {inProgress.length > 0 && <TechJobSection title="In Progress" jobs={inProgress} emphasize />}

      {noJobsToday ? (
        <div class="tech-empty-state">
          <CalendarX size={32} aria-hidden="true" />
          <p>No jobs scheduled today</p>
          {upcoming.length > 0 && (
            <p class="text-muted">
              You have {upcoming.length} upcoming job{upcoming.length === 1 ? "" : "s"} this week.
            </p>
          )}
        </div>
      ) : (
        <TechJobSection title="Today's Jobs" jobs={today} />
      )}

      {upcoming.length > 0 && <TechJobSection title="Upcoming This Week" jobs={upcoming} />}
      {completed.length > 0 && <TechJobSection title="Completed" jobs={completed} muted />}
    </div>
  );
}

function TechJobSection({ title, jobs, emphasize, muted }: { title: string; jobs: Job[]; emphasize?: boolean; muted?: boolean }) {
  if (jobs.length === 0) return null;
  return (
    <div class={`section tech-job-section ${emphasize ? "emphasize" : ""} ${muted ? "muted" : ""}`}>
      <h2 class="section-title">
        {title} <span class="tech-job-count">{jobs.length}</span>
      </h2>
      <div class="tech-job-cards">
        {jobs.map((job) => <TechJobCard key={job.id} job={job} />)}
      </div>
    </div>
  );
}

function TechJobCard({ job }: { job: Job }) {
  const { navigate } = useApp();
  const navUrl = buildNavigationUrl(job.address);

  return (
    <div
      class="tech-job-card"
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/jobs/${job.id}`)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && navigate(`/jobs/${job.id}`)}
    >
      <div class="tech-job-card-top">
        <span class="identifier">{job.identifier}</span>
        <StatusBadge status={job.status} />
      </div>
      <div class="tech-job-card-customer">{job.customer_name || "Unknown customer"}</div>
      {job.service_type_name && (
        <span class="service-pill" style={{ borderColor: job.service_type_color || "#ccc" }}>
          <span class="service-dot" style={{ background: job.service_type_color || "#ccc" }} />
          {job.service_type_name}
        </span>
      )}
      <div class="tech-job-card-meta">
        <span class="text-bold">{job.scheduled_time || "No time set"}</span>
        <span class="text-muted">{job.address || "No address on file"}</span>
      </div>
      <div class="tech-job-card-footer">
        <PriorityBadge priority={job.priority} />
        <div class="tech-job-card-actions">
          {navUrl && (
            <a
              class="btn btn-sm"
              href={navUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Navigate to ${job.address}`}
              onClick={(e) => e.stopPropagation()}
            >
              <Navigation2 size={14} /> Navigate
            </a>
          )}
          <button
            type="button"
            class="btn btn-sm btn-primary"
            aria-label={`View details for job ${job.identifier}`}
            onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}
          >
            Details <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
