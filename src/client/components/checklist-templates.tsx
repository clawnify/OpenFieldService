import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Plus, Trash2, X } from "lucide-preact";
import type { ChecklistTemplate, ChecklistSection19B, ChecklistItem19B } from "../types";

/**
 * Phase 19B — Admin-only Maintenance Checklist Templates. Self-contained
 * (own local fetch/state). Editing an existing template's structure
 * creates a NEW version (Section 18 — historical Service Reports must
 * retain the exact checklist used); there is no in-place edit of a
 * published version's sections.
 */

const ITEM_TYPES = ["PASS_FAIL", "YES_NO", "TEXT", "NUMBER", "MEASUREMENT", "SELECT", "PHOTO_REQUIRED"] as const;

let itemIdCounter = 0;
function newItem(): ChecklistItem19B {
  return { id: `item-${Date.now()}-${itemIdCounter++}`, label: "", input_type: "PASS_FAIL", required: true };
}

export function ChecklistTemplates() {
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [sections, setSections] = useState<ChecklistSection19B[]>([{ title: "", items: [newItem()] }]);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ templates: ChecklistTemplate[] }>("GET", "/api/maintenance/checklist-templates?include_inactive=true");
      setTemplates(data.templates);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingTemplateId(null);
    setName("");
    setSections([{ title: "", items: [newItem()] }]);
    setShowForm(true);
  };

  const openNewVersion = async (t: ChecklistTemplate) => {
    const detail = await api<{ versions: { id: number; sections: string }[] }>("GET", `/api/maintenance/checklist-templates/${t.id}`);
    const latest = detail.versions[0];
    setEditingTemplateId(t.id);
    setName(t.name);
    setSections(latest ? JSON.parse(latest.sections) : [{ title: "", items: [newItem()] }]);
    setShowForm(true);
  };

  const addSection = () => setSections([...sections, { title: "", items: [newItem()] }]);
  const removeSection = (i: number) => setSections(sections.filter((_, idx) => idx !== i));
  const updateSectionTitle = (i: number, title: string) => setSections(sections.map((s, idx) => (idx === i ? { ...s, title } : s)));
  const addItem = (si: number) => setSections(sections.map((s, idx) => (idx === si ? { ...s, items: [...s.items, newItem()] } : s)));
  const removeItem = (si: number, ii: number) => setSections(sections.map((s, idx) => (idx === si ? { ...s, items: s.items.filter((_, j) => j !== ii) } : s)));
  const updateItem = (si: number, ii: number, patch: Partial<ChecklistItem19B>) =>
    setSections(sections.map((s, idx) => (idx === si ? { ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : s)));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editingTemplateId) {
        await api("POST", `/api/maintenance/checklist-templates/${editingTemplateId}/versions`, { sections });
      } else {
        await api("POST", "/api/maintenance/checklist-templates", { name: name.trim(), sections });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (t: ChecklistTemplate) => {
    await api("PUT", `/api/maintenance/checklist-templates/${t.id}`, { active: !t.active });
    await load();
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Maintenance Checklist Templates</h1>
        <button class="btn btn-primary" onClick={openCreate}><Plus size={16} /> New Template</button>
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : templates.length === 0 ? (
          <div class="empty-state"><p>No checklist templates yet</p></div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} class="table-row">
                    <td class="text-bold">{t.name}</td>
                    <td>{t.active ? "Yes" : "No"}</td>
                    <td>
                      <button class="btn btn-sm" onClick={() => openNewVersion(t)}>New Version</button>{" "}
                      <button class="btn btn-sm" onClick={() => toggleActive(t)}>{t.active ? "Deactivate" : "Activate"}</button>
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
          <div class="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingTemplateId ? "New Version" : "New Checklist Template"}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setShowForm(false)}><X size={18} /></button>
            </div>
            <div class="modal-body">
              {!editingTemplateId && (
                <div class="form-group">
                  <label for="ct-name">Name</label>
                  <input id="ct-name" type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
                </div>
              )}
              {sections.map((section, si) => (
                <div key={si} class="card" style={{ marginBottom: 12 }}>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 1 }}>
                      <label for={`ct-section-${si}`}>Section Title</label>
                      <input id={`ct-section-${si}`} type="text" value={section.title} onInput={(e) => updateSectionTitle(si, (e.target as HTMLInputElement).value)} />
                    </div>
                    <button class="btn-icon" aria-label={`Remove section ${si + 1}`} onClick={() => removeSection(si)}><Trash2 size={16} /></button>
                  </div>
                  {section.items.map((item, ii) => (
                    <div key={item.id} class="form-row" style={{ alignItems: "flex-end" }}>
                      <div class="form-group" style={{ flex: 2 }}>
                        <label for={`ct-item-label-${si}-${ii}`}>Item Label</label>
                        <input id={`ct-item-label-${si}-${ii}`} type="text" value={item.label} onInput={(e) => updateItem(si, ii, { label: (e.target as HTMLInputElement).value })} />
                      </div>
                      <div class="form-group">
                        <label for={`ct-item-type-${si}-${ii}`}>Input Type</label>
                        <select id={`ct-item-type-${si}-${ii}`} value={item.input_type} onChange={(e) => updateItem(si, ii, { input_type: (e.target as HTMLSelectElement).value as ChecklistItem19B["input_type"] })}>
                          {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <label class="checkbox-row">
                        <input type="checkbox" checked={item.required} onChange={(e) => updateItem(si, ii, { required: (e.target as HTMLInputElement).checked })} />
                        Required
                      </label>
                      <button class="btn-icon" aria-label={`Remove item ${ii + 1} in section ${si + 1}`} onClick={() => removeItem(si, ii)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <button class="btn btn-sm" onClick={() => addItem(si)}>+ Add Item</button>
                </div>
              ))}
              <button class="btn" onClick={addSection}>+ Add Section</button>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button class="btn btn-primary" disabled={saving || (!editingTemplateId && !name.trim())} onClick={submit}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
