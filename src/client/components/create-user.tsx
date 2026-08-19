import { useState } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import type { User, Role } from "../types";
import { ROLE_LABELS, ROLE_OPTIONS } from "../role-labels";
import { X, Eye, EyeOff } from "lucide-preact";

export function CreateUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { setError } = useApp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<Role>("dispatcher");
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    if (!email.trim()) { setError("Email is required"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setSubmitting(true);
    try {
      await api<{ user: User }>("POST", "/api/users", {
        name: name.trim(),
        email: email.trim(),
        password,
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
          <h2>New User</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="form-grid">
            <div class="form-group full-width">
              <label>Name *</label>
              <input
                type="text" value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
                required placeholder="Jane Smith"
              />
            </div>
            <div class="form-group full-width">
              <label>Email *</label>
              <input
                type="email" value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                required placeholder="jane@example.com" autoComplete="off"
              />
            </div>
            <div class="form-group full-width">
              <label>Password *</label>
              <div class="password-input-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button" class="password-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div class="form-group">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>&nbsp;</label>
              <label class="checkbox-row">
                <input
                  type="checkbox" checked={active}
                  onChange={(e) => setActive((e.target as HTMLInputElement).checked)}
                />
                Active
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating..." : "Create User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
