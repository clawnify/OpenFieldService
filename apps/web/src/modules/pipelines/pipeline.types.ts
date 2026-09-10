import type { pipelines, pipelineStages } from "@/db/schema";
export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type NewPipelineStage = typeof pipelineStages.$inferInsert;
export type PipelineStageKind = PipelineStage["kind"];
