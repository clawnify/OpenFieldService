import { describe, expect, it } from "vitest";
import { authorize } from "@/auth/authorization";
import { ConflictError, UnauthorizedError } from "@/lib/errors";
import { AuthenticationService } from "./authentication.service";
import { MembershipRepository } from "./membership.repository";
import { MembershipService } from "./membership.service";
import { OrganizationRepository } from "./organization.repository";
import { OrganizationService } from "./organization.service";
import { UserService } from "./user.service";

describe("PostgreSQL identity and authentication", () => {
  it("atomically creates an organization, user, and owner membership", async () => {
    const result = await new OrganizationService().createOrganizationWithOwner(
      { name: "Alpha Service", slug: "alpha-service" },
      { name: "Alpha Owner", email: "owner@alpha.example", password: "Correct-Horse-123" },
    );
    expect(result.membership.organizationId).toBe(result.organization.id);
    expect(result.membership.userId).toBe(result.user.id);
    expect(result.membership.role).toBe("owner");
    expect(result.user.passwordHash).not.toBe("Correct-Horse-123");
  });

  it("authenticates only against the requested active organization membership", async () => {
    const authentication = new AuthenticationService();
    const valid = await authentication.authenticate({ email: "OWNER@ALPHA.EXAMPLE", password: "Correct-Horse-123", organizationSlug: "alpha-service" });
    expect(valid).toMatchObject({ organizationSlug: "alpha-service", role: "owner" });
    expect(await authentication.authenticate({ email: "owner@alpha.example", password: "wrong-password", organizationSlug: "alpha-service" })).toBeNull();
    expect(await authentication.authenticate({ email: "owner@alpha.example", password: "Correct-Horse-123", organizationSlug: "other-tenant" })).toBeNull();
  });

  it("creates a user and membership atomically inside the actor tenant", async () => {
    const organization = await new OrganizationRepository().findBySlug("alpha-service");
    const owner = await new AuthenticationService().authenticate({ email: "owner@alpha.example", password: "Correct-Horse-123", organizationSlug: "alpha-service" });
    expect(organization && owner).toBeTruthy();
    const actor = { userId: owner!.userId, organizationId: organization!.id, role: owner!.role };
    const created = await new UserService().createUserWithMembership(actor, { name: "Dispatcher", email: "dispatch@alpha.example", password: "Dispatcher-Pass-123" }, "manager");
    expect(created.membership.organizationId).toBe(organization!.id);
    expect((await new AuthenticationService().authenticate({ email: "dispatch@alpha.example", password: "Dispatcher-Pass-123", organizationSlug: "alpha-service" }))?.role).toBe("manager");
  });

  it("rejects spoofed tenant claims even when the claimed role is privileged", async () => {
    const owner = await new AuthenticationService().authenticate({ email: "owner@alpha.example", password: "Correct-Horse-123", organizationSlug: "alpha-service" });
    await expect(authorize({ userId: owner!.userId, organizationId: "00000000-0000-4000-8000-000000000999", role: "owner" }, "user.manage")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("prevents demoting the final owner in the role-assignment transaction", async () => {
    const owner = await new AuthenticationService().authenticate({ email: "owner@alpha.example", password: "Correct-Horse-123", organizationSlug: "alpha-service" });
    const actor = { userId: owner!.userId, organizationId: owner!.organizationId, role: owner!.role };
    await expect(new MembershipService().assignRole(actor, owner!.userId, "admin")).rejects.toBeInstanceOf(ConflictError);
    expect((await new MembershipRepository().find(owner!.organizationId, owner!.userId))?.role).toBe("owner");
  });
});
