"use server";
import { signIn } from "@/auth/auth";

export async function loginAction(formData: FormData): Promise<void> {
  await signIn("credentials", { email: formData.get("email"), password: formData.get("password"), organizationSlug: formData.get("organizationSlug"), redirectTo: "/customers" });
}
