import { createContext, type ComponentChildren } from "preact";
import { useContext, useState, useEffect, useCallback } from "preact/hooks";
import { api } from "./api";
import type { User } from "./types";

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null!);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      const res = await api<{ user: User }>("GET", "/api/auth/me");
      setUser(res.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refreshUser();
      setLoading(false);
    })();
  }, [refreshUser]);

  // Any api() call that gets a 401 mid-session (expired/revoked session) drops
  // the user back to the login page without a full page reload.
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener("auth:unauthorized", handler);
    return () => window.removeEventListener("auth:unauthorized", handler);
  }, []);

  const login = useCallback(async (email: string, password: string, remember: boolean) => {
    const res = await api<{ user: User }>("POST", "/api/auth/login", { email, password, remember });
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("POST", "/api/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const changePassword = useCallback(async (current_password: string, new_password: string) => {
    await api("PUT", "/api/auth/password", { current_password, new_password });
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, setError, login, logout, changePassword, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}
