import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { invoices, jobs, organizationMembers, payments } from "@/db/schema";
import { UnauthorizedError } from "@/lib/errors";
import { CustomerService } from "@/modules/customers/customer.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";
import { ReportingService } from "./reporting.service";

describe.sequential("PostgreSQL broad Reporting parity", () => {
  const now = new Date("2026-09-09T19:00:00Z");
  const service = new ReportingService(undefined, () => now);
  let a: Awaited<ReturnType<OrganizationService["createOrganizationWithOwner"]>>;
  let b: typeof a;
  let customerA: Awaited<ReturnType<CustomerService["createCustomer"]>>;
  let customerB: typeof customerA;
  let technician: Awaited<ReturnType<UserService["createUserWithMembership"]>>;
  let viewer: typeof technician;
  let todayJobId: string;

  const ownerA = () => ({ userId: a.user.id, organizationId: a.organization.id, role: "owner" as const });
  const ownerB = () => ({ userId: b.user.id, organizationId: b.organization.id, role: "owner" as const });
  const techActor = () => ({ userId: technician.user.id, organizationId: a.organization.id, role: "member" as const });
  const viewerActor = () => ({ userId: viewer.user.id, organizationId: a.organization.id, role: "viewer" as const });

  it("creates authoritative multi-tenant reporting fixtures", async () => {
    const organizations = new OrganizationService();
    a = await organizations.createOrganizationWithOwner({ name: "Reporting A", slug: `reporting-a-${crypto.randomUUID()}` }, { name: "Owner A", email: `reporting-a-${crypto.randomUUID()}@example.test`, password: "Synthetic-Pass-123" });
    b = await organizations.createOrganizationWithOwner({ name: "Reporting B", slug: `reporting-b-${crypto.randomUUID()}` }, { name: "Owner B", email: `reporting-b-${crypto.randomUUID()}@example.test`, password: "Synthetic-Pass-456" });
    const customers = new CustomerService(), users = new UserService();
    customerA = await customers.createCustomer(ownerA(), { name: "Report Customer A", email: "report-a@example.test" });
    customerB = await customers.createCustomer(ownerB(), { name: "Report Customer B", email: "report-b@example.test" });
    technician = await users.createUserWithMembership(ownerA(), { name: "Field Tech", email: `report-tech-${crypto.randomUUID()}@example.test`, password: "Synthetic-Pass-789" }, "member");
    viewer = await users.createUserWithMembership(ownerA(), { name: "Read Only", email: `report-viewer-${crypto.randomUUID()}@example.test`, password: "Synthetic-Pass-012" }, "viewer");

    const created = await getDb().insert(jobs).values([
      { organizationId: a.organization.id, sequenceNumber: 88001, identifier: "JOB-REPORT-TODAY", customerId: customerA.id, title: "Today", serviceAddress: "1 Main", status: "scheduled", technicianUserId: technician.user.id, scheduledDate: "2026-09-09", scheduledTime: "09:00", createdBy: a.user.id },
      { organizationId: a.organization.id, sequenceNumber: 88002, identifier: "JOB-REPORT-FUTURE", customerId: customerA.id, title: "Future", serviceAddress: "1 Main", status: "scheduled", scheduledDate: "2026-09-10", scheduledTime: "10:00", createdBy: a.user.id },
      { organizationId: a.organization.id, sequenceNumber: 88003, identifier: "JOB-REPORT-COMPLETE", customerId: customerA.id, title: "Complete", serviceAddress: "1 Main", status: "completed", technicianUserId: technician.user.id, completedAt: now, createdBy: a.user.id },
      { organizationId: a.organization.id, sequenceNumber: 88004, identifier: "JOB-REPORT-INVOICED", customerId: customerA.id, title: "Invoiced", serviceAddress: "1 Main", status: "invoiced", completedAt: now, createdBy: a.user.id },
      { organizationId: a.organization.id, sequenceNumber: 88005, identifier: "JOB-REPORT-CANCELLED", customerId: customerA.id, title: "Cancelled", serviceAddress: "1 Main", status: "cancelled", scheduledDate: "2026-09-09", scheduledTime: "08:00", cancelledAt: now, createdBy: a.user.id },
      { organizationId: b.organization.id, sequenceNumber: 88001, identifier: "JOB-FOREIGN", customerId: customerB.id, title: "Foreign", serviceAddress: "2 Main", status: "completed", completedAt: now, createdBy: b.user.id },
    ]).returning({ id: jobs.id, identifier: jobs.identifier });
    todayJobId = created.find(row => row.identifier === "JOB-REPORT-TODAY")!.id;

    const [invoiceA] = await getDb().insert(invoices).values({ organizationId: a.organization.id, sequenceNumber: 99001, identifier: "INV-REPORT-A", source: "manual", customerId: customerA.id, billingSnapshot: "{}", taxSnapshot: "{}", currency: "CAD", status: "partially_paid", paymentTerms: "due_on_receipt", issueDate: "2026-09-01", dueDate: "2026-09-08", issuedAt: now, totalCents: 12_500, createdBy: a.user.id }).returning();
    const [invoiceB] = await getDb().insert(invoices).values({ organizationId: b.organization.id, sequenceNumber: 99001, identifier: "INV-REPORT-B", source: "manual", customerId: customerB.id, billingSnapshot: "{}", taxSnapshot: "{}", currency: "CAD", status: "paid", paymentTerms: "due_on_receipt", issueDate: "2026-09-01", dueDate: "2026-09-01", issuedAt: now, totalCents: 990_000, createdBy: b.user.id }).returning();
    const [paymentA] = await getDb().insert(payments).values({ organizationId: a.organization.id, invoiceId: invoiceA!.id, entryType: "payment", amountCents: 10_000, currency: "CAD", payerType: "customer", method: "cash", businessDate: "2026-09-09", recordedBy: a.user.id }).returning();
    await getDb().insert(payments).values([
      { organizationId: a.organization.id, invoiceId: invoiceA!.id, entryType: "payment", amountCents: 2_500, currency: "CAD", payerType: "customer", method: "cash", businessDate: "2026-09-09", recordedBy: a.user.id },
      { organizationId: a.organization.id, invoiceId: invoiceA!.id, entryType: "reversal", amountCents: 10_000, currency: "CAD", payerType: "customer", method: "cash", businessDate: "2026-09-09", reversesPaymentId: paymentA!.id, reversalReason: "Synthetic reversal", recordedBy: a.user.id },
      { organizationId: b.organization.id, invoiceId: invoiceB!.id, entryType: "payment", amountCents: 990_000, currency: "CAD", payerType: "customer", method: "cash", businessDate: "2026-09-09", recordedBy: b.user.id },
    ]);
  });

  it("computes the office dashboard from authoritative lifecycle and ledger state", async () => {
    const report = await service.dashboard(ownerA());
    expect(report.asOfBusinessDate).toBe("2026-09-09");
    expect(report.operational).toEqual({ totalJobs: 5, customers: 1, todayJobs: 1, upcomingJobs: 2, completedJobs: 2 });
    expect(report.financial).toEqual({ netCollected: [{ currency: "CAD", amountCents: 2_500 }], outstandingInvoices: 1, overdueInvoices: 1 });
  });

  it("scopes a Technician to assigned work and excludes financial fields", async () => {
    const report = await service.dashboard(techActor());
    expect(report.operational).toEqual({ totalJobs: 2, customers: 1, todayJobs: 1, upcomingJobs: 1, completedJobs: 1 });
    expect(report.financial).toBeNull();
    expect(report.schedule.map(job => job.id)).toEqual([todayJobId]);
  });

  it("keeps financial KPIs hidden from a read-only viewer without payment authority", async () => {
    const report = await service.dashboard(viewerActor());
    expect(report.operational.totalJobs).toBe(5);
    expect(report.financial).toBeNull();
  });

  it("does not blend foreign tenant counts, money, or drill-down rows", async () => {
    const reportA = await service.dashboard(ownerA()), reportB = await service.dashboard(ownerB());
    expect(reportA.operational.totalJobs).toBe(5);
    expect(reportA.financial?.netCollected).toEqual([{ currency: "CAD", amountCents: 2_500 }]);
    expect(reportA.schedule.every(row => row.identifier !== "JOB-FOREIGN")).toBe(true);
    expect(reportB.operational.totalJobs).toBe(1);
    expect(reportB.financial?.netCollected).toEqual([{ currency: "CAD", amountCents: 990_000 }]);
  });

  it("excludes cancelled Jobs from today's bounded schedule", async () => {
    const report = await service.dashboard(ownerA());
    expect(report.schedule).toHaveLength(1);
    expect(report.schedule[0]).toMatchObject({ id: todayJobId, identifier: "JOB-REPORT-TODAY", customerName: "Report Customer A", technicianName: "Field Tech" });
  });

  it("revalidates active persisted membership before every report", async () => {
    await getDb().update(organizationMembers).set({ active: false }).where(and(eq(organizationMembers.organizationId, a.organization.id), eq(organizationMembers.userId, technician.user.id)));
    await expect(service.dashboard(techActor())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
