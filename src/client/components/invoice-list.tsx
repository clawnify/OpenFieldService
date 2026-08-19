import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { Pagination } from "./pagination";
import { ConfirmDialog } from "./confirm-dialog";
import { formatCents } from "../money";
import { Trash2 } from "lucide-preact";
import type { InvoiceStatus } from "../types";

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "partially_paid", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: "#6b7280",
  issued: "#3b82f6",
  partially_paid: "#ca8a04",
  paid: "#16a34a",
  void: "#9ca3af",
};

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  partially_paid: "Partially Paid",
  paid: "Paid",
  void: "Void",
};

export function InvoiceList() {
  const {
    invoices, invoicesPag, setInvoicesPage, invoicesStatusFilter, setInvoicesStatusFilter,
    navigate, deleteInvoice, setError,
  } = useApp();
  const { user } = useAuth();
  const canManageFinancials = user?.role === "admin" || user?.role === "dispatcher";
  const [pendingDelete, setPendingDelete] = useState<{ id: number; identifier: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteInvoice(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

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
            <p class="text-muted">Invoices are generated automatically when a job is completed</p>
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
                <th class="text-right">Balance</th>
                <th class="text-right">Total</th>
                {canManageFinancials && <th>Actions</th>}
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
                        {STATUS_LABELS[(inv.status as InvoiceStatus)] || inv.status}
                        {inv.is_overdue && " · Overdue"}
                      </span>
                    </td>
                    <td class="text-muted">{inv.due_date || "—"}</td>
                    <td class="text-right">{formatCents(inv.balance_cents)}</td>
                    <td class="text-bold text-right">{formatCents(inv.total_cents)}</td>
                    {canManageFinancials && (
                      <td>
                        {inv.status === "draft" && (
                          <button class="btn-icon danger" title="Delete draft" onClick={(e) => { e.stopPropagation(); setPendingDelete({ id: inv.id, identifier: inv.identifier }); }}>
                            <Trash2 size={14} />
                          </button>
                        )}
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

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this draft invoice?"
          message={`This permanently deletes draft invoice ${pendingDelete.identifier}. This cannot be undone. Once an invoice is issued it can only be voided, not deleted.`}
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={handleConfirmDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
