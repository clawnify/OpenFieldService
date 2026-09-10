"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { TaskService } from "@/modules/interactions/task.service";
export interface TaskActionState { error?: string }
function failure(error: unknown): TaskActionState { if (error instanceof ApplicationError) return { error: error.message }; throw error; }
export async function createTaskAction(_state: TaskActionState, formData: FormData): Promise<TaskActionState> { try { const actor = await currentActor(); await new TaskService().createTask(actor!, { title: String(formData.get("title") ?? ""), description: String(formData.get("description") ?? ""), priority: String(formData.get("priority") ?? "normal") as "low"|"normal"|"high"|"urgent", dueAt: String(formData.get("dueAt") ?? "") ? new Date(String(formData.get("dueAt"))).toISOString() : null, assigneeUserId: String(formData.get("assigneeUserId") ?? "") || null, targetType: "customer", targetId: String(formData.get("targetId") ?? "") }); revalidatePath("/tasks"); return {}; } catch (error) { return failure(error); } }
export async function changeTaskStatusAction(id: string, formData: FormData): Promise<void> { const actor = await currentActor(); await new TaskService().changeStatus(actor!, id, { status: String(formData.get("status")) }); revalidatePath("/tasks"); revalidatePath(`/tasks/${id}`); }
