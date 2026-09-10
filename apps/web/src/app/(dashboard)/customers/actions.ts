"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { CustomerService } from "@/modules/customers/customer.service";

export interface CustomerActionState { error?: string; issues?: ReadonlyArray<{ path: string; message: string }> }

export async function createCustomerAction(_state: CustomerActionState, formData: FormData): Promise<CustomerActionState> {
  try {
    const actor = await currentActor();
    const customer = await new CustomerService().createCustomer(actor!, {
      name: String(formData.get("name") ?? ""), email: String(formData.get("email") ?? ""), phone: String(formData.get("phone") ?? ""),
      addressLine1: String(formData.get("addressLine1") ?? ""), city: String(formData.get("city") ?? ""), region: String(formData.get("region") ?? ""), postalCode: String(formData.get("postalCode") ?? ""),
    });
    revalidatePath("/customers"); redirect(`/customers/${customer.id}`);
  } catch (error) {
    if (error instanceof ApplicationError) return { error: error.message, issues: "issues" in error ? error.issues as CustomerActionState["issues"] : undefined };
    throw error;
  }
}
