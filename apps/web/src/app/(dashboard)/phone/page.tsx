import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/auth/permissions";
import { currentActor } from "@/auth/current-actor";
import { CustomerService } from "@/modules/customers/customer.service";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";
import { placeCallAction } from "./actions";

const statuses = ["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"] as const;
export default async function PhonePage({ searchParams }: { searchParams: Promise<{ query?: string; status?: string; page?: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login");
  const q = await searchParams, service = new PhoneOperationsService(), page = Number(q.page || 1);
  const status = statuses.includes(q.status as typeof statuses[number]) ? q.status as typeof statuses[number] : undefined;
  const [calls, numbers, customers] = await Promise.all([service.listCalls(actor, { query: q.query, status, page, pageSize: 25 }), service.listPhoneNumbers(actor), new CustomerService().listCustomers(actor, { page: 1, pageSize: 100 })]);
  return <main className="mx-auto max-w-6xl px-6 py-12">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-medium text-primary">CRM communications</p><h1 className="mt-2 text-4xl font-semibold">Phone operations</h1></div>{can(actor, "phone.settings.manage") ? <Link href="/settings/phone" className="rounded-md border px-4 py-2">Phone settings</Link> : null}</header>
    <form className="mt-8 flex flex-wrap gap-2"><input name="query" defaultValue={q.query} placeholder="Phone or provider call ID" className="min-w-56 flex-1 rounded-md border px-3 py-2"/><select name="status" defaultValue={q.status ?? ""} className="rounded-md border px-3"><option value="">All statuses</option>{statuses.map(x => <option key={x}>{x}</option>)}</select><button className="rounded-md border px-4">Filter</button></form>
    <div className="mt-6 overflow-x-auto rounded-xl border"><table className="w-full min-w-[700px] text-left text-sm"><thead><tr><th className="p-3">Direction</th><th>From / to</th><th>CRM match</th><th>Status</th><th>Started</th></tr></thead><tbody>{calls.items.map(call => <tr className="border-t" key={call.id}><td className="p-3"><Link href={`/phone/${call.id}`} className="font-medium">{call.direction}</Link></td><td>{call.normalizedFrom} to {call.normalizedTo}</td><td>{call.matchConfidence}</td><td>{call.status}</td><td>{call.createdAt.toISOString()}</td></tr>)}</tbody></table>{calls.total === 0 ? <p className="p-6 text-sm text-muted-foreground">No calls match this view.</p> : null}</div>
    {can(actor, "phone.call") ? <form action={placeCallAction} className="mt-8 grid gap-3 rounded-xl border p-5 md:grid-cols-2"><h2 className="text-xl font-semibold md:col-span-2">Place outbound call</h2><select required name="phoneNumberId" className="rounded-md border px-3 py-2"><option value="">Outbound number</option>{numbers.filter(n => n.outboundEnabled && n.status === "active").map(n => <option value={n.id} key={n.id}>{n.label || n.e164}</option>)}</select><input required name="destination" placeholder="+16045550100" className="rounded-md border px-3 py-2"/><select name="customerId" className="rounded-md border px-3 py-2"><option value="">No customer link</option>{customers.items.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Place call</button></form> : null}
  </main>;
}
