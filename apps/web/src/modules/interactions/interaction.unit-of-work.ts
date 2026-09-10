import "server-only";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { AttachmentRepository } from "@/modules/attachments/attachment.repository";
import { MembershipRepository } from "@/modules/identity/membership.repository";
import { ActivityRepository } from "./activity.repository";
import { NoteRepository } from "./note.repository";
import { RelationRepository } from "./relation.repository";
import { TaskRepository } from "./task.repository";
export interface InteractionRepositories { tasks: TaskRepository; activities: ActivityRepository; notes: NoteRepository; attachments: AttachmentRepository; relations: RelationRepository; memberships: MembershipRepository; audit: AuditRepository }
export interface InteractionUnitOfWork { transaction<T>(operation: (repositories: InteractionRepositories) => Promise<T>): Promise<T> }
export class DrizzleInteractionUnitOfWork implements InteractionUnitOfWork { transaction<T>(operation: (repositories: InteractionRepositories) => Promise<T>): Promise<T> { return getDb().transaction((tx) => operation({ tasks: new TaskRepository(tx), activities: new ActivityRepository(tx), notes: new NoteRepository(tx), attachments: new AttachmentRepository(tx), relations: new RelationRepository(tx), memberships: new MembershipRepository(tx), audit: new AuditRepository(tx) })); } }
