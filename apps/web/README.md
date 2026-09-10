# Open Fieldservice Next.js application

This is the side-by-side migration target. The legacy Preact/Worker application remains the source of truth until individual modules pass parity gates.

## Local setup

1. Copy `.env.example` to `.env.local` and use development-only values.
2. Create a PostgreSQL database.
3. From this directory, run `pnpm drizzle-kit generate` and `pnpm drizzle-kit migrate`.
4. Run `pnpm dev`.

R2 variables are optional until storage features are exercised, but must be supplied as a complete group.

## Verification

- `pnpm typecheck`, `pnpm lint`, and `pnpm test` run the standard checks.
- `pnpm test:integration` runs the PostgreSQL suite against `DATABASE_URL`.
- On this Windows development host, `powershell -ExecutionPolicy Bypass -File scripts/run-postgres-integration.ps1` creates a disposable PostgreSQL 17 cluster on port 55432, recreates the test database, runs the integration suite, and stops the cluster.
- `pnpm db:seed` adds synthetic demonstration records and requires `SEED_ADMIN_PASSWORD`; it never reads legacy D1 data.
