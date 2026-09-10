import "server-only";
import { verifyPasswordOrDummy } from "@/auth/password";
import { credentialsSchema } from "./identity.schema";
import { MembershipRepository } from "./membership.repository";
import { UserRepository } from "./user.repository";

export class AuthenticationService {
  constructor(private readonly memberships = new MembershipRepository(), private readonly users = new UserRepository()) {}

  async authenticate(rawCredentials: unknown) {
    const parsed = credentialsSchema.safeParse(rawCredentials);
    if (!parsed.success) return null;
    const membership = await this.memberships.resolveForAuthentication(parsed.data.email, parsed.data.organizationSlug);
    const passwordValid = await verifyPasswordOrDummy(parsed.data.password, membership?.passwordHash);
    if (!membership || !membership.userActive || !passwordValid || !membership.passwordHash) return null;
    await this.users.recordLogin(membership.userId);
    return {
      userId: membership.userId, name: membership.name, email: membership.email,
      organizationId: membership.organizationId, organizationName: membership.organizationName,
      organizationSlug: membership.organizationSlug, role: membership.role,
    };
  }
}
