import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, CheckCircle2, CircleDollarSign, FileWarning, UsersRound, Wrench } from "lucide-react";
import { currentActor } from "@/auth/current-actor";
import { ReportingService } from "@/modules/reporting/reporting.service";

const whole = new Intl.NumberFormat("en-CA");
const money = (amountCents: number, currency: string) => new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(amountCents / 100);

function Metric({ label, value, definition, href, icon: Icon }: { label: string; value: string; definition: string; href?: string; icon: typeof Wrench }) {
  const content = <>
    <div className="flex items-start justify-between gap-4">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
    </div>
    <dd className="mt-3 font-mono text-3xl font-semibold tracking-tight tabular-nums">{value}</dd>
    <dd className="mt-2 text-sm leading-6 text-muted-foreground">{definition}</dd>
  </>;
  return href
    ? <Link className="block rounded-xl border bg-card p-5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" href={href}><dl>{content}</dl></Link>
    : <div className="rounded-xl border bg-card p-5"><dl>{content}</dl></div>;
}

export default async function ReportsPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const report = await new ReportingService().dashboard(actor);
  const collected = report.financial?.netCollected.length
    ? report.financial.netCollected.map(item => money(item.amountCents, item.currency)).join(" · ")
    : money(0, "CAD");

  return <main id="main-content" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
    <header className="max-w-3xl">
      <p className="text-sm font-medium tracking-wide text-primary">OPERATIONS REPORTING</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Business snapshot</h1>
      <p className="mt-3 text-base leading-7 text-muted-foreground">
        Authoritative current-state metrics for <time dateTime={report.asOfBusinessDate}>{report.asOfBusinessDate}</time> in {report.timezone}.
      </p>
    </header>

    <section className="mt-8" aria-labelledby="operations-heading">
      <h2 id="operations-heading" className="text-xl font-semibold">Operations</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Total Jobs" value={whole.format(report.operational.totalJobs)} definition={report.definitions.totalJobs} href="/jobs" icon={Wrench} />
        <Metric label="Customers" value={whole.format(report.operational.customers)} definition={report.definitions.customers} href="/customers" icon={UsersRound} />
        <Metric label="Today's Jobs" value={whole.format(report.operational.todayJobs)} definition={report.definitions.todayJobs} href={`/schedule?date=${report.asOfBusinessDate}`} icon={CalendarDays} />
        <Metric label="Upcoming" value={whole.format(report.operational.upcomingJobs)} definition={report.definitions.upcomingJobs} href="/jobs?status=scheduled" icon={CalendarDays} />
        <Metric label="Completed work" value={whole.format(report.operational.completedJobs)} definition={report.definitions.completedJobs} href="/jobs?status=completed" icon={CheckCircle2} />
      </div>
    </section>

    {report.financial ? <section className="mt-10" aria-labelledby="financial-heading">
      <h2 id="financial-heading" className="text-xl font-semibold">Financial</h2>
      <p className="mt-1 text-sm text-muted-foreground">Cash movement and current Invoice lifecycle state. Voided Invoices are excluded from outstanding counts.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Metric label="Net collected" value={collected} definition={report.definitions.netCollected} href="/invoices" icon={CircleDollarSign} />
        <Metric label="Outstanding Invoices" value={whole.format(report.financial.outstandingInvoices)} definition={report.definitions.outstandingInvoices} href="/invoices?status=issued" icon={FileWarning} />
        <Metric label="Overdue Invoices" value={whole.format(report.financial.overdueInvoices)} definition={report.definitions.overdueInvoices} href="/invoices?status=issued" icon={FileWarning} />
      </div>
    </section> : null}

    <section className="mt-10" aria-labelledby="schedule-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="schedule-heading" className="text-xl font-semibold">Today&apos;s schedule</h2>
          <p className="mt-1 text-sm text-muted-foreground">Up to 100 non-cancelled Jobs, ordered by scheduled time.</p>
        </div>
        <Link className="inline-flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" href={`/schedule?date=${report.asOfBusinessDate}`}>Open schedule</Link>
      </div>
      {report.schedule.length ? <div className="mt-4 overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">Jobs scheduled for {report.asOfBusinessDate}</caption>
          <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-4 py-3 font-medium" scope="col">Time</th><th className="px-4 py-3 font-medium" scope="col">Job</th><th className="px-4 py-3 font-medium" scope="col">Customer</th><th className="px-4 py-3 font-medium" scope="col">Technician</th><th className="px-4 py-3 font-medium" scope="col">Status</th></tr></thead>
          <tbody>{report.schedule.map(job => <tr className="border-t" key={job.id}>
            <td className="px-4 py-3 font-mono tabular-nums">{job.scheduledTime?.slice(0, 5) ?? "Unscheduled"}</td>
            <td className="px-4 py-3"><Link className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/jobs/${job.id}`}>{job.identifier}</Link><span className="mt-1 block text-muted-foreground">{job.title}</span></td>
            <td className="px-4 py-3"><Link className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/customers/${job.customerId}`}>{job.customerName}</Link></td>
            <td className="px-4 py-3">{job.technicianName ?? "Unassigned"}</td>
            <td className="px-4 py-3 capitalize">{job.status.replaceAll("_", " ")}</td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="mt-4 rounded-xl border border-dashed p-8 text-center"><p className="font-medium">No Jobs scheduled today</p><p className="mt-1 text-sm text-muted-foreground">The schedule is clear for this business date.</p></div>}
    </section>
  </main>;
}
