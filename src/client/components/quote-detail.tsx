import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { formatCents, formatCentsForInput, parseDollarsToCents } from "../money";
import { QUOTE_STATUS_LABELS, LINE_ITEM_CATEGORIES, LINE_ITEM_CATEGORY_LABELS, DISCOUNT_TYPES } from "../quote-status";
import { ConfirmDialog } from "./confirm-dialog";
import { RelatedContracts } from "./related-contracts";
import { PricebookPicker } from "./pricebook-picker";
import { ArrowLeft, Trash2, Edit3, Plus, X, BookOpen } from "lucide-preact";
import type { Quote, QuoteVersionDetail, QuoteVersion, QuoteStatusHistoryRow, QuoteLineItem, DiscountType, LineItemCategory, PricebookItem } from "../types";

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280", sent: "#3b82f6", accepted: "#16a34a", rejected: "#dc2626", expired: "#9ca3af", cancelled: "#9ca3af",
};

const emptyItemDraft = { description: "", category: "service" as LineItemCategory, quantity: "1", unit: "", unit_price: "", taxable: true, pricebook_item_id: null as number | null };

function itemDraftToPayload(d: typeof emptyItemDraft) {
  return {
    description: d.description, category: d.category,
    quantity: parseFloat(d.quantity) || 0,
    unit: d.unit,
    unit_price_cents: parseDollarsToCents(d.unit_price) || 0,
    taxable: d.taxable,
    pricebook_item_id: d.pricebook_item_id,
  };
}

/**
 * Phase 12 — Quote detail. Self-contained (own fetch, not AppContext) —
 * same reasoning as LeadDetail: quotes are irrelevant to the technician
 * role. All commercial fields (line items, discount, tax, notes,
 * expires_at) are editable only while the quote's CURRENT version is
 * draft — the server enforces this (not_draft -> 409); the UI mirrors it
 * by hiding edit affordances once sent/accepted/etc, matching the
 * versioning model's "sent is historically stable" requirement.
 */
export function QuoteDetail({ id, navigate }: { id: number; navigate: (to: string) => void }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [version, setVersion] = useState<QuoteVersionDetail | null>(null);
  const [versions, setVersions] = useState<QuoteVersion[]>([]);
  const [history, setHistory] = useState<QuoteStatusHistoryRow[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [canCreateRevision, setCanCreateRevision] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [viewingVersion, setViewingVersion] = useState<QuoteVersionDetail | null>(null);

  const [showAddItem, setShowAddItem] = useState(false);
  const [itemDraft, setItemDraft] = useState(emptyItemDraft);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<number | null>(null);
  const [showPricebookPicker, setShowPricebookPicker] = useState(false);

  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState({
    discount_type: "none" as DiscountType, discount_percent: "0", discount_cents_input: "0.00", notes: "", expires_at: "",
  });
  const [savingMeta, setSavingMeta] = useState(false);

  const [pendingTransition, setPendingTransition] = useState<string | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [transitioning, setTransitioning] = useState(false);

  const [pendingRevision, setPendingRevision] = useState(false);
  const [creatingRevision, setCreatingRevision] = useState(false);

  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [creatingContract, setCreatingContract] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, versionsRes, transitions, historyRes] = await Promise.all([
        api<{ quote: Quote; version: QuoteVersionDetail | null }>("GET", `/api/quotes/${id}`),
        api<{ versions: QuoteVersion[] }>("GET", `/api/quotes/${id}/versions`),
        api<{ allowed: string[]; can_create_revision: boolean }>("GET", `/api/quotes/${id}/transitions`),
        api<{ history: QuoteStatusHistoryRow[] }>("GET", `/api/quotes/${id}/status-history`),
      ]);
      setQuote(detail.quote);
      setVersion(detail.version);
      setVersions(versionsRes.versions);
      setAllowed(transitions.allowed);
      setCanCreateRevision(transitions.can_create_revision);
      setHistory(historyRes.history);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div class="page loading-text">Loading...</div>;

  if (loadError || !quote) {
    return (
      <div class="page">
        <button class="btn btn-back" onClick={() => navigate("/quotes")}><ArrowLeft size={16} /> Back</button>
        <div class="inline-error" style={{ marginTop: 16 }}>{loadError || "This quote could not be found."}</div>
      </div>
    );
  }

  const isDraft = quote.status === "draft";
  const color = STATUS_COLORS[quote.status] || "#6b7280";

  const startEditMeta = () => {
    if (!version) return;
    setMetaDraft({
      discount_type: version.discount_type, discount_percent: String(version.discount_percent),
      discount_cents_input: formatCentsForInput(version.discount_cents),
      notes: version.notes, expires_at: version.expires_at ? version.expires_at.slice(0, 10) : "",
    });
    setEditingMeta(true);
  };

  const saveMeta = async () => {
    setSavingMeta(true);
    setActionError(null);
    try {
      await api("PUT", `/api/quotes/${id}/version`, {
        discount_type: metaDraft.discount_type,
        discount_percent: metaDraft.discount_type === "percent" ? parseFloat(metaDraft.discount_percent) || 0 : 0,
        discount_cents: metaDraft.discount_type === "fixed" ? (parseDollarsToCents(metaDraft.discount_cents_input) || 0) : 0,
        notes: metaDraft.notes,
        expires_at: metaDraft.expires_at || null,
      });
      setEditingMeta(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingMeta(false);
    }
  };

  const submitAddItem = async () => {
    setSavingItem(true);
    setActionError(null);
    try {
      await api("POST", `/api/quotes/${id}/line-items`, itemDraftToPayload(itemDraft));
      setShowAddItem(false);
      setItemDraft(emptyItemDraft);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingItem(false);
    }
  };

  const startEditItem = (item: QuoteLineItem) => {
    setEditingItemId(item.id);
    setItemDraft({
      description: item.description, category: item.category as LineItemCategory,
      quantity: String(item.quantity), unit: item.unit, unit_price: formatCentsForInput(item.unit_price_cents),
      taxable: !!item.taxable, pricebook_item_id: item.pricebook_item_id,
    });
  };

  // Phase 17 — copies the Pricebook item's fields into the draft ONCE; this
  // is a one-time snapshot, not a live binding (see the server-side half in
  // src/server/quotes.ts's `resolvePricebookSnapshot`). A later Pricebook
  // price change never reaches back into this already-saved line item.
  const applyPricebookSelection = (item: PricebookItem) => {
    setItemDraft((d) => ({
      ...d,
      description: item.name,
      unit: item.unit,
      unit_price: formatCentsForInput(item.sell_price_cents),
      taxable: item.taxable,
      pricebook_item_id: item.id,
    }));
    setShowPricebookPicker(false);
  };

  const submitEditItem = async () => {
    if (editingItemId === null) return;
    setSavingItem(true);
    setActionError(null);
    try {
      await api("PUT", `/api/quotes/${id}/line-items/${editingItemId}`, itemDraftToPayload(itemDraft));
      setEditingItemId(null);
      setItemDraft(emptyItemDraft);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (pendingDeleteItem === null) return;
    setSavingItem(true);
    try {
      await api("DELETE", `/api/quotes/${id}/line-items/${pendingDeleteItem}`);
      setPendingDeleteItem(null);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSavingItem(false);
    }
  };

  const confirmTransition = async () => {
    if (!pendingTransition) return;
    setTransitioning(true);
    setActionError(null);
    try {
      await api("POST", `/api/quotes/${id}/transition`, { to_status: pendingTransition, reason: transitionReason || undefined });
      setPendingTransition(null);
      setTransitionReason("");
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setTransitioning(false);
    }
  };

  const confirmRevision = async () => {
    setCreatingRevision(true);
    setActionError(null);
    try {
      await api("POST", `/api/quotes/${id}/revisions`, {});
      setPendingRevision(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const createContract = async () => {
    setCreatingContract(true);
    setActionError(null);
    try {
      const res = await api<{ contract: { id: number } }>("POST", "/api/contracts", { quote_id: quote.id });
      navigate(`/contracts/${res.contract.id}`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCreatingContract(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await api("DELETE", `/api/quotes/${id}`);
      navigate("/quotes");
    } catch (err) {
      setActionError((err as Error).message);
      setDeleting(false);
    }
  };

  const viewVersion = async (versionId: number) => {
    try {
      const res = await api<{ version: QuoteVersionDetail }>("GET", `/api/quotes/${id}/versions/${versionId}`);
      setViewingVersion(res.version);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/quotes")}><ArrowLeft size={16} /> Back</button>
        <div class="page-header-right">
          {isDraft && history.length === 0 && (
            <button class="btn btn-danger" onClick={() => setPendingDelete(true)}><Trash2 size={14} /> Delete</button>
          )}
        </div>
      </div>

      {actionError && <div class="inline-error" style={{ marginBottom: 12 }}>{actionError}</div>}

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{quote.identifier}</span>
            <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
              <span class="status-dot" style={{ background: color }} />
              {QUOTE_STATUS_LABELS[quote.status] || quote.status}
            </span>
          </div>
          <h2 class="detail-customer-name">{quote.customer_name || "—"}</h2>

          <div class="detail-meta-grid">
            {quote.lead_identifier && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Source Lead</span>
                <span class="identifier">{quote.lead_identifier}</span>
              </div>
            )}
            {version?.expires_at && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Expires</span>
                <span>{version.expires_at.slice(0, 10)}</span>
              </div>
            )}
            {quote.accepted_at && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Accepted</span>
                <span>{new Date(quote.accepted_at).toLocaleDateString()}</span>
              </div>
            )}
            {quote.status === "rejected" && quote.rejected_reason && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Rejected Reason</span>
                <span>{quote.rejected_reason}</span>
              </div>
            )}
          </div>

          {!version ? (
            <div class="empty-state"><p class="text-muted">No version data</p></div>
          ) : (
            <div class="detail-section">
              <h3>Line Items</h3>
              <div class="card">
                <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Description</th><th>Category</th><th>Qty</th><th>Unit</th>
                      <th class="text-right">Unit Price</th><th class="text-right">Total</th><th>Taxable</th>
                      {isDraft && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {version.line_items.map((item) => (
                      editingItemId === item.id ? (
                        <tr key={item.id} class="table-row">
                          <td><input type="text" value={itemDraft.description} onInput={(e) => setItemDraft({ ...itemDraft, description: (e.target as HTMLInputElement).value })} /></td>
                          <td>
                            <select value={itemDraft.category} onChange={(e) => setItemDraft({ ...itemDraft, category: (e.target as HTMLSelectElement).value as LineItemCategory })}>
                              {LINE_ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{LINE_ITEM_CATEGORY_LABELS[c]}</option>)}
                            </select>
                          </td>
                          <td style={{ width: 70 }}><input type="number" step="any" min="0.01" value={itemDraft.quantity} onInput={(e) => setItemDraft({ ...itemDraft, quantity: (e.target as HTMLInputElement).value })} /></td>
                          <td style={{ width: 80 }}><input type="text" value={itemDraft.unit} onInput={(e) => setItemDraft({ ...itemDraft, unit: (e.target as HTMLInputElement).value })} /></td>
                          <td style={{ width: 100 }}><input type="number" step="0.01" min="0" value={itemDraft.unit_price} onInput={(e) => setItemDraft({ ...itemDraft, unit_price: (e.target as HTMLInputElement).value })} /></td>
                          <td class="text-right text-muted">—</td>
                          <td><input type="checkbox" checked={itemDraft.taxable} onChange={(e) => setItemDraft({ ...itemDraft, taxable: (e.target as HTMLInputElement).checked })} /></td>
                          <td>
                            <button class="btn-icon" title="Save" disabled={savingItem} onClick={submitEditItem}>✓</button>
                            <button class="btn-icon" title="Cancel" onClick={() => { setEditingItemId(null); setItemDraft(emptyItemDraft); }}><X size={14} /></button>
                          </td>
                        </tr>
                      ) : (
                        <tr key={item.id} class="table-row">
                          <td>{item.description || "—"}</td>
                          <td class="text-muted">{LINE_ITEM_CATEGORY_LABELS[item.category] || item.category}</td>
                          <td>{item.quantity}</td>
                          <td class="text-muted">{item.unit || "—"}</td>
                          <td class="text-right">{formatCents(item.unit_price_cents)}</td>
                          <td class="text-right">{formatCents(item.total_cents)}</td>
                          <td class="text-muted">{item.taxable ? "Yes" : "No"}</td>
                          {isDraft && (
                            <td>
                              <button class="btn-icon" title="Edit" onClick={() => startEditItem(item)}><Edit3 size={12} /></button>
                              <button class="btn-icon danger" title="Delete" onClick={() => setPendingDeleteItem(item.id)}><Trash2 size={12} /></button>
                            </td>
                          )}
                        </tr>
                      )
                    ))}
                    {showAddItem && (
                      <tr class="table-row">
                        <td>
                          <div style={{ display: "flex", gap: 4 }}>
                            <input type="text" placeholder="Description" value={itemDraft.description} onInput={(e) => setItemDraft({ ...itemDraft, description: (e.target as HTMLInputElement).value, pricebook_item_id: null })} />
                            <button type="button" class="btn-icon" title="Select from Pricebook" onClick={() => setShowPricebookPicker(true)}><BookOpen size={14} /></button>
                          </div>
                        </td>
                        <td>
                          <select value={itemDraft.category} onChange={(e) => setItemDraft({ ...itemDraft, category: (e.target as HTMLSelectElement).value as LineItemCategory })}>
                            {LINE_ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{LINE_ITEM_CATEGORY_LABELS[c]}</option>)}
                          </select>
                        </td>
                        <td style={{ width: 70 }}><input type="number" step="any" min="0.01" value={itemDraft.quantity} onInput={(e) => setItemDraft({ ...itemDraft, quantity: (e.target as HTMLInputElement).value })} /></td>
                        <td style={{ width: 80 }}><input type="text" placeholder="ea" value={itemDraft.unit} onInput={(e) => setItemDraft({ ...itemDraft, unit: (e.target as HTMLInputElement).value })} /></td>
                        <td style={{ width: 100 }}><input type="number" step="0.01" placeholder="0.00" value={itemDraft.unit_price} onInput={(e) => setItemDraft({ ...itemDraft, unit_price: (e.target as HTMLInputElement).value })} /></td>
                        <td class="text-right text-muted">—</td>
                        <td><input type="checkbox" checked={itemDraft.taxable} onChange={(e) => setItemDraft({ ...itemDraft, taxable: (e.target as HTMLInputElement).checked })} /></td>
                        <td>
                          <button class="btn-icon" title="Add" disabled={savingItem} onClick={submitAddItem}>✓</button>
                          <button class="btn-icon" title="Cancel" onClick={() => { setShowAddItem(false); setItemDraft(emptyItemDraft); }}><X size={14} /></button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5} class="text-right text-muted">Subtotal</td>
                      <td class="text-right">{formatCents(version.subtotal_cents)}</td>
                    </tr>
                    {version.discount_type !== "none" && (
                      <tr>
                        <td colSpan={5} class="text-right text-muted">
                          Discount {version.discount_type === "percent" ? `(${version.discount_percent}%)` : ""}
                        </td>
                        <td class="text-right">−{formatCents(version.discount_cents)}</td>
                      </tr>
                    )}
                    {version.tax_snapshot && version.tax_snapshot.components.length > 0 ? (
                      version.tax_snapshot.components.map((comp) => comp.amount_cents !== 0 && (
                        <tr key={comp.code}>
                          <td colSpan={5} class="text-right text-muted">{comp.name} ({comp.rate_percent}%)</td>
                          <td class="text-right">{formatCents(comp.amount_cents)}</td>
                        </tr>
                      ))
                    ) : version.tax_rate > 0 && (
                      <tr>
                        <td colSpan={5} class="text-right text-muted">Tax ({version.tax_rate}%)</td>
                        <td class="text-right">{formatCents(version.tax_amount_cents)}</td>
                      </tr>
                    )}
                    <tr>
                      <td colSpan={5} class="text-right text-bold">Total</td>
                      <td class="text-right text-bold" style={{ fontSize: 16 }}>{formatCents(version.total_cents)}</td>
                    </tr>
                  </tfoot>
                </table>
                </div>
              </div>
              {isDraft && !showAddItem && (
                <button class="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { setShowAddItem(true); setItemDraft(emptyItemDraft); }}>
                  <Plus size={14} /> Add Line Item
                </button>
              )}
            </div>
          )}

          <div class="detail-section">
            <h3>Terms</h3>
            {editingMeta ? (
              <div class="form-grid" style={{ padding: 0 }}>
                <div class="form-group">
                  <label>Discount Type</label>
                  <select value={metaDraft.discount_type} onChange={(e) => setMetaDraft({ ...metaDraft, discount_type: (e.target as HTMLSelectElement).value as DiscountType })}>
                    {DISCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {metaDraft.discount_type === "percent" && (
                  <div class="form-group">
                    <label>Discount %</label>
                    <input type="number" step="0.01" min="0" max="100" value={metaDraft.discount_percent} onInput={(e) => setMetaDraft({ ...metaDraft, discount_percent: (e.target as HTMLInputElement).value })} />
                  </div>
                )}
                {metaDraft.discount_type === "fixed" && (
                  <div class="form-group">
                    <label>Discount Amount ($)</label>
                    <input type="number" step="0.01" min="0" value={metaDraft.discount_cents_input} onInput={(e) => setMetaDraft({ ...metaDraft, discount_cents_input: (e.target as HTMLInputElement).value })} />
                  </div>
                )}
                <div class="form-group">
                  <label>Expires</label>
                  <input type="date" value={metaDraft.expires_at} onChange={(e) => setMetaDraft({ ...metaDraft, expires_at: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="form-group full-width">
                  <label>Notes</label>
                  <textarea rows={3} value={metaDraft.notes} onInput={(e) => setMetaDraft({ ...metaDraft, notes: (e.target as HTMLTextAreaElement).value })} />
                </div>
                <div class="form-group full-width" style={{ display: "flex", gap: 8 }}>
                  <button class="btn btn-sm" onClick={() => setEditingMeta(false)} disabled={savingMeta}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={saveMeta} disabled={savingMeta}>{savingMeta ? "Saving..." : "Save"}</button>
                </div>
              </div>
            ) : (
              <>
                <p class="detail-notes">{version?.notes || <span class="text-muted">No notes</span>}</p>
                {isDraft && <button class="btn btn-sm" onClick={startEditMeta}>Edit</button>}
              </>
            )}
          </div>

          <div class="detail-section">
            <h3>Status History</h3>
            {history.length === 0 ? (
              <p class="text-muted">No history yet</p>
            ) : (
              <div class="card">
                <table class="table">
                  <thead><tr><th>From</th><th>To</th><th>When</th><th>Reason</th></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} class="table-row">
                        <td>{h.old_status ? (QUOTE_STATUS_LABELS[h.old_status] || h.old_status) : "—"}</td>
                        <td>{QUOTE_STATUS_LABELS[h.new_status] || h.new_status}</td>
                        <td class="text-muted">{new Date(h.created_at).toLocaleString()}</td>
                        <td class="text-muted">{h.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div class="detail-section">
            <h3>Revision History</h3>
            <div class="card">
              <table class="table">
                <thead><tr><th>Version</th><th class="text-right">Total</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} class="table-row">
                      <td>#{v.version_number}{v.id === quote.current_version_id ? " (current)" : ""}</td>
                      <td class="text-right">{formatCents(v.total_cents)}</td>
                      <td class="text-muted">{new Date(v.created_at).toLocaleDateString()}</td>
                      <td><button class="btn btn-sm" onClick={() => viewVersion(v.id)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <RelatedContracts quoteId={quote.id} navigate={navigate} />
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Actions</h4>
            {allowed.length === 0 && !canCreateRevision && quote.status !== "accepted" ? (
              <p class="text-muted">No further actions available</p>
            ) : (
              <div class="status-buttons">
                {allowed.map((s) => (
                  <button key={s} class="status-btn" onClick={() => { setPendingTransition(s); setTransitionReason(""); }}>
                    Mark as {QUOTE_STATUS_LABELS[s] || s}
                  </button>
                ))}
                {canCreateRevision && (
                  <button class="status-btn" onClick={() => setPendingRevision(true)}>Create Revision</button>
                )}
                {/* Section 45 — explicit staff action on the Quote itself;
                    a Contract is never auto-created on acceptance. */}
                {quote.status === "accepted" && (
                  <button class="status-btn" disabled={creatingContract} onClick={createContract}>
                    {creatingContract ? "Creating..." : "Create Contract"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingDeleteItem !== null && (
        <ConfirmDialog
          title="Remove this line item?"
          message="This line item will be removed and totals recalculated."
          confirmLabel="Remove" danger
          submitting={savingItem}
          onConfirm={confirmDeleteItem}
          onClose={() => setPendingDeleteItem(null)}
        />
      )}

      {pendingTransition && (
        <div class="modal-overlay" onClick={() => !transitioning && setPendingTransition(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Mark quote as {QUOTE_STATUS_LABELS[pendingTransition] || pendingTransition}?</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setPendingTransition(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Reason {pendingTransition === "rejected" ? "" : "(optional)"}</label>
                <textarea rows={2} value={transitionReason} onInput={(e) => setTransitionReason((e.target as HTMLTextAreaElement).value)} />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingTransition(null)} disabled={transitioning}>Cancel</button>
              <button type="button" class="btn btn-primary" disabled={transitioning} onClick={confirmTransition}>
                {transitioning ? "Please wait..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRevision && (
        <ConfirmDialog
          title="Create a new revision?"
          message="This creates a new draft version copied from the current one, and moves the quote back to Draft for editing. Prior versions remain in history and cannot be changed."
          confirmLabel="Create Revision"
          submitting={creatingRevision}
          onConfirm={confirmRevision}
          onClose={() => setPendingRevision(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this draft quote?"
          message={`This permanently deletes draft quote ${quote.identifier}. This cannot be undone.`}
          confirmLabel="Delete" danger
          submitting={deleting}
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}

      {showPricebookPicker && (
        <PricebookPicker onSelect={applyPricebookSelection} onClose={() => setShowPricebookPicker(false)} />
      )}

      {viewingVersion && (
        <div class="modal-overlay" onClick={() => setViewingVersion(null)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Version #{viewingVersion.version_number}</h2>
              <button class="btn-icon" aria-label="Close" onClick={() => setViewingVersion(null)}><X size={18} /></button>
            </div>
            <table class="table">
              <thead><tr><th>Description</th><th>Qty</th><th class="text-right">Unit Price</th><th class="text-right">Total</th></tr></thead>
              <tbody>
                {viewingVersion.line_items.map((item) => (
                  <tr key={item.id} class="table-row">
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td class="text-right">{formatCents(item.unit_price_cents)}</td>
                    <td class="text-right">{formatCents(item.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={3} class="text-right text-bold">Total</td><td class="text-right text-bold">{formatCents(viewingVersion.total_cents)}</td></tr>
              </tfoot>
            </table>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setViewingVersion(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
