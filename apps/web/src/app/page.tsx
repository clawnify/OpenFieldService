import { ArrowRight, CalendarDays, ContactRound, Wrench } from "lucide-react";

const modules = [
  { name: "Customers", detail: "Customer records and service history", icon: ContactRound },
  { name: "Schedule", detail: "Dispatch and technician availability", icon: CalendarDays },
  { name: "Jobs", detail: "Work orders, assets, and compliance", icon: Wrench },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-20">
      <p className="mb-4 text-sm font-medium tracking-wide text-primary">OPEN FIELDSERVICE</p>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">Operations, without the busywork.</h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
        The Next.js migration foundation is running side-by-side with the existing application. Features will move here only after their behavior and tenant isolation are verified.
      </p>
      <div className="mt-12 grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3">
        {modules.map(({ name, detail, icon: Icon }) => (
          <section className="group bg-card p-6" key={name}>
            <Icon className="size-5 text-primary" aria-hidden />
            <h2 className="mt-8 text-lg font-semibold">{name}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
            <ArrowRight className="mt-6 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden />
          </section>
        ))}
      </div>
    </main>
  );
}
