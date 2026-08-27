import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents, formatCentsForInput, parseDollarsToCents } from "../money";
import { ConfirmDialog } from "./confirm-dialog";
import { X, Plus, Trash2 } from "lucide-preact";
import { PRICEBOOK_ITEM_TYPES } from "../types";
import type { PricebookItem, PricebookCategory, PricebookItemAuditEntry } from "../types";

const TYPE_LABELS: Record<string, string> = {
  EQUIPMENT: "Equipment", PART: "Part", MATERIAL: "Material", SERVICE: "Service", LABOR: "Labor", OTHER: "Other",
};

/** equipment_metadata/warranty_metadata are opaque JSON-object blobs at the
 *  server (src/server/pricebook.ts never inspects specific keys — Core stays
 *  industry-neutral). This is a plain key/value editor over that object
 *  rather than a hardcoded HVAC form (capacity/fuel_type/refrigerant/...) —
 *  it matches what the server actually validates (any JSON object) instead
 *  of inventing a fixed schema nothing enforces. */
function MetadataEditor({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  let parsed: Record<string, string> = {};
  try {
    const obj = JSON.parse(value || "{}");
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) parsed[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  } catch {
    parsed = {};
  }
  const entries = Object.entries(parsed);

  const commit = (next: Record<string, string>) => onChange(JSON.stringify(next));
  const updateKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) next[k === oldKey ? newKey : k] = v;
    commit(next);
  };
  const updateValue = (key: string, v: string) => commit({ ...parsed, [key]: v });
  const removeKey = (key: string) => {
    const next = { ...parsed };
    delete next[key];
    commit(next);
  };
  const addRow = () => {
    let key = "attribute";
    let i = 1;
    while (key in parsed) { key = `attribute_${i}`; i++; }
    commit({ ...parsed, [key]: "" });
  };

  return (
    <div class="metadata-editor">
      {entries.map(([k, v], index) => (
        // key is the row's stable POSITION, not the attribute name (`k`) —
        // `k` is exactly what the first input below edits on every
        // keystroke, so keying on it would give React a new `key` per
        // keystroke, forcing it to unmount/remount the DOM input (losing
        // focus and dropping characters) instead of updating it in place.
        // Rows are only ever appended/removed, never reordered, so an
        // index key is safe here.
        <div class="metadata-row" key={index} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input type="text" value={k} disabled={disabled} placeholder="Attribute" style={{ flex: 1 }}
            onInput={(e) => updateKey(k, (e.target as HTMLInputElement).value)} />
          <input type="text" value={v} disabled={disabled} placeholder="Value" style={{ flex: 2 }}
            onInput={(e) => updateValue(k, (e.target as HTMLInputElement).value)} />
          {!disabled && (
            <button type="button" class="btn-icon danger" onClick={() => removeKey(k)} aria-label={`Remove ${k}`}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" class="btn btn-sm" onClick={addRow}>
          <Plus size={14} /> Add Attribute
        </button>
      )}
      {entries.length === 0 && disabled && <p class="text-muted">No attributes recorded.</p>}
    </div>
  );
}

interface FormState {
  type: string;
  name: string;
  description: string;
  sku: string;
  category_id: string;
  manufacturer: string;
  model: string;
  unit: string;
  default_quantity: string;
  // Held as the raw typed dollar string while editing (matching quote-
  // detail.tsx's itemDraft.unit_price pattern) — NOT round-tripped through
  // parseDollarsToCents/formatCentsForInput on every keystroke, which
  // fights natural typing (each partial value like "4" would immediately
  // reformat to "4.00" mid-entry). Converted to cents once, at submit time
  // (see buildPayload).
  sell_price_input: string;
  cost_input: string;
  taxable: boolean;
  status: string;
  preferred_vendor: string;
  vendor_sku: string;
  internal_notes: string;
  equipment_metadata: string;
  warranty_metadata: string;
}

function toFormState(item: PricebookItem | undefined): FormState {
  return {
    type: item?.type ?? "PART",
    name: item?.name ?? "",
    description: item?.description ?? "",
    sku: item?.sku ?? "",
    category_id: item?.category_id != null ? String(item.category_id) : "",
    manufacturer: item?.manufacturer ?? "",
    model: item?.model ?? "",
    unit: item?.unit ?? "each",
    default_quantity: item ? String(item.default_quantity) : "1",
    sell_price_input: formatCentsForInput(item?.sell_price_cents ?? 0),
    cost_input: formatCentsForInput(item?.cost_cents ?? 0),
    taxable: item?.taxable ?? true,
    status: item?.status ?? "active",
    preferred_vendor: item?.preferred_vendor ?? "",
    vendor_sku: item?.vendor_sku ?? "",
    internal_notes: item?.internal_notes ?? "",
    equipment_metadata: item?.equipment_metadata ?? "{}",
    warranty_metadata: item?.warranty_metadata ?? "{}",
  };
}

/**
 * Phase 17 — Pricebook item create/edit form. Doubles as a read-only detail
 * view for a dispatcher (canManage=false): every input renders `disabled`
 * and the footer shows only a Close button — the same "server strips the
 * data, client just renders what's present" split as PricebookList's cost
 * column. Cost/internal fields never render at all when the caller (a
 * dispatcher) never received them from the API in the first place — the
 * `item.cost_cents !== undefined` checks below are display-only, not the
 * authorization boundary itself.
 */
export function PricebookItemForm({
  item, categories, canManage = true, onClose,
}: {
  item?: PricebookItem;
  categories: PricebookCategory[];
  canManage?: boolean;
  onClose: (changed: boolean) => void;
}) {
  const isEdit = !!item;
  const hasCostAccess = !item || item.cost_cents !== undefined;
  const [form, setForm] = useState<FormState>(() => toFormState(item));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<PricebookItemAuditEntry[]>([]);
  const [pendingArchive, setPendingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!isEdit || !canManage) return;
    api<{ audit: PricebookItemAuditEntry[] }>("GET", `/api/pricebook/${item!.id}/audit`)
      .then((data) => setAudit(data.audit))
      .catch(() => {}); // Audit trail is a supplementary view — a failed fetch shouldn't block the form itself.
  }, [isEdit, canManage, item]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const buildPayload = () => ({
    type: form.type,
    name: form.name.trim(),
    description: form.description,
    sku: form.sku.trim(),
    category_id: form.category_id ? Number(form.category_id) : null,
    manufacturer: form.manufacturer,
    model: form.model,
    unit: form.unit || "each",
    default_quantity: parseFloat(form.default_quantity) || 1,
    sell_price_cents: parseDollarsToCents(form.sell_price_input) ?? 0,
    taxable: form.taxable,
    status: form.status,
    ...(canManage ? {
      cost_cents: parseDollarsToCents(form.cost_input) ?? 0,
      preferred_vendor: form.preferred_vendor,
      vendor_sku: form.vendor_sku,
      internal_notes: form.internal_notes,
    } : {}),
    equipment_metadata: form.equipment_metadata,
    warranty_metadata: form.warranty_metadata,
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!form.name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        await api("PUT", `/api/pricebook/${item!.id}`, buildPayload());
      } else {
        await api("POST", "/api/pricebook", buildPayload());
      }
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveToggle = async () => {
    setArchiving(true);
    try {
      const nextStatus = form.status === "active" ? "archive" : "activate";
      await api("POST", `/api/pricebook/${item!.id}/${nextStatus}`);
      setPendingArchive(false);
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setArchiving(false);
    }
  };

  const readOnly = !canManage;
  const showEquipmentSections = form.type === "EQUIPMENT";

  return (
    <>
    <div class="modal-overlay" onClick={() => onClose(false)}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>{isEdit ? (readOnly ? item!.name : "Edit Pricebook Item") : "New Pricebook Item"}</h2>
          <button class="btn-icon" onClick={() => onClose(false)}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="modal-body-scroll">
            {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

            <div class="form-section">
              <div class="form-section-heading">General</div>
              <div class="form-grid">
                <div class="form-group">
                  <label>Type *</label>
                  <select value={form.type} disabled={readOnly} onChange={(e) => set("type", (e.target as HTMLSelectElement).value)}>
                    {PRICEBOOK_ITEM_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Status</label>
                  <select value={form.status} disabled={readOnly} onChange={(e) => set("status", (e.target as HTMLSelectElement).value)}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div class="form-group full-width">
                  <label>Name *</label>
                  <input type="text" value={form.name} disabled={readOnly} required
                    onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group full-width">
                  <label>Customer-Facing Description</label>
                  <textarea rows={2} value={form.description} disabled={readOnly}
                    onInput={(e) => set("description", (e.target as HTMLTextAreaElement).value)} />
                </div>
                <div class="form-group">
                  <label>SKU</label>
                  <input type="text" value={form.sku} disabled={readOnly}
                    onInput={(e) => set("sku", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Category</label>
                  <select value={form.category_id} disabled={readOnly} onChange={(e) => set("category_id", (e.target as HTMLSelectElement).value)}>
                    <option value="">None</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div class="form-group">
                  <label>Manufacturer</label>
                  <input type="text" value={form.manufacturer} disabled={readOnly}
                    onInput={(e) => set("manufacturer", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Model</label>
                  <input type="text" value={form.model} disabled={readOnly}
                    onInput={(e) => set("model", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Unit</label>
                  <input type="text" value={form.unit} disabled={readOnly}
                    onInput={(e) => set("unit", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Default Quantity</label>
                  <input type="number" min="0" step="any" value={form.default_quantity} disabled={readOnly}
                    onInput={(e) => set("default_quantity", (e.target as HTMLInputElement).value)} />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-heading">Pricing &amp; Tax</div>
              <div class="form-grid">
                <div class="form-group">
                  <label>Sell Price</label>
                  {readOnly ? (
                    <p>{formatCents(item?.sell_price_cents ?? 0)}</p>
                  ) : (
                    <input type="text" inputMode="decimal" value={form.sell_price_input}
                      placeholder="0.00"
                      onInput={(e) => set("sell_price_input", (e.target as HTMLInputElement).value)} />
                  )}
                </div>
                {hasCostAccess && (
                  <div class="form-group">
                    <label>Cost</label>
                    {readOnly ? (
                      <p>{formatCents(item?.cost_cents ?? 0)}</p>
                    ) : (
                      <input type="text" inputMode="decimal" value={form.cost_input}
                        placeholder="0.00"
                        onInput={(e) => set("cost_input", (e.target as HTMLInputElement).value)} />
                    )}
                  </div>
                )}
                <div class="form-group">
                  <label class="checkbox-row">
                    <input type="checkbox" checked={form.taxable} disabled={readOnly}
                      onChange={(e) => set("taxable", (e.target as HTMLInputElement).checked)} />
                    Taxable
                  </label>
                </div>
              </div>
            </div>

            {showEquipmentSections && (
              <div class="form-section">
                <div class="form-section-heading">Equipment Details</div>
                <MetadataEditor value={form.equipment_metadata} disabled={readOnly}
                  onChange={(v) => set("equipment_metadata", v)} />
              </div>
            )}

            {showEquipmentSections && (
              <div class="form-section">
                <div class="form-section-heading">Warranty</div>
                <MetadataEditor value={form.warranty_metadata} disabled={readOnly}
                  onChange={(v) => set("warranty_metadata", v)} />
              </div>
            )}

            {hasCostAccess && (
              <div class="form-section">
                <div class="form-section-heading">Internal</div>
                <div class="form-grid">
                  <div class="form-group">
                    <label>Preferred Vendor</label>
                    <input type="text" value={form.preferred_vendor} disabled={readOnly}
                      onInput={(e) => set("preferred_vendor", (e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="form-group">
                    <label>Vendor SKU</label>
                    <input type="text" value={form.vendor_sku} disabled={readOnly}
                      onInput={(e) => set("vendor_sku", (e.target as HTMLInputElement).value)} />
                  </div>
                  <div class="form-group full-width">
                    <label>Internal Notes (never customer-facing)</label>
                    <textarea rows={2} value={form.internal_notes} disabled={readOnly}
                      onInput={(e) => set("internal_notes", (e.target as HTMLTextAreaElement).value)} />
                  </div>
                </div>
              </div>
            )}

            {isEdit && canManage && audit.length > 0 && (
              <div class="form-section">
                <div class="form-section-heading">Price &amp; Status History</div>
                <ul class="audit-list">
                  {audit.map((a) => (
                    <li key={a.id} class="text-muted" style={{ fontSize: 13, marginBottom: 4 }}>
                      {a.created_at.slice(0, 16).replace("T", " ")} — {a.event_type.replace("_", " ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div class="modal-footer">
            {isEdit && canManage && (
              <button type="button" class="btn" style={{ marginRight: "auto" }} onClick={() => setPendingArchive(true)}>
                {form.status === "active" ? "Archive" : "Reactivate"}
              </button>
            )}
            <button type="button" class="btn" onClick={() => onClose(false)}>{readOnly ? "Close" : "Cancel"}</button>
            {!readOnly && (
              <button type="submit" class="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Item"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>

    {pendingArchive && item && (
      <ConfirmDialog
        title={form.status === "active" ? "Archive this item?" : "Reactivate this item?"}
        message={
          form.status === "active"
            ? `"${item.name}" will no longer appear as an active catalog item. Existing Quotes/Invoices that already reference it are unaffected.`
            : `"${item.name}" will become selectable in the catalog again.`
        }
        confirmLabel={form.status === "active" ? "Archive" : "Reactivate"}
        danger={form.status === "active"}
        submitting={archiving}
        onConfirm={handleArchiveToggle}
        onClose={() => setPendingArchive(false)}
      />
    )}
    </>
  );
}
