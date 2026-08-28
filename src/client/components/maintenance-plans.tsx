import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { Plus, X } from "lucide-preact";
import type { MaintenancePlan } from "../types";

/**
 * Phase 19B — Admin-only Maintenance Plan catalog. Self-contained (own
 * local fetch/state), same precedent as pricebook-list.tsx/contract-
 * list.tsx: not part of the app-wide initial-load Promise.all.
 */

const EMPTY_FORM = {
  code: "", name: "", description: "", tier: "STANDARD", price: "0.00", taxable: true,
  visit_entitlement_count: "", frequency_description: "", priority_benefit: "",
  included_services: "", other_benefits: "",
};

export function MaintenancePlans() {
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ plans: MaintenancePlan[] }>("GET", "/api/maintenance/plans?include_inactive=true");
      setPlans(data.plans);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(EMPTY_FORM); setShowForm(true); };
  const openEdit = (p: MaintenancePlan) => {
    setEditingId(p.id);
    setForm({
      code: p.code, name: p.name, description: p.description, tier: p.tier,
      price: (p.price_cents / 100).toFixed(2), taxable: !!p.taxable,
      visit_entitlement_count: p.visit_entitlement_count == null ? "" : String(p.visit_entitlement_count),
      frequency_description: p.frequency_description, priority_benefit: p.priority_benefit,
      included_services: JSON.parse(p.included_services || "[]").join(", "),
      other_benefits: JSON.parse(p.other_benefits || "[]").join(", "),
    });
    setShowForm(true);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const priceCents = Math.round(parseFloat(form.price || "0") * 100);
      const payload = {
        code: form.code.trim(), name: form.name.trim(), description: form.description, tier: form.tier,
        price_cents: Number.isFinite(priceCents) ? priceCents : 0, taxable: form.taxable,
        visit_entitlement_count: form.visit_entitlement_count.trim() === "" ? null : Number(form.visit_entitlement_count),
        frequency_description: form.frequency_description, priority_benefit: form.priority_benefit,
        included_services: form.included_services.split(",").map((s) => s.trim()).filter(Boolean),
        other_benefits: form.other_benefits.split(",").map((s) => s.trim()).filter(Boolean),
      };
      if (editingId) {
        await api("PUT", `/api/maintenance/plans/${editingId}`, payload);
      } else {
        await api("POST", "/api/maintenance/plans", payload);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (p: MaintenancePlan) => {
    await api("PUT", `/api/maintenance/plans/${p.id}`, { active: !p.active });
    await load();
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Maintenance Plans</h1>
        <button class="btn btn-primary" onClick={openCreate}><Plus size={16} /> New Plan</button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : plans.length === 0 ? (
          <div class="empty-state"><p>No maintenance plans yet</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Tier</th><th>Price</th><th>Visits</th><th>Active</th><th></th></tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} class="table-row">
                    <td><span class="identifier">{p.code}</span></td>
                    <td class="text-bold">{p.name}</td>
                    <td>{p.tier}</td>
                    <td>{formatCents(p.price_cents)}</td>
                    <td>{p.visit_entitlement_count == null ? "Unlimited" : p.visit_entitlement_count}</td>
                    <td>{p.active ? "Yes" : "No"}</td>
                    <td>
                      <button class="btn btn-sm" onClick={() => openEdit(p)}>Edit</button>{" "}
                      <button class="btn btn-sm" onClick={() => toggleActive(p)}>{p.active ? "Deactivate" : "Activate"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div class="modal-overlay" onClick={() => setShowForm(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingId ? "Edit Plan" : "New Plan"}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowForm(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              <div class="form-row">
                <div class="form-group">
                  <label for="mp-code">Code</label>
                  <input id="mp-code" type="text" value={form.code} onInput={(e) => setForm({ ...form, code: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label for="mp-tier">Tier</label>
                  <select id="mp-tier" value={form.tier} onChange={(e) => setForm({ ...form, tier: (e.target as HTMLSelectElement).value })}>
                    <option value="BASIC">Basic</option>
                    <option value="STANDARD">Standard</option>
                    <option value="PREMIUM">Premium</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label for="mp-name">Name</label>
                <input id="mp-name" type="text" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="form-group">
                <label for="mp-description">Description</label>
                <textarea id="mp-description" rows={2} value={form.description} onInput={(e) => setForm({ ...form, description: (e.target as HTMLTextAreaElement).value })} />
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label for="mp-price">Price</label>
                  <input id="mp-price" type="text" inputMode="decimal" value={form.price} onInput={(e) => setForm({ ...form, price: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group">
                  <label for="mp-visits">Included Visits (blank = unlimited)</label>
                  <input id="mp-visits" type="text" inputMode="numeric" value={form.visit_entitlement_count} onInput={(e) => setForm({ ...form, visit_entitlement_count: (e.target as HTMLInputElement).value })} />
                </div>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" checked={form.taxable} onChange={(e) => setForm({ ...form, taxable: (e.target as HTMLInputElement).checked })} />
                Taxable
              </label>
              <div class="form-group">
                <label for="mp-frequency">Visit Frequency</label>
                <input id="mp-frequency" type="text" value={form.frequency_description} onInput={(e) => setForm({ ...form, frequency_description: (e.target as HTMLInputElement).value })} placeholder="e.g. Twice yearly" />
              </div>
              <div class="form-group">
                <label for="mp-priority">Priority Benefit</label>
                <input id="mp-priority" type="text" value={form.priority_benefit} onInput={(e) => setForm({ ...form, priority_benefit: (e.target as HTMLInputElement).value })} placeholder="e.g. Priority scheduling" />
              </div>
              <div class="form-group">
                <label for="mp-included">Included Services (comma-separated)</label>
                <input id="mp-included" type="text" value={form.included_services} onInput={(e) => setForm({ ...form, included_services: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="form-group">
                <label for="mp-benefits">Other Benefits (comma-separated)</label>
                <input id="mp-benefits" type="text" value={form.other_benefits} onInput={(e) => setForm({ ...form, other_benefits: (e.target as HTMLInputElement).value })} />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={saving || !form.code.trim() || !form.name.trim()} onClick={submit}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
