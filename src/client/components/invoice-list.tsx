import { useApp } from "../context";
import { Pagination } from "./pagination";
import { Trash2 } from "lucide-preact";
import type { InvoiceStatus } from "../types";

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: "#6b7280",
  sent: "#3b82f6",
  paid: "#16a34a",
  overdue: "#dc2626",
  cancelled: "#9ca3af",
};

export function InvoiceList() {
  const {
    invoices, invoicesPag, setInvoicesPage, invoicesStatusFilter, setInvoicesStatusFilter,
    navigate, deleteInvoice, isAgent,
  } = useApp();

  return (
    <div class="page">
      <div class="page-header">
        <h1>Invoices</h1>
      </div>

      <div class="toolbar">
        <div class="filter-group">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              class={`filter-btn ${invoicesStatusFilter === s.value ? "active" : ""}`}
              onClick={() => setInvoicesStatusFilter(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div class="card">
        {invoices.length === 0 ? (
          <div class="empty-state">
            <p>No invoices yet</p>
            <p class="text-muted">Create invoices from completed jobs</p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Job</th>
                <th>Status</th>
                <th>Due Date</th>
                <th>Total</th>
                {isAgent && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const color = STATUS_COLORS[(inv.status as InvoiceStatus)] || "#6b7280";
                return (
                  <tr key={inv.id} class="table-row clickable" onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <td><span class="identifier">{inv.identifier}</span></td>
                    <td>{inv.customer_name || "—"}</td>
                    <td class="text-muted">{inv.job_identifier || "—"}</td>
                    <td>
                      <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
                        <span class="status-dot" style={{ background: color }} />
                        {inv.status}
                      </span>
                    </td>
                    <td class="text-muted">{inv.due_date || "—"}</td>
                    <td class="text-bold">${inv.total.toFixed(2)}</td>
                    {isAgent && (
                      <td>
                        <button class="btn-icon danger" onClick={(e) => { e.stopPropagation(); deleteInvoice(inv.id); }}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Pagination pag={invoicesPag} setPage={setInvoicesPage} />
    </div>
  );
}
