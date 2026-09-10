import { ValidationError } from "@/lib/errors";
import type { PipelineStageKind } from "./pipeline.types";

export function assertStageProbability(kind: PipelineStageKind, probability: number): void {
  if (kind === "won" && probability !== 100) throw new ValidationError("Won stages must have 100% probability", [{ path: "probability", message: "Use 100 for a won stage" }]);
  if (kind === "lost" && probability !== 0) throw new ValidationError("Lost stages must have 0% probability", [{ path: "probability", message: "Use 0 for a lost stage" }]);
}

export function assertCompleteOrder(expectedIds: readonly string[], submittedIds: readonly string[]): void {
  if (expectedIds.length !== submittedIds.length || expectedIds.some((id) => !submittedIds.includes(id))) throw new ValidationError("Reorder must include every active stage in this pipeline exactly once", [{ path: "stageIds", message: "Missing or foreign stage ID" }]);
}

export function isUniqueViolation(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "23505"; }
