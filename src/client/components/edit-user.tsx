import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import type { User, Role } from "../types";
import { ROLE_LABELS, ROLE_OPTIONS } from "../role-labels";
import { X } from "lucide-preact";

export function EditUser({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const { setError } = useApp();
  const { user: me } = useAuth();
  const isSelf = user.id === me?.id;

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(!!user.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    if (!email.trim()) { setError("Email is required"); return; }
    setSubmitting(true);
    try {
      await api<{ user: User }>("PUT", `/api/users/${user.id}`, {
        name: name.trim(),
        email: email.trim(),
        role,
        active: active ? 1 : 0,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Edit User</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="form-grid">
            <div class="form-group full-width">
              <label>Name *</label>
              <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="form-group full-width">
              <label>Email *</label>
              <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="form-group">
              <label>Role</label>
              <select
                value={role}
                disabled={isSelf}
                onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>&nbsp;</label>
              <label class="checkbox-row">
                <input
                  type="checkbox" checked={active} disabled={isSelf}
                  onChange={(e) => setActive((e.target as HTMLInputElement).checked)}
                />
                Active
              </label>
            </div>
            {isSelf && (
              <div class="form-group full-width">
                <span class="text-muted" style={{ fontSize: "12px" }}>
                  You can't change your own role or active status.
                </span>
              </div>
            )}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
