import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api } from "../api";
import type { Asset, Site } from "../types";

export function EquipmentDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} class="modal equipment-dialog" aria-label={title} onClose={onClose}>
    <div class="modal-header"><h2>{title}</h2><button type="button" class="btn-icon" aria-label="Close" onClick={onClose}>×</button></div>
    {children}
  </dialog>;
}

export function SiteForm({ customerId, site, onSaved, onClose }: { customerId: number; site?: Site; onSaved: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
    setBusy(true); setError("");
    try {
      await api(site ? "PUT" : "POST", site ? `/api/sites/${site.id}` : `/api/customers/${customerId}/sites`, data);
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <EquipmentDialog title={site ? "Edit site" : "Add site"} onClose={onClose}>
    <form onSubmit={submit}>
      <div class="form-grid">
        <label class="form-group full-width">Site name *<input name="name" defaultValue={site?.name} required maxLength={500} autoFocus /></label>
        <label class="form-group full-width">Full address<input name="address" defaultValue={site?.address} maxLength={500} /></label>
        <label class="form-group">Contact name<input name="contact_name" defaultValue={site?.contact_name} maxLength={500} /></label>
        <label class="form-group">Contact phone<input name="contact_phone" type="tel" defaultValue={site?.contact_phone} maxLength={500} /></label>
        <label class="form-group">Contact email<input name="contact_email" type="email" defaultValue={site?.contact_email} maxLength={254} /></label>
        <label class="form-group">Timezone<input name="timezone" defaultValue={site?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} placeholder="Europe/Amsterdam" required maxLength={100} /></label>
        <label class="form-group full-width">Access instructions<textarea name="access_instructions" defaultValue={site?.access_instructions} rows={3} maxLength={5000} /></label>
        <label class="form-group full-width">Safety notes<textarea name="safety_notes" defaultValue={site?.safety_notes} rows={3} maxLength={5000} /></label>
        {error && <p class="equipment-error full-width" role="alert">{error}</p>}
      </div>
      <div class="modal-footer"><button type="button" class="btn" onClick={onClose} disabled={busy}>Cancel</button><button class="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save site"}</button></div>
    </form>
  </EquipmentDialog>;
}

export function AssetForm({ customerId, sites, asset, onSaved, onClose }: { customerId: number; sites: Site[]; asset?: Asset; onSaved: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
    setBusy(true); setError("");
    try {
      await api(asset ? "PUT" : "POST", asset ? `/api/assets/${asset.id}` : `/api/customers/${customerId}/assets`, { ...data, site_id: Number(data.site_id) });
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <EquipmentDialog title={asset ? "Edit equipment" : "Register equipment"} onClose={onClose}>
    <form onSubmit={submit}>
      <div class="form-grid">
        <label class="form-group full-width">Equipment name *<input name="name" defaultValue={asset?.name} required maxLength={500} autoFocus placeholder="Rooftop air conditioner" /></label>
        <label class="form-group">Serial number *<input name="serial_number" defaultValue={asset?.serial_number} required maxLength={500} /></label>
        <label class="form-group">Site *<select name="site_id" defaultValue={asset?.site_id || sites[0]?.id} required>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label class="form-group">Manufacturer<input name="manufacturer" defaultValue={asset?.manufacturer} maxLength={500} /></label>
        <label class="form-group">Model<input name="model" defaultValue={asset?.model} maxLength={500} /></label>
        <label class="form-group full-width">Lifecycle status<select name="status" defaultValue={asset?.status || "in_service"}><option value="in_service">In service</option><option value="out_of_service">Out of service</option><option value="retired">Retired</option></select></label>
        <label class="form-group">Installation date<input name="installation_date" type="date" defaultValue={asset?.installation_date} /></label>
        <label class="form-group">Commissioning date<input name="commissioning_date" type="date" defaultValue={asset?.commissioning_date} /></label>
        <label class="form-group">Warranty start<input name="warranty_start" type="date" defaultValue={asset?.warranty_start} /></label>
        <label class="form-group">Warranty end<input name="warranty_end" type="date" defaultValue={asset?.warranty_end} /></label>
        <label class="form-group full-width">Equipment notes<textarea name="notes" defaultValue={asset?.notes} rows={3} maxLength={5000} /></label>
        {asset && <p class="text-muted full-width">Site moves and status changes are kept in the equipment history. Existing job addresses stay unchanged.</p>}
        {error && <p class="equipment-error full-width" role="alert">{error}</p>}
      </div>
      <div class="modal-footer"><button type="button" class="btn" onClick={onClose} disabled={busy}>Cancel</button><button class="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save equipment"}</button></div>
    </form>
  </EquipmentDialog>;
}
