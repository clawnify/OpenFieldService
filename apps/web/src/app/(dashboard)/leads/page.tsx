import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { LeadService } from "@/modules/leads/lead.service";
import { LeadForm } from "./lead-form";

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ query?: string; status?: string; page?: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login"); const query = await searchParams; const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const status = ["new", "contacted", "qualified", "estimate", "won", "lost"].includes(query.status ?? "") ? query.status as "new" : undefined;
  const result = await new LeadService().listLeads(actor, { query: query.query, status, page, pageSize: 25 });
  return <main className="mx-auto max-w-6xl px-6 py-12"><header><p className="text-sm font-medium text-primary">CRM</p><h1 className="mt-2 text-4xl font-semibold tracking-tight">Leads</h1></header>
    <form className="mt-8 flex gap-2"><input name="query" defaultValue={query.query} placeholder="Search identifier, name, email, or phone" className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2" /><select name="status" defaultValue={query.status ?? ""} className="rounded-md border bg-background px-3 py-2"><option value="">All statuses</option>{["new", "contacted", "qualified", "estimate", "won", "lost"].map((value) => <option key={value}>{value}</option>)}</select><button className="rounded-md border bg-card px-4 py-2">Filter</button></form>
    <div className="mt-6 overflow-hidden rounded-xl border bg-card"><table className="w-full text-left text-sm"><thead className="bg-muted text-muted-foreground"><tr><th className="px-4 py-3">Lead</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Source</th></tr></thead><tbody>{result.items.map((lead) => <tr className="border-t" key={lead.id}><td className="px-4 py-3"><Link className="font-medium" href={`/leads/${lead.id}`}>{lead.name}</Link><div className="text-xs text-muted-foreground">{lead.identifier}</div></td><td className="px-4 py-3 capitalize">{lead.status}</td><td className="px-4 py-3">{lead.source || "—"}</td></tr>)}</tbody></table>{!result.items.length ? <p className="p-6 text-muted-foreground">No leads found.</p> : null}</div><div className="mt-10 max-w-2xl"><LeadForm /></div></main>;
}
