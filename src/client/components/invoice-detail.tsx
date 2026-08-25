import { useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import { ConfirmDialog } from "./confirm-dialog";
import { NotificationHistory } from "./notification-history";
import { formatCents } from "../money";
import { ArrowLeft, Trash2, X } from "lucide-preact";
import type { DeliveryStatus, InvoiceStatus, PayerType, Payment, PaymentMethod } from "../types";

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

const PAYER_TYPE_LABELS: Record<PayerType, string> = {
  customer: "Customer",
  government: "Government Rebate",
  third_party: "Third Party",
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  check: "Check",
  credit_card: "Credit Card",
  debit_card: "Debit Card",
  e_transfer: "E-Transfer",
  bank_transfer: "Bank Transfer",
  financing: "Financing",
  other: "Other",
};

const PAYMENT_SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  online_provider: "Online",
};

// Phase 13B — Receipt PDF View/Download/Print, same route/window.open
// convention as the Invoice PDF helpers above.
function viewReceiptPdf(paymentId: number): void {
  window.open(`/api/payments/${paymentId}/receipt-pdf`, "_blank", "noopener,noreferrer");
}
function downloadReceiptPdf(paymentId: number): void {
  window.open(`/api/payments/${paymentId}/receipt-pdf?mode=download`, "_blank", "noopener,noreferrer");
}
function printReceiptPdf(paymentId: number): void {
  const win = window.open(`/api/payments/${paymentId}/receipt-pdf`, "_blank");
  if (!win) return;
  win.addEventListener("load", () => win.print());
}

// Phase 13A final document hardening — Section 46: View/Download/Print,
// all backed by the same live-rendered PDF route (see invoice-pdf.ts's
// own header comment for why this one is rendered fresh on every request
// rather than a stored immutable artifact like the signed Contract PDF).
function viewInvoicePdf(invoiceId: number): void {
  window.open(`/api/invoices/${invoiceId}/pdf`, "_blank", "noopener,noreferrer");
}
function downloadInvoicePdf(invoiceId: number): void {
  window.open(`/api/invoices/${invoiceId}/pdf?mode=download`, "_blank", "noopener,noreferrer");
}
function printInvoicePdf(invoiceId: number): void {
  const win = window.open(`/api/invoices/${invoiceId}/pdf`, "_blank");
  if (!win) return;
  win.addEventListener("load", () => win.print());
}

export function InvoiceDetail() {
  const {
    selectedInvoice: invoice, navigate, updateInvoice, deleteInvoice,
    issueInvoice, voidInvoice, setInvoiceRebate, recordPayment, voidPayment, setError,
  } = useApp();
  const { user } = useAuth();

  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingIssue, setPendingIssue] = useState(false);
  const [issuing, setIssuing] = useState(false);

  const [showVoidInvoice, setShowVoidInvoice] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidingInvoice, setVoidingInvoice] = useState(false);

  const [editingMeta, setEditingMeta] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [pendingSaveMeta, setPendingSaveMeta] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  const [editingRebate, setEditingRebate] = useState(false);
  const [rebateDraft, setRebateDraft] = useState("");
  const [pendingSaveRebate, setPendingSaveRebate] = useState(false);
  const [savingRebate, setSavingRebate] = useState(false);

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentDraft, setPaymentDraft] = useState({
    amount: "", payer_type: "customer" as PayerType, method: "cash" as PaymentMethod, reference: "", notes: "",
    received_by: "", email_receipt: false,
  });
  const [pendingRecordPayment, setPendingRecordPayment] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);

  const [pendingVoidPayment, setPendingVoidPayment] = useState<number | null>(null);
  const [voidPaymentReason, setVoidPaymentReason] = useState("");
  const [voidingPayment, setVoidingPayment] = useState(false);

  // Phase 13B — Invoice Delivery / Online Payment / Receipts state.
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus | null>(null);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [paymentLink, setPaymentLink] = useState<string | null>(null);
  const [receiptStatuses, setReceiptStatuses] = useState<Record<number, DeliveryStatus>>({});
  const [emailingReceiptFor, setEmailingReceiptFor] = useState<number | null>(null);

  const loadDeliveryAndConfig = async (invoiceId: number, payments: Payment[]) => {
    try {
      const [deliveryRes, configRes] = await Promise.all([
        api<{ delivery: DeliveryStatus }>("GET", `/api/invoices/${invoiceId}/delivery-status`),
        api<{ enabled: boolean }>("GET", "/api/config/payments"),
      ]);
      setDeliveryStatus(deliveryRes.delivery);
      setPaymentsEnabled(configRes.enabled);
    } catch {
      // best-effort — the page still works fully without this supplementary status
    }
    const nonVoided = payments.filter((p) => !p.voided_at);
    const entries = await Promise.all(nonVoided.map(async (p) => {
      try {
        const res = await api<{ delivery: DeliveryStatus }>("GET", `/api/payments/${p.id}/receipt-status`);
        return [p.id, res.delivery] as const;
      } catch {
        return null;
      }
    }));
    setReceiptStatuses(Object.fromEntries(entries.filter((e): e is [number, DeliveryStatus] => e !== null)));
  };

  useEffect(() => {
    if (!invoice) return;
    setPaymentLink(null);
    void loadDeliveryAndConfig(invoice.id, invoice.payments || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id, invoice?.payments?.length]);

  if (!invoice) return null;

  const color = STATUS_COLORS[(invoice.status as InvoiceStatus)] || "#6b7280";
  const canRecordPayment = invoice.status === "issued" || invoice.status === "partially_paid";
  const canVoid = invoice.status !== "void";

  const startEditMeta = () => {
    setDueDateDraft(invoice.due_date);
    setNotesDraft(invoice.notes);
    setEditingMeta(true);
  };

  const handleConfirmSaveMeta = async () => {
    setSavingMeta(true);
    try {
      await updateInvoice(invoice.id, { due_date: dueDateDraft, notes: notesDraft });
      setEditingMeta(false);
      setPendingSaveMeta(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingMeta(false);
    }
  };

  const startEditRebate = () => {
    setRebateDraft((invoice.rebate_amount_cents / 100).toFixed(2));
    setEditingRebate(true);
  };

  const handleConfirmSaveRebate = async () => {
    setSavingRebate(true);
    try {
      const cents = Math.round(parseFloat(rebateDraft || "0") * 100);
      await setInvoiceRebate(invoice.id, cents);
      setEditingRebate(false);
      setPendingSaveRebate(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRebate(false);
    }
  };

  const handleConfirmIssue = async () => {
    setIssuing(true);
    try {
      await issueInvoice(invoice.id);
      setPendingIssue(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIssuing(false);
    }
  };

  const handleConfirmVoidInvoice = async () => {
    if (!voidReason.trim()) { setError("A reason is required to void an invoice"); return; }
    setVoidingInvoice(true);
    try {
      await voidInvoice(invoice.id, voidReason.trim());
      setShowVoidInvoice(false);
      setVoidReason("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVoidingInvoice(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteInvoice(invoice.id);
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  const handleConfirmRecordPayment = async () => {
    const amountCents = Math.round(parseFloat(paymentDraft.amount || "0") * 100);
    setRecordingPayment(true);
    try {
      await recordPayment(invoice.id, {
        amount_cents: amountCents, payer_type: paymentDraft.payer_type, method: paymentDraft.method,
        reference: paymentDraft.reference, notes: paymentDraft.notes,
        received_by: paymentDraft.received_by, email_receipt: paymentDraft.email_receipt,
      });
      setShowPaymentForm(false);
      setPendingRecordPayment(false);
      setPaymentDraft({ amount: "", payer_type: "customer", method: "cash", reference: "", notes: "", received_by: "", email_receipt: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecordingPayment(false);
    }
  };

  const handleSendInvoice = async () => {
    setSendingInvoice(true);
    try {
      await api("POST", `/api/invoices/${invoice.id}/send`, {});
      const res = await api<{ delivery: DeliveryStatus }>("GET", `/api/invoices/${invoice.id}/delivery-status`);
      setDeliveryStatus(res.delivery);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendingInvoice(false);
    }
  };

  const handleGeneratePaymentLink = async () => {
    setGeneratingLink(true);
    try {
      const res = await api<{ url: string }>("POST", `/api/invoices/${invoice.id}/payment-link`, {});
      setPaymentLink(res.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleEmailReceipt = async (paymentId: number) => {
    setEmailingReceiptFor(paymentId);
    try {
      await api("POST", `/api/payments/${paymentId}/email-receipt`, {});
      const res = await api<{ delivery: DeliveryStatus }>("GET", `/api/payments/${paymentId}/receipt-status`);
      setReceiptStatuses((prev) => ({ ...prev, [paymentId]: res.delivery }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEmailingReceiptFor(null);
    }
  };

  const handleConfirmVoidPayment = async () => {
    if (pendingVoidPayment === null) return;
    if (!voidPaymentReason.trim()) { setError("A reason is required to void a payment"); return; }
    setVoidingPayment(true);
    try {
      await voidPayment(pendingVoidPayment, invoice.id, voidPaymentReason.trim());
      setPendingVoidPayment(null);
      setVoidPaymentReason("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVoidingPayment(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <button class="btn btn-back" onClick={() => navigate("/invoices")}>
          <ArrowLeft size={16} /> Back
        </button>
        <div class="page-header-right">
          {invoice.status === "draft" && (
            <button class="btn btn-danger" onClick={() => setPendingDelete(true)}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-title-row">
            <span class="identifier-lg">{invoice.identifier}</span>
            <span class="status-badge" style={{ background: `${color}14`, color, borderColor: `${color}30` }}>
              <span class="status-dot" style={{ background: color }} />
              {STATUS_LABELS[(invoice.status as InvoiceStatus)] || invoice.status}
            </span>
            {invoice.is_overdue && <span class="status-badge" style={{ background: "#dc262614", color: "#dc2626", borderColor: "#dc262630" }}>Overdue</span>}
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
            {invoice.issued_at && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Issued</span>
                <span>{new Date(invoice.issued_at).toLocaleDateString()}</span>
              </div>
            )}
            {invoice.voided_at && (
              <div class="detail-meta-item">
                <span class="detail-meta-label">Voided</span>
                <span>{new Date(invoice.voided_at).toLocaleDateString()} — {invoice.void_reason}</span>
              </div>
            )}
          </div>

          {/* Line items */}
          <div class="detail-section">
            <h3>Line Items</h3>
            <div class="card">
              <table class="table">
                <thead>
                  <tr><th>Description</th><th>Qty</th><th>Unit Price</th><th class="text-right">Total</th></tr>
                </thead>
                <tbody>
                  {(invoice.lines || []).map((line) => (
                    <tr key={line.id} class="table-row">
                      <td>{line.description}</td>
                      <td>{line.quantity}</td>
                      <td>{formatCents(line.unit_price_cents)}</td>
                      <td class="text-right">{formatCents(line.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} class="text-right text-muted">Subtotal</td>
                    <td class="text-right">{formatCents(invoice.subtotal_cents)}</td>
                  </tr>
                  {invoice.tax_rate > 0 && (
                    <tr>
                      <td colSpan={3} class="text-right text-muted">Tax ({invoice.tax_rate}%)</td>
                      <td class="text-right">{formatCents(invoice.tax_amount_cents)}</td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={3} class="text-right text-bold">Total</td>
                    <td class="text-right text-bold" style={{ fontSize: 16 }}>{formatCents(invoice.total_cents)}</td>
                  </tr>
                  {invoice.rebate_amount_cents > 0 && (
                    <>
                      <tr>
                        <td colSpan={3} class="text-right text-muted">Government Rebate</td>
                        <td class="text-right">−{formatCents(invoice.rebate_amount_cents)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} class="text-right text-bold">Customer Owes</td>
                        <td class="text-right text-bold">{formatCents(invoice.customer_amount_cents)}</td>
                      </tr>
                    </>
                  )}
                  <tr>
                    <td colSpan={3} class="text-right text-muted">Amount Paid</td>
                    <td class="text-right">{formatCents(invoice.amount_paid_cents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} class="text-right text-bold">Balance Due</td>
                    <td class="text-right text-bold" style={{ fontSize: 16, color: invoice.balance_cents > 0 ? "#dc2626" : "#16a34a" }}>
                      {formatCents(invoice.balance_cents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Payments */}
          <div class="detail-section">
            <h3>Payments</h3>
            <div class="card">
              {(invoice.payments || []).length === 0 ? (
                <div class="empty-state"><p class="text-muted">No payments recorded yet</p></div>
              ) : (
                <table class="table">
                  <thead>
                    <tr>
                      <th>Date</th><th>Payer</th><th>Method</th><th>Source</th><th>Reference</th>
                      <th class="text-right">Amount</th><th>Receipt</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoice.payments || []).map((p) => {
                      const receiptStatus = receiptStatuses[p.id];
                      return (
                        <tr key={p.id} class="table-row" style={p.voided_at ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                          <td class="text-muted">{new Date(p.paid_at).toLocaleDateString()}</td>
                          <td>{PAYER_TYPE_LABELS[p.payer_type] || p.payer_type}</td>
                          <td class="text-muted">{PAYMENT_METHOD_LABELS[p.method] || p.method}</td>
                          <td class="text-muted">{PAYMENT_SOURCE_LABELS[p.source] || p.source}</td>
                          <td class="text-muted">{p.reference || "—"}</td>
                          <td class="text-right text-bold">{formatCents(p.amount_cents)}</td>
                          <td>
                            {!p.voided_at && (
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                                <button class="btn-icon" title="View Receipt" onClick={() => viewReceiptPdf(p.id)}>View</button>
                                <button class="btn-icon" title="Download Receipt" onClick={() => downloadReceiptPdf(p.id)}>DL</button>
                                <button class="btn-icon" title="Print Receipt" onClick={() => printReceiptPdf(p.id)}>Print</button>
                                <button
                                  class="btn-icon" title="Email Receipt" disabled={emailingReceiptFor === p.id}
                                  onClick={() => handleEmailReceipt(p.id)}
                                >
                                  {emailingReceiptFor === p.id ? "…" : "Email"}
                                </button>
                                {receiptStatus && receiptStatus.total > 0 && (
                                  <span class="text-muted" style={{ fontSize: 11 }}>
                                    {receiptStatus.failed > 0 ? "⚠ failed" : receiptStatus.sent > 0 ? "✓ sent" : "pending"}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td>
                            {!p.voided_at && (
                              <button class="btn-icon danger" title="Void payment" onClick={() => setPendingVoidPayment(p.id)}>
                                <X size={12} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {canRecordPayment && (
              <button class="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowPaymentForm(true)}>Record Payment</button>
            )}
          </div>

          <div class="detail-section">
            <h3>Notes</h3>
            {editingMeta ? (
              <div class="form-grid" style={{ padding: 0 }}>
                <div class="form-group full-width">
                  <label>Due Date</label>
                  <input type="date" value={dueDateDraft} onChange={(e) => setDueDateDraft((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group full-width">
                  <label>Notes</label>
                  <textarea rows={3} value={notesDraft} onInput={(e) => setNotesDraft((e.target as HTMLTextAreaElement).value)} />
                </div>
                <div class="form-group full-width" style={{ display: "flex", gap: 8 }}>
                  <button class="btn btn-sm" onClick={() => setEditingMeta(false)}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={() => setPendingSaveMeta(true)}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <p class="detail-notes">{invoice.notes || <span class="text-muted">No notes</span>}</p>
                <button class="btn btn-sm" onClick={startEditMeta}>Edit</button>
              </>
            )}
          </div>

          <NotificationHistory entityType="invoice" entityId={invoice.id} role={user?.role} />
        </div>

        <div class="detail-sidebar">
          <div class="detail-sidebar-section">
            <h4>Actions</h4>
            <div class="status-buttons">
              {invoice.status === "draft" && (
                <button class="status-btn" onClick={() => setPendingIssue(true)}>Issue Invoice</button>
              )}
              {canVoid && (
                <button class="status-btn" onClick={() => setShowVoidInvoice(true)}>Void Invoice</button>
              )}
              {!canVoid && <p class="text-muted" style={{ fontSize: 12 }}>This invoice is void.</p>}
            </div>
          </div>

          <div class="detail-sidebar-section">
            <h4>Invoice PDF</h4>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button class="btn btn-sm" onClick={() => viewInvoicePdf(invoice.id)}>View</button>
              <button class="btn btn-sm" onClick={() => downloadInvoicePdf(invoice.id)}>Download</button>
              <button class="btn btn-sm" onClick={() => printInvoicePdf(invoice.id)}>Print</button>
            </div>
          </div>

          {invoice.status !== "draft" && (
            <div class="detail-sidebar-section">
              <h4>Invoice Delivery</h4>
              <button class="btn btn-sm" disabled={sendingInvoice} onClick={handleSendInvoice}>
                {sendingInvoice ? "Sending..." : deliveryStatus && deliveryStatus.total > 0 ? "Resend Invoice" : "Send Invoice"}
              </button>
              {deliveryStatus && deliveryStatus.total > 0 && (
                <p class="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {deliveryStatus.failed > 0
                    ? `⚠ Delivery failed${deliveryStatus.last_error ? `: ${deliveryStatus.last_error}` : ""}`
                    : deliveryStatus.sent > 0
                      ? `✓ Sent${deliveryStatus.last_sent_at ? ` — ${new Date(deliveryStatus.last_sent_at).toLocaleString()}` : ""}`
                      : "Pending delivery..."}
                </p>
              )}
            </div>
          )}

          {invoice.status !== "draft" && invoice.status !== "void" && invoice.balance_cents > 0 && (
            <div class="detail-sidebar-section">
              <h4>Pay Online</h4>
              {paymentsEnabled ? (
                <>
                  <button class="btn btn-sm" disabled={generatingLink} onClick={handleGeneratePaymentLink}>
                    {generatingLink ? "Generating..." : "Generate Payment Link"}
                  </button>
                  {paymentLink && (
                    <div style={{ marginTop: 8 }}>
                      <input type="text" readOnly value={paymentLink} style={{ width: "100%", fontSize: 11 }} onClick={(e) => (e.target as HTMLInputElement).select()} />
                      <p class="text-muted" style={{ fontSize: 11, marginTop: 4 }}>Share this link with the customer — shown once.</p>
                    </div>
                  )}
                </>
              ) : (
                <p class="text-muted" style={{ fontSize: 12 }}>Online payment is not configured.</p>
              )}
            </div>
          )}

          <div class="detail-sidebar-section">
            <h4>Rebate</h4>
            {editingRebate ? (
              <div class="form-grid" style={{ padding: 0 }}>
                <div class="form-group full-width">
                  <label>Rebate Amount ($)</label>
                  <input type="number" step="0.01" min="0" value={rebateDraft} onInput={(e) => setRebateDraft((e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-group full-width" style={{ display: "flex", gap: 8 }}>
                  <button class="btn btn-sm" onClick={() => setEditingRebate(false)}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={() => setPendingSaveRebate(true)}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <p class="text-muted" style={{ marginBottom: 4 }}>
                  Rebate: {formatCents(invoice.rebate_amount_cents)}<br />
                  Customer owes: {formatCents(invoice.customer_amount_cents)}
                </p>
                {invoice.status !== "void" && <button class="btn btn-sm" onClick={startEditRebate}>Correct Rebate Amount</button>}
              </>
            )}
          </div>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this draft invoice?"
          message={`This permanently deletes draft invoice ${invoice.identifier}. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          submitting={deleting}
          onConfirm={handleConfirmDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}

      {pendingIssue && (
        <ConfirmDialog
          title="Issue this invoice?"
          message={`Invoice ${invoice.identifier} will be marked issued and become eligible for payments. This cannot be reverted to draft.`}
          confirmLabel="Issue"
          submitting={issuing}
          onConfirm={handleConfirmIssue}
          onClose={() => setPendingIssue(false)}
        />
      )}

      {pendingSaveMeta && (
        <ConfirmDialog
          title="Save changes?"
          message="Update this invoice's due date and notes?"
          confirmLabel="Save"
          submitting={savingMeta}
          onConfirm={handleConfirmSaveMeta}
          onClose={() => setPendingSaveMeta(false)}
        />
      )}

      {pendingSaveRebate && (
        <ConfirmDialog
          title="Update rebate amount?"
          message={`Set the government rebate amount to $${rebateDraft || "0.00"}? This is logged permanently to the invoice's audit history.`}
          confirmLabel="Save"
          submitting={savingRebate}
          onConfirm={handleConfirmSaveRebate}
          onClose={() => setPendingSaveRebate(false)}
        />
      )}

      {pendingRecordPayment && (
        <ConfirmDialog
          title="Record this payment?"
          message={`Record a $${paymentDraft.amount || "0.00"} payment from ${PAYER_TYPE_LABELS[paymentDraft.payer_type]} via ${PAYMENT_METHOD_LABELS[paymentDraft.method]}? This cannot be edited afterward — only voided.`}
          confirmLabel="Record Payment"
          submitting={recordingPayment}
          onConfirm={handleConfirmRecordPayment}
          onClose={() => setPendingRecordPayment(false)}
        />
      )}

      {showVoidInvoice && (
        <div class="modal-overlay" onClick={() => !voidingInvoice && setShowVoidInvoice(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Void this invoice?</h2>
              <button class="btn-icon" onClick={() => setShowVoidInvoice(false)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Reason *</label>
                <textarea
                  rows={3} value={voidReason}
                  onInput={(e) => setVoidReason((e.target as HTMLTextAreaElement).value)}
                  placeholder="Why is this invoice being voided?"
                  required
                />
              </div>
              <div class="form-group full-width">
                <p class="text-muted" style={{ fontSize: 12 }}>
                  Voiding does not reverse any payments already recorded — this app has no refund/credit process. The invoice will simply stop counting as active/billable.
                </p>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setShowVoidInvoice(false)} disabled={voidingInvoice}>Cancel</button>
              <button type="button" class="btn btn-danger" disabled={voidingInvoice || !voidReason.trim()} onClick={handleConfirmVoidInvoice}>
                {voidingInvoice ? "Please wait..." : "Void Invoice"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaymentForm && (
        <div class="modal-overlay" onClick={() => !recordingPayment && setShowPaymentForm(false)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Record Payment</h2>
              <button class="btn-icon" onClick={() => setShowPaymentForm(false)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Amount ($) *</label>
                <input
                  type="number" step="0.01" min="0.01" value={paymentDraft.amount}
                  onInput={(e) => setPaymentDraft({ ...paymentDraft, amount: (e.target as HTMLInputElement).value })}
                />
                <p class="text-muted" style={{ fontSize: 12, marginTop: 2 }}>Remaining balance: {formatCents(invoice.balance_cents)}</p>
              </div>
              <div class="form-group">
                <label>Payer</label>
                <select
                  value={paymentDraft.payer_type}
                  onChange={(e) => setPaymentDraft({ ...paymentDraft, payer_type: (e.target as HTMLSelectElement).value as PayerType })}
                >
                  {(Object.keys(PAYER_TYPE_LABELS) as PayerType[]).map((k) => <option key={k} value={k}>{PAYER_TYPE_LABELS[k]}</option>)}
                </select>
              </div>
              <div class="form-group">
                <label>Method</label>
                <select
                  value={paymentDraft.method}
                  onChange={(e) => setPaymentDraft({ ...paymentDraft, method: (e.target as HTMLSelectElement).value as PaymentMethod })}
                >
                  {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => <option key={k} value={k}>{PAYMENT_METHOD_LABELS[k]}</option>)}
                </select>
              </div>
              <div class="form-group full-width">
                <label>Reference (optional)</label>
                <input
                  type="text" value={paymentDraft.reference}
                  onInput={(e) => setPaymentDraft({ ...paymentDraft, reference: (e.target as HTMLInputElement).value })}
                  placeholder="Check #, transaction ID, ..."
                />
              </div>
              <div class="form-group full-width">
                <label>Notes (optional)</label>
                <input
                  type="text" value={paymentDraft.notes}
                  onInput={(e) => setPaymentDraft({ ...paymentDraft, notes: (e.target as HTMLInputElement).value })}
                />
              </div>
              <div class="form-group full-width">
                <label>Received By (optional)</label>
                <input
                  type="text" value={paymentDraft.received_by}
                  onInput={(e) => setPaymentDraft({ ...paymentDraft, received_by: (e.target as HTMLInputElement).value })}
                  placeholder="Who physically took this payment?"
                />
              </div>
              <div class="form-group full-width">
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input
                    type="checkbox" checked={paymentDraft.email_receipt}
                    onChange={(e) => setPaymentDraft({ ...paymentDraft, email_receipt: (e.target as HTMLInputElement).checked })}
                  />
                  Email the receipt to the customer
                </label>
                <p class="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                  Optional — the payment is recorded either way. Leave unchecked for an on-site payment with no customer email.
                </p>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setShowPaymentForm(false)}>Cancel</button>
              <button
                type="button" class="btn btn-primary"
                disabled={!paymentDraft.amount || parseFloat(paymentDraft.amount) <= 0}
                onClick={() => setPendingRecordPayment(true)}
              >
                Record Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingVoidPayment !== null && (
        <div class="modal-overlay" onClick={() => !voidingPayment && setPendingVoidPayment(null)}>
          <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Void this payment?</h2>
              <button class="btn-icon" onClick={() => setPendingVoidPayment(null)}><X size={18} /></button>
            </div>
            <div class="form-grid">
              <div class="form-group full-width">
                <label>Reason *</label>
                <textarea
                  rows={2} value={voidPaymentReason}
                  onInput={(e) => setVoidPaymentReason((e.target as HTMLTextAreaElement).value)}
                  placeholder="Why is this payment being voided?"
                  required
                />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => setPendingVoidPayment(null)} disabled={voidingPayment}>Cancel</button>
              <button type="button" class="btn btn-danger" disabled={voidingPayment || !voidPaymentReason.trim()} onClick={handleConfirmVoidPayment}>
                {voidingPayment ? "Please wait..." : "Void Payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
