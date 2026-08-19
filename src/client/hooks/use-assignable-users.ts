import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { Role } from "../types";

export interface AssignableUser { id: number; name: string }

/**
 * Phase 8.4 found that a readable "Assigned To" selector needs a list of
 * eligible users (admin/dispatcher only — see validateLeadAssigneeUserId()
 * in src/server/index.ts, Phase 8.2 decision 20), but the only endpoint
 * that listed users at all, GET /api/users, was admin-only — a dispatcher
 * actor (who has full Lead management parity with admin, Phase 8.2 decision
 * 19) got a real 403 trying to browse it. Phase 8.5 resolved this properly:
 * GET /api/users/assignable is a new, deliberately minimal, read-only
 * lookup (id/name/role only, admin+dispatcher only server-side, never
 * technicians) that both admin and dispatcher can call — GET /api/users
 * itself stays admin-only and untouched (it exposes real account-management
 * detail this selector never needed). No more graceful-degradation branch:
 * both roles get the real list now. */
export function useAssignableUsers(role: Role | undefined): { users: AssignableUser[]; available: boolean } {
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (role !== "admin" && role !== "dispatcher") { setAvailable(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ users: AssignableUser[] }>("GET", "/api/users/assignable");
        if (cancelled) return;
        setUsers(res.users);
        setAvailable(true);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [role]);

  return { users, available };
}
