"use client";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { createCustomerAction, type CustomerActionState } from "./actions";

const initialState: CustomerActionState = {};
export function CustomerForm() {
  const [state, action, pending] = useActionState(createCustomerAction, initialState);
  useEffect(() => { if (state.error) toast.error(state.error); }, [state]);
  return (
    <form action={action} className="grid gap-4 rounded-xl border bg-card p-6 sm:grid-cols-2">
      <h2 className="text-lg font-semibold sm:col-span-2">Create customer</h2>
      <label className="text-sm font-medium sm:col-span-2">Name<input name="name" required maxLength={200} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium">Email<input name="email" type="email" maxLength={255} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium">Phone<input name="phone" maxLength={255} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium sm:col-span-2">Address<input name="addressLine1" maxLength={255} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium">City<input name="city" maxLength={120} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium">Region<input name="region" maxLength={120} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      <label className="text-sm font-medium">Postal code<input name="postalCode" maxLength={24} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
      {state.issues?.length ? <ul className="text-sm text-destructive sm:col-span-2">{state.issues.map((issue) => <li key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>)}</ul> : null}
      <button disabled={pending} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50 sm:col-span-2">{pending ? "Creating…" : "Create customer"}</button>
    </form>
  );
}
