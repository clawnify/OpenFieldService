export const permissions = [
  "customer.read", "customer.create", "customer.update", "customer.delete",
  "contact.read", "contact.create", "contact.update", "contact.delete",
  "company.read", "company.create", "company.update", "company.delete",
  "lead.read", "lead.create", "lead.update", "lead.assign", "lead.status", "lead.delete", "lead.convert",
  "pipeline.read", "pipeline.create", "pipeline.update", "pipeline.delete",
  "pipeline_stage.read", "pipeline_stage.create", "pipeline_stage.update", "pipeline_stage.delete",
  "deal.read", "deal.create", "deal.update", "deal.assign", "deal.move", "deal.close", "deal.delete",
  "task.read", "task.create", "task.update", "task.assign", "task.delete",
  "activity.read", "activity.create", "activity.update", "activity.delete",
  "note.read", "note.create", "note.update", "note.delete",
  "attachment.read", "attachment.create", "attachment.delete",
  "job.read", "job.create", "job.update", "job.assign", "job.schedule", "job.status", "job.complete", "job.delete", "job.checklist", "job.note", "job.evidence.manage", "job.report.write", "job.report.submit", "job.signature.capture",
  "pricebook.read", "pricebook.manage", "quote.read", "quote.create", "quote.update", "quote.present", "quote.accept", "quote.delete",
  "contract.read", "contract.create", "contract.update", "contract.send", "contract.void", "contract.delete", "contract.signing.manage",
  "invoice.read", "invoice.create", "invoice.update", "invoice.issue", "invoice.send", "invoice.void", "invoice.delete",
  "payment.read", "payment.create", "payment.reverse", "payment.receipt.read",
  "maintenance_plan.read", "maintenance_plan.manage", "maintenance_agreement.read", "maintenance_agreement.create", "maintenance_agreement.manage", "maintenance_schedule.manage", "maintenance_automation.run", "maintenance_asset.read", "maintenance_asset.manage", "maintenance_template.manage", "maintenance_report.read", "maintenance_report.manage",
  "retention.read", "retention.manage", "referral.read", "referral.manage", "loyalty.read", "loyalty.manage", "campaign.read", "campaign.manage", "campaign.execute",
  "phone.read", "phone.manage", "phone.call", "phone.assign", "phone.settings.manage",
  "user.invite", "user.manage", "settings.manage", "reports.view",
] as const;

export type Permission = (typeof permissions)[number];
export type Role = "owner" | "admin" | "manager" | "member" | "viewer";

const allPermissions = new Set<Permission>(permissions);
const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  owner: allPermissions,
  admin: allPermissions,
  manager: new Set(["customer.read", "customer.create", "customer.update", "contact.read", "contact.create", "contact.update", "company.read", "company.create", "company.update", "lead.read", "lead.create", "lead.update", "lead.assign", "lead.status", "lead.convert", "pipeline.read", "pipeline_stage.read", "deal.read", "deal.create", "deal.update", "deal.assign", "deal.move", "deal.close", "task.read", "task.create", "task.update", "task.assign", "activity.read", "activity.create", "activity.update", "note.read", "note.create", "note.update", "attachment.read", "attachment.create", "job.read", "job.create", "job.update", "job.assign", "job.schedule", "job.status", "job.complete", "job.checklist", "job.note", "pricebook.read", "quote.read", "quote.create", "quote.update", "quote.present", "quote.accept", "contract.read", "contract.create", "contract.update", "contract.send", "contract.void", "contract.signing.manage", "invoice.read", "invoice.create", "invoice.update", "invoice.issue", "invoice.send", "invoice.void", "invoice.delete", "payment.read", "payment.create", "payment.reverse", "payment.receipt.read", "maintenance_plan.read", "maintenance_agreement.read", "maintenance_agreement.create", "maintenance_agreement.manage", "maintenance_schedule.manage", "maintenance_automation.run", "maintenance_asset.read", "maintenance_asset.manage", "maintenance_template.manage", "maintenance_report.read", "maintenance_report.manage", "retention.read", "referral.read", "loyalty.read", "campaign.read", "reports.view"]),
  member: new Set(["customer.read", "customer.create", "customer.update", "contact.read", "contact.create", "contact.update", "company.read", "company.create", "company.update", "lead.read", "lead.create", "lead.update", "pipeline.read", "pipeline_stage.read", "deal.read", "task.read", "task.create", "task.update", "activity.read", "activity.create", "activity.update", "note.read", "note.create", "note.update", "attachment.read", "attachment.create", "job.read", "job.create", "job.update", "job.status", "job.complete", "job.checklist", "job.note", "maintenance_asset.read", "maintenance_report.read", "maintenance_report.manage", "reports.view"]),
  viewer: new Set(["customer.read", "contact.read", "company.read", "lead.read", "pipeline.read", "pipeline_stage.read", "deal.read", "task.read", "activity.read", "note.read", "attachment.read", "job.read", "quote.read", "contract.read", "invoice.read", "maintenance_asset.read", "maintenance_report.read", "reports.view"]),
};

const completionWorkflowPermissions = new Set<Permission>(["job.evidence.manage", "job.report.write", "job.report.submit", "job.signature.capture"]);
const dispatcherPhonePermissions = new Set<Permission>(["phone.read", "phone.manage", "phone.call", "phone.assign"]);

export interface AuthorizationSubject { role: Role }

export function can(subject: AuthorizationSubject, permission: Permission): boolean {
  if ((subject.role === "manager" || subject.role === "member") && completionWorkflowPermissions.has(permission)) return true;
  if (subject.role === "manager" && dispatcherPhonePermissions.has(permission)) return true;
  return rolePermissions[subject.role].has(permission);
}
