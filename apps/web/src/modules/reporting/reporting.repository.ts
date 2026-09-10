import "server-only";
import { and, asc, count, countDistinct, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { customers, invoices, jobs, payments, users } from "@/db/schema";

export interface ReportingScope { organizationId: string; technicianUserId?: string }

const jobScope = (scope: ReportingScope) => and(
  eq(jobs.organizationId, scope.organizationId),
  isNull(jobs.archivedAt),
  scope.technicianUserId ? eq(jobs.technicianUserId, scope.technicianUserId) : undefined,
);

export class ReportingRepository {
  constructor(private readonly db: DatabaseExecutor = getDb()) {}

  async operationalSummary(scope: ReportingScope, today: string) {
    const scoped = jobScope(scope);
    const customerQuery = scope.technicianUserId
      ? this.db.select({ value: countDistinct(jobs.customerId) }).from(jobs).where(scoped)
      : this.db.select({ value: count() }).from(customers).where(and(eq(customers.organizationId, scope.organizationId), eq(customers.status, "active"), isNull(customers.archivedAt)));
    const [[totalJobs], [customerCount], [todayJobs], [upcomingJobs], [completedJobs]] = await Promise.all([
      this.db.select({ value: count() }).from(jobs).where(scoped),
      customerQuery,
      this.db.select({ value: count() }).from(jobs).where(and(scoped, eq(jobs.scheduledDate, today), ne(jobs.status, "cancelled"))),
      this.db.select({ value: count() }).from(jobs).where(and(scoped, eq(jobs.status, "scheduled"), gte(jobs.scheduledDate, today))),
      this.db.select({ value: count() }).from(jobs).where(and(scoped, inArray(jobs.status, ["completed", "invoiced"]))),
    ]);
    return {
      totalJobs: Number(totalJobs.value),
      customers: Number(customerCount.value),
      todayJobs: Number(todayJobs.value),
      upcomingJobs: Number(upcomingJobs.value),
      completedJobs: Number(completedJobs.value),
    };
  }

  async financialSummary(organizationId: string, today: string) {
    const [netCollected, [outstanding], [overdue]] = await Promise.all([
      this.db.select({
        currency: payments.currency,
        amountCents: sql<string>`coalesce(sum(case when ${payments.entryType} = 'payment' then ${payments.amountCents} else -${payments.amountCents} end), 0)`,
      }).from(payments).where(eq(payments.organizationId, organizationId)).groupBy(payments.currency).orderBy(asc(payments.currency)),
      this.db.select({ value: count() }).from(invoices).where(and(eq(invoices.organizationId, organizationId), isNull(invoices.archivedAt), inArray(invoices.status, ["issued", "partially_paid"]))),
      this.db.select({ value: count() }).from(invoices).where(and(eq(invoices.organizationId, organizationId), isNull(invoices.archivedAt), inArray(invoices.status, ["issued", "partially_paid"]), lt(invoices.dueDate, today))),
    ]);
    return {
      netCollected: netCollected.map(row => ({ currency: row.currency, amountCents: Number(row.amountCents) })),
      outstandingInvoices: Number(outstanding.value),
      overdueInvoices: Number(overdue.value),
    };
  }

  todaySchedule(scope: ReportingScope, today: string, limit = 100) {
    return this.db.select({
      id: jobs.id,
      identifier: jobs.identifier,
      scheduledTime: jobs.scheduledTime,
      title: jobs.title,
      status: jobs.status,
      customerId: customers.id,
      customerName: customers.name,
      technicianUserId: jobs.technicianUserId,
      technicianName: users.name,
    }).from(jobs)
      .innerJoin(customers, and(eq(customers.organizationId, jobs.organizationId), eq(customers.id, jobs.customerId)))
      .leftJoin(users, eq(users.id, jobs.technicianUserId))
      .where(and(jobScope(scope), eq(jobs.scheduledDate, today), ne(jobs.status, "cancelled")))
      .orderBy(asc(jobs.scheduledTime), asc(jobs.identifier))
      .limit(limit);
  }
}
