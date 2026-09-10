import { foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "./identity";
import { jobs } from "./jobs";

export const technicianSyncOperation = pgEnum("technician_sync_operation", [
  "save_report",
  "submit_report",
  "set_checklist",
  "add_note",
  "upload_evidence",
  "capture_signature",
  "complete_job",
]);

export const technicianSyncState = pgEnum("technician_sync_state", ["pending", "applied"]);

export const technicianSyncMutations = pgTable("technician_sync_mutations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").notNull(),
  jobId: uuid("job_id").notNull(),
  clientMutationId: uuid("client_mutation_id").notNull(),
  operation: technicianSyncOperation("operation").notNull(),
  payloadHash: text("payload_hash").notNull(),
  state: technicianSyncState("state").default("pending").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("technician_sync_mutations_context_key_unique").on(table.organizationId, table.actorUserId, table.clientMutationId),
  index("technician_sync_mutations_job_idx").on(table.organizationId, table.jobId, table.createdAt),
  foreignKey({ columns: [table.organizationId, table.actorUserId], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "technician_sync_mutation_actor_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "technician_sync_mutation_job_tenant_fk" }).onDelete("restrict"),
]);
