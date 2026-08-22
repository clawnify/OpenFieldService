import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useReferenceData } from "../reference-data";
import { ConfirmDialog } from "./confirm-dialog";
import { Plus, Edit3, Trash2, X, Save } from "lucide-preact";
import type { Asset } from "../types";

const emptyForm = {
  asset_type: "", display_name: "", manufacturer: "", model: "",
  serial_number: "", installation_date: "", status: "active" as string, notes: "",
};

const ASSET_STATUS_COLORS: Record<string, string> = {
  active: "#16a34a",
  inactive: "#6b7280",
  retired: "#9ca3af",
};

function AssetStatusBadge({ status }: { status: string }) {
  const color = ASSET_STATUS_COLORS[status] || "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

/**
 * Phase 11.4 — Customer's Equipment (Core term "Asset"; UI says "Equipment"
 * for HVAC users). Self-contained (own fetch/state), same precedent as
 * NotificationPreferences rather than threading Asset state through the
 * large AppContext/use-app.ts hub.
 *
 * `role` gates rendering client-side only (UX convenience, matching every
 * other role-hidden control in this app) — the server independently
 * enforces canManageAssets() on every read/write regardless of what this
 * component does.
 */
export function CustomerAssets({ customerId, role }: { customerId: number; role: string | undefined }) {
  const { assetTypes } = useReferenceData();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [savingEdit, setSavingEdit] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<{ assets: Asset[]; total: number }>("GET", `/api/assets?customer_id=${customerId}`);
      setAssets(res.assets);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  // Same "gate the fetch itself, not just the render" fix Phase 9.5 applied
  // to NotificationPreferences — a technician always renders null a few
  // lines below, so never fire the doomed GET in the first place.
  useEffect(() => { if (role !== "technician") load(); }, [load, role]);

  if (role === "technician") return null;

  const typeLabel = (key: string) => assetTypes.find((t) => t.key === key)?.label || key || "—";

  const startAdd = () => {
    setMutationError(null);
    setAddForm(emptyForm);
    setShowAddForm(true);
  };

  const confirmAdd = async () => {
    setAdding(true);
    setMutationError(null);
    try {
      await api("POST", "/api/assets", {
        customer_id: customerId,
        asset_type: addForm.asset_type || undefined,
        display_name: addForm.display_name,
        manufacturer: addForm.manufacturer,
        model: addForm.model,
        serial_number: addForm.serial_number,
        installation_date: addForm.installation_date || null,
        notes: addForm.notes,
      });
      setShowAddForm(false);
      await load();
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (asset: Asset) => {
    setMutationError(null);
    setEditForm({
      asset_type: asset.asset_type, display_name: asset.display_name, manufacturer: asset.manufacturer,
      model: asset.model, serial_number: asset.serial_number, installation_date: asset.installation_date || "",
      status: asset.status, notes: asset.notes,
    });
    setEditingId(asset.id);
  };

  const confirmEdit = async () => {
    if (editingId === null) return;
    setSavingEdit(true);
    setMutationError(null);
    try {
      await api("PUT", `/api/assets/${editingId}`, {
        asset_type: editForm.asset_type || undefined,
        display_name: editForm.display_name,
        manufacturer: editForm.manufacturer,
        model: editForm.model,
        serial_number: editForm.serial_number,
        installation_date: editForm.installation_date || null,
        status: editForm.status,
        notes: editForm.notes,
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setMutationError((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = async () => {
    if (pendingDeleteId === null) return;
    setDeleting(true);
    setMutationError(null);
    try {
      await api("DELETE", `/api/assets/${pendingDeleteId}`);
      setPendingDeleteId(null);
      await load();
    } catch (err) {
      // A 409 here means the asset is still linked to a job — surface the
      // server's own explanation (retire instead of delete) rather than a
      // generic failure message.
      setMutationError((err as Error).message);
      setPendingDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="detail-section customer-assets">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3>Equipment ({assets.length})</h3>
        {!showAddForm && (
          <button class="btn btn-sm" onClick={startAdd}><Plus size={14} /> Add Equipment</button>
        )}
      </div>

      {mutationError && <div class="inline-error" style={{ marginBottom: 10 }}>{mutationError}</div>}

      {showAddForm && (
        <div class="card" style={{ padding: 12, marginBottom: 12 }}>
          <div class="form-grid">
            <div class="form-group">
              <label>Type</label>
              <select value={addForm.asset_type} onChange={(e) => setAddForm({ ...addForm, asset_type: (e.target as HTMLSelectElement).value })}>
                <option value="">Select...</option>
                {assetTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div class="form-group">
              <label>Display Name</label>
              <input type="text" value={addForm.display_name} onInput={(e) => setAddForm({ ...addForm, display_name: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="form-group">
              <label>Manufacturer</label>
              <input type="text" value={addForm.manufacturer} onInput={(e) => setAddForm({ ...addForm, manufacturer: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="form-group">
              <label>Model</label>
              <input type="text" value={addForm.model} onInput={(e) => setAddForm({ ...addForm, model: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="form-group">
              <label>Serial Number</label>
              <input type="text" value={addForm.serial_number} onInput={(e) => setAddForm({ ...addForm, serial_number: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="form-group">
              <label>Installation Date</label>
              <input type="date" value={addForm.installation_date} onChange={(e) => setAddForm({ ...addForm, installation_date: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="form-group full-width">
              <label>Notes</label>
              <textarea rows={2} value={addForm.notes} onInput={(e) => setAddForm({ ...addForm, notes: (e.target as HTMLTextAreaElement).value })} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button class="btn btn-sm" onClick={() => setShowAddForm(false)} disabled={adding}>Cancel</button>
            <button class="btn btn-sm btn-primary" onClick={confirmAdd} disabled={adding}>
              {adding ? "Adding..." : "Add Equipment"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p class="text-muted">Loading...</p>
      ) : loadError ? (
        <div class="inline-error">{loadError}</div>
      ) : assets.length === 0 ? (
        <p class="text-muted">No equipment on file yet</p>
      ) : (
        <div class="card">
          <table class="table">
            <thead>
              <tr><th>Type</th><th>Name</th><th>Manufacturer / Model</th><th>Serial</th><th>Installed</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {assets.map((a) => editingId === a.id ? (
                <tr key={a.id} class="table-row">
                  <td colSpan={7}>
                    <div class="form-grid">
                      <div class="form-group">
                        <label>Type</label>
                        <select value={editForm.asset_type} onChange={(e) => setEditForm({ ...editForm, asset_type: (e.target as HTMLSelectElement).value })}>
                          <option value="">Select...</option>
                          {assetTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                        </select>
                      </div>
                      <div class="form-group">
                        <label>Display Name</label>
                        <input type="text" value={editForm.display_name} onInput={(e) => setEditForm({ ...editForm, display_name: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label>Manufacturer</label>
                        <input type="text" value={editForm.manufacturer} onInput={(e) => setEditForm({ ...editForm, manufacturer: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label>Model</label>
                        <input type="text" value={editForm.model} onInput={(e) => setEditForm({ ...editForm, model: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label>Serial Number</label>
                        <input type="text" value={editForm.serial_number} onInput={(e) => setEditForm({ ...editForm, serial_number: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label>Installation Date</label>
                        <input type="date" value={editForm.installation_date} onChange={(e) => setEditForm({ ...editForm, installation_date: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label>Status</label>
                        <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: (e.target as HTMLSelectElement).value })}>
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                          <option value="retired">Retired</option>
                        </select>
                      </div>
                      <div class="form-group full-width">
                        <label>Notes</label>
                        <textarea rows={2} value={editForm.notes} onInput={(e) => setEditForm({ ...editForm, notes: (e.target as HTMLTextAreaElement).value })} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button class="btn btn-sm" onClick={() => setEditingId(null)} disabled={savingEdit}><X size={14} /> Cancel</button>
                      <button class="btn btn-sm btn-primary" onClick={confirmEdit} disabled={savingEdit}>
                        <Save size={14} /> {savingEdit ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={a.id} class="table-row">
                  <td>{typeLabel(a.asset_type)}</td>
                  <td>{a.display_name || "—"}</td>
                  <td>{[a.manufacturer, a.model].filter(Boolean).join(" / ") || "—"}</td>
                  <td>{a.serial_number || "—"}</td>
                  <td>{a.installation_date || "—"}</td>
                  <td><AssetStatusBadge status={a.status} /></td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button class="btn-icon" aria-label={`Edit ${a.display_name || typeLabel(a.asset_type)}`} onClick={() => startEdit(a)}>
                        <Edit3 size={14} />
                      </button>
                      <button class="btn-icon danger" aria-label={`Delete ${a.display_name || typeLabel(a.asset_type)}`} onClick={() => setPendingDeleteId(a.id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingDeleteId !== null && (
        <ConfirmDialog
          title="Delete this equipment record?"
          message="This equipment record will be permanently deleted. If it's linked to any job, deletion will be refused — retire it instead by editing its Status."
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={confirmDelete}
          onClose={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
}
