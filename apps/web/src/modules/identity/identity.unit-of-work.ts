import "server-only";
import { getDb } from "@/db";
import { MembershipRepository } from "./membership.repository";
import { OrganizationRepository } from "./organization.repository";
import { UserRepository } from "./user.repository";

export interface IdentityRepositories {
  organizations: OrganizationRepository;
  users: UserRepository;
  memberships: MembershipRepository;
}

export interface IdentityUnitOfWork {
  transaction<T>(operation: (repositories: IdentityRepositories) => Promise<T>): Promise<T>;
}

export class DrizzleIdentityUnitOfWork implements IdentityUnitOfWork {
  async transaction<T>(operation: (repositories: IdentityRepositories) => Promise<T>): Promise<T> {
    return getDb().transaction((transaction) => operation({
      organizations: new OrganizationRepository(transaction),
      users: new UserRepository(transaction),
      memberships: new MembershipRepository(transaction),
    }));
  }
}
