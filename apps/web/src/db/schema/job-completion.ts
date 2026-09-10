import { boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { attachments } from "./attachments";
import { organizationMembers, organizations } from "./identity";
import { jobs } from "./jobs";

export const jobEvidenceKind = pgEnum("job_evidence_kind", ["pre_work_photo", "post_work_photo"]);
export const jobCompletionReportStatus = pgEnum("job_completion_report_status", ["draft", "submitted"]);

export const jobCompletionEvidence = pgTable("job_completion_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  attachmentId: uuid("attachment_id").notNull(),
  kind: jobEvidenceKind("kind").notNull(),
  position: integer("position").notNull(),
  required: boolean("required").default(true).notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedBy: uuid("archived_by"),
}, (table) => [
  uniqueIndex("job_completion_evidence_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("job_completion_evidence_attachment_unique").on(table.organizationId, table.attachmentId),
  uniqueIndex("job_completion_evidence_position_unique").on(table.organizationId, table.jobId, table.kind, table.position),
  index("job_completion_evidence_job_idx").on(table.organizationId, table.jobId, table.kind, table.createdAt),
  foreignKey({ columns: [table.organizationId, table.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "job_completion_evidence_job_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.attachmentId], foreignColumns: [attachments.organizationId, attachments.id], name: "job_completion_evidence_attachment_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.createdBy], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_evidence_creator_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.archivedBy], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_evidence_archiver_tenant_fk" }).onDelete("restrict"),
]);

export const jobCompletionReports = pgTable("job_completion_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  technicianUserId: uuid("technician_user_id").notNull(),
  status: jobCompletionReportStatus("status").default("draft").notNull(),
  workPerformed: text("work_performed").default("").notNull(),
  findings: text("findings").default("").notNull(),
  notes: text("notes").default("").notNull(),
  materialsUsed: text("materials_used").default("").notNull(),
  checklistSnapshot: jsonb("checklist_snapshot").$type<ReadonlyArray<Record<string, unknown>>>().default([]).notNull(),
  submittedSnapshot: jsonb("submitted_snapshot").$type<Record<string, unknown>>(),
  snapshotHash: text("snapshot_hash"),
  rowVersion: integer("row_version").default(0).notNull(),
  lastSyncMutationId: uuid("last_sync_mutation_id"),
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("job_completion_reports_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("job_completion_reports_job_unique").on(table.organizationId, table.jobId),
  index("job_completion_reports_status_idx").on(table.organizationId, table.status, table.submittedAt),
  foreignKey({ columns: [table.organizationId, table.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "job_completion_report_job_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.technicianUserId], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_report_technician_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.submittedBy], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_report_submitter_tenant_fk" }).onDelete("restrict"),
]);

export const jobCustomerSignatures = pgTable("job_customer_signatures", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  reportId: uuid("report_id").notNull(),
  attachmentId: uuid("attachment_id").notNull(),
  reportSnapshotHash: text("report_snapshot_hash").notNull(),
  signerName: text("signer_name").notNull(),
  signerRelationship: text("signer_relationship").default("").notNull(),
  acknowledgement: text("acknowledgement").notNull(),
  capturedBy: uuid("captured_by").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("job_customer_signatures_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("job_customer_signatures_attachment_unique").on(table.organizationId, table.attachmentId),
  index("job_customer_signatures_job_idx").on(table.organizationId, table.jobId, table.capturedAt),
  foreignKey({ columns: [table.organizationId, table.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "job_customer_signature_job_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.reportId], foreignColumns: [jobCompletionReports.organizationId, jobCompletionReports.id], name: "job_customer_signature_report_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.attachmentId], foreignColumns: [attachments.organizationId, attachments.id], name: "job_customer_signature_attachment_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.capturedBy], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_customer_signature_capturer_tenant_fk" }).onDelete("restrict"),
]);

export const jobCompletionRecords = pgTable("job_completion_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  reportId: uuid("report_id").notNull(),
  signatureId: uuid("signature_id").notNull(),
  technicianUserId: uuid("technician_user_id").notNull(),
  completedBy: uuid("completed_by").notNull(),
  reportSnapshot: jsonb("report_snapshot").$type<Record<string, unknown>>().notNull(),
  preWorkEvidenceSnapshot: jsonb("pre_work_evidence_snapshot").$type<ReadonlyArray<Record<string, unknown>>>().notNull(),
  postWorkEvidenceSnapshot: jsonb("post_work_evidence_snapshot").$type<ReadonlyArray<Record<string, unknown>>>().notNull(),
  signatureSnapshot: jsonb("signature_snapshot").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("job_completion_records_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("job_completion_records_job_unique").on(table.organizationId, table.jobId),
  uniqueIndex("job_completion_records_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  foreignKey({ columns: [table.organizationId, table.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "job_completion_record_job_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.reportId], foreignColumns: [jobCompletionReports.organizationId, jobCompletionReports.id], name: "job_completion_record_report_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.signatureId], foreignColumns: [jobCustomerSignatures.organizationId, jobCustomerSignatures.id], name: "job_completion_record_signature_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.technicianUserId], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_record_technician_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.completedBy], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "job_completion_record_actor_tenant_fk" }).onDelete("restrict"),
]);
