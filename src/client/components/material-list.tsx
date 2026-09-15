import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus, Trash2, Edit3 } from "lucide-preact";

export function MaterialList() {
  const { materials, addMaterial, updateMaterial, deleteMaterial, isAgent, setError } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", unit: "", unit_cost: 0, in_stock: 0 });
  const [newForm, setNewForm] = useState({ name: "", unit: "ea", unit_cost: 0, in_stock: 0 });

  const startEdit = (m: typeof materials[0]) => {
    setEditForm({ name: m.name, unit: m.unit, unit_cost: m.unit_cost, in_stock: m.in_stock });
    setEditingId(m.id);
  };

  const saveEdit = async (id: string) => {
    await updateMaterial(id, editForm);
    setEditingId(null);
  };

  const handleCreate = async () => {
    if (!newForm.name.trim()) { setError("Name is required"); return; }
    await addMaterial(newForm);
    setNewForm({ name: "", unit: "ea", unit_cost: 0, in_stock: 0 });
    setShowCreate(false);
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Materials & Inventory</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Add Material
        </button>
      </div>

      <div class="table-scroll">
        {materials.length === 0 && !showCreate ? (
          <div class="empty-state">
            <p>No materials yet</p>
            <button class="btn" onClick={() => setShowCreate(true)}>
              Add your first material
            </button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Unit</th>
                <th>Unit Cost</th>
                <th>In Stock</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {showCreate && (
                <tr class="table-row">
                  <td><input type="text" value={newForm.name} onInput={(e) => setNewForm({ ...newForm, name: (e.target as HTMLInputElement).value })} class="inline-input" placeholder="Material name" /></td>
                  <td><input type="text" value={newForm.unit} onInput={(e) => setNewForm({ ...newForm, unit: (e.target as HTMLInputElement).value })} class="inline-input" style={{ width: 60 }} /></td>
                  <td><input type="number" step="0.01" value={newForm.unit_cost} onInput={(e) => setNewForm({ ...newForm, unit_cost: parseFloat((e.target as HTMLInputElement).value) || 0 })} class="inline-input" style={{ width: 90 }} /></td>
                  <td><input type="number" value={newForm.in_stock} onInput={(e) => setNewForm({ ...newForm, in_stock: parseFloat((e.target as HTMLInputElement).value) || 0 })} class="inline-input" style={{ width: 80 }} /></td>
                  <td>
                    <div class="action-btns">
                      <button class="btn btn-sm" onClick={handleCreate}>Add</button>
                      <button class="btn btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
                    </div>
                  </td>
                </tr>
              )}
              {materials.map((m) => (
                <tr key={m.id} class="table-row">
                  {editingId === m.id ? (
                    <>
                      <td><input type="text" value={editForm.name} onInput={(e) => setEditForm({ ...editForm, name: (e.target as HTMLInputElement).value })} class="inline-input" /></td>
                      <td><input type="text" value={editForm.unit} onInput={(e) => setEditForm({ ...editForm, unit: (e.target as HTMLInputElement).value })} class="inline-input" style={{ width: 60 }} /></td>
                      <td><input type="number" step="0.01" value={editForm.unit_cost} onInput={(e) => setEditForm({ ...editForm, unit_cost: parseFloat((e.target as HTMLInputElement).value) || 0 })} class="inline-input" style={{ width: 90 }} /></td>
                      <td><input type="number" value={editForm.in_stock} onInput={(e) => setEditForm({ ...editForm, in_stock: parseFloat((e.target as HTMLInputElement).value) || 0 })} class="inline-input" style={{ width: 80 }} /></td>
                      <td>
                        <div class="action-btns">
                          <button class="btn btn-sm" onClick={() => saveEdit(m.id)}>Save</button>
                          <button class="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td class="text-bold">{m.name}</td>
                      <td class="text-muted">{m.unit}</td>
                      <td>${m.unit_cost.toFixed(2)}</td>
                      <td>{m.in_stock}</td>
                      <td>
                        <div class="action-btns">
                          <button class="btn-icon" onClick={() => startEdit(m)}><Edit3 size={14} /></button>
                          {isAgent && (
                            <button class="btn-icon danger" onClick={() => deleteMaterial(m.id)}><Trash2 size={14} /></button>
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
    </div>
  );
}
