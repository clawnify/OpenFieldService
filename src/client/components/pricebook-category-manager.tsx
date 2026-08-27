import { useState } from "preact/hooks";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { X, Plus, Edit3, Trash2 } from "lucide-preact";
import type { PricebookCategory } from "../types";

const emptyDraft = { name: "", description: "" };

/**
 * Phase 17 — Pricebook category management. Admin-only (gated by its sole
 * caller, PricebookList, which only renders the "Categories" button for
 * canManage). Deliberately no parent-category picker — `parent_category_id`
 * exists in the schema as a documented extension point only (migrations/
 * 0025_pricebook.sql), no UI here builds a multi-level tree yet.
 */
export function PricebookCategoryManager({
  categories, onClose, onChanged,
}: {
  categories: PricebookCategory[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const startEdit = (c: PricebookCategory) => {
    setEditDraft({ name: c.name, description: c.description });
    setEditingId(c.id);
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!draft.name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await api("POST", "/api/pricebook/categories", draft);
      setDraft(emptyDraft);
      setShowCreate(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (id: number) => {
    if (!editDraft.name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await api("PUT", `/api/pricebook/categories/${id}`, editDraft);
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (c: PricebookCategory) => {
    setError(null);
    try {
      await api("PUT", `/api/pricebook/categories/${c.id}`, { active: !c.active });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/pricebook/categories/${pendingDelete.id}`);
      setPendingDelete(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Pricebook Categories</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div class="modal-body-scroll">
          {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {showCreate && (
                <tr class="table-row">
                  <td><input type="text" class="inline-input" placeholder="Category name" value={draft.name}
                    onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} /></td>
                  <td><input type="text" class="inline-input" placeholder="Description" value={draft.description}
                    onInput={(e) => setDraft({ ...draft, description: (e.target as HTMLInputElement).value })} /></td>
                  <td>—</td>
                  <td>
                    <div class="action-btns">
                      <button class="btn btn-sm btn-primary" disabled={saving} onClick={handleCreate}>Add</button>
                      <button class="btn btn-sm" onClick={() => { setShowCreate(false); setDraft(emptyDraft); }}>Cancel</button>
                    </div>
                  </td>
                </tr>
              )}
              {categories.map((c) => (
                <tr key={c.id} class="table-row">
                  {editingId === c.id ? (
                    <>
                      <td><input type="text" class="inline-input" value={editDraft.name}
                        onInput={(e) => setEditDraft({ ...editDraft, name: (e.target as HTMLInputElement).value })} /></td>
                      <td><input type="text" class="inline-input" value={editDraft.description}
                        onInput={(e) => setEditDraft({ ...editDraft, description: (e.target as HTMLInputElement).value })} /></td>
                      <td>{c.active ? "Yes" : "No"}</td>
                      <td>
                        <div class="action-btns">
                          <button class="btn btn-sm btn-primary" disabled={saving} onClick={() => saveEdit(c.id)}>Save</button>
                          <button class="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td class="text-bold">{c.name}</td>
                      <td class="text-muted">{c.description || "—"}</td>
                      <td>
                        <label class="checkbox-row">
                          <input type="checkbox" checked={c.active} onChange={() => toggleActive(c)} />
                        </label>
                      </td>
                      <td>
                        <div class="action-btns">
                          <button class="btn-icon" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`}><Edit3 size={14} /></button>
                          <button class="btn-icon danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })} aria-label={`Delete ${c.name}`}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {!showCreate && (
            <button class="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setShowCreate(true)}>
              <Plus size={14} /> Add Category
            </button>
          )}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>

    {pendingDelete && (
      <ConfirmDialog
        title="Delete this category?"
        message={`This permanently deletes "${pendingDelete.name}". Categories with items or child categories cannot be deleted — deactivate instead.`}
        confirmLabel="Delete"
        danger
        submitting={deleting}
        onConfirm={handleConfirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    )}
    </>
  );
}
