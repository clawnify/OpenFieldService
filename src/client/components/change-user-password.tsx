import { useState } from "preact/hooks";
import { useApp } from "../context";
import { api } from "../api";
import type { User } from "../types";
import { X, Eye, EyeOff } from "lucide-preact";

export function ChangeUserPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const { setError } = useApp();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setSubmitting(true);
    try {
      await api("PUT", `/api/users/${user.id}/password`, { password });
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
          <h2>Change Password — {user.name}</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="form-grid">
            <div class="form-group full-width">
              <label>New Password *</label>
              <div class="password-input-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                  required minLength={8} placeholder="At least 8 characters" autoComplete="new-password"
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
            <div class="form-group full-width">
              <label>Confirm Password *</label>
              <input
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
                required minLength={8} placeholder="Repeat password" autoComplete="new-password"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Saving..." : "Set Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
