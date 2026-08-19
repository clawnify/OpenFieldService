import type { Role } from "./types";

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  dispatcher: "Dispatcher",
  technician: "Technician",
};

export const ROLE_OPTIONS: Role[] = ["admin", "dispatcher", "technician"];
