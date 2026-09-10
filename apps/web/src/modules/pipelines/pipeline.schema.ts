import { z } from "zod";

const description = z.string().trim().max(2_000).optional().or(z.literal(""));
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional().or(z.literal(""));
const stageShape = { name: z.string().trim().min(1).max(120), kind: z.enum(["open", "won", "lost"]).default("open"), probability: z.number().int().min(0).max(100).default(0), color };

export const createPipelineSchema = z.strictObject({ name: z.string().trim().min(1).max(160), description, makeDefault: z.boolean().optional(), stages: z.array(z.strictObject(stageShape)).max(100).optional() });
export const updatePipelineSchema = z.strictObject({ name: z.string().trim().min(1).max(160).optional(), description });
export const pipelineFilterSchema = z.strictObject({ query: z.string().trim().max(160).optional() });
export const setDefaultPipelineSchema = z.strictObject({ pipelineId: z.uuid() });
export const archivePipelineSchema = z.strictObject({ replacementPipelineId: z.uuid().optional() });
export const createPipelineStageSchema = z.strictObject(stageShape);
export const updatePipelineStageSchema = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), kind: z.enum(["open", "won", "lost"]).optional(), probability: z.number().int().min(0).max(100).optional(), color });
export const reorderPipelineStagesSchema = z.strictObject({ stageIds: z.array(z.uuid()).max(100) }).superRefine((value, context) => { if (new Set(value.stageIds).size !== value.stageIds.length) context.addIssue({ code: "custom", path: ["stageIds"], message: "Stage IDs must be unique" }); });

export type CreatePipelineInput = z.input<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.input<typeof updatePipelineSchema>;
export type CreatePipelineStageInput = z.input<typeof createPipelineStageSchema>;
export type UpdatePipelineStageInput = z.input<typeof updatePipelineStageSchema>;
export type ReorderPipelineStagesInput = z.input<typeof reorderPipelineStagesSchema>;
