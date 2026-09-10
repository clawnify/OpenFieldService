import "server-only";
import { can, type Permission } from "./permissions";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { MembershipRepository } from "@/modules/identity/membership.repository";
import type { RequestActor } from "@/modules/customers/customer.service";

export async function authorize(actor: RequestActor | null, permission: Permission, memberships = new MembershipRepository()): Promise<RequestActor> {
  if (!actor) throw new UnauthorizedError();
  const membership = await memberships.find(actor.organizationId, actor.userId);
  if (!membership || membership.role !== actor.role) throw new UnauthorizedError("Organization membership is no longer active");
  if (!can({ role: membership.role }, permission)) throw new ForbiddenError();
  return actor;
}
