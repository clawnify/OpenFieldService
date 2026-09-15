import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useApp } from "../context";
import type { Asset, Site } from "../types";
import { AssetForm, SiteForm } from "./equipment-forms";
import { Pagination } from "./pagination";

export function CustomerEquipment({ customerId }: { customerId: number }) {
  const { navigate } = useApp();
  const [sites, setSites] = useState<Site[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [siteForm, setSiteForm] = useState<Site | "new" | null>(null);
  const [assetForm, setAssetForm] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    Promise.all([
      api<{ sites: Site[] }>("GET", `/api/customers/${customerId}/sites`),
      api<{ assets: Asset[]; total: number }>("GET", `/api/customers/${customerId}/assets?${new URLSearchParams({ search, page: String(page) })}`),
    ]).then(([s, a]) => {
      if (current) { setSites(s.sites); setAssets(a.assets); setTotal(a.total); }
    }).catch((err) => { if (current) setError(err.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [customerId, page, search, revision]);
  const saved = () => { setSiteForm(null); setAssetForm(false); setRevision((n) => n + 1); };
  return <section class="detail-section equipment-section" aria-label="Sites and equipment">
    <div class="equipment-heading"><h3>Sites & equipment</h3><div class="equipment-actions">
      <button class="btn" onClick={() => setSiteForm("new")}>Add site</button>
      <button class="btn btn-primary" disabled={!sites.length || loading || !!error} onClick={() => setAssetForm(true)}>Register equipment</button>
    </div></div>
    <p class="text-muted">Optional for equipment service. Jobs can still use the customer address without equipment.</p>
    {error ? <p class="equipment-error" role="alert">{error} <button class="btn" onClick={() => setRevision((n) => n + 1)}>Retry</button></p> : <>
      <div class="equipment-sites">{sites.map((site) => <details key={site.id} class="card equipment-card">
        <summary>{site.name}</summary>
        <p>{site.address || "No address recorded"}</p>
        <p>{[site.contact_name, site.contact_phone, site.contact_email].filter(Boolean).join(" · ")}</p>
        <p class="text-muted">Timezone: {site.timezone}</p>
        {site.access_instructions && <p class="detail-notes"><strong>Access: </strong>{site.access_instructions}</p>}
        {site.safety_notes && <p class="detail-notes"><strong>Safety: </strong>{site.safety_notes}</p>}
        <button class="btn" onClick={() => setSiteForm(site)}>Edit site</button>
      </details>)}</div>
      {!loading && !sites.length && <p class="text-muted">Add a site to register equipment at this customer’s location.</p>}
      <label class="form-group equipment-search">Find equipment<input type="search" value={search} placeholder="Name, serial number, or model" onInput={(e) => { setSearch(e.currentTarget.value); setPage(1); }} /></label>
      {loading ? <p role="status">Loading equipment…</p> : <>
        {assets.length === 0 ? <p class="text-muted">{search ? "No equipment matches your search." : "No equipment registered yet."}</p> : <div class="equipment-grid">{assets.map((asset) => <button key={asset.id} class="card equipment-card equipment-link" onClick={() => navigate(`/assets/${asset.id}`)}>
          <strong>{asset.name}</strong><span>Serial: {asset.serial_number}</span><span>{asset.site_name}</span><span class="text-muted">{asset.status.replaceAll("_", " ")}</span>
        </button>)}</div>}
        <Pagination pag={{ page, total, limit: 50 }} setPage={setPage} />
      </>}
    </>}
    {siteForm && <SiteForm customerId={customerId} site={siteForm === "new" ? undefined : siteForm} onClose={() => setSiteForm(null)} onSaved={saved} />}
    {assetForm && <AssetForm customerId={customerId} sites={sites} onClose={() => setAssetForm(false)} onSaved={saved} />}
  </section>;
}
