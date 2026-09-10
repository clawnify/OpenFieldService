import { notFound, redirect } from "next/navigation";
import { can } from "@/auth/permissions";
import { currentActor } from "@/auth/current-actor";
import { CustomerService } from "@/modules/customers/customer.service";
import { LeadService } from "@/modules/leads/lead.service";
import { NotFoundError } from "@/lib/errors";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";
import { updateCallAction } from "../actions";

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login");
  const { id } = await params, service = new PhoneOperationsService();
  let view; try { view = await service.getCall(actor, id); } catch (error) { if (error instanceof NotFoundError) notFound(); throw error; }
  const [customers, leads] = await Promise.all([new CustomerService().listCustomers(actor, { page: 1, pageSize: 100 }), new LeadService().listLeads(actor, { page: 1, pageSize: 100 })]);
  return <main className="mx-auto max-w-4xl px-6 py-12">
    <p className="text-sm font-medium text-primary">{view.call.direction} call</p><h1 className="mt-2 text-3xl font-semibold">{view.call.normalizedFrom} to {view.call.normalizedTo}</h1>
    <dl className="mt-6 grid gap-4 rounded-xl border p-5 sm:grid-cols-3"><div><dt className="text-sm text-muted-foreground">Status</dt><dd>{view.call.status}</dd></div><div><dt className="text-sm text-muted-foreground">Match</dt><dd>{view.call.matchConfidence}</dd></div><div><dt className="text-sm text-muted-foreground">Provider ID</dt><dd className="break-all text-sm">{view.call.providerCallId}</dd></div></dl>
    {can(actor, "phone.manage") ? <form action={updateCallAction.bind(null, id)} className="mt-8 grid gap-3 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">CRM context and outcome</h2>
      <select name="subject" defaultValue={view.call.customerId ? "customer" : view.call.leadId ? "lead" : "none"} className="rounded-md border px-3 py-2"><option value="none">Unlinked</option><option value="customer">Customer</option><option value="lead">Lead</option></select>
      <select name="subjectId" defaultValue={view.call.customerId ?? view.call.leadId ?? ""} className="rounded-md border px-3 py-2"><option value="">Select CRM record</option><optgroup label="Customers">{customers.items.map(x => <option value={x.id} key={x.id}>{x.name}</option>)}</optgroup><optgroup label="Leads">{leads.items.map(x => <option value={x.id} key={x.id}>{x.name}</option>)}</optgroup></select>
      <input name="disposition" defaultValue={view.call.disposition ?? ""} placeholder="Disposition" className="rounded-md border px-3 py-2"/><textarea name="notes" defaultValue={view.call.notes ?? ""} placeholder="Internal call notes" className="min-h-28 rounded-md border px-3 py-2"/><button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Save call context</button>
    </form> : null}
    <section className="mt-8"><h2 className="text-xl font-semibold">Lifecycle</h2><ol className="mt-3 space-y-2">{view.events.map(event => <li className="rounded-md border p-3 text-sm" key={event.id}>{event.providerStatus} - {event.accepted ? "accepted" : "ignored as stale"} - {event.providerOccurredAt.toISOString()}</li>)}</ol></section>
    {view.transcript.length ? <section className="mt-8"><h2 className="text-xl font-semibold">Transcript</h2><p className="text-sm text-muted-foreground">Private to authorized Phone Operations users.</p><ol className="mt-3 space-y-2">{view.transcript.map(line => <li key={line.id} className="rounded-md border p-3"><b>{line.speaker}</b><p>{line.content}</p></li>)}</ol></section> : null}
  </main>;
}
