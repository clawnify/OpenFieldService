import { StatusBadge } from "./status-badge";
import { useApp } from "../context";
import { ArrowLeft, Trash2 } from "lucide-preact";
import type { InvoiceStatus } from "../types";

const ALL_STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "cancelled"];

export function InvoiceDetail() {
  const { selectedInvoice: invoice, navigate, updateInvoice, deleteInvoice } = useApp();

  if (!invoice) return null;

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/invoices")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          <button class="btn btn-danger" onClick={() => deleteInvoice(invoice.id)}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{invoice.identifier}</span>
            <StatusBadge status={invoice.status} />
          </div>

          <div class="detail-meta-grid">
            <div class="detail-meta-item">
              <span class="detail-meta-label">Customer</span>
              <span>{invoice.customer_name || "—"}</span>
            </div>
            {invoice.job_identifier && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Job</span>
                <span class="identifier">{invoice.job_identifier}</span>
              </div>
            )}
            <div class="detail-meta-item">
              <span class="detail-meta-label">Due Date</span>
              <span>{invoice.due_date || "Not set"}</span>
            </div>
            {invoice.paid_date && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Paid Date</span>
                <span>{invoice.paid_date}</span>
              </div>
            )}
          </div>

          {/* Line items */}
          <div class="detail-section">
            <h3>Line Items</h3>
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr><th>Description</th><th>Qty</th><th>Unit Price</th><th class="text-right">Total</th></tr>
                </thead>
                <tbody>
                  {(invoice.lines || []).map((line) => (
                    <tr key={line.id} class="table-row">
                      <td>{line.description}</td>
                      <td>{line.quantity}</td>
                      <td>${line.unit_price.toFixed(2)}</td>
                      <td class="text-right">${line.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} class="text-right text-muted">Subtotal</td>
                    <td class="text-right">${invoice.subtotal.toFixed(2)}</td>
                  </tr>
                  {invoice.tax_rate > 0 && (
                    <tr>
                      <td colSpan={3} class="text-right text-muted">Tax ({invoice.tax_rate}%)</td>
                      <td class="text-right">${invoice.tax_amount.toFixed(2)}</td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={3} class="text-right text-bold">Total</td>
                    <td class="text-right text-bold" style={{ fontSize: 16 }}>${invoice.total.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {invoice.notes && (
            <div class="detail-section">
              <h3>Notes</h3>
              <p class="detail-notes">{invoice.notes}</p>
            </div>
          )}
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Status</h4>
            <div class="status-buttons">
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  class={`status-btn ${invoice.status === s ? "active" : ""}`}
                  onClick={() => updateInvoice(invoice.id, { status: s, ...(s === "paid" ? { paid_date: new Date().toISOString().split("T")[0] } : {}) })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div class="detail-sidebar-section">
            <h4>Due Date</h4>
            <input
              type="date"
              value={invoice.due_date}
              onChange={(e) => updateInvoice(invoice.id, { due_date: (e.target as HTMLInputElement).value })}
              style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: 13 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
