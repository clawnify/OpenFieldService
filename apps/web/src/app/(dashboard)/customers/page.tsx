import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { CustomerService } from "@/modules/customers/customer.service";
import { CustomerForm } from "./customer-form";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ query?: string; page?: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login");
  const query = await searchParams; const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const result = await new CustomerService().listCustomers(actor, { query: query.query, page, pageSize: 25 });
  return <main className="mx-auto max-w-6xl px-6 py-12"><header><p className="text-sm font-medium text-primary">CRM</p><h1 className="mt-2 text-4xl font-semibold tracking-tight">Customers</h1></header>
    <form className="mt-8 flex gap-2"><input name="query" defaultValue={query.query} placeholder="Search name, email, or phone" className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2" /><button className="rounded-md border bg-card px-4 py-2">Search</button></form>
    <div className="mt-6 overflow-hidden rounded-xl border bg-card"><table className="w-full text-left text-sm"><thead className="bg-muted text-muted-foreground"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Phone</th></tr></thead><tbody>{result.items.map((customer) => <tr className="border-t" key={customer.id}><td className="px-4 py-3 font-medium"><Link href={`/customers/${customer.id}`}>{customer.name}</Link></td><td className="px-4 py-3">{customer.email || "—"}</td><td className="px-4 py-3">{customer.phone || "—"}</td></tr>)}</tbody></table>{!result.items.length ? <p className="p-6 text-muted-foreground">No customers found.</p> : null}</div>
    <div className="mt-10 max-w-2xl"><CustomerForm /></div></main>;
}
