import { useApp } from "../context";
import { ChevronLeft, ChevronRight } from "lucide-preact";
import { calendarDate, daysInRange, weekRange } from "../calendar";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleView() {
  const { scheduleJobs, scheduleStart, scheduleEnd, setScheduleRange, navigate, technicianLookup } = useApp();

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
        <div class="page-header-right">
          <button class="btn" onClick={goToday}>Today</button>
          <button class="btn btn-icon" onClick={() => shiftWeek(-1)}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: 14, fontWeight: 600, minWidth: 200, textAlign: "center" }}>
            {new Date(scheduleStart + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            {" — "}
            {new Date(scheduleEnd + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
          <button class="btn btn-icon" onClick={() => shiftWeek(1)}><ChevronRight size={16} /></button>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
