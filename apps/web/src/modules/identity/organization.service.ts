import "server-only";
import { ConflictError } from "@/lib/errors";
import { authorize } from "@/auth/authorization";
import type { RequestActor } from "@/modules/customers/customer.service";
import { hashPassword } from "@/auth/password";
import { createOrganizationSchema, createUserSchema, type CreateOrganizationInput, type CreateUserInput } from "./identity.schema";
import { DrizzleIdentityUnitOfWork, type IdentityUnitOfWork } from "./identity.unit-of-work";
import { MembershipRepository } from "./membership.repository";
import { OrganizationRepository } from "./organization.repository";

export class OrganizationService {
  constructor(private readonly unitOfWork: IdentityUnitOfWork = new DrizzleIdentityUnitOfWork(), private readonly organizations = new OrganizationRepository(), private readonly actorMemberships = new MembershipRepository()) {}

  /** Organization, initial user, and owner membership are one atomic boundary. */
  async createOrganizationWithOwner(rawOrganization: CreateOrganizationInput, rawOwner: CreateUserInput) {
    const organizationInput = createOrganizationSchema.parse(rawOrganization);
    const ownerInput = createUserSchema.parse(rawOwner);
    const passwordHash = await hashPassword(ownerInput.password);

    return this.unitOfWork.transaction(async ({ organizations, users, memberships }) => {
      if (await organizations.findBySlug(organizationInput.slug)) throw new ConflictError("Organization slug is already in use");
      if (await users.findByEmail(ownerInput.email)) throw new ConflictError("Email is already in use");
      const organization = await organizations.create(organizationInput);
      const user = await users.create({ name: ownerInput.name, email: ownerInput.email, passwordHash });
      const membership = await memberships.create({ organizationId: organization.id, userId: user.id, role: "owner" });
      return { organization, user, membership };
    });
  }

  async getCurrentOrganization(actor: RequestActor) {
    await authorize(actor, "customer.read", this.actorMemberships);
    return this.organizations.findById(actor.organizationId);
  }

  async updateCurrentOrganization(actor: RequestActor, name: string) {
    await authorize(actor, "settings.manage", this.actorMemberships);
    const parsedName = createOrganizationSchema.shape.name.parse(name);
    return this.organizations.update(actor.organizationId, { name: parsedName });
  }
}
