import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ContactService } from "@/modules/contacts/contact.service";
import { CustomerService } from "@/modules/customers/customer.service";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor(); if (!actor) redirect("/login"); const { id } = await params;
  const [customer, contactPage] = await Promise.all([new CustomerService().getCustomer(actor, id), new ContactService().listContacts(actor, { customerId: id, page: 1, pageSize: 50 })]);
  return <main className="mx-auto max-w-4xl px-6 py-12"><Link href="/customers" className="text-sm text-primary">← Customers</Link><h1 className="mt-5 text-4xl font-semibold tracking-tight">{customer.name}</h1>
    <dl className="mt-8 grid gap-4 rounded-xl border bg-card p-6 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Email</dt><dd>{customer.email || "—"}</dd></div><div><dt className="text-sm text-muted-foreground">Phone</dt><dd>{customer.phone || "—"}</dd></div><div className="sm:col-span-2"><dt className="text-sm text-muted-foreground">Address</dt><dd>{[customer.addressLine1, customer.city, customer.region, customer.postalCode].filter(Boolean).join(", ") || "—"}</dd></div></dl>
    <section className="mt-10"><h2 className="text-xl font-semibold">Contacts</h2><ul className="mt-4 divide-y rounded-xl border bg-card">{contactPage.items.map((contact) => <li className="p-4" key={contact.id}><span className="font-medium">{contact.firstName} {contact.lastName}</span>{contact.isPrimary ? <span className="ml-2 text-xs text-primary">Primary</span> : null}<p className="text-sm text-muted-foreground">{contact.email || contact.phone || "No contact details"}</p></li>)}</ul>{!contactPage.items.length ? <p className="mt-3 text-sm text-muted-foreground">No normalized contacts yet.</p> : null}</section></main>;
}
