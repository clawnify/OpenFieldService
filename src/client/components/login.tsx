import { useState } from "preact/hooks";
import { useAuth } from "../auth-context";
import { CalendarClock, Eye, EyeOff } from "lucide-preact";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password");
      return;
    }
    setSubmitting(true);
    try {
      await login(email.trim(), password, remember);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="sidebar-brand-icon">
            <CalendarClock size={18} />
          </div>
          Field Scheduler
        </div>
        <h1 class="auth-title">Sign in</h1>
        <p class="auth-subtitle">Enter your credentials to access the dashboard.</p>

        {error && <div class="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div class="form-group">
            <label for="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              placeholder="you@example.com"
              autoFocus
            />
          </div>
          <div class="form-group">
            <label for="login-password">Password</label>
            <div class="password-input-wrap">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                class="password-toggle"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
            />
            Remember me
          </label>
          <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
