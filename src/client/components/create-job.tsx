import { useState } from "preact/hooks";
import { useApp } from "../context";
import { ConfirmDialog } from "./confirm-dialog";
import { JOB_TYPE_LABELS, JOB_TYPE_OPTIONS } from "../job-type-labels";
import type { JobType } from "../types";
import { X } from "lucide-preact";

export function CreateJob({ onClose, initialDate }: { onClose: () => void; initialDate?: string }) {
  const { addJob, customerLookup, technicianLookup, serviceTypes, setError } = useApp();

  const today = new Date().toISOString().split("T")[0];
  const [customerId, setCustomerId] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [serviceTypeId, setServiceTypeId] = useState("");
  const [jobType, setJobType] = useState<JobType>("STANDARD");
  const [scheduledDate, setScheduledDate] = useState(initialDate || today);
  const [scheduledTime, setScheduledTime] = useState("09:00");
  const [priority, setPriority] = useState("normal");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Phase 7.2 fix: this form used to call the API directly on submit, with
  // no confirmation step at all — the one job-creation gap in this
  // codebase's otherwise-universal "mutation requires confirmation" rule
  // (every other create-*.tsx component already follows it). Staged the
  // same way as create-customer.tsx: validate → pendingSubmit → ConfirmDialog
  // → the actual addJob() call.
  const requestSubmit = (e: Event) => {
    e.preventDefault();
    if (!customerId) { setError("Please select a customer"); return; }
    if (!scheduledDate) { setError("Please select a date"); return; }
    setPendingSubmit(true);
  };

  const customerName = customerLookup.find((c) => String(c.id) === customerId)?.name || "this customer";

  const confirmSubmit = async () => {
    setSubmitting(true);
    try {
      await addJob({
        customer_id: parseInt(customerId, 10),
        technician_id: technicianId ? parseInt(technicianId, 10) : null,
        service_type_id: serviceTypeId ? parseInt(serviceTypeId, 10) : null,
        job_type: jobType,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        priority: priority as "low" | "normal" | "high" | "urgent",
        address,
        notes,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>New Job</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={requestSubmit}>
          <div class="form-grid">
            <div class="form-group">
              <label>Customer *</label>
              <select value={customerId} onChange={(e) => setCustomerId((e.target as HTMLSelectElement).value)} required>
                <option value="">Select customer...</option>
                {customerLookup.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Job Type</label>
              <select value={jobType} onChange={(e) => setJobType((e.target as HTMLSelectElement).value as JobType)}>
                {JOB_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{JOB_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Service Type</label>
              <select value={serviceTypeId} onChange={(e) => setServiceTypeId((e.target as HTMLSelectElement).value)}>
                <option value="">Select service...</option>
                {serviceTypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} (${s.default_price})</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Technician</label>
              <select value={technicianId} onChange={(e) => setTechnicianId((e.target as HTMLSelectElement).value)}>
                <option value="">Unassigned</option>
                {technicianLookup.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Priority</label>
              <select value={priority} onChange={(e) => setPriority((e.target as HTMLSelectElement).value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div class="form-group">
              <label>Date *</label>
              <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="form-group">
              <label>Time</label>
              <input type="time" value={scheduledTime} onChange={(e) => setScheduledTime((e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-group full-width">
              <label>Address (leave blank to use customer address)</label>
              <input type="text" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} placeholder="123 Main St, City, ST 12345" />
            </div>
            <div class="form-group full-width">
              <label>Notes</label>
              <textarea rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} placeholder="Job notes..." />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              Create Job
            </button>
          </div>
        </form>
      </div>
    </div>

    {pendingSubmit && (
      <ConfirmDialog
        title="Create this job?"
        message={`Create a new job for ${customerName} on ${scheduledDate} at ${scheduledTime}?`}
        confirmLabel="Create Job"
        submitting={submitting}
        onConfirm={confirmSubmit}
        onClose={() => setPendingSubmit(false)}
      />
    )}
    </>
  );
}
