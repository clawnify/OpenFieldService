import { useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { ConfirmDialog } from "./confirm-dialog";
import { X } from "lucide-preact";
import type { Job } from "../types";

/** Shared staged-change-then-confirm scheduling editor (Phase 7 — Advanced
 *  Scheduler). One component serves every entry point that can propose a
 *  reschedule: the "Change Schedule" button on job-detail.tsx, a tap-to-edit
 *  action from the Day/Week/List scheduler views, AND a staged drag-and-drop
 *  drop target (via `initialDate`/`initialTime`/`initialTechnicianId`) — none
 *  of them mutate anything directly; they all just open this modal
 *  pre-filled with the proposed values. The actual mutation only ever
 *  happens from `confirmSave()`, after the ConfirmDialog step, via the same
 *  `PUT /api/jobs/{id}` (`updateJob`) every other scheduling path already
 *  uses — no second mutation endpoint, no duplicated validation (the server
 *  is the sole authority on conflicts/validation; this UI never predicts
 *  that outcome, it just reports whatever error message the server sends
 *  back through the existing setError() convention). */
export function ScheduleEditModal({
  job, initialDate, initialTime, initialTechnicianId, onClose,
}: {
  job: Job;
  initialDate?: string;
  initialTime?: string;
  initialTechnicianId?: number | null;
  onClose: () => void;
}) {
  const { updateJob, technicianLookup, setError } = useApp();
  const [date, setDate] = useState(initialDate ?? job.scheduled_date);
  const [time, setTime] = useState(initialTime ?? job.scheduled_time);
  const [duration, setDuration] = useState(String(job.duration));
  const [technicianId, setTechnicianId] = useState<number | null>(
    initialTechnicianId !== undefined ? initialTechnicianId : job.technician_id
  );
  const [pendingSave, setPendingSave] = useState(false);
  const [saving, setSaving] = useState(false);

  // The job's currently-assigned technician may have gone inactive since
  // assignment (technicianLookup only ever lists active technicians, same
  // as every other technician dropdown in the app) — without this, a
  // native <select> whose bound value matches none of its <option>s
  // silently falls back to displaying whichever option happens to be
  // first, misleading the user about who is actually assigned. Found
  // during the Phase 7.1 UI audit.
  const currentTechInactive = job.technician_id !== null && !technicianLookup.some((t) => t.id === job.technician_id);

  const technicianName = (id: number | null) => {
    if (id === null) return "Unassigned";
    if (id === job.technician_id && job.technician_name) return job.technician_name;
    return technicianLookup.find((t) => t.id === id)?.name || "Unknown";
  };

  // Escape-to-close, scoped to this modal only — the shared ConfirmDialog
  // and other pre-existing app modals have no such handling app-wide
  // (documented pre-existing gap), and adding it globally is out of scope
  // for this phase; this is a new Phase 7 component, so it starts correct.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape" && !pendingSave) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingSave, onClose]);

  const changed = date !== job.scheduled_date || time !== job.scheduled_time
    || Number(duration) !== job.duration || technicianId !== job.technician_id;

  const requestSave = () => {
    if (!date || !time) { setError("Enter a date and time"); return; }
    const dur = parseInt(duration, 10);
    if (!Number.isInteger(dur) || dur <= 0) { setError("Duration must be a positive number of minutes"); return; }
    if (!changed) { onClose(); return; }
    setPendingSave(true);
  };

  const confirmSave = async () => {
    setSaving(true);
    try {
      // Only send fields that actually changed — critically, this means an
      // untouched technician_id is never re-sent. A job already assigned to
      // a technician who has since gone inactive must remain freely
      // reschedulable on date/time/duration alone; sending technician_id
      // unconditionally would re-trigger the server's active-technician
      // check on every save regardless of user intent (found during the
      // Phase 7.1 UI audit — see mem:phase7/advanced-scheduler).
      const payload: { scheduled_date?: string; scheduled_time?: string; duration?: number; technician_id?: number | null } = {};
      if (date !== job.scheduled_date) payload.scheduled_date = date;
      if (time !== job.scheduled_time) payload.scheduled_time = time;
      if (Number(duration) !== job.duration) payload.duration = parseInt(duration, 10);
      if (technicianId !== job.technician_id) payload.technician_id = technicianId;
      await updateJob(job.id, payload);
      setPendingSave(false);
      onClose();
    } catch (err) {
      // Covers both plain validation errors (400) and scheduling conflicts
      // (409, "This technician is already booked during an overlapping time
      // range...") — api()'s handleResponse() already surfaces the server's
      // exact message for any non-2xx response, so no special-casing is
      // needed here to explain a conflict to the user.
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Change Schedule — {job.identifier}</h2>
          <button class="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div class="form-grid schedule-edit-grid">
          <div class="form-group">
            <label htmlFor="sched-date">Date</label>
            <input id="sched-date" type="date" value={date} onChange={(e) => setDate((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group">
            <label htmlFor="sched-time">Time</label>
            <input id="sched-time" type="time" value={time} onChange={(e) => setTime((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-group full-width">
            <label htmlFor="sched-duration">Duration (minutes)</label>
            <input
              id="sched-duration" type="number" min="1" step="1" value={duration}
              onInput={(e) => setDuration((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="form-group full-width">
            <label htmlFor="sched-tech">Technician</label>
            <select
              id="sched-tech"
              value={technicianId ?? ""}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setTechnicianId(v ? parseInt(v, 10) : null);
              }}
            >
              <option value="">Unassigned</option>
              {currentTechInactive && job.technician_id !== null && (
                <option value={job.technician_id}>{job.technician_name || "Unknown"} (Inactive)</option>
              )}
              {technicianLookup.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button type="button" class="btn btn-primary" onClick={requestSave}>Review Change</button>
        </div>
      </div>
    </div>

    {pendingSave && (
      <ConfirmDialog
        title="Confirm schedule change?"
        message={`Move ${job.identifier} to ${date} at ${time} (${duration} min)? Technician: ${technicianName(technicianId)}.`}
        confirmLabel="Confirm"
        submitting={saving}
        onConfirm={confirmSave}
        onClose={() => setPendingSave(false)}
      />
    )}
    </>
  );
}
