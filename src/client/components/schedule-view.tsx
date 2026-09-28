import { useApp } from "../context";
import { useState } from "preact/hooks";
import { ChevronLeft, ChevronRight, Plus } from "lucide-preact";
import { calendarDate, daysInRange, weekRange } from "../calendar";
import { CreateJob } from "./create-job";
import { useConnectivity } from "../hooks/use-connectivity";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleView() {
  const { scheduleJobs, scheduleStart, scheduleEnd, setScheduleRange, navigate } = useApp();
  const { readOnly } = useConnectivity();
  const [createDate, setCreateDate] = useState<string | null>(null);

  const days = daysInRange(scheduleStart, scheduleEnd);
  const todayStr = calendarDate(new Date());

  const shiftWeek = (delta: number) => {
    const start = new Date(scheduleStart + "T00:00:00");
    start.setDate(start.getDate() + delta * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    setScheduleRange(calendarDate(start), calendarDate(end));
  };

  const goToday = () => {
    setScheduleRange(...weekRange());
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Schedule</h1>
        <button class="btn btn-primary" disabled={readOnly} onClick={() => setCreateDate(todayStr >= scheduleStart && todayStr <= scheduleEnd ? todayStr : scheduleStart)}>
          <Plus size={16} /> New job
        </button>
      </div>
      <div class="toolbar schedule-toolbar">
        <div class="page-header-right">
          <button class="btn" disabled={readOnly} onClick={goToday}>Today</button>
          <button class="btn btn-icon" disabled={readOnly} aria-label="Previous week" onClick={() => shiftWeek(-1)}><ChevronLeft size={16} /></button>
          <span class="schedule-range" aria-live="polite">
            {new Date(scheduleStart + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            {" — "}
            {new Date(scheduleEnd + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
          <button class="btn btn-icon" disabled={readOnly} aria-label="Next week" onClick={() => shiftWeek(1)}><ChevronRight size={16} /></button>
        </div>
      </div>

      <div class="schedule-grid">
        {days.map((day) => {
          const dayJobs = scheduleJobs.filter((j) => j.scheduled_date === day);
          const dateObj = new Date(day + "T00:00:00");
          const isToday = day === todayStr;
          return (
            <div key={day} class={`schedule-day ${isToday ? "today" : ""}`}>
              <div class="schedule-day-header">
                <span class="schedule-day-name">{DAY_NAMES[dateObj.getDay()]}</span>
                <span class={`schedule-day-num ${isToday ? "today" : ""}`}>{dateObj.getDate()}</span>
              </div>
              <div class="schedule-day-jobs">
                {dayJobs.map((job) => (
                  <button
                    key={job.id}
                    class="schedule-job"
                    style={{ "--category": job.technician_color || job.service_type_color || "var(--info)" }}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                  >
                    <div class="schedule-job-time">{job.scheduled_time}</div>
                    <div class="schedule-job-title">{job.customer_name}</div>
                    {job.service_type_name && <div class="schedule-job-service">{job.service_type_name}</div>}
                    {job.technician_name && <div class="schedule-job-tech">{job.technician_name}</div>}
                  </button>
                ))}
                {dayJobs.length === 0 && (
                  <div class="schedule-empty">No jobs</div>
                )}
              </div>
              <button class="btn btn-ghost schedule-add-job" disabled={readOnly} aria-label={`Add job on ${dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`} onClick={() => setCreateDate(day)}>
                <Plus size={14} /> Add job
              </button>
            </div>
          );
        })}
      </div>
      {createDate !== null && <CreateJob initialDate={createDate} onClose={() => setCreateDate(null)} onCreated={(job) => {
        if (job.scheduled_date < scheduleStart || job.scheduled_date > scheduleEnd) {
          setScheduleRange(...weekRange(new Date(job.scheduled_date + "T00:00:00")));
        }
      }} />}
    </div>
  );
}
