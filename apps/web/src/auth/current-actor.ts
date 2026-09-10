import "server-only";
import { auth } from "./auth";
import type { RequestActor } from "@/modules/customers/customer.service";

export async function currentActor(): Promise<RequestActor | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.organizationId || !session.user.role) return null;
  return { userId: session.user.id, organizationId: session.user.organizationId, role: session.user.role };
}
