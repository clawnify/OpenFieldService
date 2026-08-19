import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { useReferenceData } from "../reference-data";
import { ConfirmDialog } from "./confirm-dialog";
import { CustomerSearchSelect } from "./customer-search-select";
import { StatusBadge } from "./status-badge";
import { NotificationPreferences } from "./notification-preferences";
import { NotificationHistory } from "./notification-history";
import { ArrowLeft, Trash2, Edit3, Save, X } from "lucide-preact";

const emptyForm = {
  name: "", email: "", phone: "", address: "", city: "", state: "", zip: "", notes: "",
  referral_source: "", referral_name: "", referred_by_customer_id: null as number | null,
  house_size: "", primary_heating_source: "",
  number_of_adults: "", number_of_children: "", household_income: "",
};

export function CustomerDetail() {
  const { selectedCustomer: customer, selectedCustomerJobs: jobs, navigate, updateCustomer, deleteCustomer, setError } = useApp();
  const { user } = useAuth();
  const { referralSources, heatingSources } = useReferenceData();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [referredByLabel, setReferredByLabel] = useState("");
  const [pendingSave, setPendingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!customer) return null;

  const startEdit = () => {
    setForm({
      name: customer.name, email: customer.email, phone: customer.phone,
      address: customer.address, city: customer.city, state: customer.state,
      zip: customer.zip, notes: customer.notes,
      referral_source: customer.referral_source,
      referral_name: customer.referral_name,
      referred_by_customer_id: customer.referred_by_customer_id,
      house_size: customer.house_size?.toString() || "",
      primary_heating_source: customer.primary_heating_source,
      number_of_adults: customer.number_of_adults?.toString() || "",
      number_of_children: customer.number_of_children?.toString() || "",
      household_income: customer.household_income?.toString() || "",
    });
    setReferredByLabel(customer.referred_by_customer_name || "");
    setEditing(true);
  };

  const handleReferralSourceChange = (value: string) => {
    // Same "clear the now-invalid conditional field on change" rule as
    // create-customer.tsx — the server independently enforces this too
    // (src/server/customers.ts), this just keeps the UI from showing/
    // submitting a stale value for a since-changed source.
    setForm((f) => ({
      ...f,
      referral_source: value,
      referral_name: value === "Referral" ? f.referral_name : "",
      referred_by_customer_id: value === "Existing Customer" ? f.referred_by_customer_id : null,
    }));
    if (value !== "Existing Customer") setReferredByLabel("");
  };

  const requestSave = () => {
    if (form.referral_source === "Referral" && !form.referral_name.trim()) {
      setError("Referral Name is required");
      return;
    }
    if (form.referral_source === "Existing Customer" && form.referred_by_customer_id === null) {
      setError("Select the customer who made the referral");
      return;
    }
    setPendingSave(true);
  };

  const confirmSave = async () => {
    setSaving(true);
    try {
      await updateCustomer(customer.id, {
        name: form.name, email: form.email, phone: form.phone, address: form.address,
        city: form.city, state: form.state, zip: form.zip, notes: form.notes,
        referral_source: form.referral_source,
        referral_name: form.referral_name,
        referred_by_customer_id: form.referred_by_customer_id,
        house_size: form.house_size ? parseInt(form.house_size, 10) : null,
        primary_heating_source: form.primary_heating_source,
        number_of_adults: form.number_of_adults ? parseInt(form.number_of_adults, 10) : null,
        number_of_children: form.number_of_children ? parseInt(form.number_of_children, 10) : null,
        household_income: form.household_income ? parseFloat(form.household_income) : null,
      });
      setEditing(false);
      setPendingSave(false);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteCustomer(customer.id);
    } finally {
      setDeleting(false);
    }
  };

  const hasRebateProfile = customer.house_size !== null || customer.household_income !== null
    || customer.number_of_adults !== null || customer.number_of_children !== null || customer.primary_heating_source;

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/customers")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          {editing ? (
            <>
              <button class="btn" onClick={() => setEditing(false)}><X size={14} /> Cancel</button>
              <button class="btn btn-primary" onClick={requestSave}><Save size={14} /> Save</button>
            </>
          ) : (
            <>
              <button class="btn" onClick={startEdit}><Edit3 size={14} /> Edit</button>
              <button class="btn btn-danger" onClick={() => setPendingDelete(true)}><Trash2 size={14} /> Delete</button>
            </>
          )}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          {editing ? (
            <>
              <div class="form-grid">
                <div class="form-group full-width">
                  <label>Name</label>
                  <input type="text" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Email</label>
                  <input type="email" value={form.email} onInput={(e) => setForm({ ...form, email: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Phone</label>
                  <input type="tel" value={form.phone} onInput={(e) => setForm({ ...form, phone: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group full-width">
                  <label>Address</label>
                  <input type="text" value={form.address} onInput={(e) => setForm({ ...form, address: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>City</label>
                  <input type="text" value={form.city} onInput={(e) => setForm({ ...form, city: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>State</label>
                  <input type="text" value={form.state} onInput={(e) => setForm({ ...form, state: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>ZIP</label>
                  <input type="text" value={form.zip} onInput={(e) => setForm({ ...form, zip: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label>Referral Source</label>
                  <select value={form.referral_source} onChange={(e) => handleReferralSourceChange((e.target as HTMLSelectElement).value)}>
                    <option value="">Select...</option>
                    {referralSources.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {form.referral_source === "Referral" && (
                  <div class="form-group full-width">
                    <label>Referral Name *</label>
                    <input
                      type="text" value={form.referral_name}
                      onInput={(e) => setForm({ ...form, referral_name: (e.target as HTMLInputElement).value })}
                      placeholder="Jane Smith" required
                    />
                  </div>
                )}
                {form.referral_source === "Existing Customer" && (
                  <div class="form-group full-width">
                    <label>Referred By Customer *</label>
                    <CustomerSearchSelect
                      value={form.referred_by_customer_id}
                      valueLabel={referredByLabel}
                      excludeId={customer.id}
                      onChange={(id, label) => { setForm({ ...form, referred_by_customer_id: id }); setReferredByLabel(label); }}
                    />
                  </div>
                )}
                <div class="form-group full-width">
                  <label>Notes</label>
                  <textarea rows={3} value={form.notes} onInput={(e) => setForm({ ...form, notes: (e.target as HTMLTextAreaElement).value })} />
                </div>
              </div>

              <div class="detail-section">
                <h3>Rebate Program Profile</h3>
                <div class="form-grid">
                  <div class="form-group">
                    <label>House Size (sq ft)</label>
                    <input type="number" min="0" value={form.house_size} onInput={(e) => setForm({ ...form, house_size: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Primary Heating Source</label>
                    <select value={form.primary_heating_source} onChange={(e) => setForm({ ...form, primary_heating_source: (e.target as HTMLSelectElement).value })}>
                      <option value="">Select...</option>
                      {heatingSources.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Number of Adults</label>
                    <input type="number" min="0" value={form.number_of_adults} onInput={(e) => setForm({ ...form, number_of_adults: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Number of Children (&lt;18)</label>
                    <input type="number" min="0" value={form.number_of_children} onInput={(e) => setForm({ ...form, number_of_children: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div class="form-group">
                    <label>Household Income Level ($/yr)</label>
                    <input type="number" min="0" value={form.household_income} onInput={(e) => setForm({ ...form, household_income: (e.target as HTMLInputElement).value })} />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <h2 class="detail-customer-name">{customer.name}</h2>
              <div class="detail-meta-grid">
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Phone</span>
                  <span>{customer.phone || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Email</span>
                  <span>{customer.email || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Address</span>
                  <span>{[customer.address, customer.city, customer.state, customer.zip].filter(Boolean).join(", ") || "—"}</span>
                </div>
                <div class="detail-meta-item">
                  <span class="detail-meta-label">Referral Source</span>
                  <span>{customer.referral_source || "—"}</span>
                </div>
                {customer.referral_source === "Referral" && customer.referral_name && (
                  <div class="detail-meta-item">
                    <span class="detail-meta-label">Referral Name</span>
                    <span>{customer.referral_name}</span>
                  </div>
                )}
                {customer.referral_source === "Existing Customer" && customer.referred_by_customer_name && (
                  <div class="detail-meta-item">
                    <span class="detail-meta-label">Referred By</span>
                    <span
                      class="link"
                      onClick={() => customer.referred_by_customer_id && navigate(`/customers/${customer.referred_by_customer_id}`)}
                    >
                      {customer.referred_by_customer_name}
                    </span>
                  </div>
                )}
              </div>
              {customer.notes && (
                <div class="detail-section">
                  <h3>Notes</h3>
                  <p class="detail-notes">{customer.notes}</p>
                </div>
              )}
              {hasRebateProfile && (
                <div class="detail-section">
                  <h3>Rebate Program Profile</h3>
                  <div class="detail-meta-grid">
                    <div class="detail-meta-item">
                      <span class="detail-meta-label">House Size</span>
                      <span>{customer.house_size ? `${customer.house_size} sq ft` : "—"}</span>
                    </div>
                    <div class="detail-meta-item">
                      <span class="detail-meta-label">Heating Source</span>
                      <span>{customer.primary_heating_source || "—"}</span>
                    </div>
                    <div class="detail-meta-item">
                      <span class="detail-meta-label">Household</span>
                      <span>
                        {customer.number_of_adults ?? "—"} adult(s), {customer.number_of_children ?? "—"} child(ren)
                      </span>
                    </div>
                    <div class="detail-meta-item">
                      <span class="detail-meta-label">Household Income</span>
                      <span>{customer.household_income !== null ? `$${customer.household_income.toLocaleString()}/yr` : "—"}</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          <div class="detail-section">
            <h3>Service History ({jobs.length})</h3>
            {jobs.length === 0 ? (
              <p class="text-muted">No jobs yet</p>
            ) : (
              <div class="card">
                <table class="table">
                  <thead>
                    <tr><th>ID</th><th>Date</th><th>Service</th><th>Technician</th><th>Status</th><th>Price</th></tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id} class="table-row clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                        <td><span class="identifier">{j.identifier}</span></td>
                        <td>{j.scheduled_date}</td>
                        <td>{j.service_type_name || "—"}</td>
                        <td>{j.technician_name || "Unassigned"}</td>
                        <td><StatusBadge status={j.status} /></td>
                        <td class="text-right">${j.price.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <NotificationHistory entityType="customer" entityId={customer.id} role={user?.role} />
        </div>

        <div class="detail-sidebar">
          <NotificationPreferences recipientType="customer" recipientId={customer.id} role={user?.role} />
        </div>
      </div>

      {pendingSave && (
        <ConfirmDialog
          title="Save changes?"
          message={`Save changes to "${form.name}"?`}
          confirmLabel="Save"
          submitting={saving}
          onConfirm={confirmSave}
          onClose={() => setPendingSave(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this customer?"
          message={`"${customer.name}" and their service history reference will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}
    </div>
  );
}
