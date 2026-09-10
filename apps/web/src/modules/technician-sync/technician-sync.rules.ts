import { createHash } from "node:crypto";
import type { TechnicianSyncMutation } from "./technician-sync.schema";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}

export function technicianSyncPayloadHash(value: TechnicianSyncMutation) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

