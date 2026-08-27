import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useAuth } from "../auth-context";
import { formatCents } from "../money";
import { Pagination } from "./pagination";
import { PricebookItemForm } from "./pricebook-item-form";
import { PricebookCategoryManager } from "./pricebook-category-manager";
import { Search, X, Plus, FolderCog } from "lucide-preact";
import { PRICEBOOK_ITEM_TYPES } from "../types";
import type { PricebookItem, PricebookCategory, PaginatedState } from "../types";

const TYPE_LABELS: Record<string, string> = {
  EQUIPMENT: "Equipment", PART: "Part", MATERIAL: "Material", SERVICE: "Service", LABOR: "Labor", OTHER: "Other",
};

function StatusBadge({ status }: { status: string }) {
  const color = status === "active" ? "#16a34a" : "#6b7280";
  return (
    <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
      <span class="status-dot" style={{ background: color }} />
      {status === "active" ? "Active" : "Inactive"}
    </span>
  );
}

/**
 * Phase 17 — Pricebook catalog list. Self-contained (own fetch, not
 * AppContext), same precedent as contract-list.tsx/quote-list.tsx —
 * irrelevant to the technician role, who never reaches this route (see
 * app.tsx/sidebar.tsx's hideFromTechnician gate; the server's own
 * canViewPricebook RBAC is what actually enforces this either way).
 * The cost column is simply absent from the API response for a dispatcher
 * (server-side stripping, not client-side hiding — src/server/pricebook.ts
 * `stripCost`), so this component never needs to itself decide whether to
 * render it beyond checking whether the field is present.
 */
export function PricebookList() {
  const { user } = useAuth();
  const canManage = user?.role === "admin";

  const [items, setItems] = useState<PricebookItem[]>([]);
  const [categories, setCategories] = useState<PricebookCategory[]>([]);
  const [pag, setPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<PricebookItem | null>(null);
  const [showCategories, setShowCategories] = useState(false);

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api<{ categories: PricebookCategory[] }>("GET", "/api/pricebook/categories");
      setCategories(data.categories);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pag.limit));
      params.set("offset", String((pag.page - 1) * pag.limit));
      if (search) params.set("search", search);
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (categoryId) params.set("category_id", categoryId);
      const data = await api<{ items: PricebookItem[]; total: number }>("GET", `/api/pricebook?${params.toString()}`);
      setItems(data.items);
      setPag((p) => ({ ...p, total: data.total }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pag.page, pag.limit, search, type, status, categoryId]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);
  useEffect(() => { fetchItems(); }, [pag.page, search, type, status, categoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSearchAndReset = (v: string) => { setSearch(v); setPag((p) => ({ ...p, page: 1 })); };
  const setTypeAndReset = (v: string) => { setType(v); setPag((p) => ({ ...p, page: 1 })); };
  const setStatusAndReset = (v: string) => { setStatus(v); setPag((p) => ({ ...p, page: 1 })); };
  const setCategoryAndReset = (v: string) => { setCategoryId(v); setPag((p) => ({ ...p, page: 1 })); };
  const setPage = (page: number) => setPag((p) => ({ ...p, page }));
  const hasFilters = !!(search || type || status || categoryId);
  const categoryName = (id: number | null) => categories.find((c) => c.id === id)?.name || "—";

  const closeForm = (changed: boolean) => {
    setShowForm(false);
    setEditingItem(null);
    if (changed) fetchItems();
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>Pricebook</h1>
        {canManage && (
          <div class="action-btns">
            <button class="btn" onClick={() => setShowCategories(true)}>
              <FolderCog size={16} /> Categories
            </button>
            <button class="btn btn-primary" onClick={() => setShowForm(true)}>
              <Plus size={16} /> New Item
            </button>
          </div>
        )}
      </div>

      {error && <div class="inline-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div class="jobs-search-row">
        <Search size={18} class="jobs-search-icon" aria-hidden="true" />
        <input
          type="text"
          class="jobs-search-input"
          placeholder="Search by name, SKU, manufacturer, or model..."
          aria-label="Search Pricebook items"
          value={search}
          onInput={(e) => setSearchAndReset((e.target as HTMLInputElement).value)}
        />
        {search && (
          <button type="button" class="jobs-search-clear" aria-label="Clear search" onClick={() => setSearchAndReset("")}>
            <X size={16} />
          </button>
        )}
      </div>

      <div class="toolbar">
        <div class="filter-group">
          <button class={`filter-btn ${type === "" ? "active" : ""}`} onClick={() => setTypeAndReset("")}>All Types</button>
          {PRICEBOOK_ITEM_TYPES.map((t) => (
            <button key={t} class={`filter-btn ${type === t ? "active" : ""}`} onClick={() => setTypeAndReset(t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatusAndReset((e.target as HTMLSelectElement).value)} aria-label="Filter by status">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select value={categoryId} onChange={(e) => setCategoryAndReset((e.target as HTMLSelectElement).value)} aria-label="Filter by category">
          <option value="">All Categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div class="card">
        {loading ? (
          <div class="loading-text">Loading...</div>
        ) : items.length === 0 ? (
          <div class="empty-state">
            {hasFilters ? (
              <>
                <p>No items found</p>
                <p class="text-muted">Try adjusting your search or filters.</p>
              </>
            ) : (
              <>
                <p>No Pricebook items yet</p>
                {canManage && (
                  <button class="btn btn-primary" onClick={() => setShowForm(true)}>Add your first item</button>
                )}
              </>
            )}
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>SKU</th>
                  <th>Category</th>
                  <th>Manufacturer / Model</th>
                  {canManage && <th>Cost</th>}
                  <th>Sell Price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} class="table-row clickable" onClick={() => setEditingItem(it)}>
                    <td class="text-bold">{it.name}</td>
                    <td class="text-muted">{TYPE_LABELS[it.type] || it.type}</td>
                    <td class="text-muted">{it.sku || "—"}</td>
                    <td class="text-muted">{categoryName(it.category_id)}</td>
                    <td class="text-muted">{[it.manufacturer, it.model].filter(Boolean).join(" / ") || "—"}</td>
                    {canManage && <td>{it.cost_cents !== undefined ? formatCents(it.cost_cents) : "—"}</td>}
                    <td>{formatCents(it.sell_price_cents)}</td>
                    <td><StatusBadge status={it.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination pag={pag} setPage={setPage} />

      {showForm && (
        <PricebookItemForm categories={categories} onClose={closeForm} />
      )}
      {editingItem && (
        <PricebookItemForm item={editingItem} categories={categories} canManage={canManage} onClose={closeForm} />
      )}
      {showCategories && (
        <PricebookCategoryManager
          categories={categories}
          onClose={() => setShowCategories(false)}
          onChanged={fetchCategories}
        />
      )}
    </div>
  );
}
