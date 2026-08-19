import { useState } from "preact/hooks";
import { useApp } from "../context";
import { CreateTechnician } from "./create-technician";
import { ConfirmDialog } from "./confirm-dialog";
import { Plus, Trash2, Edit3 } from "lucide-preact";

export function TechnicianList() {
  const { technicians, updateTechnician, deleteTechnician, isAgent, setError } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", phone: "", color: "" });
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const startEdit = (t: typeof technicians[0]) => {
    setEditForm({ name: t.name, email: t.email, phone: t.phone, color: t.color });
    setEditingId(t.id);
  };

  const saveEdit = async (id: number) => {
    await updateTechnician(id, editForm);
    setEditingId(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteTechnician(pendingDelete.id);
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
        <h1>Technicians</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Add Technician
        </button>
      </div>

      <div class="card">
        {technicians.length === 0 ? (
          <div class="empty-state">
            <p>No technicians yet</p>
            <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
              Add your first technician
            </button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Color</th>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Active Jobs</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {technicians.map((t) => (
                <tr key={t.id} class="table-row">
                  {editingId === t.id ? (
                    <>
                      <td>
                        <input type="color" value={editForm.color} onChange={(e) => setEditForm({ ...editForm, color: (e.target as HTMLInputElement).value })} style={{ width: 32, height: 24 }} />
                      </td>
                      <td><input type="text" value={editForm.name} onInput={(e) => setEditForm({ ...editForm, name: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td><input type="email" value={editForm.email} onInput={(e) => setEditForm({ ...editForm, email: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td><input type="tel" value={editForm.phone} onInput={(e) => setEditForm({ ...editForm, phone: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td>{t.job_count || 0}</td>
                      <td>
                        <span class={`status-badge-sm ${t.active ? "active" : "inactive"}`}>
                          {t.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <div class="action-btns">
                          <button class="btn btn-sm btn-primary" onClick={() => saveEdit(t.id)}>Save</button>
                          <button class="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td><span class="color-swatch" style={{ background: t.color }} /></td>
                      <td class="text-bold">{t.name}</td>
                      <td class="text-muted">{t.email || "—"}</td>
                      <td class="text-muted">{t.phone || "—"}</td>
                      <td>{t.job_count || 0}</td>
                      <td>
                        <button
                          class={`status-badge-sm clickable ${t.active ? "active" : "inactive"}`}
                          onClick={() => updateTechnician(t.id, { active: t.active ? 0 : 1 })}
                        >
                          {t.active ? "Active" : "Inactive"}
                        </button>
                      </td>
                      <td>
                        <div class="action-btns">
                          <button class="btn-icon" onClick={() => startEdit(t)}><Edit3 size={14} /></button>
                          {isAgent && (
                            <button class="btn-icon danger" onClick={() => setPendingDelete({ id: t.id, name: t.name })}><Trash2 size={14} /></button>
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

      {showCreate && <CreateTechnician onClose={() => setShowCreate(false)} />}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this technician?"
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
