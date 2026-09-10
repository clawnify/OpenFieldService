import { ConflictError } from "@/lib/errors";
export type TaskState = "open" | "in_progress" | "completed";
export function assertTaskTransition(from: TaskState, to: TaskState): void { if (from === to) throw new ConflictError(`Task is already ${to}`); if (from === "completed" && to === "in_progress") throw new ConflictError("Reopen a completed task to open before starting it"); }
