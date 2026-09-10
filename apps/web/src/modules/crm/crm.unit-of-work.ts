import "server-only";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { CompanyRepository } from "@/modules/companies/company.repository";
import { ContactRepository } from "@/modules/contacts/contact.repository";
import { DrizzleCustomerRepository } from "@/modules/customers/customer.repository";
import { LeadRepository } from "@/modules/leads/lead.repository";
import { MembershipRepository } from "@/modules/identity/membership.repository";

export interface CrmRepositories { customers: DrizzleCustomerRepository; contacts: ContactRepository; companies: CompanyRepository; leads: LeadRepository; memberships: MembershipRepository; audit: AuditRepository }
export interface CrmUnitOfWork { transaction<T>(operation: (repositories: CrmRepositories) => Promise<T>): Promise<T> }

export class DrizzleCrmUnitOfWork implements CrmUnitOfWork {
  transaction<T>(operation: (repositories: CrmRepositories) => Promise<T>): Promise<T> {
    return getDb().transaction((transaction) => operation({ customers: new DrizzleCustomerRepository(transaction), contacts: new ContactRepository(transaction), companies: new CompanyRepository(transaction), leads: new LeadRepository(transaction), memberships: new MembershipRepository(transaction), audit: new AuditRepository(transaction) }));
  }
}
