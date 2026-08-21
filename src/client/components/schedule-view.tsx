import { useState, useEffect, useMemo } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { CreateJob } from "./create-job";
import { DayDetail } from "./day-detail";
import { ScheduleEditModal } from "./schedule-edit-modal";
import { ScheduleMap } from "./schedule-map";
import { STATUS_COLORS, STATUS_LABELS, STATUS_ABBR } from "./status-badge";
import { ChevronLeft, ChevronRight, Flag, CalendarClock, MapPin } from "lucide-preact";
import type { Job } from "../types";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_VISIBLE_JOBS = 3;
// Phase 10.2 — "map" is admin/dispatcher only (see canSchedule gate below,
// same UX-only-hiding pattern as drag-and-drop; the underlying data route
// GET /api/schedule already force-scopes a technician to their own job(s)
// regardless of this tab's visibility — server remains authoritative, per
// mem:phase10/maps-routing-architecture-audit Section 18).
const VIEW_MODES = ["month", "week", "day", "list", "map"] as const;
type ViewMode = typeof VIEW_MODES[number];
const VIEW_LABELS: Record<ViewMode, string> = { month: "Month", week: "Week", day: "Day", list: "List", map: "Map" };

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return toISODate(d);
}

/** Monday of the week containing `dateStr`. */
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return toISODate(d);
}

/** Every date cell for a Monday-start month grid, including the leading/trailing
 *  days from the adjacent months needed to fill out full weeks. */
function getMonthGrid(anchor: Date): string[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();

  const firstOfMonth = new Date(year, month, 1);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);

  const lastOfMonth = new Date(year, month + 1, 0);
  const sundayOffset = (7 - lastOfMonth.getDay()) % 7;
  const gridEnd = new Date(year, month, lastOfMonth.getDate() + sundayOffset);

  const days: string[] = [];
  const d = new Date(gridStart);
  while (d <= gridEnd) {
    days.push(toISODate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

const PRIORITY_FLAG_COLOR: Record<string, string> = { high: "#f59e0b", urgent: "#dc2626" };

export function ScheduleView() {
  const { scheduleJobs, setScheduleRange, refreshSchedule, navigate, technicianLookup } = useApp();
  const { user } = useAuth();
  // Drag-and-drop reschedule and inline "Reschedule" actions are dispatcher/
  // admin only — a technician is read-only in the scheduler (server-side
  // enforcement is what actually matters: PUT /api/jobs/{id} already 403s a
  // technician on any scheduling field; hiding these affordances here is UX
  // only, not a second authorization layer). See mem:phase7/advanced-scheduler.
  const canSchedule = user?.role === "admin" || user?.role === "dispatcher";
  // Phase 10.2 — the Dispatcher Map tab is hidden entirely for a
  // technician (UX only; GET /api/schedule already force-scopes their data
  // server-side regardless — see mem:phase10/maps-routing-architecture-audit
  // Section 18, "do not rely only on UI hiding").
  const visibleViewModes = canSchedule ? VIEW_MODES : VIEW_MODES.filter((v) => v !== "map");

  const [viewMode, setViewMode] = useState<ViewMode>("month");

  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState(() => mondayOf(toISODate(new Date())));
  const [currentDay, setCurrentDay] = useState(() => toISODate(new Date()));
  const [listStart, setListStart] = useState(() => toISODate(new Date()));
  const [listEnd, setListEnd] = useState(() => addDays(toISODate(new Date()), 13));
  const [listSearch, setListSearch] = useState("");
  const [listTechnician, setListTechnician] = useState("");
  const [listStatus, setListStatus] = useState("");

  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [createDate, setCreateDate] = useState<string | null>(null);
  const [rescheduleJob, setRescheduleJob] = useState<Job | null>(null);
  // Set only by a drag-and-drop drop (never by the plain "Reschedule"
  // button, which should show the job's real current date) — carries the
  // staged target date into ScheduleEditModal so the drop is actually
  // reflected in the pre-filled form. A prior version of this code dropped
  // this value on the floor entirely (found during the Phase 7.1 UI audit):
  // the modal opened but silently showed the job's ORIGINAL date, so a
  // drag-and-drop reschedule never actually proposed the dropped-onto date.
  const [rescheduleProposedDate, setRescheduleProposedDate] = useState<string | undefined>(undefined);
  const [dragJobId, setDragJobId] = useState<number | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  const monthDays = useMemo(() => getMonthGrid(currentMonth), [currentMonth]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const todayStr = toISODate(new Date());

  // Every view mode drives the same GET /api/schedule?start=&end= range
  // fetch already used before Phase 7 — no new endpoint, just a wider or
  // narrower range depending on which view is active. Phase 10.2's "map"
  // mode falls into the same final `else` as "list" — it deliberately
  // shares List's date range AND filters (technician/status/search)
  // rather than inventing a second, duplicate set (Section 15's explicit
  // "do not duplicate filter logic inside Map component").
  useEffect(() => {
    if (viewMode === "month") setScheduleRange(monthDays[0], monthDays[monthDays.length - 1]);
    else if (viewMode === "week") setScheduleRange(weekDays[0], weekDays[weekDays.length - 1]);
    else if (viewMode === "day") setScheduleRange(currentDay, currentDay);
    else setScheduleRange(listStart, listEnd);
  }, [viewMode, monthDays, weekDays, currentDay, listStart, listEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Defense in depth: the "Map" tab button is never rendered for a
  // technician, but if viewMode were ever "map" while canSchedule is
  // false (e.g. a role change mid-session), fall back to Month rather
  // than rendering a tab that isn't in visibleViewModes.
  useEffect(() => {
    if (viewMode === "map" && !canSchedule) setViewMode("month");
  }, [viewMode, canSchedule]);

  const jobsByDay = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of scheduleJobs) {
      const list = map.get(job.scheduled_date);
      if (list) list.push(job);
      else map.set(job.scheduled_date, [job]);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
    return map;
  }, [scheduleJobs]);

  const listJobs = useMemo(() => {
    return scheduleJobs
      .filter((j) => !listTechnician || String(j.technician_id) === listTechnician)
      .filter((j) => !listStatus || j.status === listStatus)
      .filter((j) => {
        if (!listSearch.trim()) return true;
        const q = listSearch.trim().toLowerCase();
        return j.identifier.toLowerCase().includes(q)
          || (j.customer_name || "").toLowerCase().includes(q)
          || (j.technician_name || "").toLowerCase().includes(q);
      })
      .sort((a, b) => `${a.scheduled_date} ${a.scheduled_time}`.localeCompare(`${b.scheduled_date} ${b.scheduled_time}`));
  }, [scheduleJobs, listTechnician, listStatus, listSearch]);

  // Phase 10.4 — the Dispatcher Map's "Show Travel Times" action only makes
  // sense for ONE technician's ONE day (GET /api/technician/route routes a
  // single technician/day, matching the existing Scheduler-permission
  // boundary — see mem:phase10/maps-routing-architecture-audit's Section
  // 13). Reuses the List filter's own technician/date state verbatim
  // rather than a second range-tracking mechanism — null (button hidden)
  // unless the dispatcher has narrowed List mode to exactly one technician
  // and a single-day range.
  const mapRouteContext = useMemo(() => {
    if (!listTechnician || listStart !== listEnd) return null;
    const technicianId = Number(listTechnician);
    if (!Number.isInteger(technicianId)) return null;
    return { technicianId, date: listStart };
  }, [listTechnician, listStart, listEnd]);

  const goToday = () => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setWeekStart(mondayOf(toISODate(now)));
    setCurrentDay(toISODate(now));
  };

  const detailJobs = detailDate ? jobsByDay.get(detailDate) || [] : [];

  // Single entry point for opening ScheduleEditModal, used by both the
  // plain tap-to-reschedule button (no staged date — the modal shows the
  // job's real current values) and the drag-and-drop drop handler (stages
  // the drop-target date). Always resets any stale staged date left over
  // from a previous drag before opening for an unrelated job.
  const openReschedule = (job: Job, proposedDate?: string) => {
    setRescheduleProposedDate(proposedDate);
    setRescheduleJob(job);
  };
  const closeReschedule = () => {
    setRescheduleJob(null);
    setRescheduleProposedDate(undefined);
  };

  // Drag-and-drop is native HTML5 DnD — deliberately, since it simply does
  // not fire on touchscreens, so mobile users transparently fall back to the
  // tap-based "Reschedule" button every job card also exposes. Dropping
  // NEVER mutates directly: it only stages a proposed date by opening
  // ScheduleEditModal pre-filled with the drop target, which still requires
  // its own Review → Confirm step before any API call.
  const handleDragStart = (job: Job) => (e: DragEvent) => {
    if (!canSchedule) return;
    setDragJobId(job.id);
    e.dataTransfer?.setData("text/plain", String(job.id));
  };
  const handleDragOver = (date: string) => (e: DragEvent) => {
    if (!canSchedule || dragJobId === null) return;
    e.preventDefault();
    setDragOverDate(date);
  };
  const handleDrop = (date: string) => (e: DragEvent) => {
    e.preventDefault();
    setDragOverDate(null);
    if (!canSchedule || dragJobId === null) return;
    const job = scheduleJobs.find((j) => j.id === dragJobId);
    setDragJobId(null);
    if (!job || job.scheduled_date === date) return;
    openReschedule(job, date);
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Schedule</h1>
        <div class="page-header-right">
          <div class="view-toggle" role="tablist" aria-label="Scheduler view">
            {visibleViewModes.map((v) => (
              <button
                key={v} role="tab" aria-selected={viewMode === v}
                class={`view-toggle-btn ${viewMode === v ? "active" : ""}`}
                onClick={() => setViewMode(v)}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
          {viewMode !== "list" && viewMode !== "map" && <button class="btn" onClick={goToday}>Today</button>}
          {viewMode === "month" && (
            <>
              <button class="btn btn-icon" onClick={() => setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month">
                <ChevronLeft size={16} />
              </button>
              <span class="schedule-month-label">{currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
              <button class="btn btn-icon" onClick={() => setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {viewMode === "week" && (
            <>
              <button class="btn btn-icon" onClick={() => setWeekStart((s) => addDays(s, -7))} aria-label="Previous week">
                <ChevronLeft size={16} />
              </button>
              <span class="schedule-month-label">
                {new Date(weekStart + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                {" – "}
                {new Date(addDays(weekStart, 6) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
              <button class="btn btn-icon" onClick={() => setWeekStart((s) => addDays(s, 7))} aria-label="Next week">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {viewMode === "day" && (
            <>
              <button class="btn btn-icon" onClick={() => setCurrentDay((d) => addDays(d, -1))} aria-label="Previous day">
                <ChevronLeft size={16} />
              </button>
              <span class="schedule-month-label">
                {new Date(currentDay + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
              </span>
              <button class="btn btn-icon" onClick={() => setCurrentDay((d) => addDays(d, 1))} aria-label="Next day">
                <ChevronRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {(viewMode === "list" || viewMode === "map") && (
        <div class="schedule-list-filters">
          <div class="form-group">
            <label htmlFor="list-start">From</label>
            <input id="list-start" type="date" value={listStart} onChange={(e) => setListStart((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group">
            <label htmlFor="list-end">To</label>
            <input id="list-end" type="date" value={listEnd} onChange={(e) => setListEnd((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group">
            <label htmlFor="list-search">Search</label>
            <input id="list-search" type="text" placeholder="Job #, customer, technician..." value={listSearch} onInput={(e) => setListSearch((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group">
            <label htmlFor="list-technician">Technician</label>
            <select id="list-technician" value={listTechnician} onChange={(e) => setListTechnician((e.target as HTMLSelectElement).value)}>
              <option value="">All</option>
              {technicianLookup.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div class="form-group">
            <label htmlFor="list-status">Status</label>
            <select id="list-status" value={listStatus} onChange={(e) => setListStatus((e.target as HTMLSelectElement).value)}>
              <option value="">All</option>
              {Object.keys(STATUS_LABELS).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
      )}

      {viewMode === "month" && (
        <>
          <div class="schedule-weekdays">
            {DAY_NAMES.map((name) => <div key={name} class="schedule-weekday">{name}</div>)}
          </div>
          <div class="schedule-grid">
            {monthDays.map((day) => {
              const dayJobs = jobsByDay.get(day) || [];
              const dateObj = new Date(day + "T00:00:00");
              const isToday = day === todayStr;
              const isOtherMonth = dateObj.getMonth() !== currentMonth.getMonth();
              const visibleJobs = dayJobs.slice(0, MAX_VISIBLE_JOBS);
              const hiddenCount = dayJobs.length - visibleJobs.length;

              return (
                <div
                  key={day}
                  class={`schedule-day ${isToday ? "today" : ""} ${isOtherMonth ? "other-month" : ""} ${dragOverDate === day ? "drag-over" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, ${dayJobs.length} job${dayJobs.length === 1 ? "" : "s"}`}
                  onClick={() => setDetailDate(day)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setDetailDate(day))}
                  onDragOver={handleDragOver(day)}
                  onDragLeave={() => setDragOverDate((d) => (d === day ? null : d))}
                  onDrop={handleDrop(day)}
                >
                  <div class="schedule-day-header">
                    <span class={`schedule-day-num ${isToday ? "today" : ""}`}>{dateObj.getDate()}</span>
                  </div>
                  <div class="schedule-day-jobs">
                    {visibleJobs.map((job) => (
                      <button
                        key={job.id}
                        class="schedule-job"
                        draggable={canSchedule}
                        onDragStart={handleDragStart(job)}
                        style={{ borderLeftColor: job.technician_color || job.service_type_color || "#16a34a" }}
                        onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}
                      >
                        <div class="schedule-job-time">
                          <span
                            class="schedule-job-status-badge"
                            style={{ background: `${STATUS_COLORS[job.status] || "#6b7280"}22`, color: STATUS_COLORS[job.status] || "#6b7280" }}
                            aria-label={STATUS_LABELS[job.status] || job.status}
                          >
                            {STATUS_ABBR[job.status] || "?"}
                          </span>
                          {job.scheduled_time}
                          {(job.priority === "high" || job.priority === "urgent") && (
                            <Flag size={11} aria-label={`${job.priority} priority`} color={PRIORITY_FLAG_COLOR[job.priority]} />
                          )}
                        </div>
                        <div class="schedule-job-title">
                          <span class="identifier">{job.identifier}</span> {job.service_type_name || ""}
                        </div>
                        <div class="schedule-job-customer">{job.customer_name}</div>
                        {job.technician_name && <div class="schedule-job-tech">{job.technician_name}</div>}
                      </button>
                    ))}
                    {hiddenCount > 0 && (
                      <button class="schedule-more" onClick={(e) => { e.stopPropagation(); setDetailDate(day); }}>
                        +{hiddenCount} more
                      </button>
                    )}
                    {dayJobs.length === 0 && <div class="schedule-empty">No jobs</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {viewMode === "week" && (
        <div class="schedule-week-grid">
          {weekDays.map((day) => {
            const dayJobs = jobsByDay.get(day) || [];
            const isToday = day === todayStr;
            const dateObj = new Date(day + "T00:00:00");
            return (
              <div
                key={day}
                class={`schedule-week-col ${isToday ? "today" : ""} ${dragOverDate === day ? "drag-over" : ""}`}
                onDragOver={handleDragOver(day)}
                onDragLeave={() => setDragOverDate((d) => (d === day ? null : d))}
                onDrop={handleDrop(day)}
              >
                <div class="schedule-week-col-header">
                  <span>{dateObj.toLocaleDateString("en-US", { weekday: "short" })}</span>
                  <span class={`schedule-day-num ${isToday ? "today" : ""}`}>{dateObj.getDate()}</span>
                </div>
                <div class="schedule-week-col-jobs">
                  {dayJobs.length === 0 && <div class="schedule-empty">No jobs</div>}
                  {dayJobs.map((job) => (
                    <ScheduleJobRow key={job.id} job={job} canSchedule={canSchedule} onDragStart={handleDragStart(job)} onNavigate={navigate} onReschedule={openReschedule} compact />
                  ))}
                </div>
                {canSchedule && (
                  <button class="btn btn-sm schedule-week-add" onClick={() => setCreateDate(day)}>+ Job</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {viewMode === "day" && (
        <div class="schedule-day-list">
          {(jobsByDay.get(currentDay) || []).length === 0 ? (
            <div class="tech-empty-state">
              <p>No jobs scheduled for this day.</p>
            </div>
          ) : (
            (jobsByDay.get(currentDay) || []).map((job) => (
              <ScheduleJobRow key={job.id} job={job} canSchedule={canSchedule} onNavigate={navigate} onReschedule={openReschedule} />
            ))
          )}
          {canSchedule && (
            <button class="btn btn-primary" onClick={() => setCreateDate(currentDay)}>+ New Job</button>
          )}
        </div>
      )}

      {viewMode === "list" && (
        <div class="card">
          <div class="schedule-list-table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Job #</th><th>Date</th><th>Time</th><th>Customer</th><th>Technician</th><th>Status</th><th>Priority</th>
                {canSchedule && <th></th>}
              </tr>
            </thead>
            <tbody>
              {listJobs.length === 0 ? (
                <tr><td colSpan={canSchedule ? 8 : 7} class="text-muted" style={{ textAlign: "center", padding: 20 }}>No jobs in this range</td></tr>
              ) : listJobs.map((job) => (
                <tr key={job.id} class="table-row clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                  <td><span class="identifier">{job.identifier}</span></td>
                  <td>{job.scheduled_date}</td>
                  <td class="text-muted">{job.scheduled_time}</td>
                  <td>{job.customer_name || "—"}</td>
                  <td>{job.technician_name || <span class="text-muted">Unassigned</span>}</td>
                  <td>
                    <span class="schedule-job-status-badge" style={{ background: `${STATUS_COLORS[job.status] || "#6b7280"}22`, color: STATUS_COLORS[job.status] || "#6b7280" }}>
                      {STATUS_ABBR[job.status] || "?"}
                    </span> {STATUS_LABELS[job.status] || job.status}
                  </td>
                  <td>{job.priority !== "normal" && job.priority !== "low" ? job.priority : <span class="text-muted">—</span>}</td>
                  {canSchedule && (
                    <td>
                      <button class="btn-icon" aria-label={`Reschedule ${job.identifier}`} onClick={(e) => { e.stopPropagation(); openReschedule(job); }}>
                        <CalendarClock size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {viewMode === "map" && canSchedule && (
        <ScheduleMap jobs={listJobs} canSchedule={canSchedule} navigate={navigate} onGeocoded={refreshSchedule} routeContext={mapRouteContext} />
      )}

      {detailDate && (
        <DayDetail
          date={detailDate}
          jobs={detailJobs}
          onClose={() => setDetailDate(null)}
          onCreateJob={() => { setCreateDate(detailDate); setDetailDate(null); }}
          canCreate={canSchedule}
        />
      )}
      {createDate && <CreateJob initialDate={createDate} onClose={() => setCreateDate(null)} />}
      {rescheduleJob && (
        <ScheduleEditModal job={rescheduleJob} initialDate={rescheduleProposedDate} onClose={closeReschedule} />
      )}
    </div>
  );
}

/** Richer job row shared by the Week and Day views — more room than a
 *  month-grid tile, so it surfaces address/priority/status text directly
 *  instead of relying on the tile's abbreviation-only treatment. */
function ScheduleJobRow({
  job, canSchedule, onDragStart, onNavigate, onReschedule, compact,
}: {
  job: Job;
  canSchedule: boolean;
  onDragStart?: (e: DragEvent) => void;
  onNavigate: (to: string) => void;
  onReschedule: (job: Job) => void;
  compact?: boolean;
}) {
  return (
    <div
      class={`schedule-row ${compact ? "compact" : ""}`}
      draggable={canSchedule && !!onDragStart}
      onDragStart={onDragStart}
      onClick={() => onNavigate(`/jobs/${job.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onNavigate(`/jobs/${job.id}`)}
    >
      <div class="schedule-row-top">
        <span class="identifier">{job.identifier}</span>
        <span
          class="schedule-job-status-badge"
          style={{ background: `${STATUS_COLORS[job.status] || "#6b7280"}22`, color: STATUS_COLORS[job.status] || "#6b7280" }}
        >
          {STATUS_ABBR[job.status] || "?"}
        </span>
        {(job.priority === "high" || job.priority === "urgent") && (
          <Flag size={12} aria-label={`${job.priority} priority`} color={PRIORITY_FLAG_COLOR[job.priority]} />
        )}
      </div>
      <div class="schedule-row-time text-bold">{job.scheduled_time} <span class="text-muted">({job.duration} min)</span></div>
      <div>{job.customer_name || "—"}</div>
      {job.address && !compact && (
        <div class="text-muted schedule-row-address"><MapPin size={12} /> {job.address}</div>
      )}
      <div class="text-muted">{job.technician_name || "Unassigned"}{job.service_type_name ? ` · ${job.service_type_name}` : ""}</div>
      {canSchedule && (
        <button
          type="button" class="btn btn-sm schedule-row-reschedule"
          onClick={(e) => { e.stopPropagation(); onReschedule(job); }}
        >
          <CalendarClock size={13} /> Reschedule
        </button>
      )}
    </div>
  );
}
