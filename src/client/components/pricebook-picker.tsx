import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents } from "../money";
import { Search, X } from "lucide-preact";
import type { PricebookItem } from "../types";

/**
 * Phase 17 — Quote line-item integration. A minimal search-and-pick modal
 * over the active Pricebook catalog; selecting an item hands its snapshot
 * fields (name/unit/sell_price_cents/taxable) back to the caller, which
 * copies them into its own line-item draft ONCE — this component never
 * holds a live reference to the item after selection (see quote-detail.tsx's
 * `applyPricebookSelection`, and src/server/quotes.ts's
 * `resolvePricebookSnapshot` for the server-side half of the same
 * snapshot-at-selection discipline).
 */
export function PricebookPicker({ onSelect, onClose }: { onSelect: (item: PricebookItem) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<PricebookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ status: "active", limit: "50" });
        if (search) params.set("search", search);
        const data = await api<{ items: PricebookItem[] }>("GET", `/api/pricebook?${params.toString()}`);
        setItems(data.items);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Select from Pricebook</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div class="modal-body-scroll">
          <div class="jobs-search-row">
            <Search size={18} class="jobs-search-icon" aria-hidden="true" />
            <input
              type="text" class="jobs-search-input" autoFocus
              placeholder="Search by name, SKU, manufacturer, or model..."
              aria-label="Search Pricebook items"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </div>

          {error && <div class="inline-error" style={{ marginTop: 12 }}>{error}</div>}

          {loading ? (
            <div class="loading-text">Loading...</div>
          ) : items.length === 0 ? (
            <div class="empty-state"><p>No active items found</p></div>
          ) : (
            <table class="table">
              <thead>
                <tr><th>Name</th><th>SKU</th><th>Manufacturer / Model</th><th class="text-right">Sell Price</th></tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} class="table-row clickable" onClick={() => onSelect(it)}>
                    <td class="text-bold">{it.name}</td>
                    <td class="text-muted">{it.sku || "—"}</td>
                    <td class="text-muted">{[it.manufacturer, it.model].filter(Boolean).join(" / ") || "—"}</td>
                    <td class="text-right">{formatCents(it.sell_price_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
