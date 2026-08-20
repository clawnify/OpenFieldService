import { useEffect, useMemo, useState } from "preact/hooks";
import { useApp } from "../context";
import { StatusBadge, PriorityBadge } from "./status-badge";
import { buildNavigationUrl } from "../navigation";
import { TechnicianRoute } from "./technician-route";
import { Navigation2, ChevronRight, CalendarX } from "lucide-preact";
import type { Job } from "../types";

const TECH_HOME_MODES = ["jobs", "route"] as const;
type TechHomeMode = typeof TECH_HOME_MODES[number];
const TECH_HOME_MODE_LABELS: Record<TechHomeMode, string> = { jobs: "My Jobs", route: "My Route" };

/** Technician mobile home ("My Jobs Today") — Phase 6, extended in Phase
 *  10.3 with a "My Route" mode. Deliberately reuses the existing
 *  `scheduleJobs` data already fetched by `useAppState`
 *  (`GET /api/schedule`) rather than a new API: that route is already
 *  server-side scoped to the caller's own jobs only (see
 *  `mem:risks/technician-job-read-scoping`), so this component never has to
 *  filter by technician identity itself — there is nothing else in the list
 *  to filter out. Full day/week scheduling UX is Phase 7's job; this is only
 *  the "enough for My Jobs Today" slice Phase 6 needs, plus Phase 10.3's
 *  read-only route/map view. */
export function TechnicianHome() {
  const { scheduleJobs, setScheduleRange } = useApp();
  const [mode, setMode] = useState<TechHomeMode>("jobs");
  const todayStr = new Date().toISOString().split("T")[0];

  // "My Route" mode (technician-route.tsx) narrows the shared
  // scheduleJobs range to a single selected day; switching back to "My
  // Jobs" must restore the normal current-week range this section's own
  // "Today"/"Upcoming This Week" split expects — otherwise it would
  // silently show only whatever single day Route mode last selected.
  // Mirrors use-app.ts's own boot-time Mon–Sun computation exactly.
  useEffect(() => {
    if (mode !== "jobs") return;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    setScheduleRange(monday.toISOString().split("T")[0], sunday.toISOString().split("T")[0]);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <h1>{mode === "jobs" ? "My Jobs Today" : "My Route"}</h1>
        <div class="view-toggle" role="tablist" aria-label="Technician home view">
          {TECH_HOME_MODES.map((m) => (
            <button
              key={m} role="tab" aria-selected={mode === m}
              class={`view-toggle-btn ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
            >
              {TECH_HOME_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {mode === "route" ? (
        <TechnicianRoute />
      ) : (
        <>
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
        </>
      )}
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
