import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useApp } from "../context";
import type { Asset, Job } from "../types";

export function AssetPicker({ customerId, value, onChange }: { customerId: number; value: number | null; onChange: (id: number | null) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    if (!customerId) { setAssets([]); return; }
    setLoading(true); setError("");
    api<{ assets: Asset[]; total: number }>("GET", `/api/customers/${customerId}/assets?${new URLSearchParams({ search })}`)
      .then((data) => { if (current) { setAssets(data.assets); setTotal(data.total); } })
      .catch((err) => { if (current) setError(err.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [customerId, search, revision]);
  return <div class="equipment-picker">
    <label class="form-group">Find equipment<input type="search" disabled={!customerId} value={search} placeholder="Name, serial number, or model" onInput={(e) => setSearch(e.currentTarget.value)} /></label>
    <label class="form-group">Equipment (optional)<select value={value ?? ""} disabled={!customerId || loading || !!error} onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
      <option value="">No equipment — customer job</option>
      {value != null && !assets.some((a) => a.id === value) && <option value={value}>Linked equipment #{value}</option>}
      {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.serial_number} · {asset.site_name}{asset.status === "retired" ? " (retired)" : ""}</option>)}
    </select></label>
    {loading && <p role="status">Loading equipment…</p>}
    {error && <p role="alert" class="equipment-error">{error} <button type="button" class="btn" onClick={() => setRevision((n) => n + 1)}>Retry</button></p>}
    {!loading && !error && total > 50 && <p class="text-muted">Showing the first 50 matches. Search by serial number to find more.</p>}
  </div>;
}

export function JobEquipment({ job }: { job: Job }) {
  const { updateJob, navigate } = useApp();
  const [value, setValue] = useState(job.asset_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setValue(job.asset_id); }, [job.asset_id]);
  const save = async () => {
    setBusy(true); setError("");
    try { await updateJob(job.id, { asset_id: value }); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <section class="detail-section equipment-section" aria-label="Job equipment"><h3>Equipment</h3>
    <fieldset disabled={busy}><AssetPicker customerId={job.customer_id} value={value} onChange={setValue} /></fieldset>
    <div class="equipment-actions">
      <button class="btn" disabled={busy || value === job.asset_id} onClick={save}>{busy ? "Saving…" : "Save equipment link"}</button>
      {job.asset_id != null && <button class="btn" onClick={() => navigate(`/assets/${job.asset_id}`)}>View equipment & history</button>}
    </div>
    <p class="text-muted">Changing the equipment link keeps the job address unchanged.</p>
    {error && <p class="equipment-error" role="alert">{error}</p>}
  </section>;
}
