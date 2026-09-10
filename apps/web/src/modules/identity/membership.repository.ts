import "server-only";
import { and, count, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { organizationMembers, organizations, users } from "@/db/schema";
import type { AuthenticatedMembership, NewOrganizationMembership, OrganizationMembership } from "./identity.types";

export class MembershipRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}

  async create(input: NewOrganizationMembership): Promise<OrganizationMembership> {
    const [membership] = await this.executor.insert(organizationMembers).values(input).returning();
    return membership;
  }

  async find(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    const [membership] = await this.executor.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.active, true))).limit(1);
    return membership ?? null;
  }

  async list(organizationId: string): Promise<AuthenticatedMembership[]> {
    return this.executor.select({
      userId: users.id, name: users.name, email: users.email,
      organizationId: organizations.id, organizationName: organizations.name, organizationSlug: organizations.slug, role: organizationMembers.role,
    }).from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.active, true), eq(users.active, true), eq(organizations.active, true)));
  }

  async resolveForAuthentication(email: string, organizationSlug: string): Promise<(AuthenticatedMembership & { passwordHash: string | null; userActive: boolean }) | null> {
    const [result] = await this.executor.select({
      userId: users.id, name: users.name, email: users.email, passwordHash: users.passwordHash, userActive: users.active,
      organizationId: organizations.id, organizationName: organizations.name, organizationSlug: organizations.slug, role: organizationMembers.role,
    }).from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(users.email, email), eq(organizations.slug, organizationSlug), eq(users.active, true), eq(organizations.active, true), eq(organizationMembers.active, true))).limit(1);
    return result ?? null;
  }

  async countOwners(organizationId: string): Promise<number> {
    const [{ value }] = await this.executor.select({ value: count() }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, "owner"), eq(organizationMembers.active, true)));
    return value;
  }

  async changeRole(organizationId: string, userId: string, role: OrganizationMembership["role"]): Promise<OrganizationMembership | null> {
    const [membership] = await this.executor.update(organizationMembers).set({ role, updatedAt: new Date() }).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.active, true))).returning();
    return membership ?? null;
  }

  async deactivate(organizationId: string, userId: string): Promise<boolean> {
    const membership = await this.executor.update(organizationMembers).set({ active: false, updatedAt: new Date() }).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.active, true))).returning({ userId: organizationMembers.userId });
    return membership.length === 1;
  }
}
