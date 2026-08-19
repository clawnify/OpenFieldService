import { useApp } from "../context";
import { StatusBadge, PriorityBadge } from "./status-badge";
import { X, Plus, MapPin } from "lucide-preact";
import type { Job } from "../types";

export function DayDetail({
  date, jobs, onClose, onCreateJob, canCreate = true,
}: { date: string; jobs: Job[]; onClose: () => void; onCreateJob: () => void; canCreate?: boolean }) {
  const { navigate } = useApp();
  const dateObj = new Date(date + "T00:00:00");
  const label = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const goToJob = (id: number) => {
    navigate(`/jobs/${id}`);
    onClose();
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>{label}</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div class="day-detail-body">
          {jobs.length === 0 ? (
            <p class="text-muted">No jobs scheduled for this day.</p>
          ) : (
            jobs.map((job) => (
              <button key={job.id} class="day-detail-job" onClick={() => goToJob(job.id)}>
                <div class="day-detail-job-top">
                  <span class="identifier">{job.identifier}</span>
                  <StatusBadge status={job.status} />
                  <PriorityBadge priority={job.priority} />
                </div>
                <div class="day-detail-job-time">{job.scheduled_time} <span class="text-muted">({job.duration} min)</span></div>
                <div class="text-bold">{job.service_type_name || "Service"} — {job.customer_name}</div>
                {job.address && (
                  <div class="text-muted day-detail-job-address"><MapPin size={12} /> {job.address}</div>
                )}
                {job.technician_name && <div class="text-muted">Tech: {job.technician_name}</div>}
              </button>
            ))
          )}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose}>Close</button>
          {canCreate && (
            <button type="button" class="btn btn-primary" onClick={onCreateJob}>
              <Plus size={16} /> New Job
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
