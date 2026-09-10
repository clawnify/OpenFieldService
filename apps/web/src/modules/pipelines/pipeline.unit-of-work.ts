import "server-only";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { PipelineRepository } from "./pipeline.repository";
import { PipelineStageRepository } from "./pipeline-stage.repository";
import { DealRepository } from "@/modules/deals/deal.repository";

export interface PipelineRepositories { pipelines: PipelineRepository; stages: PipelineStageRepository; deals: DealRepository; audit: AuditRepository }
export interface PipelineUnitOfWork { transaction<T>(operation: (repositories: PipelineRepositories) => Promise<T>): Promise<T> }
export class DrizzlePipelineUnitOfWork implements PipelineUnitOfWork {
  transaction<T>(operation: (repositories: PipelineRepositories) => Promise<T>): Promise<T> { return getDb().transaction((transaction) => operation({ pipelines: new PipelineRepository(transaction), stages: new PipelineStageRepository(transaction), deals: new DealRepository(transaction), audit: new AuditRepository(transaction) })); }
}
