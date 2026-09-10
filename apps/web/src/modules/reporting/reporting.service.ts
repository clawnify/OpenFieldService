import "server-only";
import { authorize } from "@/auth/authorization";
import { can } from "@/auth/permissions";
import type { RequestActor } from "@/modules/customers/customer.service";
import { ReportingRepository } from "./reporting.repository";
import { dashboardMetricDefinitions, vancouverBusinessDate } from "./reporting.rules";

export class ReportingService {
  constructor(private readonly repository = new ReportingRepository(), private readonly now = () => new Date()) {}

  async dashboard(actor: RequestActor) {
    await authorize(actor, "reports.view");
    const today = vancouverBusinessDate(this.now());
    const scope = {
      organizationId: actor.organizationId,
      ...(actor.role === "member" ? { technicianUserId: actor.userId } : {}),
    };
    const [operational, schedule] = await Promise.all([
      this.repository.operationalSummary(scope, today),
      this.repository.todaySchedule(scope, today),
    ]);
    const financial = can(actor, "payment.read") && can(actor, "invoice.read")
      ? await this.repository.financialSummary(actor.organizationId, today)
      : null;
    return { asOfBusinessDate: today, timezone: "America/Vancouver" as const, operational, financial, schedule, definitions: dashboardMetricDefinitions };
  }
}
