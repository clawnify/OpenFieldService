import { ConflictError, ValidationError } from "@/lib/errors";
import type { PipelineStageKind } from "@/modules/pipelines/pipeline.types";
export function assertOpenForMutation(kind: PipelineStageKind): void { if (kind !== "open") throw new ConflictError("Closed deals cannot be changed or reopened"); }
export function assertMove(currentPipelineId: string, destinationPipelineId: string, currentKind: PipelineStageKind, destinationKind: PipelineStageKind, lostReason?: string): void {
  assertOpenForMutation(currentKind); if (currentPipelineId !== destinationPipelineId) throw new ConflictError("Moving a deal between pipelines is not supported"); if (destinationKind === "lost" && !lostReason?.trim()) throw new ValidationError("A lost reason is required", [{ path: "lostReason", message: "Enter a lost reason" }]);
}
export function isDatabaseConstraintError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ["23503", "23505", "23514"].includes(String(error.code)); }
