import "server-only";
import { authorize } from "@/auth/authorization";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { RequestActor } from "@/modules/customers/customer.service";
import { roleSchema, type MembershipRole } from "./identity.schema";
import { DrizzleIdentityUnitOfWork, type IdentityUnitOfWork } from "./identity.unit-of-work";
import { MembershipRepository } from "./membership.repository";

export class MembershipService {
  constructor(private readonly unitOfWork: IdentityUnitOfWork = new DrizzleIdentityUnitOfWork(), private readonly actorMemberships = new MembershipRepository()) {}

  /** Role validation and last-owner protection execute in the same transaction as the update. */
  async assignRole(actor: RequestActor, userId: string, rawRole: MembershipRole) {
    await authorize(actor, "user.manage", this.actorMemberships);
    const role = roleSchema.parse(rawRole);
    return this.unitOfWork.transaction(async ({ memberships, organizations }) => {
      await organizations.lock(actor.organizationId);
      const current = await memberships.find(actor.organizationId, userId);
      if (!current) throw new NotFoundError("Organization membership not found");
      if (current.role === "owner" && role !== "owner" && await memberships.countOwners(actor.organizationId) <= 1) {
        throw new ConflictError("The last organization owner cannot be demoted");
      }
      const membership = await memberships.changeRole(actor.organizationId, userId, role);
      if (!membership) throw new NotFoundError("Organization membership not found");
      return membership;
    });
  }

  async removeMembership(actor: RequestActor, userId: string): Promise<void> {
    await authorize(actor, "user.manage", this.actorMemberships);
    await this.unitOfWork.transaction(async ({ memberships, organizations }) => {
      await organizations.lock(actor.organizationId);
      const current = await memberships.find(actor.organizationId, userId);
      if (!current) throw new NotFoundError("Organization membership not found");
      if (current.role === "owner" && await memberships.countOwners(actor.organizationId) <= 1) {
        throw new ConflictError("The last organization owner cannot be removed");
      }
      if (!await memberships.deactivate(actor.organizationId, userId)) throw new NotFoundError("Organization membership not found");
    });
  }
}
