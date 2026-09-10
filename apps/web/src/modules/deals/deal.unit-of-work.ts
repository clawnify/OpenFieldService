import "server-only";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { ContactRepository } from "@/modules/contacts/contact.repository";
import { DrizzleCustomerRepository } from "@/modules/customers/customer.repository";
import { MembershipRepository } from "@/modules/identity/membership.repository";
import { PipelineRepository } from "@/modules/pipelines/pipeline.repository";
import { PipelineStageRepository } from "@/modules/pipelines/pipeline-stage.repository";
import { DealRepository } from "./deal.repository";
export interface DealRepositories { deals: DealRepository; pipelines: PipelineRepository; stages: PipelineStageRepository; customers: DrizzleCustomerRepository; contacts: ContactRepository; memberships: MembershipRepository; audit: AuditRepository }
export interface DealUnitOfWork { transaction<T>(operation: (repositories: DealRepositories) => Promise<T>): Promise<T> }
export class DrizzleDealUnitOfWork implements DealUnitOfWork { transaction<T>(operation: (repositories: DealRepositories) => Promise<T>): Promise<T> { return getDb().transaction((transaction) => operation({ deals: new DealRepository(transaction), pipelines: new PipelineRepository(transaction), stages: new PipelineStageRepository(transaction), customers: new DrizzleCustomerRepository(transaction), contacts: new ContactRepository(transaction), memberships: new MembershipRepository(transaction), audit: new AuditRepository(transaction) })); } }
