import { useState } from "preact/hooks";
import { useApp } from "../context";
import { CreateServiceType } from "./create-service-type";
import { ConfirmDialog } from "./confirm-dialog";
import { Plus, Trash2, Edit3 } from "lucide-preact";

export function ServiceTypeList() {
  const { serviceTypes, updateServiceType, deleteServiceType, isAgent, setError } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "", default_duration: 60, default_price: 0, color: "#6b7280" });
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const startEdit = (s: typeof serviceTypes[0]) => {
    setEditForm({
      name: s.name,
      description: s.description,
      default_duration: s.default_duration,
      default_price: s.default_price,
      color: s.color,
    });
    setEditingId(s.id);
  };

  const saveEdit = async (id: number) => {
    await updateServiceType(id, editForm);
    setEditingId(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteServiceType(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Service Types</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Add Service Type
        </button>
      </div>

      <div class="card">
        {serviceTypes.length === 0 ? (
          <div class="empty-state">
            <p>No service types yet</p>
            <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
              Add your first service type
            </button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Color</th>
                <th>Name</th>
                <th>Description</th>
                <th>Duration</th>
                <th>Default Price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {serviceTypes.map((s) => (
                <tr key={s.id} class="table-row">
                  {editingId === s.id ? (
                    <>
                      <td>
                        <input type="color" value={editForm.color} onChange={(e) => setEditForm({ ...editForm, color: (e.target as HTMLInputElement).value })} style={{ width: 32, height: 24 }} />
                      </td>
                      <td><input type="text" value={editForm.name} onInput={(e) => setEditForm({ ...editForm, name: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td><input type="text" value={editForm.description} onInput={(e) => setEditForm({ ...editForm, description: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td><input type="number" value={editForm.default_duration} onInput={(e) => setEditForm({ ...editForm, default_duration: parseInt((e.target as HTMLInputElement).value, 10) || 0 })} class="inline-input" style={{ width: 80 }} /></td>
                      <td><input type="number" step="0.01" value={editForm.default_price} onInput={(e) => setEditForm({ ...editForm, default_price: parseFloat((e.target as HTMLInputElement).value) || 0 })} class="inline-input" style={{ width: 100 }} /></td>
                      <td>
                        <div class="action-btns">
                          <button class="btn btn-sm btn-primary" onClick={() => saveEdit(s.id)}>Save</button>
                          <button class="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td><span class="color-swatch" style={{ background: s.color }} /></td>
                      <td class="text-bold">{s.name}</td>
                      <td class="text-muted">{s.description || "—"}</td>
                      <td>{s.default_duration} min</td>
                      <td>${s.default_price.toFixed(2)}</td>
                      <td>
                        <div class="action-btns">
                          <button class="btn-icon" onClick={() => startEdit(s)}><Edit3 size={14} /></button>
                          {isAgent && (
                            <button class="btn-icon danger" onClick={() => setPendingDelete({ id: s.id, name: s.name })}><Trash2 size={14} /></button>
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && <CreateServiceType onClose={() => setShowCreate(false)} />}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this service type?"
          message={`This permanently deletes ${pendingDelete.name}. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={handleConfirmDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
