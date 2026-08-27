import { useState } from "preact/hooks";
import { api } from "../api";
import { formatCents, formatCentsForInput, parseDollarsToCents } from "../money";
import { ConfirmDialog } from "./confirm-dialog";
import { PricebookPicker } from "./pricebook-picker";
import { Copy, Trash2, Star, BookOpen, Plus, X } from "lucide-preact";
import type { QuoteOption, QuoteOptionLineItem, OptionTier, PricebookItem } from "../types";
import { OPTION_TIERS } from "../types";

const TIER_LABELS: Record<string, string> = { GOOD: "Good", BETTER: "Better", BEST: "Best", CUSTOM: "Custom" };

const emptyLineDraft = { description: "", quantity: "1", unit: "", unit_price_input: "0.00", taxable: true, pricebook_item_id: null as number | null };

/**
 * Phase 18 — one Good/Better/Best option card in the Admin/Dispatcher
 * Estimate builder. Text fields are edited into LOCAL state and saved via
 * an explicit "Save" button (not per-keystroke) — deliberately, after
 * Phase 17's browser acceptance pass found two real input-corruption bugs
 * caused by round-tripping a controlled input's value through a
 * reformat/reparse on every keystroke; this component never does that.
 * Money line-item inputs hold the raw typed dollar string until submit,
 * the same fix applied to pricebook-item-form.tsx.
 */
export function QuoteOptionCard({
  quoteId, option, isDraft, onChanged,
}: {
  quoteId: number;
  option: QuoteOption;
  isDraft: boolean;
  onChanged: () => void;
}) {
  const hasCostAccess = option.cost_summary !== undefined;
  const [draft, setDraft] = useState({
    tier: option.tier, name: option.name, headline: option.headline, description: option.description,
    highlightsText: option.highlights.join(", "), recommended: option.recommended,
    discount_type: option.discount_type, discount_percent: String(option.discount_percent),
    discount_input: formatCentsForInput(option.discount_cents),
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateTier, setDuplicateTier] = useState<OptionTier>(option.tier);

  const [showAddLine, setShowAddLine] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [lineDraft, setLineDraft] = useState(emptyLineDraft);
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [savingLine, setSavingLine] = useState(false);

  const setField = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const saveOption = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("PUT", `/api/quotes/${quoteId}/options/${option.id}`, {
        tier: draft.tier, name: draft.name, headline: draft.headline, description: draft.description,
        highlights: draft.highlightsText.split(",").map((h) => h.trim()).filter(Boolean),
        recommended: draft.recommended,
        discount_type: draft.discount_type,
        discount_percent: parseFloat(draft.discount_percent) || 0,
        discount_cents: parseDollarsToCents(draft.discount_input) ?? 0,
      });
      setDirty(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await api("DELETE", `/api/quotes/${quoteId}/options/${option.id}`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
      setPendingDelete(false);
    }
  };

  const duplicate = async () => {
    setDuplicating(true);
    setError(null);
    try {
      await api("POST", `/api/quotes/${quoteId}/options/${option.id}/duplicate`, { tier: duplicateTier });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDuplicating(false);
    }
  };

  const startEditLine = (line: QuoteOptionLineItem) => {
    setEditingLineId(line.id);
    setLineDraft({
      description: line.description, quantity: String(line.quantity), unit: line.unit,
      unit_price_input: formatCentsForInput(line.unit_price_cents), taxable: !!line.taxable, pricebook_item_id: line.pricebook_item_id,
    });
  };

  const submitAddLine = async () => {
    setSavingLine(true);
    setError(null);
    try {
      await api("POST", `/api/quotes/${quoteId}/options/${option.id}/line-items`, {
        description: lineDraft.description, quantity: parseFloat(lineDraft.quantity) || 1, unit: lineDraft.unit,
        unit_price_cents: parseDollarsToCents(lineDraft.unit_price_input) ?? 0, taxable: lineDraft.taxable,
        pricebook_item_id: lineDraft.pricebook_item_id,
      });
      setShowAddLine(false);
      setLineDraft(emptyLineDraft);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingLine(false);
    }
  };

  const submitEditLine = async () => {
    if (editingLineId === null) return;
    setSavingLine(true);
    setError(null);
    try {
      await api("PUT", `/api/quotes/${quoteId}/options/${option.id}/line-items/${editingLineId}`, {
        description: lineDraft.description, quantity: parseFloat(lineDraft.quantity) || 1, unit: lineDraft.unit,
        unit_price_cents: parseDollarsToCents(lineDraft.unit_price_input) ?? 0, taxable: lineDraft.taxable,
      });
      setEditingLineId(null);
      setLineDraft(emptyLineDraft);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingLine(false);
    }
  };

  const deleteLine = async (lineId: number) => {
    setError(null);
    try {
      await api("DELETE", `/api/quotes/${quoteId}/options/${option.id}/line-items/${lineId}`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyPricebookSelection = (item: PricebookItem) => {
    setLineDraft((d) => ({ ...d, description: item.name, unit: item.unit, unit_price_input: formatCentsForInput(item.sell_price_cents), taxable: item.taxable, pricebook_item_id: item.id }));
    setShowPicker(false);
  };

  return (
    <div class="card quote-option-card-admin">
      <div class="form-grid">
        <div class="form-group">
          <label>Tier</label>
          <select value={draft.tier} disabled={!isDraft} onChange={(e) => setField("tier", (e.target as HTMLSelectElement).value as OptionTier)}>
            {OPTION_TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
          </select>
        </div>
        <div class="form-group">
          <label class="checkbox-row" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={draft.recommended} disabled={!isDraft} onChange={(e) => setField("recommended", (e.target as HTMLInputElement).checked)} />
            <Star size={14} /> Recommended
          </label>
        </div>
        <div class="form-group full-width">
          <label>Name</label>
          <input type="text" value={draft.name} disabled={!isDraft} onInput={(e) => setField("name", (e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group full-width">
          <label>Headline</label>
          <input type="text" value={draft.headline} disabled={!isDraft} placeholder="e.g. Recommended balance of efficiency and price" onInput={(e) => setField("headline", (e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group full-width">
          <label>Customer-Facing Description</label>
          <textarea rows={2} value={draft.description} disabled={!isDraft} onInput={(e) => setField("description", (e.target as HTMLTextAreaElement).value)} />
        </div>
        <div class="form-group full-width">
          <label>Highlights (comma-separated)</label>
          <input type="text" value={draft.highlightsText} disabled={!isDraft} placeholder="Best value, Longest warranty, Premium comfort" onInput={(e) => setField("highlightsText", (e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-group">
          <label>Discount Type</label>
          <select value={draft.discount_type} disabled={!isDraft} onChange={(e) => setField("discount_type", (e.target as HTMLSelectElement).value)}>
            <option value="none">None</option>
            <option value="fixed">Fixed</option>
            <option value="percent">Percent</option>
          </select>
        </div>
        {draft.discount_type === "percent" && (
          <div class="form-group">
            <label>Discount %</label>
            <input type="number" min="0" max="100" value={draft.discount_percent} disabled={!isDraft} onInput={(e) => setField("discount_percent", (e.target as HTMLInputElement).value)} />
          </div>
        )}
        {draft.discount_type === "fixed" && (
          <div class="form-group">
            <label>Discount $</label>
            <input type="text" inputMode="decimal" value={draft.discount_input} disabled={!isDraft} onInput={(e) => setField("discount_input", (e.target as HTMLInputElement).value)} />
          </div>
        )}
      </div>

      {error && <div class="inline-error" style={{ margin: "8px 0" }}>{error}</div>}

      {isDraft && dirty && (
        <button class="btn btn-sm btn-primary" style={{ marginBottom: 12 }} disabled={saving} onClick={saveOption}>
          {saving ? "Saving..." : "Save Option Details"}
        </button>
      )}

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Description</th><th>Qty</th><th>Unit</th><th class="text-right">Unit Price</th>
              {hasCostAccess && <th class="text-right">Cost</th>}
              <th class="text-right">Total</th><th>Taxable</th>
              {isDraft && <th></th>}
            </tr>
          </thead>
          <tbody>
            {option.line_items.map((line) => (
              editingLineId === line.id ? (
                <tr key={line.id} class="table-row">
                  <td><input type="text" value={lineDraft.description} onInput={(e) => setLineDraft({ ...lineDraft, description: (e.target as HTMLInputElement).value })} /></td>
                  <td style={{ width: 60 }}><input type="number" step="any" min="0.01" value={lineDraft.quantity} onInput={(e) => setLineDraft({ ...lineDraft, quantity: (e.target as HTMLInputElement).value })} /></td>
                  <td style={{ width: 70 }}><input type="text" value={lineDraft.unit} onInput={(e) => setLineDraft({ ...lineDraft, unit: (e.target as HTMLInputElement).value })} /></td>
                  <td style={{ width: 90 }}><input type="text" inputMode="decimal" value={lineDraft.unit_price_input} onInput={(e) => setLineDraft({ ...lineDraft, unit_price_input: (e.target as HTMLInputElement).value })} /></td>
                  {hasCostAccess && <td class="text-right text-muted">{line.cost_cents != null ? formatCents(line.cost_cents) : "—"}</td>}
                  <td class="text-right text-muted">—</td>
                  <td><input type="checkbox" checked={lineDraft.taxable} onChange={(e) => setLineDraft({ ...lineDraft, taxable: (e.target as HTMLInputElement).checked })} /></td>
                  <td>
                    <button class="btn-icon" disabled={savingLine} onClick={submitEditLine}>✓</button>
                    <button class="btn-icon" onClick={() => { setEditingLineId(null); setLineDraft(emptyLineDraft); }}><X size={14} /></button>
                  </td>
                </tr>
              ) : (
                <tr key={line.id} class="table-row">
                  <td>{line.description || "—"}{line.pricebook_item_id && <span class="text-muted" style={{ fontSize: 11 }}> (Pricebook)</span>}</td>
                  <td>{line.quantity}</td>
                  <td class="text-muted">{line.unit || "—"}</td>
                  <td class="text-right">{formatCents(line.unit_price_cents)}</td>
                  {hasCostAccess && <td class="text-right text-muted">{line.cost_cents != null ? formatCents(line.cost_cents) : "—"}</td>}
                  <td class="text-right">{formatCents(line.total_cents)}</td>
                  <td class="text-muted">{line.taxable ? "Yes" : "No"}</td>
                  {isDraft && (
                    <td>
                      <button class="btn-icon" onClick={() => startEditLine(line)}>✎</button>
                      <button class="btn-icon danger" onClick={() => deleteLine(line.id)}><Trash2 size={12} /></button>
                    </td>
                  )}
                </tr>
              )
            ))}
            {showAddLine && (
              <tr class="table-row">
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    <input type="text" placeholder="Description" value={lineDraft.description} onInput={(e) => setLineDraft({ ...lineDraft, description: (e.target as HTMLInputElement).value, pricebook_item_id: null })} />
                    <button type="button" class="btn-icon" title="Select from Pricebook" onClick={() => setShowPicker(true)}><BookOpen size={14} /></button>
                  </div>
                </td>
                <td style={{ width: 60 }}><input type="number" step="any" min="0.01" value={lineDraft.quantity} onInput={(e) => setLineDraft({ ...lineDraft, quantity: (e.target as HTMLInputElement).value })} /></td>
                <td style={{ width: 70 }}><input type="text" placeholder="ea" value={lineDraft.unit} onInput={(e) => setLineDraft({ ...lineDraft, unit: (e.target as HTMLInputElement).value })} /></td>
                <td style={{ width: 90 }}><input type="text" inputMode="decimal" placeholder="0.00" value={lineDraft.unit_price_input} onInput={(e) => setLineDraft({ ...lineDraft, unit_price_input: (e.target as HTMLInputElement).value })} /></td>
                {hasCostAccess && <td class="text-right text-muted">—</td>}
                <td class="text-right text-muted">—</td>
                <td><input type="checkbox" checked={lineDraft.taxable} onChange={(e) => setLineDraft({ ...lineDraft, taxable: (e.target as HTMLInputElement).checked })} /></td>
                <td>
                  <button class="btn-icon" disabled={savingLine} onClick={submitAddLine}>✓</button>
                  <button class="btn-icon" onClick={() => { setShowAddLine(false); setLineDraft(emptyLineDraft); }}><X size={14} /></button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {isDraft && !showAddLine && (
        <button class="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAddLine(true)}><Plus size={14} /> Add Line</button>
      )}

      <div class="quote-option-totals-row">
        <span class="text-muted">Subtotal {formatCents(option.subtotal_cents)}</span>
        <span class="text-muted">Tax {formatCents(option.tax_amount_cents)}</span>
        <span class="text-bold">Total {formatCents(option.total_cents)}</span>
        {hasCostAccess && option.cost_summary && (
          <span class="text-muted">
            Cost {formatCents(option.cost_summary.totalCostCents)} · Margin {option.cost_summary.grossMarginPercent}% · Markup {option.cost_summary.markupPercent}%
            {/* Architecture-review finding: a line with no cost snapshot
                (manual line, or Pricebook line added by a dispatcher who
                never had cost to snapshot) contributes 0 to totalCostCents
                but still contributes to sell price — silently inflating
                margin/markup rather than just being incomplete. Flag it
                honestly instead of presenting a partial number as exact. */}
            {option.line_items.some((l) => l.cost_cents == null) && " (partial — some lines have no cost data)"}
          </span>
        )}
      </div>

      {isDraft && (
        <div class="action-btns" style={{ marginTop: 12 }}>
          <select value={duplicateTier} onChange={(e) => setDuplicateTier((e.target as HTMLSelectElement).value as OptionTier)} style={{ width: "auto" }}>
            {OPTION_TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
          </select>
          <button class="btn btn-sm" disabled={duplicating} onClick={duplicate}><Copy size={14} /> Duplicate as</button>
          <button class="btn btn-sm btn-danger" onClick={() => setPendingDelete(true)}><Trash2 size={14} /> Delete Option</button>
        </div>
      )}

      {showPicker && <PricebookPicker onSelect={applyPricebookSelection} onClose={() => setShowPicker(false)} />}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete this option?"
          message={`This permanently deletes "${option.name || TIER_LABELS[option.tier]}" and its line items. This cannot be undone.`}
          confirmLabel="Delete" danger
          submitting={deleting}
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}
    </div>
  );
}
