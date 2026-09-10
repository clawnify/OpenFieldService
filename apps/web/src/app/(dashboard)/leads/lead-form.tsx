"use client";
import { useActionState } from "react";
import { createLeadAction } from "./actions";

export function LeadForm() {
  const [state, action, pending] = useActionState(createLeadAction, {});
  return <form action={action} className="space-y-4 rounded-xl border bg-card p-6"><h2 className="text-xl font-semibold">Create lead</h2>
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Name<input required name="name" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label><label className="text-sm">Source<input name="source" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label><label className="text-sm">Email<input type="email" name="email" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label><label className="text-sm">Phone<input name="phone" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label></div>
    <label className="block text-sm">Notes<textarea name="notes" className="mt-1 min-h-24 w-full rounded-md border bg-background px-3 py-2" /></label>{state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}<button disabled={pending} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{pending ? "Creating…" : "Create lead"}</button></form>;
}
