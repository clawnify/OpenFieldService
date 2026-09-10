import "server-only";
import { authorize } from "@/auth/authorization";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ConflictError } from "@/lib/errors";
import { AuditRepository } from "@/modules/audit/audit.repository";
import type { RequestActor } from "@/modules/customers/customer.service";
import { MaintenanceJobGateway } from "./maintenance-job.gateway";
import { MaintenanceParityRepository } from "./maintenance-parity.repository";
import { MaintenanceRepository } from "./maintenance.repository";
import { MaintenanceService, type MaintenanceClock } from "./maintenance.service";
import { addDays, advanceDueDate, assertEntitlement, daysBetween, REMINDER_MILESTONES } from "./maintenance.rules";

export interface TrustedMaintenanceRunner { kind: "trusted_maintenance_scheduler"; organizationId: string }
export interface MaintenanceRunSummary { occurrencesProcessed: number; jobsGenerated: number; renewalsProcessed: number; remindersCreated: number; erroredCount: number; errorSummary: string }
const defaultClock: MaintenanceClock = { now: () => new Date(), today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) };

export class MaintenanceAutomationService {
  private readonly maintenance: MaintenanceService;
  constructor(private readonly time: MaintenanceClock = defaultClock, private readonly jobs = new MaintenanceJobGateway()) { this.maintenance = new MaintenanceService(time); }
  async runManual(actor: RequestActor) { await authorize(actor, "maintenance_automation.run"); return this.run(actor.organizationId, "manual", actor.userId); }
  async runTrusted(context: TrustedMaintenanceRunner) { if (context.kind !== "trusted_maintenance_scheduler") throw new ConflictError("Invalid automation execution context"); return this.run(context.organizationId, "scheduler", null); }
  async runTrustedAll(context:{kind:"trusted_maintenance_scheduler"}) { if(context.kind!=="trusted_maintenance_scheduler")throw new ConflictError("Invalid automation execution context");const orgs=await getDb().select({id:organizations.id}).from(organizations).where(eq(organizations.active,true));const results=[];for(const organization of orgs)results.push({organizationId:organization.id,...await this.run(organization.id,"scheduler",null)});return results; }

  private async run(organizationId: string, triggeredBy: "manual" | "scheduler", actorUserId: string | null): Promise<MaintenanceRunSummary> {
    return getDb().transaction(async tx => {
      const r = new MaintenanceRepository(tx), audit = new AuditRepository(tx), today = this.time.today();
      const summary: MaintenanceRunSummary = { occurrencesProcessed: 0, jobsGenerated: 0, renewalsProcessed: 0, remindersCreated: 0, erroredCount: 0, errorSummary: "" };
      for (const candidateSchedule of await r.dueSchedules(organizationId, today)) {
        const candidateMembership = await r.membership(organizationId, candidateSchedule.membershipId);
        if (!candidateMembership) continue;
        const agreement = await r.agreement(organizationId, candidateMembership.agreementId, true);
        const membership = await r.membership(organizationId, candidateMembership.id, true);
        const schedule = await r.schedule(organizationId, candidateSchedule.id, true);
        if (!agreement || agreement.status !== "active" || !membership || membership.status !== "active" || !schedule || schedule.status !== "active" || !schedule.automationEnabled || schedule.nextDueDate > today) continue;
        const cycle = schedule.cyclesGenerated + 1, occurrence = await r.createOccurrence({ organizationId, scheduleId: schedule.id, membershipId: membership.id, cycleNumber: cycle, dueDate: schedule.nextDueDate });
        if (!occurrence) continue;
        summary.occurrencesProcessed++;
        if (schedule.nextDueDate > membership.effectiveEnd) {
          await r.finishOccurrence(organizationId, occurrence.id, { status: "skipped", skipReason: "Agreement term ended" }); await r.setMembershipStatus(organizationId, membership.id, "expired", "Agreement term ended"); await r.setScheduleStatus(organizationId, schedule.id, "cancelled", "Agreement term ended"); continue;
        }
        const remaining = await r.entitlement(organizationId, membership.id);
        try { assertEntitlement(membership.visitsIncluded, remaining); } catch { await r.finishOccurrence(organizationId, occurrence.id, { status: "skipped", skipReason: "No remaining visit entitlement" }); await r.advanceSchedule(organizationId, schedule.id, cycle, advanceDueDate(schedule.nextDueDate, schedule.recurrence, schedule.customIntervalDays)); continue; }
        const version = agreement.currentVersionId ? await r.version(organizationId, agreement.id, agreement.currentVersionId) : null;
        if (!version) { await r.finishOccurrence(organizationId, occurrence.id, { status: "skipped", skipReason: "Agreement version is unavailable" }); continue; }
        const plan = JSON.parse(version.planSnapshot) as { name?: string }, location = JSON.parse(version.serviceLocationSnapshot) as { address?: string };
        const job = await this.jobs.create(tx, { kind: "maintenance_automation", organizationId, occurrenceId: occurrence.id }, { customerId: membership.customerId, title: `Recurring maintenance — ${plan.name ?? agreement.identifier}`, description: `Maintenance Agreement ${agreement.identifier}; occurrence ${cycle}; due ${schedule.nextDueDate}.`, serviceAddress: location.address ?? "Service location on file" });
        await r.finishOccurrence(organizationId, occurrence.id, { status: "job_generated", jobId: job.id, generatedAt: this.time.now() });
        if (!await r.advanceSchedule(organizationId, schedule.id, cycle, advanceDueDate(schedule.nextDueDate, schedule.recurrence, schedule.customIntervalDays))) throw new ConflictError("Maintenance schedule changed concurrently");
        await audit.record({ organizationId, actorUserId: null, action: "maintenance_occurrence.job_generated", entityType: "maintenance_occurrence", entityId: occurrence.id, metadata: { jobId: job.id, scheduleId: schedule.id, dueDate: schedule.nextDueDate } }); summary.jobsGenerated++;
      }

      const reminderDates = REMINDER_MILESTONES.map(days => addDays(today, days));
      for (const candidate of await r.reminderCandidates(organizationId, reminderDates)) {
        const milestone = daysBetween(today, candidate.version.expiresOn); if (!REMINDER_MILESTONES.includes(milestone as 60 | 30 | 14)) continue;
        const reminder = await r.createReminder({ organizationId, agreementId: candidate.agreement.id, agreementVersionId: candidate.version.id, milestoneDays: milestone, recipientSnapshot: JSON.stringify({ customerId: candidate.customer.id, name: candidate.customer.name, email: candidate.customer.email, phone: candidate.customer.phone }) });
        if (reminder) { const outbox=new MaintenanceParityRepository(tx), recipient=JSON.parse(reminder.recipientSnapshot) as {name?:string;email?:string|null;phone?:string|null}; for(const channel of [recipient.email?"email":null,recipient.phone?"sms":null].filter((x):x is string=>Boolean(x))) await outbox.addOutbox({organizationId,reminderIntentId:reminder.id,channel,eventType:"maintenance.renewal_reminder",recipientSnapshot:{name:recipient.name,address:channel==="email"?recipient.email:recipient.phone},payload:{agreementId:candidate.agreement.id,milestoneDays:milestone}}); summary.remindersCreated++; await audit.record({ organizationId, actorUserId: null, action: "maintenance_renewal.reminder_intent_created", entityType: "maintenance_agreement", entityId: candidate.agreement.id, metadata: { reminderId: reminder.id, milestoneDays: milestone } }); }
      }

      for (const candidate of await r.renewalCandidates(organizationId, addDays(today, 14), today)) {
        await this.maintenance.renew(tx, organizationId, candidate.agreement.id, null, true); summary.renewalsProcessed++;
      }
      const didWork = summary.occurrencesProcessed + summary.renewalsProcessed + summary.remindersCreated + summary.erroredCount > 0;
      if (didWork) await r.createRun({ organizationId, triggeredBy, actorUserId, ...summary });
      return summary;
    });
  }
}
