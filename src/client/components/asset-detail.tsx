import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useApp } from "../context";
import type { Asset, AssetHistory, Site } from "../types";
import { AssetForm } from "./equipment-forms";
import { Pagination } from "./pagination";
import { CreateJob } from "./create-job";

export function AssetDetail({ id }: { id: string }) {
  const { navigate } = useApp();
  const [detail, setDetail] = useState<{ asset: Asset; site: Site } | null>(null);
  const [history, setHistory] = useState<AssetHistory[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editSites, setEditSites] = useState<Site[] | null>(null);
  const [scheduling, setScheduling] = useState(false);
  useEffect(() => {
    let current = true;
    setError(""); setLoading(true);
    Promise.all([
      api<{ asset: Asset; site: Site }>("GET", `/api/assets/${id}`),
      api<{ history: AssetHistory[]; total: number }>("GET", `/api/assets/${id}/history?page=${page}`),
    ]).then(([d, h]) => { if (current) { setDetail(d); setHistory(h.history); setTotal(h.total); } })
      .catch((err) => { if (current) setError(err.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, page, revision]);
  const edit = async () => {
    try { const data = await api<{ sites: Site[] }>("GET", `/api/customers/${detail!.asset.customer_id}/sites`); setEditSites(data.sites); }
    catch (err) { setError((err as Error).message); }
  };
  return <div class="page equipment-page">
    <div class="page-header"><button class="btn" onClick={() => navigate(detail ? `/customers/${detail.asset.customer_id}` : "/customers")}>Back to customer</button>
      <div class="equipment-actions">
        <button class="btn" disabled={!detail || loading} onClick={edit}>Edit equipment</button>
        <button class="btn btn-primary" disabled={!detail || loading || !!error} onClick={() => setScheduling(true)}>Schedule job</button>
      </div></div>
    {error && <p class="equipment-error" role="alert">{error} <button class="btn" onClick={() => setRevision((n) => n + 1)}>Retry</button></p>}
    {loading ? <p role="status">Loading equipment…</p> : detail && <>
      <div class="equipment-record"><aside class="equipment-rail">
      <h1>{detail.asset.name}</h1><p class="text-muted">{detail.asset.customer_name} · {detail.asset.site_name}</p>
      <dl class="equipment-facts">{[
        ["Serial number", detail.asset.serial_number], ["Manufacturer", detail.asset.manufacturer], ["Model", detail.asset.model],
        ["Lifecycle status", detail.asset.status.replaceAll("_", " ")], ["Installed", detail.asset.installation_date], ["Commissioned", detail.asset.commissioning_date],
        ["Warranty start", detail.asset.warranty_start], ["Warranty end", detail.asset.warranty_end],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not recorded"}</dd></div>)}</dl>
      {detail.asset.notes && <p class="detail-notes">{detail.asset.notes}</p>}
      <section class="detail-section"><h3>Current site</h3><p>{detail.site.name} · {detail.site.address || "No address recorded"}</p>
        <p>{[detail.site.contact_name, detail.site.contact_phone, detail.site.contact_email].filter(Boolean).join(" · ")}</p>
        <p class="text-muted">Timezone: {detail.site.timezone}</p>
        {detail.site.access_instructions && <p class="detail-notes"><strong>Access: </strong>{detail.site.access_instructions}</p>}
        {detail.site.safety_notes && <p class="detail-notes"><strong>Safety: </strong>{detail.site.safety_notes}</p>}
      </section>
      </aside><section class="detail-section equipment-timeline"><h3>Equipment history ({total})</h3>
        <ol class="equipment-history">{history.map((event) => <li key={event.id} class="card equipment-card">
          <div class="equipment-heading"><strong>{event.summary}</strong><time dateTime={event.created_at.replace(" ", "T") + "Z"}>{new Date(event.created_at.replace(" ", "T") + "Z").toLocaleString()}</time></div>
          {event.details && <p class="detail-notes">{event.details}</p>}
          {event.available_job_id && <button class="btn btn-sm" onClick={() => navigate(`/jobs/${event.available_job_id}`)}>View job, checklist & materials</button>}
        </li>)}</ol>
        <Pagination pag={{ page, total, limit: 50 }} setPage={setPage} />
      </section></div>
    </>}
    {editSites && detail && <AssetForm customerId={detail.asset.customer_id} asset={detail.asset} sites={editSites} onClose={() => setEditSites(null)} onSaved={() => { setEditSites(null); setPage(1); setRevision((n) => n + 1); }} />}
    {scheduling && detail && <CreateJob initialAsset={detail.asset} onClose={() => setScheduling(false)} onCreated={(job) => navigate(`/jobs/${job.id}`)} />}
  </div>;
}
