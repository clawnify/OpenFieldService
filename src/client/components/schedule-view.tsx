import { useApp } from "../context";
import { ChevronLeft, ChevronRight } from "lucide-preact";

function getDaysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (d <= endDate) {
    days.push(d.toISOString().split("T")[0]);
    d.setDate(d.getDate() + 1);
  }
  return days;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleView() {
  const { scheduleJobs, scheduleStart, scheduleEnd, setScheduleRange, navigate } = useApp();

  const days = getDaysInRange(scheduleStart, scheduleEnd);
  const todayStr = new Date().toISOString().split("T")[0];

  const shiftWeek = (delta: number) => {
    const start = new Date(scheduleStart + "T00:00:00");
    start.setDate(start.getDate() + delta * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    setScheduleRange(start.toISOString().split("T")[0], end.toISOString().split("T")[0]);
  };

  const goToday = () => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - today.getDay() + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    setScheduleRange(monday.toISOString().split("T")[0], sunday.toISOString().split("T")[0]);
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
                    style={{ borderLeftColor: job.technician_color || job.service_type_color || "#16a34a" }}
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
