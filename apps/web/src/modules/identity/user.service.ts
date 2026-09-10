import "server-only";
import { authorize } from "@/auth/authorization";
import { hashPassword } from "@/auth/password";
import { ConflictError } from "@/lib/errors";
import type { RequestActor } from "@/modules/customers/customer.service";
import { createUserSchema, roleSchema, type CreateUserInput, type MembershipRole } from "./identity.schema";
import { DrizzleIdentityUnitOfWork, type IdentityUnitOfWork } from "./identity.unit-of-work";
import { MembershipRepository } from "./membership.repository";

export class UserService {
  constructor(private readonly unitOfWork: IdentityUnitOfWork = new DrizzleIdentityUnitOfWork(), private readonly actorMemberships = new MembershipRepository()) {}

  /** User and membership creation are atomic; users cannot be orphaned on a failed membership insert. */
  async createUserWithMembership(actor: RequestActor, rawUser: CreateUserInput, rawRole: MembershipRole) {
    await authorize(actor, "user.manage", this.actorMemberships);
    const input = createUserSchema.parse(rawUser);
    const role = roleSchema.parse(rawRole);
    const passwordHash = await hashPassword(input.password);

    return this.unitOfWork.transaction(async ({ users, memberships }) => {
      if (await users.findByEmail(input.email)) throw new ConflictError("Email is already in use");
      const user = await users.create({ name: input.name, email: input.email, passwordHash });
      const membership = await memberships.create({ organizationId: actor.organizationId, userId: user.id, role });
      return { user, membership };
    });
  }

  async listOrganizationUsers(actor: RequestActor) {
    await authorize(actor, "user.manage", this.actorMemberships);
    return this.actorMemberships.list(actor.organizationId);
  }
}
