import { X } from "lucide-preact";

export function ConfirmDialog({
  title, message, confirmLabel = "Confirm", danger = false, submitting = false, onConfirm, onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  submitting?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>{title}</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div class="confirm-body">
          <p>{message}</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            type="button"
            class={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Please wait..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
