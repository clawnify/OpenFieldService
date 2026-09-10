import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getServerEnv } from "@/lib/env";
import { AuthenticationService } from "@/modules/identity/authentication.service";
import { roleSchema } from "@/modules/identity/identity.schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: getServerEnv().AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        organizationSlug: { label: "Organization", type: "text" },
      },
      async authorize(credentials) {
        const membership = await new AuthenticationService().authenticate(credentials);
        if (!membership) return null;
        return {
          id: membership.userId,
          name: membership.name,
          email: membership.email,
          organizationId: membership.organizationId,
          organizationName: membership.organizationName,
          organizationSlug: membership.organizationSlug,
          role: membership.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.organizationId = user.organizationId;
        token.organizationName = user.organizationName;
        token.organizationSlug = user.organizationSlug;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      const organizationId = token.organizationId;
      const organizationName = token.organizationName;
      const organizationSlug = token.organizationSlug;
      const role = roleSchema.safeParse(token.role);
      if (typeof token.sub !== "string" || typeof organizationId !== "string" || typeof organizationName !== "string" || typeof organizationSlug !== "string" || !role.success) {
        throw new Error("Authenticated session is missing organization membership claims");
      }
      session.user.id = token.sub;
      session.user.organizationId = organizationId;
      session.user.organizationName = organizationName;
      session.user.organizationSlug = organizationSlug;
      session.user.role = role.data;
      return session;
    },
  },
});
