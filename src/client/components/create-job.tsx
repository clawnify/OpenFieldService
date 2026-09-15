import { useState } from "preact/hooks";
import { calendarDate } from "../calendar";
import { useApp } from "../context";
import { AssetPicker } from "./asset-picker";
import { EquipmentDialog } from "./equipment-forms";
import type { Asset, Job } from "../types";

export function CreateJob({ onClose, initialAsset, initialDate, onCreated }: { onClose: () => void; initialAsset?: Asset; initialDate?: string; onCreated?: (job: Job) => void }) {
  const { addJob, customerLookup, technicianLookup, serviceTypes } = useApp();

  const [customerId, setCustomerId] = useState(initialAsset ? String(initialAsset.customer_id) : "");
  const [assetId, setAssetId] = useState<string | null>(initialAsset?.id ?? null);
  const [technicianId, setTechnicianId] = useState("");
  const [serviceTypeId, setServiceTypeId] = useState("");
  const [scheduledDate, setScheduledDate] = useState(() => initialDate ?? calendarDate(new Date()));
  const [scheduledTime, setScheduledTime] = useState("09:00");
  const [priority, setPriority] = useState("normal");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState("");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    if (!customerId) { setError("Please select a customer"); return; }
    if (!scheduledDate) { setError("Please select a date"); return; }
    setSubmitting(true);
    try {
      const job = await addJob({
        customer_id: customerId,
        asset_id: assetId,
        technician_id: technicianId ? technicianId : null,
        service_type_id: serviceTypeId ? serviceTypeId : null,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        priority: priority as "low" | "normal" | "high" | "urgent",
        address,
        notes,
      });
      onClose();
      onCreated?.(job);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <EquipmentDialog title="New job" onClose={onClose} busy={submitting}>
        <form onSubmit={handleSubmit}>
          <fieldset class="form-grid job-form-fields" disabled={submitting}>
            <div class="form-group">
              <label htmlFor="job-customer">Customer *</label>
              <select id="job-customer" autoFocus value={customerId} onChange={(e) => { setCustomerId((e.target as HTMLSelectElement).value); setAssetId(null); }} required>
                <option value="">Select customer...</option>
                {initialAsset && !customerLookup.some((c) => c.id === initialAsset.customer_id) && <option value={initialAsset.customer_id}>{initialAsset.customer_name}</option>}
                {customerLookup.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label htmlFor="job-service">Service Type</label>
              <select id="job-service" value={serviceTypeId} onChange={(e) => setServiceTypeId((e.target as HTMLSelectElement).value)}>
                <option value="">Select service...</option>
                {serviceTypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} (${s.default_price})</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label htmlFor="job-technician">Technician</label>
              <select id="job-technician" value={technicianId} onChange={(e) => setTechnicianId((e.target as HTMLSelectElement).value)}>
                <option value="">Unassigned</option>
                {technicianLookup.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label htmlFor="job-priority">Priority</label>
              <select id="job-priority" value={priority} onChange={(e) => setPriority((e.target as HTMLSelectElement).value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div class="form-group">
              <label htmlFor="job-date">Date *</label>
              <input id="job-date" type="date" value={scheduledDate} onChange={(e) => setScheduledDate((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="form-group">
              <label htmlFor="job-time">Time</label>
              <input id="job-time" type="time" value={scheduledTime} onChange={(e) => setScheduledTime((e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-group full-width">
              <AssetPicker key={customerId} customerId={customerId} value={assetId} onChange={setAssetId} initialAsset={initialAsset} />
            </div>
            <div class="form-group full-width">
              <label htmlFor="job-address">Address (leave blank to use equipment site or customer address)</label>
              <input id="job-address" type="text" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} placeholder="123 Main St, City, ST 12345" />
            </div>
            <div class="form-group full-width">
              <label htmlFor="job-notes">Notes</label>
              <textarea id="job-notes" rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} placeholder="Job notes..." />
            </div>
            {error && <p class="equipment-error full-width" role="alert">{error}</p>}
          </fieldset>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating..." : "Create job"}
            </button>
          </div>
        </form>
    </EquipmentDialog>
  );
}
