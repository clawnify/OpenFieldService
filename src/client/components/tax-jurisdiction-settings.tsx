import { useState, useEffect, useCallback } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import { Plus, Trash2 } from "lucide-preact";

// Phase 13D — Tax & Jurisdiction: organization-scoped, versioned,
// component-based tax configuration. Saving publishes a NEW effective
// version (src/server/tax-jurisdiction.ts#saveTaxProfile) — it never edits
// an existing one in place, so Quotes/Invoices already created keep
// whatever tax basis was resolved for them at the time (their own
// tax_snapshots row), completely unaffected by a later Save here. This is
// NOT a tax/legal compliance tool — Canadian presets are editable starting
// points only, never applied automatically.

interface TaxComponentForm { code: string; name: string; rate_percent: string }
interface TaxProfile {
  id: number; tax_enabled: boolean; country_code: string; region_code: string; currency: string;
  prices_include_tax: boolean; default_taxable: boolean; effective_from: string; effective_until: string | null;
  components: { id: number; code: string; name: string; rate_percent: number }[];
}
interface TaxOptions { ca_regions: { code: string; name: string }[]; ca_presets: Record<string, { code: string; name: string; rate_percent: number }[]> }

const EMPTY_COMPONENT: TaxComponentForm = { code: "", name: "", rate_percent: "0" };

export function TaxJurisdictionSettings() {
  const { setError } = useApp();
  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [options, setOptions] = useState<TaxOptions | null>(null);
  const [history, setHistory] = useState<TaxProfile[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [taxEnabled, setTaxEnabled] = useState(false);
  const [countryCode, setCountryCode] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [currency, setCurrency] = useState("CAD");
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false);
  const [defaultTaxable, setDefaultTaxable] = useState(true);
  const [components, setComponents] = useState<TaxComponentForm[]>([]);

  const applyProfile = (p: TaxProfile | null) => {
    setTaxEnabled(p?.tax_enabled ?? false);
    setCountryCode(p?.country_code ?? "");
    setRegionCode(p?.region_code ?? "");
    setCurrency(p?.currency ?? "CAD");
    setPricesIncludeTax(p?.prices_include_tax ?? false);
    setDefaultTaxable(p?.default_taxable ?? true);
    setComponents(p?.components.map((c) => ({ code: c.code, name: c.name, rate_percent: String(c.rate_percent) })) ?? []);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, optionsRes] = await Promise.all([
        api<{ profile: TaxProfile | null }>("GET", "/api/tax-profile"),
        api<TaxOptions>("GET", "/api/tax-profile/options"),
      ]);
      setProfile(profileRes.profile);
      applyProfile(profileRes.profile);
      setOptions(optionsRes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  const loadHistory = async () => {
    if (showHistory) { setShowHistory(false); return; }
    try {
      const res = await api<{ history: TaxProfile[] }>("GET", "/api/tax-profile/history");
      setHistory(res.history);
      setShowHistory(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyPreset = (regionCodeToApply: string) => {
    if (!options) return;
    const preset = options.ca_presets[regionCodeToApply];
    if (!preset) return;
    setCountryCode("CA");
    setRegionCode(regionCodeToApply);
    setComponents(preset.map((c) => ({ code: c.code, name: c.name, rate_percent: String(c.rate_percent) })));
  };

  const addComponent = () => setComponents([...components, { ...EMPTY_COMPONENT }]);
  const removeComponent = (i: number) => setComponents(components.filter((_, idx) => idx !== i));
  const updateComponent = (i: number, field: keyof TaxComponentForm, value: string) =>
    setComponents(components.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));

  const submit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const res = await api<{ profile: TaxProfile }>("POST", "/api/tax-profile", {
        tax_enabled: taxEnabled,
        country_code: countryCode,
        region_code: regionCode,
        currency,
        prices_include_tax: pricesIncludeTax,
        default_taxable: defaultTaxable,
        components: components.map((c) => ({ code: c.code, name: c.name, rate_percent: parseFloat(c.rate_percent) || 0 })),
      });
      setProfile(res.profile);
      applyProfile(res.profile);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div class="card"><p class="text-muted">Loading tax settings...</p></div>;

  return (
    <div class="settings-category">
      <h2 class="section-title">Tax &amp; Jurisdiction</h2>
      <p class="text-muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 8 }}>
        Not tax or legal advice — configure the components that apply to your
        organization and verify them with your own accountant. Saving takes
        effect for Quotes/Invoices created from now on; documents already
        created keep the tax basis they were calculated under and are never
        rewritten.
      </p>
      <form class="card settings-card" onSubmit={submit}>
        <h3 class="settings-group-heading">Jurisdiction</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>
              <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled((e.target as HTMLInputElement).checked)} />
              {" "}Tax Enabled
            </label>
            <p class="text-muted" style={{ fontSize: 11 }}>When off, new Quotes/Invoices calculate $0 tax.</p>
          </div>
          <div class="form-group">
            <label for="tj-country">Country</label>
            <input id="tj-country" type="text" value={countryCode} onInput={(e) => setCountryCode((e.target as HTMLInputElement).value.toUpperCase())} placeholder="CA" maxLength={2} />
          </div>
          <div class="form-group">
            <label for="tj-region">Province / State / Region</label>
            {countryCode === "CA" && options ? (
              <select id="tj-region" value={regionCode} onChange={(e) => setRegionCode((e.target as HTMLSelectElement).value)}>
                <option value="">Select a province/territory</option>
                {options.ca_regions.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
              </select>
            ) : (
              <input id="tj-region" type="text" value={regionCode} onInput={(e) => setRegionCode((e.target as HTMLInputElement).value)} />
            )}
          </div>
          <div class="form-group">
            <label for="tj-currency">Currency</label>
            <input id="tj-currency" type="text" value={currency} onInput={(e) => setCurrency((e.target as HTMLInputElement).value.toUpperCase())} placeholder="CAD" maxLength={3} />
          </div>
        </div>

        {countryCode === "CA" && options && (
          <>
            <h3 class="settings-group-heading">Canadian Presets (editable starting points — not legal advice)</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {options.ca_regions.map((r) => (
                <button type="button" key={r.code} class="btn btn-sm" onClick={() => applyPreset(r.code)}>{r.code}</button>
              ))}
            </div>
          </>
        )}

        <h3 class="settings-group-heading">Pricing</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>
              <input type="checkbox" checked={pricesIncludeTax} onChange={(e) => setPricesIncludeTax((e.target as HTMLInputElement).checked)} />
              {" "}Prices Include Tax
            </label>
            <p class="text-muted" style={{ fontSize: 11 }}>
              {pricesIncludeTax ? "Line prices already include tax — it will be extracted, never added on top." : "Tax will be added on top of line prices."}
            </p>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" checked={defaultTaxable} onChange={(e) => setDefaultTaxable((e.target as HTMLInputElement).checked)} />
              {" "}Default Taxable
            </label>
            <p class="text-muted" style={{ fontSize: 11 }}>Default for new line items — always overridable per line.</p>
          </div>
        </div>

        <h3 class="settings-group-heading">Tax Components</h3>
        {components.length === 0 && <p class="text-muted" style={{ fontSize: 12 }}>No components configured — tax will always be $0.</p>}
        {components.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input type="text" value={c.code} onInput={(e) => updateComponent(i, "code", (e.target as HTMLInputElement).value)} placeholder="GST" style={{ width: 80 }} aria-label={`Tax component ${i + 1} code`} />
            <input type="text" value={c.name} onInput={(e) => updateComponent(i, "name", (e.target as HTMLInputElement).value)} placeholder="Display name" style={{ flex: 1 }} aria-label={`Tax component ${i + 1} display name`} />
            <input type="number" step="0.001" min="0" max="100" value={c.rate_percent} onInput={(e) => updateComponent(i, "rate_percent", (e.target as HTMLInputElement).value)} style={{ width: 90 }} aria-label={`Tax component ${i + 1} rate percent`} />
            <span class="text-muted">%</span>
            <button type="button" class="btn-icon danger" onClick={() => removeComponent(i)} title="Remove component"><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" class="btn btn-sm" onClick={addComponent}><Plus size={14} /> Add Component</button>

        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" class="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Tax Profile"}</button>
          {saved && <span class="text-muted">Saved — new version now in effect.</span>}
          <button type="button" class="btn-link" onClick={loadHistory}>{showHistory ? "Hide" : "Show"} version history</button>
        </div>

        {profile && (
          <p class="text-muted" style={{ fontSize: 11, marginTop: 8 }}>
            Currently effective version since {new Date(profile.effective_from).toLocaleString()}.
          </p>
        )}

        {showHistory && (
          <div style={{ marginTop: 12 }}>
            <h3 class="settings-group-heading">Version History</h3>
            {history.length === 0 ? <p class="text-muted" style={{ fontSize: 12 }}>No prior versions.</p> : (
              <table class="table">
                <thead><tr><th>Effective From</th><th>Effective Until</th><th>Enabled</th><th>Components</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{new Date(h.effective_from).toLocaleString()}</td>
                      <td>{h.effective_until ? new Date(h.effective_until).toLocaleString() : "current"}</td>
                      <td>{h.tax_enabled ? "Yes" : "No"}</td>
                      <td>{h.components.map((c) => `${c.code} ${c.rate_percent}%`).join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
