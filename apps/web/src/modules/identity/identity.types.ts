import type { organizationMembers, organizations, users } from "@/db/schema";

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type OrganizationMembership = typeof organizationMembers.$inferSelect;
export type NewOrganizationMembership = typeof organizationMembers.$inferInsert;

export type AuthenticatedMembership = {
  userId: string;
  name: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationMembership["role"];
};
