import { hashPassword } from "@/auth/password";
import { getDb } from "@/db";
import { activities, companies, contacts, customers, deals, dealStageHistory, leads, leadStatusHistory, maintenanceAgreements, maintenanceAgreementVersions, maintenanceEntitlementEvents, maintenanceMemberships, maintenancePlans, maintenanceSchedules, notes, organizationMembers, organizations, pipelines, pipelineStages, tasks, users } from "@/db/schema";
import { eq } from "drizzle-orm";

async function seed() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error("SEED_ADMIN_PASSWORD must contain at least 12 characters");
  const database = getDb();
  await database.transaction(async (transaction) => {
    const [existing] = await transaction.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, "demo-fieldservice")).limit(1);
    if (existing) return;
    const [organization] = await transaction.insert(organizations).values({ name: "Demo Fieldservice", slug: "demo-fieldservice" }).returning();
    const [owner] = await transaction.insert(users).values({ name: "Demo Owner", email: "owner@example.test", passwordHash: await hashPassword(password) }).returning();
    await transaction.insert(organizationMembers).values({ organizationId: organization.id, userId: owner.id, role: "owner" });
    const [company] = await transaction.insert(companies).values({ organizationId: organization.id, name: "Example Property Group", email: "office@example.test", city: "Sample City", region: "BC", createdBy: owner.id, updatedBy: owner.id }).returning();
    const [community, bakery] = await transaction.insert(customers).values([
      { organizationId: organization.id, companyId: company.id, name: "Example Community Facility", email: "facilities@example.test", phone: "+1 555 0101", city: "Sample City", region: "BC", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, name: "Example Bakery Account", email: "operations@example.test", phone: "+1 555 0102", city: "Sample City", region: "BC", createdBy: owner.id, updatedBy: owner.id },
    ]).returning();
    await transaction.insert(contacts).values([
      { organizationId: organization.id, customerId: community.id, companyId: company.id, firstName: "Demo", lastName: "Coordinator", email: "coordinator@example.test", isPrimary: true, createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, customerId: bakery.id, firstName: "Sample", lastName: "Manager", email: "manager@example.test", isPrimary: true, createdBy: owner.id, updatedBy: owner.id },
    ]);
    const [websiteLead, referralLead] = await transaction.insert(leads).values([
      { organizationId: organization.id, identifier: "LEAD-DEMO0001", name: "Example Website Inquiry", email: "inquiry@example.test", source: "Website", status: "new", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, identifier: "LEAD-DEMO0002", name: "Example Referral Inquiry", phone: "+1 555 0103", source: "Referral", status: "contacted", assignedUserId: owner.id, createdBy: owner.id, updatedBy: owner.id },
    ]).returning();
    await transaction.insert(leadStatusHistory).values([
      { organizationId: organization.id, leadId: websiteLead.id, oldStatus: null, newStatus: "new", reason: "Seeded lead", actorUserId: owner.id },
      { organizationId: organization.id, leadId: referralLead.id, oldStatus: null, newStatus: "new", reason: "Seeded lead", actorUserId: owner.id },
      { organizationId: organization.id, leadId: referralLead.id, oldStatus: "new", newStatus: "contacted", reason: "Seeded workflow", actorUserId: owner.id },
    ]);
    const [salesPipeline] = await transaction.insert(pipelines).values({ organizationId: organization.id, name: "Sales", description: "Synthetic default sales workflow", isDefault: true, createdBy: owner.id, updatedBy: owner.id }).returning();
    const seededStages = await transaction.insert(pipelineStages).values([
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "New", position: 0, kind: "open", probability: 10, color: "#2563EB", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "Contacted", position: 1, kind: "open", probability: 25, color: "#7C3AED", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "Qualified", position: 2, kind: "open", probability: 50, color: "#D97706", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "Estimate", position: 3, kind: "open", probability: 75, color: "#0891B2", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "Won", position: 4, kind: "won", probability: 100, color: "#16A34A", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, pipelineId: salesPipeline.id, name: "Lost", position: 5, kind: "lost", probability: 0, color: "#DC2626", createdBy: owner.id, updatedBy: owner.id },
    ]).returning();
    const [openDeal, wonDeal, lostDeal] = await transaction.insert(deals).values([
      { organizationId: organization.id, identifier: "DEAL-DEMO0001", name: "Example Facility Upgrade", pipelineId: salesPipeline.id, stageId: seededStages[2].id, customerId: community.id, ownerUserId: owner.id, amountCents: 425000, currency: "CAD", expectedCloseDate: "2026-11-30", source: "Website", createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, identifier: "DEAL-DEMO0002", name: "Example Completed Sale", pipelineId: salesPipeline.id, stageId: seededStages[4].id, customerId: bakery.id, ownerUserId: owner.id, amountCents: 185000, currency: "CAD", closedAt: new Date("2026-08-15T12:00:00Z"), createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, identifier: "DEAL-DEMO0003", name: "Example Lost Opportunity", pipelineId: salesPipeline.id, stageId: seededStages[5].id, customerId: community.id, amountCents: 95000, currency: "CAD", closedAt: new Date("2026-08-20T12:00:00Z"), lostReason: "Timing", createdBy: owner.id, updatedBy: owner.id },
    ]).returning();
    await transaction.insert(dealStageHistory).values([
      { organizationId: organization.id, dealId: openDeal.id, newPipelineId: salesPipeline.id, newStageId: openDeal.stageId, actorUserId: owner.id, reason: "Seeded deal" },
      { organizationId: organization.id, dealId: wonDeal.id, newPipelineId: salesPipeline.id, newStageId: wonDeal.stageId, actorUserId: owner.id, reason: "Seeded won deal" },
      { organizationId: organization.id, dealId: lostDeal.id, newPipelineId: salesPipeline.id, newStageId: lostDeal.stageId, actorUserId: owner.id, reason: "Seeded lost deal" },
    ]);
    await transaction.insert(tasks).values([
      { organizationId: organization.id, title: "Follow up on facility upgrade", description: "Synthetic CRM follow-up", priority: "high", dueAt: new Date("2026-10-01T17:00:00Z"), assigneeUserId: owner.id, targetType: "deal", targetId: openDeal.id, createdBy: owner.id, updatedBy: owner.id },
      { organizationId: organization.id, title: "Confirm customer requirements", priority: "normal", targetType: "customer", targetId: bakery.id, createdBy: owner.id, updatedBy: owner.id },
    ]);
    await transaction.insert(activities).values({ organizationId: organization.id, type: "call", subject: "Initial discovery call", details: "Synthetic timeline activity", occurredAt: new Date("2026-09-01T16:00:00Z"), targetType: "deal", targetId: openDeal.id, actorUserId: owner.id, createdBy: owner.id, updatedBy: owner.id });
    await transaction.insert(notes).values({ organizationId: organization.id, body: "Synthetic internal CRM note; no attachment.", targetType: "deal", targetId: openDeal.id, authorUserId: owner.id, createdBy: owner.id, updatedBy: owner.id });
    const [maintenancePlan] = await transaction.insert(maintenancePlans).values({ organizationId: organization.id, code: "DEMO-CARE", name: "Demo Care Plan", description: "Synthetic annual maintenance plan", tier: "CARE", priceCents: 24900, currency: "CAD", visitEntitlementCount: 2, frequencyDescription: "Annual", priorityBenefit: "Priority booking", discountType: "percent", discountBasisPoints: 1000, includedServices: JSON.stringify(["Annual inspection"]), createdBy: owner.id, updatedBy: owner.id }).returning();
    const [maintenanceAgreement] = await transaction.insert(maintenanceAgreements).values({ organizationId: organization.id, sequenceNumber: 1, identifier: "MAINT-1", customerId: community.id, planId: maintenancePlan.id, status: "active", createdBy: owner.id, updatedBy: owner.id }).returning();
    const [maintenanceVersion] = await transaction.insert(maintenanceAgreementVersions).values({ organizationId: organization.id, agreementId: maintenanceAgreement.id, planSnapshot: JSON.stringify({ planId: maintenancePlan.id, code: maintenancePlan.code, name: maintenancePlan.name, priceCents: maintenancePlan.priceCents, currency: maintenancePlan.currency, visitEntitlementCount: 2, discountType: "percent", discountBasisPoints: 1000 }), customerSnapshot: JSON.stringify({ customerId: community.id, name: community.name, email: community.email, phone: community.phone }), serviceLocationSnapshot: JSON.stringify({ address: "100 Example Service Road" }), termsSnapshot: "Synthetic development agreement terms.", effectiveDate: "2026-01-01", expiresOn: "2026-12-31", renewalPreference: "manual", autoRenewConsent: JSON.stringify({ enabled: false }), totalPriceCents: 24900, currency: "CAD", activationProvenance: "synthetic_seed", createdBy: owner.id }).returning();
    await transaction.update(maintenanceAgreements).set({ currentVersionId: maintenanceVersion.id }).where(eq(maintenanceAgreements.id, maintenanceAgreement.id));
    const [membership] = await transaction.insert(maintenanceMemberships).values({ organizationId: organization.id, agreementId: maintenanceAgreement.id, customerId: community.id, planId: maintenancePlan.id, effectiveStart: "2026-01-01", effectiveEnd: "2026-12-31", visitsIncluded: 2 }).returning();
    await transaction.insert(maintenanceEntitlementEvents).values({ organizationId: organization.id, membershipId: membership.id, eventType: "grant", visitDelta: 2, idempotencyKey: `agreement:${maintenanceAgreement.id}:grant`, reason: "Synthetic seed activation", actorUserId: owner.id });
    await transaction.insert(maintenanceSchedules).values({ organizationId: organization.id, membershipId: membership.id, recurrence: "annual", nextDueDate: "2026-10-15", createdBy: owner.id });
  });
}

seed().then(() => process.exit(0)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Seed failed"); process.exit(1); });
