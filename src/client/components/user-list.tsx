import { useState, useEffect, useCallback } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { api } from "../api";
import type { User } from "../types";
import { ROLE_LABELS } from "../role-labels";
import { CreateUser } from "./create-user";
import { EditUser } from "./edit-user";
import { ChangeUserPassword } from "./change-user-password";
import { ConfirmDialog } from "./confirm-dialog";
import { Plus, Search, Edit3, KeyRound, Trash2, ShieldCheck } from "lucide-preact";

type ConfirmAction = { user: User; action: "deactivate" | "delete" };

export function UserManagement() {
  const { setError } = useApp();
  const { user: me } = useAuth();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [changingPassword, setChangingPassword] = useState<User | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmAction | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  const fetchUsers = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("search", q);
      const res = await api<{ users: User[] }>("GET", `/api/users?${params}`);
      setUsers(res.users);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    fetchUsers(search);
  }, [search, fetchUsers]);

  const toggleActive = async (u: User) => {
    if (u.active) {
      setConfirmTarget({ user: u, action: "deactivate" });
      return;
    }
    try {
      await api("PUT", `/api/users/${u.id}`, { active: 1 });
      fetchUsers(search);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runConfirmed = async () => {
    if (!confirmTarget) return;
    setConfirmSubmitting(true);
    try {
      if (confirmTarget.action === "deactivate") {
        await api("PUT", `/api/users/${confirmTarget.user.id}`, { active: 0 });
      } else {
        await api("DELETE", `/api/users/${confirmTarget.user.id}`);
      }
      setConfirmTarget(null);
      fetchUsers(search);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirmSubmitting(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1>User Management</h1>
        <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New User
        </button>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <Search size={14} class="search-icon" />
          <input
            type="text"
            placeholder="Search users..."
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="card">
        {loading ? (
          <div class="empty-state"><p>Loading users...</p></div>
        ) : users.length === 0 ? (
          <div class="empty-state">
            <p>No users found</p>
            <button class="btn btn-primary" onClick={() => setShowCreate(true)}>Add your first user</button>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} class="table-row">
                  <td class="text-bold">{u.name}{u.id === me?.id ? " (you)" : ""}</td>
                  <td class="text-muted">{u.email}</td>
                  <td>
                    <span class="role-badge">
                      {u.role === "admin" && <ShieldCheck size={12} />}
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td>
                    <button
                      class={`status-badge-sm clickable ${u.active ? "active" : "inactive"}`}
                      onClick={() => toggleActive(u)}
                      disabled={u.id === me?.id}
                      title={u.id === me?.id ? "You cannot deactivate your own account" : undefined}
                    >
                      {u.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td class="text-muted">{u.created_at?.slice(0, 10)}</td>
                  <td class="text-muted">{u.last_login_at ? u.last_login_at.slice(0, 16).replace("T", " ") : "Never"}</td>
                  <td>
                    <div class="action-btns">
                      <button class="btn-icon" title="Edit" onClick={() => setEditing(u)}><Edit3 size={14} /></button>
                      <button class="btn-icon" title="Change password" onClick={() => setChangingPassword(u)}>
                        <KeyRound size={14} />
                      </button>
                      {u.id !== me?.id && (
                        <button
                          class="btn-icon danger"
                          title="Delete"
                          onClick={() => setConfirmTarget({ user: u, action: "delete" })}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && <CreateUser onClose={() => setShowCreate(false)} onSaved={() => fetchUsers(search)} />}
      {editing && (
        <EditUser user={editing} onClose={() => setEditing(null)} onSaved={() => fetchUsers(search)} />
      )}
      {changingPassword && (
        <ChangeUserPassword user={changingPassword} onClose={() => setChangingPassword(null)} />
      )}
      {confirmTarget && (
        <ConfirmDialog
          title={confirmTarget.action === "deactivate" ? "Deactivate user?" : "Delete user?"}
          message={
            confirmTarget.action === "deactivate"
              ? `${confirmTarget.user.name} will no longer be able to log in. Their data is kept, and you can reactivate the account at any time.`
              : `This permanently deletes ${confirmTarget.user.name}. This cannot be undone.`
          }
          confirmLabel={confirmTarget.action === "deactivate" ? "Deactivate" : "Delete"}
          danger
          submitting={confirmSubmitting}
          onConfirm={runConfirmed}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
