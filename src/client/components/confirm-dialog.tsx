import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";

// Phase 19A accessibility finding: shared across ~26 call sites (every
// destructive/confirm action in the app), this dialog had no Escape
// handler, no focus management, no focus trap, and no dialog role/
// aria-modal — the same gap Phase 16 already closed for the sidebar's
// mobile drawer. Fixing it once here closes it everywhere at once, per
// the shared-component strategy, rather than patching each call site.
let dialogIdCounter = 0;

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
  const titleId = useRef(`confirm-dialog-title-${dialogIdCounter++}`);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Independent-review finding: most call sites pass `onClose`/`submitting`
  // as a fresh inline value on every parent re-render. Depending on them
  // directly would re-run this effect (and re-steal focus to Close) on
  // every keystroke/state change while the dialog is open — so the effect
  // itself stays mount-only ([]) and reads the current value through a ref.
  const latest = useRef({ onClose, submitting });
  latest.current = { onClose, submitting };

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (latest.current.submitting) return; // don't allow closing mid-request
        latest.current.onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div class="modal-overlay" onClick={submitting ? undefined : onClose}>
      <div ref={dialogRef} class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby={titleId.current} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2 id={titleId.current}>{title}</h2>
          <button ref={closeBtnRef} class="btn-icon" aria-label="Close" onClick={onClose} disabled={submitting}><X size={18} /></button>
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
