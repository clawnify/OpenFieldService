import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { useApp } from "../context";
import { api, apiUpload } from "../api";
import type { CompanyProfile } from "../types";

// Phase 13A hardening — Company Profile: tenant business identity, rendered
// into the Contract PDF header/footer (contract-pdf.ts via
// contracts.ts#buildCompanySnapshot). A profile edit here only affects
// Contracts created AFTER the save — an already-signed Contract's PDF was
// snapshotted at creation time and never changes (see migrations/0019).

type FormState = Omit<CompanyProfile, "organization_id" | "logo_key" | "updated_by" | "created_at" | "updated_at">;

const EMPTY_FORM: FormState = {
  company_name: "", legal_name: "", phone: "", email: "", website: "",
  address_line1: "", address_line2: "", city: "", state: "", postal_code: "", country: "",
  business_number: "", tax_number: "", contract_footer: "",
};

function toForm(p: CompanyProfile): FormState {
  return {
    company_name: p.company_name, legal_name: p.legal_name, phone: p.phone, email: p.email, website: p.website,
    address_line1: p.address_line1, address_line2: p.address_line2, city: p.city, state: p.state,
    postal_code: p.postal_code, country: p.country, business_number: p.business_number,
    tax_number: p.tax_number, contract_footer: p.contract_footer,
  };
}

export function CompanyProfileSettings() {
  const { setError } = useApp();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [hasLogo, setHasLogo] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0); // cache-bust the <img> src after upload/remove
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ profile: CompanyProfile }>("GET", "/api/company-profile");
      setForm(toForm(res.profile));
      setHasLogo(res.profile.logo_key !== null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  const uploadLogo = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await apiUpload("POST", "/api/company-profile/logo", formData);
      setHasLogo(true);
      setLogoVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const removeLogo = async () => {
    setUploadingLogo(true);
    try {
      await api("DELETE", "/api/company-profile/logo");
      setHasLogo(false);
      setLogoVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingLogo(false);
    }
  };

  const set = (field: keyof FormState) => (e: Event) =>
    setForm({ ...form, [field]: (e.target as HTMLInputElement | HTMLTextAreaElement).value });

  const submit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const res = await api<{ profile: CompanyProfile }>("PUT", "/api/company-profile", form);
      setForm(toForm(res.profile));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div class="card"><p class="text-muted">Loading company profile...</p></div>;

  return (
    <div class="settings-category">
      <h2 class="section-title">Company Profile</h2>
      <p class="text-muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 8 }}>
        Your business identity, used on generated documents such as the signed
        Contract PDF. Changes here apply to documents generated from now on —
        Contracts already signed keep the company details that were on file
        when they were signed.
      </p>
      <form class="card settings-card" onSubmit={submit}>
        <h3 class="settings-group-heading">Identity</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="cp-company-name">Company Name</label>
            <input id="cp-company-name" type="text" value={form.company_name} onInput={set("company_name")} placeholder="Coreline Comfort" />
          </div>
          <div class="form-group">
            <label for="cp-legal-name">Legal Name</label>
            <input id="cp-legal-name" type="text" value={form.legal_name} onInput={set("legal_name")} placeholder="Coreline Comfort Ltd." />
          </div>
        </div>

        <h3 class="settings-group-heading">Branding</h3>
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="cp-logo">Company Logo</label>
            {hasLogo && (
              <div style={{ marginBottom: 8 }}>
                <img
                  src={`/api/company-profile/logo?v=${logoVersion}`} alt="Company logo"
                  style={{ maxHeight: 60, maxWidth: 200, display: "block", background: "#fff", padding: 4, border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 4 }}
                />
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                id="cp-logo" ref={logoInputRef} type="file" accept="image/png,image/jpeg"
                onChange={uploadLogo} disabled={uploadingLogo}
              />
              {hasLogo && (
                <button type="button" class="btn btn-sm" disabled={uploadingLogo} onClick={removeLogo}>Remove</button>
              )}
            </div>
            <p class="text-muted" style={{ fontSize: 11 }}>PNG or JPEG, up to 2MB. Appears on the signed Contract PDF header.</p>
          </div>
        </div>

        <h3 class="settings-group-heading">Contact</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="cp-phone">Phone</label>
            <input id="cp-phone" type="text" value={form.phone} onInput={set("phone")} />
          </div>
          <div class="form-group">
            <label for="cp-email">Email</label>
            <input id="cp-email" type="email" value={form.email} onInput={set("email")} />
          </div>
          <div class="form-group">
            <label for="cp-website">Website</label>
            <input id="cp-website" type="text" value={form.website} onInput={set("website")} placeholder="https://example.com" />
          </div>
        </div>

        <h3 class="settings-group-heading">Address</h3>
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="cp-address1">Address Line 1</label>
            <input id="cp-address1" type="text" value={form.address_line1} onInput={set("address_line1")} />
          </div>
          <div class="form-group full-width">
            <label for="cp-address2">Address Line 2</label>
            <input id="cp-address2" type="text" value={form.address_line2} onInput={set("address_line2")} />
          </div>
          <div class="form-group">
            <label for="cp-city">City</label>
            <input id="cp-city" type="text" value={form.city} onInput={set("city")} />
          </div>
          <div class="form-group">
            <label for="cp-state">Province / State</label>
            <input id="cp-state" type="text" value={form.state} onInput={set("state")} />
          </div>
          <div class="form-group">
            <label for="cp-postal">Postal / ZIP Code</label>
            <input id="cp-postal" type="text" value={form.postal_code} onInput={set("postal_code")} />
          </div>
          <div class="form-group">
            <label for="cp-country">Country</label>
            <input id="cp-country" type="text" value={form.country} onInput={set("country")} />
          </div>
        </div>

        <h3 class="settings-group-heading">Business IDs</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="cp-business-number">Business Number</label>
            <input id="cp-business-number" type="text" value={form.business_number} onInput={set("business_number")} placeholder="123456789BC0001" />
          </div>
          <div class="form-group">
            <label for="cp-tax-number">Tax Number</label>
            <input id="cp-tax-number" type="text" value={form.tax_number} onInput={set("tax_number")} placeholder="123456789RT0001" />
            <p class="text-muted" style={{ fontSize: 11 }}>GST/HST registration number, if different from your Business Number.</p>
          </div>
        </div>

        <h3 class="settings-group-heading">Contract Footer</h3>
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="cp-footer">Default Contract Footer</label>
            <textarea id="cp-footer" rows={3} value={form.contract_footer} onInput={set("contract_footer")} placeholder="Thank you for your business." />
            <p class="text-muted" style={{ fontSize: 11 }}>Plain text only — printed on every page of the signed Contract PDF.</p>
          </div>
        </div>

        <div class="modal-footer" style={{ paddingLeft: 0, paddingRight: 0 }}>
          {saved && <span class="text-muted" style={{ marginRight: "auto", color: "var(--color-success, green)" }}>Saved</span>}
          <button type="submit" class="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
