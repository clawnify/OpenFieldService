import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import {
  attachments,
  jobChecklistItems,
  jobCompletionEvidence,
  jobCompletionRecords,
  jobCompletionReports,
  jobCustomerSignatures,
  jobs,
  maintenanceOccurrences,
  organizationMembers,
} from "@/db/schema";

export class JobCompletionRepository {
  constructor(private readonly db: DatabaseExecutor = getDb()) {}

  async findJob(organizationId: string, jobId: string) {
    const [row] = await this.db.select().from(jobs).where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId), isNull(jobs.archivedAt))).limit(1);
    return row ?? null;
  }

  async lockJob(organizationId: string, jobId: string) {
    const [row] = await this.db.select().from(jobs).where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId), isNull(jobs.archivedAt))).for("update").limit(1);
    return row ?? null;
  }

  async maintenanceOccurrence(organizationId: string, jobId: string) {
    return this.db.query.maintenanceOccurrences.findFirst({ where: and(eq(maintenanceOccurrences.organizationId, organizationId), eq(maintenanceOccurrences.jobId, jobId)) });
  }

  async activeTechnicianMembership(organizationId: string, userId: string) {
    const [row] = await this.db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.role, "member"), eq(organizationMembers.active, true))).limit(1);
    return row ?? null;
  }

  async attachmentForUpdate(organizationId: string, attachmentId: string) {
    const [row] = await this.db.select().from(attachments).where(and(eq(attachments.organizationId, organizationId), eq(attachments.id, attachmentId), isNull(attachments.archivedAt), isNull(attachments.storageDeletedAt))).for("update").limit(1);
    return row ?? null;
  }

  async evidenceByAttachment(organizationId: string, attachmentId: string) {
    return this.db.query.jobCompletionEvidence.findFirst({ where: and(eq(jobCompletionEvidence.organizationId, organizationId), eq(jobCompletionEvidence.attachmentId, attachmentId)) });
  }

  async signatureByAttachment(organizationId: string, attachmentId: string) {
    return this.db.query.jobCustomerSignatures.findFirst({ where: and(eq(jobCustomerSignatures.organizationId, organizationId), eq(jobCustomerSignatures.attachmentId, attachmentId)) });
  }

  async nextEvidencePosition(organizationId: string, jobId: string, kind: typeof jobCompletionEvidence.$inferSelect.kind) {
    const [row] = await this.db.select({ position: sql<number>`coalesce(max(${jobCompletionEvidence.position}), 0) + 1` }).from(jobCompletionEvidence).where(and(eq(jobCompletionEvidence.organizationId, organizationId), eq(jobCompletionEvidence.jobId, jobId), eq(jobCompletionEvidence.kind, kind)));
    return Number(row.position);
  }

  async createEvidence(input: typeof jobCompletionEvidence.$inferInsert) {
    const [row] = await this.db.insert(jobCompletionEvidence).values(input).onConflictDoNothing().returning();
    return row ?? null;
  }

  listActiveEvidence(organizationId: string, jobId: string) {
    return this.db.select({ evidence: jobCompletionEvidence, attachment: attachments }).from(jobCompletionEvidence).innerJoin(attachments, and(eq(attachments.organizationId, jobCompletionEvidence.organizationId), eq(attachments.id, jobCompletionEvidence.attachmentId))).where(and(eq(jobCompletionEvidence.organizationId, organizationId), eq(jobCompletionEvidence.jobId, jobId), isNull(jobCompletionEvidence.archivedAt), isNull(attachments.archivedAt), isNull(attachments.storageDeletedAt))).orderBy(asc(jobCompletionEvidence.kind), asc(jobCompletionEvidence.position), asc(jobCompletionEvidence.id));
  }

  lockActiveEvidence(organizationId: string, jobId: string) {
    return this.db.select({ evidence: jobCompletionEvidence, attachment: attachments }).from(jobCompletionEvidence).innerJoin(attachments, and(eq(attachments.organizationId, jobCompletionEvidence.organizationId), eq(attachments.id, jobCompletionEvidence.attachmentId))).where(and(eq(jobCompletionEvidence.organizationId, organizationId), eq(jobCompletionEvidence.jobId, jobId), isNull(jobCompletionEvidence.archivedAt), isNull(attachments.archivedAt), isNull(attachments.storageDeletedAt))).orderBy(asc(jobCompletionEvidence.attachmentId)).for("update");
  }

  report(organizationId: string, jobId: string) {
    return this.db.query.jobCompletionReports.findFirst({ where: and(eq(jobCompletionReports.organizationId, organizationId), eq(jobCompletionReports.jobId, jobId)) });
  }

  async lockReport(organizationId: string, jobId: string) {
    const [row] = await this.db.select().from(jobCompletionReports).where(and(eq(jobCompletionReports.organizationId, organizationId), eq(jobCompletionReports.jobId, jobId))).for("update").limit(1);
    return row ?? null;
  }

  async createReport(input: typeof jobCompletionReports.$inferInsert) {
    const [row] = await this.db.insert(jobCompletionReports).values(input).returning();
    return row;
  }

  async saveReport(organizationId: string, reportId: string, expectedRowVersion: number, input: Partial<typeof jobCompletionReports.$inferInsert>) {
    const [row] = await this.db.update(jobCompletionReports)
      .set({ ...input, rowVersion: sql.raw('"row_version" + 1'), updatedAt: new Date() })
      .where(and(eq(jobCompletionReports.organizationId, organizationId), eq(jobCompletionReports.id, reportId), eq(jobCompletionReports.rowVersion, expectedRowVersion)))
      .returning();
    return row ?? null;
  }

  listChecklist(organizationId: string, jobId: string) {
    return this.db.select().from(jobChecklistItems).where(and(eq(jobChecklistItems.organizationId, organizationId), eq(jobChecklistItems.jobId, jobId), isNull(jobChecklistItems.archivedAt))).orderBy(asc(jobChecklistItems.position), asc(jobChecklistItems.id));
  }

  async createSignature(input: typeof jobCustomerSignatures.$inferInsert) {
    const [row] = await this.db.insert(jobCustomerSignatures).values(input).onConflictDoNothing().returning();
    return row ?? null;
  }

  listSignatures(organizationId: string, jobId: string) {
    return this.db.select({
      id: jobCustomerSignatures.id,
      reportId: jobCustomerSignatures.reportId,
      attachmentId: jobCustomerSignatures.attachmentId,
      reportSnapshotHash: jobCustomerSignatures.reportSnapshotHash,
      signerName: jobCustomerSignatures.signerName,
      signerRelationship: jobCustomerSignatures.signerRelationship,
      capturedBy: jobCustomerSignatures.capturedBy,
      capturedAt: jobCustomerSignatures.capturedAt,
    }).from(jobCustomerSignatures).where(and(eq(jobCustomerSignatures.organizationId, organizationId), eq(jobCustomerSignatures.jobId, jobId))).orderBy(desc(jobCustomerSignatures.capturedAt), desc(jobCustomerSignatures.id));
  }

  async lockMatchingSignature(organizationId: string, jobId: string, reportId: string, reportSnapshotHash: string) {
    const [row] = await this.db.select({ signature: jobCustomerSignatures, attachment: attachments })
      .from(jobCustomerSignatures)
      .innerJoin(attachments, and(eq(attachments.organizationId, jobCustomerSignatures.organizationId), eq(attachments.id, jobCustomerSignatures.attachmentId)))
      .where(and(
        eq(jobCustomerSignatures.organizationId, organizationId),
        eq(jobCustomerSignatures.jobId, jobId),
        eq(jobCustomerSignatures.reportId, reportId),
        eq(jobCustomerSignatures.reportSnapshotHash, reportSnapshotHash),
        isNull(attachments.archivedAt),
        isNull(attachments.storageDeletedAt),
      ))
      .orderBy(desc(jobCustomerSignatures.capturedAt), desc(jobCustomerSignatures.id))
      .for("update")
      .limit(1);
    return row ?? null;
  }

  async matchingSignature(organizationId: string, jobId: string, reportId: string, reportSnapshotHash: string) {
    const [row] = await this.db.select({ signature: jobCustomerSignatures, attachment: attachments })
      .from(jobCustomerSignatures)
      .innerJoin(attachments, and(eq(attachments.organizationId, jobCustomerSignatures.organizationId), eq(attachments.id, jobCustomerSignatures.attachmentId)))
      .where(and(
        eq(jobCustomerSignatures.organizationId, organizationId),
        eq(jobCustomerSignatures.jobId, jobId),
        eq(jobCustomerSignatures.reportId, reportId),
        eq(jobCustomerSignatures.reportSnapshotHash, reportSnapshotHash),
        isNull(attachments.archivedAt),
        isNull(attachments.storageDeletedAt),
      ))
      .orderBy(desc(jobCustomerSignatures.capturedAt), desc(jobCustomerSignatures.id))
      .limit(1);
    return row ?? null;
  }

  completion(organizationId: string, jobId: string) {
    return this.db.query.jobCompletionRecords.findFirst({ where: and(eq(jobCompletionRecords.organizationId, organizationId), eq(jobCompletionRecords.jobId, jobId)) });
  }

  async createCompletion(input: typeof jobCompletionRecords.$inferInsert) {
    const [row] = await this.db.insert(jobCompletionRecords).values(input).onConflictDoNothing().returning();
    return row ?? null;
  }

  async completeJob(organizationId: string, jobId: string, actorUserId: string, completedAt: Date) {
    const [row] = await this.db.update(jobs).set({ status: "completed", completedAt, updatedBy: actorUserId, updatedAt: completedAt }).where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId), eq(jobs.status, "in_progress"), isNull(jobs.archivedAt))).returning();
    return row ?? null;
  }
}
