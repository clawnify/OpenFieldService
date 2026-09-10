"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { PipelineService } from "@/modules/pipelines/pipeline.service";

export interface PipelineActionState { error?: string; issues?: ReadonlyArray<{ path: string; message: string }> }
function failure(error: unknown): PipelineActionState { if (error instanceof ApplicationError) return { error: error.message, issues: "issues" in error ? error.issues as PipelineActionState["issues"] : undefined }; throw error; }
export async function createPipelineAction(_state: PipelineActionState, formData: FormData): Promise<PipelineActionState> { try { const actor = await currentActor(); const result = await new PipelineService().createPipeline(actor!, { name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? ""), makeDefault: formData.get("makeDefault") === "on" }); revalidatePath("/pipelines"); redirect(`/pipelines/${result.pipeline.id}`); } catch (error) { return failure(error); } }
export async function createStageAction(pipelineId: string, _state: PipelineActionState, formData: FormData): Promise<PipelineActionState> { try { const actor = await currentActor(); const kind = String(formData.get("kind") ?? "open") as "open" | "won" | "lost"; await new PipelineService().createStage(actor!, pipelineId, { name: String(formData.get("name") ?? ""), kind, probability: Number(formData.get("probability") ?? 0), color: String(formData.get("color") ?? "") }); revalidatePath(`/pipelines/${pipelineId}`); return {}; } catch (error) { return failure(error); } }
export async function setDefaultPipelineAction(pipelineId: string): Promise<void> { const actor = await currentActor(); await new PipelineService().setDefaultPipeline(actor!, { pipelineId }); revalidatePath("/pipelines"); revalidatePath(`/pipelines/${pipelineId}`); }
export async function reorderPipelineStagesAction(pipelineId: string, stageIds: string[]): Promise<PipelineActionState> { try { const actor = await currentActor(); await new PipelineService().reorderStages(actor!, pipelineId, { stageIds }); revalidatePath(`/pipelines/${pipelineId}`); return {}; } catch (error) { return failure(error); } }
