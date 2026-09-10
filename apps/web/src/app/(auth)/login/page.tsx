import { loginAction } from "./actions";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <section className="w-full rounded-xl border bg-card p-8">
        <p className="text-sm font-medium text-primary">OPEN FIELDSERVICE</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Sign in to an organization workspace.</p>
        <form action={loginAction} className="mt-8 space-y-4">
          <label className="block text-sm font-medium">Organization<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" name="organizationSlug" autoComplete="organization" required /></label>
          <label className="block text-sm font-medium">Email<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" name="email" type="email" autoComplete="email" required /></label>
          <label className="block text-sm font-medium">Password<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" name="password" type="password" autoComplete="current-password" required /></label>
          <button className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
