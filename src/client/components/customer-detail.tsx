import { useState } from "preact/hooks";
import { useApp } from "../context";
import { CustomerEquipment } from "./customer-equipment";
import { StatusBadge } from "./status-badge";
import { ArrowLeft, Trash2, Edit3, Save, X } from "lucide-preact";

export function CustomerDetail() {
  const { selectedCustomer: customer, selectedCustomerJobs: jobs, navigate, updateCustomer, deleteCustomer, setError } = useApp();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", city: "", state: "", zip: "", notes: "" });

  if (!customer) return null;

  const startEdit = () => {
    setForm({
      name: customer.name, email: customer.email, phone: customer.phone,
      address: customer.address, city: customer.city, state: customer.state,
      zip: customer.zip, notes: customer.notes,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    await updateCustomer(customer.id, form);
    setEditing(false);
  };

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
              <button class="btn" onClick={saveEdit}><Save size={14} /> Save</button>
            </>
          ) : (
            <>
              <button class="btn" onClick={startEdit}><Edit3 size={14} /> Edit</button>
              <button class="btn btn-danger" onClick={() => deleteCustomer(customer.id).catch((err) => setError(err.message))}><Trash2 size={14} /> Delete</button>
            </>
          )}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          {editing ? (
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
              <div class="form-group full-width">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onInput={(e) => setForm({ ...form, notes: (e.target as HTMLTextAreaElement).value })} />
              </div>
            </div>
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
              </div>
              {customer.notes && (
                <div class="detail-section">
                  <h3>Notes</h3>
                  <p class="detail-notes">{customer.notes}</p>
                </div>
              )}
            </>
          )}

          <CustomerEquipment key={customer.id} customerId={customer.id} />

          <div class="detail-section">
            <h3>Service History ({jobs.length})</h3>
            {jobs.length === 0 ? (
              <p class="text-muted">No jobs yet</p>
            ) : (
              <div class="table-scroll">
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
        </div>
      </div>
    </div>
  );
}
