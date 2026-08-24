import { useState } from "preact/hooks";
import { api } from "../api";
import { CustomerSearchSelect } from "./customer-search-select";
import { X } from "lucide-preact";

/**
 * Phase 12 — Create Quote. Deliberately minimal (matches create-job.tsx's
 * "collect identity, then edit everything else on the detail page"
 * precedent): only Customer is collected here. The quote starts with zero
 * line items — the detail page's line-item editor is where the real work
 * happens, same "start empty, build up via the detail page" shape as
 * Assets/Invoices. Lead linkage (optional, Section 14) is set via a
 * dedicated "Create Quote" action on Lead Detail instead of a field here —
 * most quotes don't originate from a Lead, and a Lead-linked quote needs an
 * already-known Customer (typically the Lead's own converted_customer_id)
 * anyway, which that dedicated flow already has in hand.
 */
export function CreateQuote({ onClose, onCreated }: { onClose: () => void; onCreated: (quoteId: number) => void }) {
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (customerId === null) { setError("Select a customer"); return; }
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ quote: { id: number } }>("POST", "/api/quotes", { customer_id: customerId });
      onCreated(res.quote.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={() => !creating && onClose()}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>New Quote</h2>
          <button class="btn-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div class="form-grid">
          <div class="form-group full-width">
            <label>Customer *</label>
            <CustomerSearchSelect value={customerId} valueLabel={customerLabel} onChange={(id, label) => { setCustomerId(id); setCustomerLabel(label); }} />
          </div>
          {error && <div class="inline-error" style={{ margin: "0 0 0 0" }}>{error}</div>}
          <div class="form-group full-width">
            <p class="text-muted" style={{ fontSize: 12 }}>
              A draft quote will be created for this customer. Add line items, pricing, and terms on the next screen.
            </p>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose} disabled={creating}>Cancel</button>
          <button type="button" class="btn btn-primary" disabled={creating || customerId === null} onClick={handleCreate}>
            {creating ? "Please wait..." : "Create Quote"}
          </button>
        </div>
      </div>
    </div>
  );
}
