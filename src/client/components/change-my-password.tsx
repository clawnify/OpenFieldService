import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { X, Eye, EyeOff } from "lucide-preact";

export function ChangeMyPassword({ onClose }: { onClose: () => void }) {
  const { setError } = useApp();
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!currentPassword) { setError("Enter your current password"); return; }
    if (newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("New passwords do not match"); return; }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
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
          <h2>Change My Password</h2>
          <button class="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="form-grid">
            <div class="form-group full-width">
              <label>Current Password *</label>
              <input
                type={showPassword ? "text" : "password"}
                value={currentPassword}
                onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)}
                required autoComplete="current-password"
              />
            </div>
            <div class="form-group full-width">
              <label>New Password *</label>
              <div class="password-input-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
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
              <label>Confirm New Password *</label>
              <input
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
                required minLength={8} placeholder="Repeat new password" autoComplete="new-password"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={submitting}>
              {submitting ? "Saving..." : "Change Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
