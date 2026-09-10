import { notFound, redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { NotFoundError } from "@/lib/errors";
import { LeadService } from "@/modules/leads/lead.service";
import { convertLeadAction } from "../actions";
import { LeadStatusForm } from "./lead-status-form";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login"); const { id } = await params; let lead; try { lead = await new LeadService().getLead(actor, id); } catch (error) { if (error instanceof NotFoundError) notFound(); throw error; }
  const convert = convertLeadAction.bind(null, lead.id);
  return <main className="mx-auto max-w-3xl px-6 py-12"><p className="text-sm font-medium text-primary">{lead.identifier}</p><div className="mt-2 flex items-start justify-between gap-4"><h1 className="text-4xl font-semibold tracking-tight">{lead.name}</h1><span className="rounded-full border px-3 py-1 text-sm capitalize">{lead.status}</span></div>
    <dl className="mt-8 grid gap-4 rounded-xl border bg-card p-6 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Email</dt><dd>{lead.email || "—"}</dd></div><div><dt className="text-sm text-muted-foreground">Phone</dt><dd>{lead.phone || "—"}</dd></div><div><dt className="text-sm text-muted-foreground">Source</dt><dd>{lead.source || "—"}</dd></div><div><dt className="text-sm text-muted-foreground">Converted customer</dt><dd>{lead.convertedCustomerId || "—"}</dd></div></dl>
    <LeadStatusForm id={lead.id} status={lead.status} />
    {(lead.status === "estimate" || lead.status === "won") && !lead.convertedCustomerId ? <form action={convert} className="mt-6"><button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Convert to customer</button></form> : null}</main>;
}
