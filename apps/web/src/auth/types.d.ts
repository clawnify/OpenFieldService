import type { DefaultSession } from "next-auth";
import type { Role } from "./permissions";

declare module "next-auth" {
  interface User {
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: Role;
  }
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      organizationId: string;
      organizationName: string;
      organizationSlug: string;
      role: Role;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: Role;
  }
}
