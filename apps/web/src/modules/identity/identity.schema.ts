import { z } from "zod";

export const roleSchema = z.enum(["owner", "admin", "manager", "member", "viewer"]);
export const organizationNameSchema = z.string().trim().min(2).max(160);
export const organizationSlugSchema = z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const emailSchema = z.email().trim().toLowerCase().max(255);
export const passwordSchema = z.string().min(12).max(128);

export const createOrganizationSchema = z.object({ name: organizationNameSchema, slug: organizationSlugSchema });
export const createUserSchema = z.object({ name: z.string().trim().min(1).max(160), email: emailSchema, password: passwordSchema });
export const addMembershipSchema = z.object({ userId: z.uuid(), role: roleSchema });
export const changeMembershipRoleSchema = z.object({ userId: z.uuid(), role: roleSchema });
export const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128), organizationSlug: organizationSlugSchema });

export type MembershipRole = z.infer<typeof roleSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
